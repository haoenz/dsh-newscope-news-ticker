import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { articleKeysFor } from '../lib/article-identity.js';
import { ReadStateStore } from '../lib/read-state.js';

const SOURCE = 'https://newscope.example';
const RSS = { title: 'Candidate', url: 'https://publisher.example/story' };
const API = { ...RSS, newscopeId: 42 };
const [ID, URL] = articleKeysFor(API, SOURCE);
const options = { source: SOURCE, includeRead: true };
const event = (eventId, articleKey = ID, type = 'exposure') => ({ eventId, articleKey, type });
const early = '2026-01-01T00:00:00.000Z';
const later = '2026-01-02T00:00:00.000Z';
const latest = '2026-01-03T00:00:00.000Z';
const record = (overrides = {}) => ({
  aliases: [], exposureCount: 0, firstReadAt: null, lastReadAt: null,
  readReason: null, lastShownAt: null, updatedAt: null, ...overrides,
});
const disk = async (file) => JSON.parse(await readFile(file, 'utf8'));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'newscope-inventory-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'state.json');
}

async function seed(file, articles, eventLog = []) {
  await writeFile(file, JSON.stringify({ version: 1, revision: 7, articles, eventLog }));
}

test('includeRead is opt-in and returns complete public state for every candidate', async (t) => {
  const file = await fixture(t);
  const store = new ReadStateStore({ file, now: () => Date.parse(early) });
  const untouched = { title: 'Untouched', url: 'https://publisher.example/untouched' };
  const untouchedKey = articleKeysFor(untouched, SOURCE)[0];
  const initial = await store.present([API, untouched], options);
  assert.equal(initial.items.length, 2);
  assert.deepEqual(initial.exposureStates[ID], {
    read: false, exposureCount: 0, readAt: null, readReason: null, lastShownAt: null,
  });
  assert.equal(initial.readVersion, 0);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await store.recordEvents([event('read')], { readAfterExposures: 1 });
  const all = await store.present([API, untouched], options);
  assert.equal(all.items.length, 2);
  assert.deepEqual(all.exposureStates[ID], {
    read: true, exposureCount: 1, readAt: early, readReason: 'exposure', lastShownAt: early,
  });
  const filtered = await store.present([API, untouched], { source: SOURCE });
  assert.deepEqual(filtered.items.map((item) => item.articleKey), [untouchedKey]);
  assert.deepEqual(Object.keys(filtered.exposureStates), [untouchedKey]);
  assert.equal(Object.keys((await disk(file)).articles).length, 1);
});

test('RSS read identity stays canonical through API migration and restart', async (t) => {
  const file = await fixture(t);
  const store = new ReadStateStore({ file, now: () => Date.parse(early) });
  await store.recordEvents([event('rss-open', URL, 'open')]);
  const before = await disk(file);
  // Even a filtered-out read candidate must durably teach its new alias.
  assert.equal((await store.present([API], { source: SOURCE })).items.length, 0);
  const migrated = await disk(file);
  assert.equal(migrated.revision, before.revision + 1);
  assert.deepEqual(Object.keys(migrated.articles), [URL]);
  assert.deepEqual(migrated.articles[URL].aliases, [ID]);
  assert.deepEqual(migrated.eventLog, before.eventLog);
  const restarted = new ReadStateStore({ file });
  const presented = await restarted.present([API, RSS], options);
  assert.deepEqual(presented.items.map((item) => item.articleKey), [URL, URL]);
  assert.equal(presented.exposureStates[URL].read, true);
  const aliasEvent = await restarted.recordEvents([event('api-replay', ID)]);
  assert.equal(aliasEvent.exposureStates[ID].read, true);
  assert.equal(aliasEvent.exposureStates[ID].exposureCount, 0);
  assert.equal(Object.keys((await disk(file)).articles).length, 1);
});

test('API-first exposure persists its URL alias for RSS fallback after restart', async (t) => {
  const file = await fixture(t);
  const store = new ReadStateStore({ file });
  await store.present([API], options);
  await store.recordEvents([event('api-first')]);
  assert.deepEqual((await disk(file)).articles[ID].aliases, [URL]);
  const restarted = new ReadStateStore({ file });
  const fallback = await restarted.present([RSS], options);
  assert.equal(fallback.items[0].articleKey, ID);
  assert.equal(fallback.exposureStates[ID].exposureCount, 1);
  const oldUrl = await restarted.recordEvents([event('old-rss-client', URL)], { readAfterExposures: 2 });
  assert.equal(oldUrl.exposureStates[URL].read, true);
  assert.equal(oldUrl.exposureStates[URL].exposureCount, 2);
  assert.equal((await new ReadStateStore({ file }).present([RSS], { source: SOURCE })).items.length, 0);
});

test('successful read-only replay updates lastShownAt without recounting or clearing readAt', async (t) => {
  const file = await fixture(t);
  let now = Date.parse(early);
  const store = new ReadStateStore({ file, now: () => now });
  await store.present([API], options);
  const read = await store.recordEvents([event('initial')], { readAfterExposures: 1 });
  now = Date.parse(later);
  const replay = await store.recordEvents([event('replay', URL)]);
  assert.deepEqual(replay.exposureStates[URL], { ...read.exposureStates[ID], lastShownAt: later });
  now = Date.parse(latest);
  const retry = await store.recordEvents([event('replay', URL)]);
  assert.equal(retry.accepted, 0);
  assert.equal(retry.duplicates, 1);
  assert.equal(retry.readVersion, replay.readVersion);
  assert.equal(retry.exposureStates[URL].lastShownAt, later);
  const restored = await new ReadStateStore({ file }).present([RSS], options);
  assert.deepEqual(restored.exposureStates[ID], replay.exposureStates[URL]);
});

test('aliases do not loosen event-ID conflict semantics, including a mixed atomic batch', async (t) => {
  const file = await fixture(t);
  const store = new ReadStateStore({ file });
  await store.present([API], options);
  await store.recordEvents([event('original')]);
  const original = await readFile(file, 'utf8');
  await assert.rejects(store.recordEvents([event('original', URL)]), { statusCode: 409 });
  await assert.rejects(store.recordEvents([event('new-url', URL), event('original', ID, 'open')]), { statusCode: 409 });
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await store.recordEvents([event('original')])).duplicates, 1);
  assert.equal((await store.recordEvents([event('new-url', URL)])).exposureStates[URL].exposureCount, 2);
});

test('legacy duplicate records merge read OR, max count and date extrema without rewriting events', async (t) => {
  const file = await fixture(t);
  const log = [event('legacy-id'), event('legacy-url', URL, 'manual')];
  await seed(file, {
    [ID]: record({ exposureCount: 4, lastShownAt: latest, updatedAt: latest }),
    [URL]: record({ exposureCount: 2, firstReadAt: early, lastReadAt: later, readReason: 'manual', lastShownAt: early }),
  }, log);
  const store = new ReadStateStore({ file });
  // RSS is encountered first; a later API candidate must update its earlier view.
  const presented = await store.present([RSS, API], options);
  assert.deepEqual(presented.items.map((item) => item.articleKey), [ID, ID]);
  assert.deepEqual(presented.exposureStates[ID], {
    read: true, exposureCount: 4, readAt: later, readReason: 'manual', lastShownAt: latest,
  });
  const merged = await disk(file);
  assert.equal(merged.version, 1);
  assert.equal(merged.revision, 8);
  assert.equal(merged.articles[ID].firstReadAt, early);
  assert.deepEqual(merged.articles[ID].aliases, [URL]);
  assert.deepEqual(merged.eventLog, log);
  assert.equal((await store.recordEvents([event('legacy-url', URL, 'manual')])).duplicates, 1);
  assert.equal((await store.present([API], options)).readVersion, 8);
});

test('overlapping persisted aliases merge transitively and retain the latest read reason', async (t) => {
  const file = await fixture(t);
  const otherId = articleKeysFor({ ...RSS, newscopeId: 43 }, SOURCE)[0];
  await seed(file, {
    [URL]: record({ aliases: [ID], exposureCount: 2, firstReadAt: early, lastReadAt: early, readReason: 'open' }),
    [otherId]: record({ aliases: [ID], exposureCount: 3, firstReadAt: later, lastReadAt: latest, readReason: 'manual' }),
  });
  const store = new ReadStateStore({ file });
  const result = await store.recordEvents([event('transitive', ID)]);
  assert.equal(result.exposureStates[ID].readAt, latest);
  assert.equal(result.exposureStates[ID].readReason, 'manual');
  assert.equal(result.exposureStates[ID].exposureCount, 3);
  const persisted = await disk(file);
  assert.deepEqual(Object.keys(persisted.articles), [URL]);
  assert.equal(persisted.articles[URL].firstReadAt, early);
  assert.deepEqual(new Set(persisted.articles[URL].aliases), new Set([ID, otherId]));
});

test('concurrent stores resolve hinted identities against the locked latest disk state', async (t) => {
  const file = await fixture(t);
  const api = new ReadStateStore({ file });
  const rss = new ReadStateStore({ file });
  await api.present([API], options);
  await rss.recordEvents([event('rss-before-api', URL)]);
  await Promise.all([
    api.recordEvents([event('api-after-rss')], { readAfterExposures: 100 }),
    rss.recordEvents([event('rss-race', URL)], { readAfterExposures: 100 }),
    new ReadStateStore({ file }).present([API], options),
  ]);
  const restored = await new ReadStateStore({ file }).present([RSS, API], options);
  assert.deepEqual(restored.items.map((item) => item.articleKey), [URL, URL]);
  assert.equal(restored.exposureStates[URL].exposureCount, 3);
  const persisted = await disk(file);
  assert.deepEqual(Object.keys(persisted.articles), [URL]);
  assert.deepEqual(persisted.articles[URL].aliases, [ID]);
  assert.equal(persisted.eventLog.length, 3);
});

for (const failure of ['write', 'rename', 'lost-response']) {
  test('alias-only present handles ' + failure + ' without fake confirmation', async (t) => {
    const file = await fixture(t);
    await new ReadStateStore({ file }).recordEvents([event('old-read', URL, 'manual')]);
    let fail = true;
    const store = new ReadStateStore({
      file,
      writeFile: async (...args) => {
        if (fail && failure === 'write') throw new Error('injected write');
        return writeFile(...args);
      },
      rename: async (...args) => {
        if (fail && failure === 'rename') throw new Error('injected rename');
        await rename(...args);
        if (fail && failure === 'lost-response') throw new Error('injected lost-response');
      },
    });
    const before = await disk(file);
    await assert.rejects(store.present([API], options), /injected/);
    assert.deepEqual(store.state.articles[URL].aliases, []);
    assert.equal(store.identities.size, 0);
    if (failure !== 'lost-response') assert.deepEqual(await disk(file), before);
    fail = false;
    const retry = await store.present([API], options);
    assert.equal(retry.readVersion, before.revision + 1);
    assert.equal(retry.items[0].articleKey, URL);
    assert.equal(retry.exposureStates[URL].read, true);
    const restored = await new ReadStateStore({ file }).present([RSS], options);
    assert.equal(restored.exposureStates[URL].read, true);
    assert.deepEqual((await disk(file)).articles[URL].aliases, [ID]);
  });
}

test('failed first event does not publish a hinted alias or read acknowledgment', async (t) => {
  const file = await fixture(t);
  let fail = true;
  const store = new ReadStateStore({ file, writeFile: async (...args) => {
    if (fail) throw new Error('injected first-write');
    return writeFile(...args);
  } });
  await store.present([API], options);
  await assert.rejects(store.recordEvents([event('first')], { readAfterExposures: 1 }), /injected/);
  assert.deepEqual(store.state.articles, {});
  assert.equal((await store.present([API], options)).exposureStates[ID].read, false);
  fail = false;
  const retry = await store.recordEvents([event('first')], { readAfterExposures: 1 });
  assert.equal(retry.accepted, 1);
  assert.equal(retry.exposureStates[ID].read, true);
  assert.deepEqual((await disk(file)).articles[ID].aliases, [URL]);
});

test('10000 record/event bounds remain enforced while aliases consume no record slot', async (t) => {
  const file = await fixture(t);
  const prefix = ID.slice(0, ID.lastIndexOf(':') + 1);
  const articles = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [prefix + (i + 1), record()]));
  const log = Array.from({ length: 10_000 }, (_, i) => event('bounded-' + i));
  await seed(file, articles, log);
  const store = new ReadStateStore({ file });
  await store.present([API], options);
  const before = await readFile(file, 'utf8');
  await assert.rejects(store.recordEvents([event('overflow', prefix + 10001)]), /article limit/);
  assert.equal(await readFile(file, 'utf8'), before);
  await store.recordEvents([event('known-alias', URL)]);
  const persisted = await disk(file);
  assert.equal(Object.keys(persisted.articles).length, 10_000);
  assert.equal(persisted.eventLog.length, 10_000);
  assert.equal(persisted.eventLog[0].eventId, 'bounded-1');
  assert.deepEqual(persisted.eventLog.at(-1), event('known-alias', URL));
  assert.equal((await new ReadStateStore({ file }).present([RSS], options)).exposureStates[ID].exposureCount, 1);
});

test('a full 10000-candidate inventory retains first-event URL identity hints without persisting unread rows', async (t) => {
  const file = await fixture(t);
  const store = new ReadStateStore({ file });
  const candidates = Array.from({ length: 10_000 }, (_, i) => ({
    newscopeId: i + 1, url: 'https://publisher.example/inventory/' + i,
  }));
  const [firstId, firstUrl] = articleKeysFor(candidates[0], SOURCE);
  const result = await store.present(candidates, options);
  assert.equal(result.items.length, 10_000);
  assert.equal(result.readVersion, 0);
  assert.deepEqual(store.state.articles, {});
  await store.recordEvents([event('first-of-full-inventory', firstId)]);
  const persisted = await disk(file);
  assert.deepEqual(Object.keys(persisted.articles), [firstId]);
  assert.deepEqual(persisted.articles[firstId].aliases, [firstUrl]);
  const fallback = await new ReadStateStore({ file }).present([{ url: candidates[0].url }], options);
  assert.equal(fallback.items[0].articleKey, firstId);
  assert.equal(fallback.exposureStates[firstId].exposureCount, 1);
});

test('memory-only presentation and immediately queued events share identity hints', async () => {
  const store = new ReadStateStore();
  const presenting = store.present([API], options);
  const recording = store.recordEvents([event('queued')]);
  await presenting;
  assert.equal((await recording).exposureStates[ID].exposureCount, 1);
  assert.deepEqual(store.state.articles[ID].aliases, [URL]);
  assert.equal((await store.present([RSS], options)).items[0].articleKey, ID);
});

test('alias overflow fails atomically rather than dropping historical keys', async (t) => {
  const file = await fixture(t);
  const prefix = ID.slice(0, ID.lastIndexOf(':') + 1);
  const aliases = Array.from({ length: 8 }, (_, i) => prefix + (i + 100));
  await seed(file, { [ID]: record({ aliases, firstReadAt: early, lastReadAt: early, readReason: 'manual' }) });
  const before = await readFile(file, 'utf8');
  const store = new ReadStateStore({ file });
  await assert.rejects(store.present([API], options), /alias limit/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.deepEqual(store.state.articles[ID].aliases, aliases);
});
