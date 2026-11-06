import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NewsCache } from '../lib/index.js';
import { CandidateStore } from '../lib/candidate-store.js';
import { ReadStateStore } from '../lib/read-state.js';
import { articleKeyFor } from '../lib/article-identity.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const HOUR = 3600_000;
const SOURCE = 'https://original.test';
const OTHER = 'https://second.test';
const THIRD = 'https://third.test';
const config = (overrides = {}) => ({
  newscopeUrl: SOURCE, minScore: 7, maxAgeHours: 48, refreshMinutes: 1,
  translationEnabled: false, semanticDedupEnabled: false,
  inventory: { targetInventory: 1, lowWatermark: 0, refillDebounceSeconds: 30 },
  ...overrides,
});
const row = (id, score = 8, age = 1, extra = {}) => ({
  id: String(id), guid: `guid-${id}`, title: `Story-${id}`, url: `https://publisher.test/${id}`,
  score, publishedAt: new Date(NOW - age * HOUR).toISOString(), topics: ['technology'],
  feed: { id: '1', title: 'Publisher' }, ...extra,
});
const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function rss(rows) {
  return '<rss version="2.0"><channel><title>Original Newscope</title>' + rows.map((item) =>
    `<item><title>[${item.score}] ${escapeXml(item.title)}</title><link>${escapeXml(item.url)}</link>`
    + `<guid>${escapeXml(item.guid)}</guid><pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>`
    + item.topics.map((topic) => `<category>${escapeXml(topic)}</category>`).join('') + '</item>').join('') + '</channel></rss>';
}
function htmlResult(articles = []) {
  return { articles, coverage: 'window-scanned', truncated: false, pages: 1, stopReason: 'end-of-pages', warnings: [] };
}

// Every network request is intercepted here. Every durable store is under a new
// temporary directory; no default production path or real Newscope server is used.
async function harness(t, initial = []) {
  const directory = await mkdtemp(join(tmpdir(), 'newscope-original-compat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = {
    directory, candidateFile: join(directory, 'candidate-inventory.json'), readFile: join(directory, 'read-state.json'),
    now: NOW, rssRows: initial, apiRows: initial, apiSupported: false, offline: false,
    calls: [], htmlCalls: [], htmlRows: [], htmlError: null, bySource: new Map(), apiPage: null,
    rssStatus: 200, beforeRssResponse: null,
  };
  h.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.ok([SOURCE, OTHER, THIRD].includes(url.origin), `unexpected outbound host ${url.origin}`);
    assert.ok(!options.method || options.method === 'GET', 'metadata only, no feed-fetch POSTs');
    assert.ok(['/api/v1/articles', '/rss', '/api/v1/status'].includes(url.pathname), `unexpected endpoint ${url.pathname}`);
    h.calls.push({ url, options, at: h.now });
    if (h.offline) throw new Error('stub remote offline');
    if (url.pathname === '/api/v1/status') return Response.json({ version: h.apiSupported ? 'api-upgraded' : 'original' });
    if (url.pathname === '/rss') {
      if (h.beforeRssResponse) await h.beforeRssResponse();
      if (h.rssStatus !== 200) return new Response('RSS unavailable', { status: h.rssStatus });
      const rows = h.bySource.get(url.origin) ?? h.rssRows;
      return new Response(rss(rows.filter((item) => item.score >= Number(url.searchParams.get('min_score')))),
        { headers: { 'content-type': 'application/rss+xml' } });
    }
    if (!h.apiSupported) return new Response('not found', { status: 404 });
    if (h.apiPage) return h.apiPage(url);
    const after = Date.parse(url.searchParams.get('published_after'));
    const minimum = Number(url.searchParams.get('min_score'));
    const offset = Number(url.searchParams.get('cursor') || 0);
    const rows = h.apiRows.filter((item) => item.score >= minimum && Date.parse(item.publishedAt) >= after)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || Number(BigInt(b.id) - BigInt(a.id)));
    return Response.json({ items: rows.slice(offset, offset + 100), nextCursor: offset + 100 < rows.length ? String(offset + 100) : null });
  };
  h.htmlQuery = async (fetchImpl, broad, options) => {
    assert.equal(fetchImpl, h.fetch);
    assert.ok(options.now <= h.now, 'HTML receives the query-start clock, not a future timestamp');
    h.htmlCalls.push({ broad, at: h.now });
    if (h.htmlError) throw h.htmlError;
    return htmlResult(h.htmlRows);
  };
  h.reopen = (candidateOptions = {}) => {
    h.candidates = new CandidateStore({ file: h.candidateFile, now: () => h.now, ...candidateOptions });
    h.readState = new ReadStateStore({ file: h.readFile, now: () => h.now });
    h.cache = new NewsCache(h.fetch, { now: () => h.now, candidateStore: h.candidates, readState: h.readState, htmlQuery: h.htmlQuery });
    return h.cache;
  };
  h.queries = (path) => h.calls.filter(({ url }) => url.pathname === path);
  let event = 0;
  h.mark = (items) => h.readState.recordEvents(items.map((item) => ({
    type: 'open', eventId: `compat-read-${++event}`, articleKey: item.articleKey,
  })));
  h.reopen();
  return h;
}

test('original 404 uses the widest RSS window, then advances L0 → L1 → L2 → replay locally', async (t) => {
  const h = await harness(t, [row(1), row(2, 6, 60), row(3, 5, 100), row(4, 4, 1), row(5, 8, 200)]);
  let snapshot = await h.cache.snapshot(config());
  assert.equal(snapshot.service, 'ok');
  assert.equal(snapshot.pool.tier, 'L0');
  assert.equal(snapshot.items[0].url, row(1).url);
  assert.equal(snapshot.capabilities.history, true);
  assert.equal(snapshot.capabilities.inventoryScope, 'known-local');
  assert.equal(snapshot.capabilities.remoteWindowComplete, false);
  assert.equal(snapshot.inventoryStore.retainedCount, 3);
  assert.equal(snapshot.inventoryStore.firstCollectedAt, new Date(NOW).toISOString());
  assert.equal(h.queries('/api/v1/articles').length, 1);
  assert.equal(h.queries('/rss')[0].url.searchParams.get('min_score'), '5');
  assert.equal(h.htmlCalls[0].broad.maxAgeHours, 168);
  assert.equal(h.htmlCalls[0].broad.minScore, 5);
  for (const [tier, id] of [['L1', 2], ['L2', 3]]) {
    await h.mark(snapshot.items);
    snapshot = await h.cache.snapshot(config());
    assert.equal(snapshot.pool.tier, tier);
    assert.equal(snapshot.items[0].url, row(id).url);
    assert.equal(snapshot.items[0].replay, false);
  }
  await h.mark(snapshot.items);
  snapshot = await h.cache.snapshot(config());
  assert.equal(snapshot.pool.tier, 'replay');
  assert.equal(snapshot.items[0].replay, true);
  const read = snapshot.exposureStates[snapshot.items[0].articleKey];
  assert.equal(read.read, true);
  const replayAgain = await h.cache.snapshot(config());
  assert.equal(replayAgain.exposureStates[snapshot.items[0].articleKey].readAt, read.readAt);
  assert.equal(replayAgain.exposureStates[snapshot.items[0].articleKey].exposureCount, read.exposureCount);
  assert.equal(h.queries('/api/v1/articles').length, 1);
  assert.equal(h.queries('/rss').length, 1, 'tier changes query known local candidates rather than fetching RSS repeatedly');
});

test('RSS URL read identity survives API upgrade, restart, and API-to-RSS fallback', async (t) => {
  const h = await harness(t, [row(42)]);
  const first = await h.cache.snapshot(config());
  const rssKey = first.items[0].articleKey;
  assert.ok(rssKey.startsWith('url:'));
  await h.mark(first.items);
  const before = await h.readState.present(first.items, { source: SOURCE, includeRead: true });
  h.apiSupported = true;
  h.now += 15 * 60_000;
  const upgraded = await h.cache.snapshot(config());
  assert.equal(upgraded.capabilities.source, 'articles');
  assert.equal(upgraded.pool.tier, 'replay');
  assert.equal(upgraded.items[0].newscopeId, '42');
  assert.equal(upgraded.items[0].articleKey, rssKey, 'read-state canonical URL identity remains stable');
  assert.equal(upgraded.exposureStates[rssKey].readAt, before.exposureStates[rssKey].readAt);
  const inventory = await h.candidates.snapshot(SOURCE);
  assert.equal(inventory.retainedCount, 1);
  assert.equal(inventory.articles[0].articleKey, articleKeyFor({ newscopeId: '42' }, SOURCE));
  h.apiSupported = false;
  h.rssRows = [row(42, 8, 1, { title: 'RSS title revision', url: row(42).url + '?utm_source=refresh#part' })];
  h.reopen();
  const fallback = await h.cache.snapshot(config());
  assert.equal(fallback.items[0].newscopeId, '42');
  assert.equal(fallback.items[0].title, 'RSS title revision');
  assert.equal(fallback.items[0].articleKey, rssKey);
  assert.equal(fallback.pool.tier, 'replay');
  assert.equal(fallback.exposureStates[rssKey].read, true);
  assert.equal((await h.candidates.snapshot(SOURCE)).retainedCount, 1);
});

test('API-first read identity remains read on original RSS after a full Host restart', async (t) => {
  const h = await harness(t, [row(9)]);
  h.apiSupported = true;
  const first = await h.cache.snapshot(config());
  assert.ok(first.items[0].articleKey.startsWith('newscope:'));
  await h.mark(first.items);
  h.apiSupported = false;
  h.reopen();
  const rssOnly = await h.cache.snapshot(config());
  assert.equal(rssOnly.pool.tier, 'replay');
  assert.equal(rssOnly.items[0].newscopeId, '9');
  assert.equal(rssOnly.items[0].articleKey, first.items[0].articleKey);
  assert.equal(rssOnly.exposureStates[first.items[0].articleKey].read, true);
});

test('crash recovery restores read identity through inventory-only URL → API ID → changed URL aliases', async (t) => {
  for (const mode of ['offline-local', 'complete-api']) {
    await t.test(mode, async (t) => {
      const h = await harness(t, [row(42)]);
      const original = await h.cache.snapshot(config());
      const oldKey = original.items[0].articleKey;
      await h.mark(original.items);
      const readBefore = await readFile(h.readFile, 'utf8');
      const apiKey = articleKeyFor({ newscopeId: '42' }, SOURCE);
      assert.equal(readBefore.includes(apiKey), false);
      // Simulate collection committed immediately before a Host crash: read-state
      // has never been presented the API identity or the changed URL.
      await h.candidates.merge(SOURCE, [{ ...row(42), newscopeId: '42' }]);
      const changed = row(42, 8, 1, { url: 'https://publisher.test/relocated-42', title: 'Relocated story' });
      await h.candidates.merge(SOURCE, [{ ...changed, newscopeId: '42' }]);
      assert.equal(await readFile(h.readFile, 'utf8'), readBefore, 'candidate collection never changes independent read-state');
      const collected = await h.candidates.snapshot(SOURCE);
      assert.equal(collected.retainedCount, 1);
      assert.ok(collected.aliasesByKey[apiKey].includes(oldKey));
      h.apiRows = [changed];
      h.apiSupported = true;
      h.offline = mode === 'offline-local';
      h.reopen();
      const recovered = await h.cache.snapshot(config());
      assert.equal(recovered.service, mode === 'offline-local' ? 'cache' : 'ok');
      assert.equal(recovered.pool.tier, 'replay');
      assert.equal(recovered.items[0].url, changed.url);
      assert.equal(recovered.items[0].newscopeId, '42');
      assert.equal(recovered.items[0].articleKey, oldKey);
      assert.equal(recovered.exposureStates[oldKey].read, true);
      assert.equal(recovered.exposureStates[oldKey].readAt, new Date(NOW).toISOString());
      assert.equal(recovered.exposureStates[oldKey].exposureCount, 0, 'identity migration cannot fabricate exposure events');
      assert.equal(recovered.aliasesByKey, undefined);
      assert.equal(recovered.identityAliases, undefined);
      assert.equal(recovered.items[0].aliases, undefined, 'trusted internal aliases do not leak into public news metadata');
      assert.equal(recovered.inventoryStore.aliasesByKey, undefined);
    });
  }
});

test('RSS rotation accumulates across restart and a remote outage serves durable stale local inventory', async (t) => {
  const h = await harness(t, [row(1)]);
  const settings = config({ inventory: { targetInventory: 5, lowWatermark: 0 } });
  const first = await h.cache.snapshot(settings);
  h.rssRows = [row(2)];
  h.now += 60_000;
  h.reopen();
  const rotated = await h.cache.snapshot(settings);
  assert.deepEqual(new Set(rotated.items.map((item) => item.url)), new Set([row(1).url, row(2).url]));
  assert.equal(rotated.inventoryStore.firstCollectedAt, first.inventoryStore.firstCollectedAt);
  assert.equal(rotated.inventoryStore.retainedCount, 2);
  const savedAt = rotated.inventoryStore.updatedAt;
  h.now += 60_000;
  h.offline = true;
  h.reopen();
  const offline = await h.cache.snapshot(settings);
  assert.equal(offline.service, 'cache');
  assert.equal(offline.stale, true);
  assert.equal(offline.capabilities.source, 'local');
  assert.equal(offline.capabilities.remoteWindowComplete, false);
  assert.equal(offline.pool.scope, 'known-local');
  assert.equal(offline.items.length, 2);
  assert.equal(offline.fetchedAt, savedAt);
  assert.match(offline.error, /offline/);
  assert.ok(offline.warnings.some((message) => /stale locally collected/.test(message)));
  const calls = h.calls.length;
  await h.cache.snapshot(settings);
  assert.equal(h.calls.length, calls, 'offline retry is debounced');
});

test('first HTML supplement runs once, sufficient inventory skips it, and low water obeys a 60-second floor', async (t) => {
  const h = await harness(t, [row(1)]);
  h.htmlRows = [{ ...row(2), newscopeId: '2', source: 'Publisher' }];
  const settings = config({ inventory: { targetInventory: 3, lowWatermark: 2, refillDebounceSeconds: 30 } });
  const first = await h.cache.snapshot(settings);
  assert.equal(h.htmlCalls.length, 1);
  assert.equal(first.capabilities.source, 'rss+html');
  assert.equal(first.items.length, 2);
  assert.equal(first.pool.unreadCount, 2);
  h.now += 60_000;
  const enough = await h.cache.snapshot(settings);
  assert.equal(h.queries('/rss').length, 2);
  assert.equal(h.htmlCalls.length, 1, 'do not repeat history supplements while L0 unread inventory is sufficient');
  await h.mark(enough.items);
  h.now += 30_000;
  const low = await h.cache.snapshot(settings);
  assert.equal(low.pool.tier, 'replay');
  assert.equal(h.htmlCalls.length, 2);
  h.now += 30_000;
  await h.cache.snapshot(settings);
  assert.equal(h.htmlCalls.length, 2, 'RSS can refill at 30s but HTML cannot');
  h.now += 30_000;
  await h.cache.snapshot(settings);
  assert.equal(h.htmlCalls.length, 3);
  assert.equal(h.htmlCalls[2].at - h.htmlCalls[1].at, 60_000);
});

test('first-time HTML supplements even when the first RSS response already fills L0', async (t) => {
  const h = await harness(t, [row(1), row(2)]);
  const settings = config({ inventory: { targetInventory: 2, lowWatermark: 1 } });
  await h.cache.snapshot(settings);
  assert.equal(h.htmlCalls.length, 1);
  h.now += 60_000;
  await h.cache.snapshot(settings);
  assert.equal(h.htmlCalls.length, 1);
});

test('continuous original RSS polling cannot renew the API-negative capability cache beyond 15 minutes', async (t) => {
  const h = await harness(t, [row(1)]);
  const settings = config({ refreshMinutes: 60, inventory: { targetInventory: 2, lowWatermark: 2, refillDebounceSeconds: 30 } });
  await h.cache.snapshot(settings);
  assert.equal(h.queries('/api/v1/articles').length, 1);
  h.apiSupported = true;
  h.apiRows = [row(99)];
  for (let second = 30; second < 900; second += 30) {
    h.now = NOW + second * 1000;
    const snapshot = await h.cache.snapshot(settings);
    assert.equal(snapshot.service, 'ok');
    assert.equal(snapshot.capabilities.inventoryScope, 'known-local');
  }
  assert.equal(h.queries('/rss').length, 30);
  assert.equal(h.queries('/api/v1/articles').length, 1, 'negative capability remains cached until its original deadline');
  h.now = NOW + 900_000;
  const upgraded = await h.cache.snapshot(settings);
  assert.equal(h.queries('/api/v1/articles').length, 2);
  assert.equal(upgraded.capabilities.source, 'articles');
  assert.equal(upgraded.capabilities.remoteWindowComplete, true);
  assert.equal(upgraded.items[0].newscopeId, '99');
  assert.equal(h.queries('/rss').length, 30);
});

test('an RSS request begun before API-negative expiry cannot renew it by finishing after the deadline', async (t) => {
  const h = await harness(t, [row(1)]);
  const settings = config({ inventory: { targetInventory: 2, lowWatermark: 2, refillDebounceSeconds: 30 } });
  await h.cache.snapshot(settings);
  h.apiSupported = true;
  h.apiRows = [row(99)];
  h.now = NOW + 890_000;
  h.beforeRssResponse = async () => { h.now = NOW + 910_000; };
  const crossing = await h.cache.snapshot(settings);
  assert.equal(crossing.service, 'ok');
  assert.equal(crossing.capabilities.inventoryScope, 'known-local');
  assert.equal(h.queries('/rss').at(-1).at, NOW + 890_000);
  assert.equal(h.queries('/api/v1/articles').length, 1);
  h.beforeRssResponse = null;
  h.now = NOW + 940_000;
  const upgraded = await h.cache.snapshot(settings);
  assert.equal(h.queries('/api/v1/articles').length, 2, 'finishing an RSS poll after 15min must not start another 15min blacklist');
  assert.equal(upgraded.capabilities.source, 'articles');
  assert.equal(upgraded.items[0].newscopeId, '99');
  assert.equal(h.queries('/rss').length, 2);
});

test('API 404 remains negatively cached for 15 minutes even when the following RSS request fails', async (t) => {
  const h = await harness(t, [row(1)]);
  h.rssStatus = 503;
  const first = await h.cache.snapshot(config());
  assert.equal(first.service, 'unavailable');
  assert.match(first.error, /RSS returned HTTP 503/);
  assert.equal(h.queries('/api/v1/articles').length, 1);
  h.apiSupported = true;
  for (const elapsed of [30_000, 870_000]) {
    h.now = NOW + elapsed;
    const retry = await h.cache.snapshot(config());
    assert.equal(retry.service, 'unavailable');
    assert.match(retry.error, /RSS returned HTTP 503/);
    assert.equal(h.queries('/api/v1/articles').length, 1, 'RSS failure must not erase the confirmed API-unsupported capability');
  }
  assert.equal(h.queries('/rss').length, 3);
  h.now = NOW + 900_000;
  const upgraded = await h.cache.snapshot(config());
  assert.equal(upgraded.service, 'ok');
  assert.equal(upgraded.capabilities.source, 'articles');
  assert.equal(upgraded.items[0].newscopeId, '1');
  assert.equal(h.queries('/api/v1/articles').length, 2);
  assert.equal(h.queries('/rss').length, 3);
});

test('complete API inventory is authoritative and never resurrects locally retained server deletions', async (t) => {
  const h = await harness(t, [row(1), row(2)]);
  h.apiSupported = true;
  const settings = config({ inventory: { targetInventory: 5, lowWatermark: 0 } });
  assert.equal((await h.cache.snapshot(settings)).items.length, 2);
  h.apiRows = [row(2)];
  h.now += 60_000;
  const deleted = await h.cache.snapshot(settings);
  assert.equal(deleted.capabilities.remoteWindowComplete, true);
  assert.deepEqual(deleted.items.map((item) => item.newscopeId), ['2']);
  assert.equal((await h.candidates.snapshot(SOURCE)).retainedCount, 2, 'archive retention is not remote deletion authority');
  h.apiRows = [];
  h.now += 60_000;
  const empty = await h.cache.snapshot(settings);
  assert.equal(empty.service, 'ok');
  assert.equal(empty.pool.tier, 'empty');
  assert.equal(empty.pool.scope, 'remote-window');
  assert.equal(empty.items.length, 0);
  assert.equal((await h.candidates.snapshot(SOURCE)).retainedCount, 2);
});

test('truncated API coverage unions known local candidates and still permits relaxed L2 selection', async (t) => {
  const h = await harness(t);
  await h.candidates.merge(SOURCE, [row(500, 8)]);
  h.apiSupported = true;
  h.apiPage = async (url) => {
    const page = Number(url.searchParams.get('cursor') || 0);
    return Response.json({ items: [row(1000 - page, 5, 100 + page / 60)], nextCursor: String(page + 1) });
  };
  let snapshot = await h.cache.snapshot(config());
  assert.equal(snapshot.service, 'ok');
  assert.equal(h.queries('/api/v1/articles').length, 50);
  assert.equal(snapshot.capabilities.source, 'articles');
  assert.equal(snapshot.capabilities.truncated, true);
  assert.equal(snapshot.capabilities.remoteWindowComplete, false);
  assert.equal(snapshot.pool.scope, 'known-local');
  assert.equal(snapshot.pool.tier, 'L0');
  assert.equal(snapshot.items[0].url, row(500).url);
  assert.equal(snapshot.inventoryStore.retainedCount, 51);
  await h.mark(snapshot.items);
  snapshot = await h.cache.snapshot(config());
  assert.equal(snapshot.pool.tier, 'L2');
  assert.equal(snapshot.pool.unreadCount, 50);
  assert.equal(snapshot.items[0].newscopeId, '1000');
  assert.equal(snapshot.items[0].replay, false);
  assert.equal(h.queries('/api/v1/articles').length, 50);
});

test('unavailable HTML produces an explicit warning while RSS and accumulated local candidates remain usable', async (t) => {
  const h = await harness(t, [row(1)]);
  h.htmlError = new Error('HTML not supported at https://original.test/private?token=secret');
  const settings = config({ inventory: { targetInventory: 5, lowWatermark: 5 } });
  const first = await h.cache.snapshot(settings);
  assert.equal(first.service, 'ok');
  assert.equal(first.capabilities.source, 'rss');
  assert.equal(first.items.length, 1);
  assert.ok(first.warnings.some((message) => /HTML history supplement unavailable/.test(message)));
  assert.ok(first.warnings.every((message) => !message.includes('token=secret')));
  h.rssRows = [row(2)];
  h.now += 60_000;
  const second = await h.cache.snapshot(settings);
  assert.equal(second.service, 'ok');
  assert.equal(second.items.length, 2);
  assert.equal(second.inventoryStore.retainedCount, 2);
  assert.ok(second.warnings.some((message) => /HTML history supplement unavailable/.test(message)));
});

test('corrupt candidate files report candidate-state-unavailable without returning invented empty history', async (t) => {
  const h = await harness(t, [row(1)]);
  const first = await h.cache.snapshot(config());
  await h.mark(first.items);
  const readBefore = await readFile(h.readFile, 'utf8');
  const valid = await readFile(h.candidateFile, 'utf8');
  await writeFile(h.candidateFile, '{corrupt-inventory');
  h.reopen();
  const calls = h.calls.length;
  const failed = await h.cache.snapshot(config());
  assert.equal(failed.service, 'candidate-state-unavailable');
  assert.match(failed.error, /Candidate inventory unavailable/);
  assert.equal(failed.items.length, 0);
  assert.equal(failed.pool, undefined, 'unavailable is not a valid empty-pool claim');
  assert.equal(failed.fetchedAt, null);
  assert.equal(h.calls.length, calls, 'validate storage before any remote collection');
  assert.equal(await readFile(h.candidateFile, 'utf8'), '{corrupt-inventory');
  assert.equal(await readFile(h.readFile, 'utf8'), readBefore);
  assert.equal((await readdir(h.directory)).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')), false);
  await writeFile(h.candidateFile, valid);
  h.now += 30_000;
  const recovered = await h.cache.snapshot(config());
  assert.equal(recovered.service, 'ok');
  assert.equal(recovered.pool.tier, 'replay');
});

test('candidate persistence faults are explicit, atomic, and do not masquerade as cached or empty success', async (t) => {
  for (const stage of ['write', 'rename']) {
    await t.test(stage, async (t) => {
      const h = await harness(t, [row(1)]);
      let failing = false;
      h.reopen({
        writeFile: async (...args) => {
          if (failing && stage === 'write') { await writeFile(args[0], 'partial', args[2]); throw new Error('injected candidate disk failure'); }
          return writeFile(...args);
        },
        rename: async (...args) => {
          if (failing && stage === 'rename') throw new Error('injected candidate rename failure');
          return rename(...args);
        },
      });
      await h.cache.snapshot(config());
      const before = await readFile(h.candidateFile, 'utf8');
      h.rssRows = [row(2)];
      h.now += 60_000;
      failing = true;
      const failed = await h.cache.snapshot(config());
      assert.equal(failed.service, 'candidate-state-unavailable');
      assert.match(failed.error, /injected candidate/);
      assert.equal(failed.items.length, 0);
      assert.equal(failed.pool, undefined);
      assert.equal(await readFile(h.candidateFile, 'utf8'), before);
      assert.equal((await readdir(h.directory)).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')), false);
      h.reopen();
      const recovered = await h.cache.snapshot(config({ inventory: { targetInventory: 5, lowWatermark: 0 } }));
      assert.equal(recovered.service, 'ok');
      assert.equal(recovered.items.length, 2);
    });
  }
});

test('failure on the first candidate write is unavailable, not successful empty inventory', async (t) => {
  const h = await harness(t, [row(1)]);
  h.reopen({ writeFile: async () => { throw new Error('initial candidate disk failure'); } });
  const failed = await h.cache.snapshot(config());
  assert.equal(failed.service, 'candidate-state-unavailable');
  assert.match(failed.error, /initial candidate disk failure/);
  assert.equal(failed.fetchedAt, null);
  assert.equal(failed.inventoryStore, undefined);
  assert.equal(failed.pool, undefined);
  assert.deepEqual(failed.items, []);
  await assert.rejects(() => readFile(h.candidateFile, 'utf8'), { code: 'ENOENT' });
  assert.equal((await readdir(h.directory)).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')), false);
});

test('source switching never borrows candidates or read flags, and changed config reclassifies archived metadata', async (t) => {
  const h = await harness(t, [row(1, 8, 1, { topics: ['custom-beat'] })]);
  const maps = { finance: ['custom-beat'], technology: [], science: [], general: [] };
  const first = await h.cache.snapshot(config({ topicMap: maps }));
  assert.equal(first.items[0].category, 'finance');
  await h.mark(first.items);
  h.bySource.set(OTHER, [row(1, 8, 1, { topics: ['custom-beat'] })]);
  const other = await h.cache.snapshot(config({ newscopeUrl: OTHER, topicMap: maps }));
  assert.equal(other.pool.tier, 'L0');
  assert.equal(other.items[0].replay, false);
  assert.equal(other.exposureStates[other.items[0].articleKey].read, false);
  assert.notEqual(other.items[0].articleKey, first.items[0].articleKey);
  h.bySource.set(THIRD, []);
  const missing = await h.cache.snapshot(config({ newscopeUrl: THIRD }));
  assert.equal(missing.service, 'ok');
  assert.equal(missing.pool.tier, 'empty');
  assert.equal(missing.items.length, 0);
  h.rssRows = [];
  const changed = await h.cache.snapshot(config({ topicMap: { finance: [], technology: ['custom-beat'], science: [], general: [] } }));
  assert.equal(changed.pool.tier, 'replay');
  assert.equal(changed.items[0].category, 'technology');
  assert.equal(changed.items[0].articleKey, first.items[0].articleKey);
  assert.equal(changed.inventoryStore.retainedCount, 1);
  const originalArchive = await h.candidates.snapshot(SOURCE);
  assert.ok([undefined, 'finance'].includes(originalArchive.articles[0].category), 'stored category may be omitted or remain advisory; it is not current classification authority');
});
