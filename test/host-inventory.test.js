import test from 'node:test';
import assert from 'node:assert/strict';
import { NewsCache } from '../lib/index.js';
import { ReadStateStore } from '../lib/read-state.js';
import { queryNewscope } from '../lib/newscope-query.js';
import { resolveConfig } from '../lib/config.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
function article(id, score = 8, age = 1) {
  return { id: String(id), guid: 'g-' + id, title: 'Article ' + id, url: 'https://example.com/' + id,
    score, publishedAt: new Date(NOW - age * 3600000).toISOString(), topics: ['technology'], feed: { id: '1', title: 'Example' } };
}
function harness(initial = []) {
  const state = { rows: initial, now: NOW, calls: [], fail: false, status: 200, gate: null };
  state.fetch = async (input, options = {}) => {
    const url = new URL(input); state.calls.push({ url, options });
    assert.ok(!url.pathname.includes('/feeds'), 'queries never trigger source fetching');
    assert.ok(!options.method || options.method === 'GET');
    if (url.pathname === '/api/v1/status') return Response.json({ version: 'test' });
    if (state.fail) throw new Error('offline');
    if (url.pathname === '/rss') return new Response('<rss><channel></channel></rss>');
    assert.equal(url.pathname, '/api/v1/articles');
    if (state.status !== 200) return new Response(null, { status: state.status });
    if (state.gate) await state.gate;
    const min = Number(url.searchParams.get('min_score'));
    const after = Date.parse(url.searchParams.get('published_after'));
    const offset = Number(url.searchParams.get('cursor') || 0);
    const rows = state.rows.filter((item) => item.score >= min && Date.parse(item.publishedAt) > after)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || Number(BigInt(b.id) - BigInt(a.id)));
    const items = rows.slice(offset, offset + 100);
    return Response.json({ items, nextCursor: offset + 100 < rows.length ? String(offset + 100) : null });
  };
  state.readState = new ReadStateStore({ now: () => state.now });
  state.cache = new NewsCache(state.fetch, { readState: state.readState, now: () => state.now });
  state.queries = () => state.calls.filter(({ url }) => url.pathname === '/api/v1/articles');
  return state;
}
async function mark(store, items, prefix = 'read') {
  await store.recordEvents(items.map((item, index) => ({ type: 'open', eventId: prefix + index, articleKey: item.articleKey })));
}

test('pagination loads a bounded candidate superset beyond the RSS latest-100 window', async () => {
  const h = harness(Array.from({ length: 205 }, (_, i) => article(i + 1, 8, i / 10 + 1)));
  const snapshot = await h.cache.snapshot({});
  assert.equal(snapshot.capabilities.history, true);
  assert.equal(snapshot.pool.tier, 'L0'); assert.equal(snapshot.pool.unreadCount, 205);
  assert.equal(snapshot.items.length, 30); assert.equal(h.queries().length, 3);
  assert.equal(h.cache.cache.articles.length, 205);
  assert.ok(snapshot.items.every((item) => item.articleKey.startsWith('newscope:') && !item.replay));
  assert.equal(h.queries()[0].url.searchParams.get('min_score'), '5');
  assert.equal(h.queries()[0].url.searchParams.get('published_after'), new Date(NOW - 168 * 3600000).toISOString());
});

test('strict pool exhaustion selects L1 then L2 then replay, and new L0 preempts all', async () => {
  const h = harness([article(1, 8), article(2, 6, 60), article(3, 5, 100)]);
  let snapshot = await h.cache.snapshot({});
  assert.equal(snapshot.pool.tier, 'L0'); assert.deepEqual(snapshot.items.map((item) => item.newscopeId), ['1']);
  await mark(h.readState, snapshot.items, 'l0');
  snapshot = await h.cache.snapshot({});
  assert.equal(snapshot.pool.tier, 'L1'); assert.deepEqual(snapshot.items.map((item) => item.newscopeId), ['2']);
  await mark(h.readState, snapshot.items, 'l1');
  snapshot = await h.cache.snapshot({});
  assert.equal(snapshot.pool.tier, 'L2+replay');
  assert.equal(snapshot.items[0].newscopeId, '3'); assert.equal(snapshot.items[0].replay, false);
  assert.ok(snapshot.items.slice(1).every((item) => item.replay));
  await mark(h.readState, [snapshot.items[0]], 'l2');
  snapshot = await h.cache.snapshot({});
  assert.equal(snapshot.pool.tier, 'replay'); assert.ok(snapshot.items.every((item) => item.replay));
  assert.ok(Object.values(snapshot.exposureStates).every((entry) => entry.read));
  h.rows.push(article(4, 9, 0)); h.now += 31000;
  snapshot = await h.cache.snapshot({});
  assert.equal(snapshot.pool.tier, 'L0'); assert.deepEqual(snapshot.items.map((item) => item.newscopeId), ['4']);
  assert.equal(h.queries().length, 2);
});

test('low water bypasses TTL once, shares in-flight work and respects a 30 second debounce', async () => {
  const h = harness([article(1), article(2, 6, 60)]);
  const first = await h.cache.snapshot({ refreshMinutes: 60 });
  assert.equal(first.pool.unreadCount, 1); assert.equal(first.items.length, 1);
  await Promise.all(Array.from({ length: 8 }, () => h.cache.snapshot({ refreshMinutes: 60 })));
  assert.equal(h.queries().length, 1);
  h.now += 31000;
  let release; h.gate = new Promise((resolve) => { release = resolve; });
  const pending = Array.from({ length: 8 }, () => h.cache.snapshot({ refreshMinutes: 60 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.queries().length, 2); release();
  const outputs = await Promise.all(pending); h.gate = null;
  assert.ok(outputs.every((result) => result.pool.tier === 'L0' && result.items.length === 1));
  await h.cache.snapshot({ refreshMinutes: 60 }); assert.equal(h.queries().length, 2);
});

test('query errors use stale candidates and latest read state without dropping to RSS', async () => {
  const h = harness([article(1), article(2, 6, 60)]);
  const first = await h.cache.snapshot({}); await mark(h.readState, first.items);
  h.now += 31000; h.fail = true;
  const stale = await h.cache.snapshot({});
  assert.equal(stale.stale, true); assert.equal(stale.service, 'cache');
  assert.equal(stale.pool.tier, 'L1'); assert.equal(stale.items[0].newscopeId, '2');
  assert.equal(h.calls.some(({ url }) => url.pathname === '/rss'), false);
  await h.cache.snapshot({}); assert.equal(h.queries().length, 2, 'failure is debounced too');
});

test('RSS fallback is explicit and history-limited; 500 and invalid JSON never silently fall back', async () => {
  const h = harness(); h.status = 404;
  const fallback = await h.cache.snapshot({});
  assert.equal(fallback.capabilities.history, false); assert.equal(fallback.capabilities.source, 'rss');
  assert.equal(fallback.pool.tier, 'empty');
  for (const status of [500, 400]) {
    const other = harness(); other.status = status;
    const result = await other.cache.snapshot({});
    assert.equal(result.service, 'unavailable'); assert.equal(other.calls.some(({ url }) => url.pathname === '/rss'), false);
  }
  await assert.rejects(queryNewscope(async () => new Response('not JSON'), resolveConfig(), { now: NOW }), /JSON/);
});

test('replay exposures update lastShownAt without resetting read state or increasing threshold count', async () => {
  const h = harness([article(1)]);
  const first = await h.cache.snapshot({}); await mark(h.readState, first.items);
  const replay = await h.cache.snapshot({});
  assert.equal(replay.items[0].replay, true);
  const key = replay.items[0].articleKey;
  const before = replay.exposureStates[key]; h.now += 1000;
  await h.readState.recordEvents([{ type: 'exposure', eventId: 'replay-once', articleKey: key }]);
  const after = (await h.cache.snapshot({})).exposureStates[key];
  assert.equal(after.read, true); assert.equal(after.readAt, before.readAt);
  assert.equal(after.exposureCount, before.exposureCount); assert.equal(after.lastShownAt, new Date(h.now).toISOString());
});

test('cache keys isolate changed age bounds and classification maps', async () => {
  const h = harness([article(1)]);
  const a = await h.cache.snapshot({});
  const b = await h.cache.snapshot({ topicMap: { finance: ['technology'], technology: [] } });
  assert.equal(a.items[0].category, 'technology'); assert.equal(b.items[0].category, 'finance');
  await h.cache.snapshot({ inventory: { level2: { maxAgeHours: 240 } } });
  assert.equal(h.queries().length, 3);
  assert.equal(h.queries()[2].url.searchParams.get('published_after'), new Date(NOW - 240 * 3600000).toISOString());
});

test('cursor cycles, invalid identities and out-of-order pages fail closed', async () => {
  const config = resolveConfig();
  await assert.rejects(queryNewscope(async () => Response.json({ items: [article(1)], nextCursor: 'same' }), config, { now: NOW }), /stable order|cursor/);
  await assert.rejects(queryNewscope(async () => Response.json({ items: [{ ...article(1), id: Number.MAX_SAFE_INTEGER + 1 }], nextCursor: null }), config, { now: NOW }), /identity/);
  await assert.rejects(queryNewscope(async () => Response.json({ items: [article(1), article(2)], nextCursor: null }), config, { now: NOW }), /stable order/);
});

test('truncated bounded history does not authorize relaxation or claim a complete scan', async () => {
  const h = harness(Array.from({ length: 5001 }, (_, i) => article(i + 1, 6, 60)));
  const snapshot = await h.cache.snapshot({});
  assert.equal(h.queries().length, 50); assert.equal(h.cache.cache.articles.length, 5000);
  assert.equal(snapshot.capabilities.history, false); assert.equal(snapshot.capabilities.truncated, true);
  assert.equal(snapshot.items.length, 0); assert.equal(snapshot.pool.tier, 'empty');
});
