import test from 'node:test';
import assert from 'node:assert/strict';
import { NewsCache } from '../lib/index.js';
import { ReadStateStore } from '../lib/read-state.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const CONFIG = { translationEnabled: true, translationModel: 'test/model', inventory: { targetInventory: 1 } };

function article(id, score) {
  return {
    id: String(id), title: 'Original headline ' + id, url: 'https://example.com/race/' + id,
    score, publishedAt: new Date(NOW - 3600_000).toISOString(), topics: ['technology'],
    feed: { id: '1', title: 'Example' },
  };
}

function harness(rows) {
  const state = { now: NOW, queries: 0, translationCalls: [], translate: async (items) => items.map((item) => ({
    ...item, originalTitle: item.title, title: '已译标题' + item.newscopeId,
  })) };
  state.readState = new ReadStateStore({ now: () => state.now });
  state.cache = new NewsCache(async (input, options = {}) => {
    const url = new URL(input);
    assert.ok(!options.method || options.method === 'GET');
    if (url.pathname === '/api/v1/status') return Response.json({ version: 'test' });
    assert.equal(url.pathname, '/api/v1/articles');
    state.queries++;
    return Response.json({ items: rows.slice().sort((a, b) => Number(b.id) - Number(a.id)), nextCursor: null });
  }, {
    now: () => state.now,
    readState: state.readState,
    deduplicator: { deduplicate: async (items) => items },
    translator: { translate: async (items) => {
      state.translationCalls.push(items.map((item) => item.newscopeId));
      return state.translate(items);
    } },
  });
  return state;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a read committed during translation reselects the complete raw pool and prepares newly eligible L1', { timeout: 5000 }, async (t) => {
  const h = harness([article(1, 8), article(2, 6)]);
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const translate = h.translate;
  h.translate = async (items) => {
    if (h.translationCalls.length === 1) {
      entered.resolve(items[0]);
      await release.promise;
    }
    return translate(items);
  };

  const pending = h.cache.snapshot(CONFIG);
  const inTranslation = await entered.promise;
  assert.equal(inTranslation.newscopeId, '1');
  const acknowledgement = await h.readState.recordEvents([{ type: 'open', eventId: 'read-during-translation', articleKey: inTranslation.articleKey }]);
  release.resolve();
  const snapshot = await pending;

  assert.equal(snapshot.pool.tier, 'L1');
  assert.equal(snapshot.pool.unreadCount, 1);
  assert.deepEqual(snapshot.pool.effective, { minScore: 6, maxAgeHours: 72 });
  assert.deepEqual(snapshot.items.map((item) => item.newscopeId), ['2']);
  assert.equal(snapshot.items[0].title, '已译标题2');
  assert.equal(snapshot.items[0].replay, false);
  assert.ok(snapshot.readVersion >= acknowledgement.readVersion);
  assert.equal(snapshot.exposureStates[snapshot.items[0].articleKey].read, false);
  assert.deepEqual(h.translationCalls, [['1'], ['2']], 'one bounded second preparation serves newly eligible inventory');
  assert.equal(h.queries, 1, 'tier changes reuse the already loaded historical superset');
});

test('a partial translation result is retried after recovery instead of being cached indefinitely', { timeout: 5000 }, async () => {
  const h = harness([article(1, 9), article(2, 8)]);
  const translate = h.translate;
  h.translate = async (items) => translate(h.translationCalls.length === 1 ? items.slice(0, 1) : items);
  const config = { ...CONFIG, refreshMinutes: 1, inventory: { targetInventory: 2 } };

  const partial = await h.cache.snapshot(config);
  assert.deepEqual(partial.items.map((item) => item.newscopeId), ['1']);
  assert.equal(partial.pool.unreadCount, 2);
  assert.equal(h.translationCalls.length, 1);

  // The same candidate signature returns after a normal TTL refresh, but the
  // translator has recovered and can now supply both requested Chinese titles.
  h.now += 61_000;
  const recovered = await h.cache.snapshot(config);
  assert.deepEqual(recovered.items.map((item) => item.newscopeId), ['1', '2']);
  assert.deepEqual(recovered.items.map((item) => item.title), ['已译标题1', '已译标题2']);
  assert.ok(recovered.items.every((item) => item.replay === false));
  assert.equal(recovered.pool.tier, 'L0');
  assert.equal(recovered.pool.unreadCount, 2);
  assert.deepEqual(h.translationCalls, [['1', '2'], ['1', '2']]);
  assert.equal(h.queries, 2, 'normal candidate refresh must not retain an incomplete prepared result');
});

test('translation fallback cannot promote an old displayed subset to replay while raw L0 unread remains', { timeout: 5000 }, async () => {
  const h = harness([article(1, 9), article(2, 8)]);
  const first = await h.cache.snapshot(CONFIG);
  assert.deepEqual(first.items.map((item) => item.newscopeId), ['1']);
  assert.equal(first.pool.unreadCount, 2);
  const acknowledgement = await h.readState.recordEvents([{ type: 'open', eventId: 'read-before-failed-translation', articleKey: first.items[0].articleKey }]);
  h.translate = async () => { throw new Error('temporary translation outage'); };

  const fallback = await h.cache.snapshot(CONFIG);
  assert.equal(fallback.pool.tier, 'L0', 'selection must use both raw candidates, not only lastGood.items');
  assert.equal(fallback.pool.unreadCount, 1);
  assert.deepEqual(fallback.pool.effective, { minScore: 7, maxAgeHours: 48 });
  assert.deepEqual(fallback.items, [], 'no matching prepared L0 exists; replaying the consumed A is forbidden');
  assert.deepEqual(fallback.exposureStates, {});
  assert.ok(fallback.readVersion >= acknowledgement.readVersion);
  assert.equal(fallback.capabilities.history, true);
  assert.equal(fallback.stale, true);
  assert.match(fallback.error, /temporary translation outage/);
  assert.deepEqual(h.translationCalls, [['1'], ['2']]);
  assert.equal(h.queries, 1);
});
