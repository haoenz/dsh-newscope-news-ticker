import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFile as fsWriteFile, rename as fsRename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { articleKeyFor, articleKeysFor } from '../lib/article-identity.js';
import { ReadStateStore } from '../lib/read-state.js';
import { apply, NewsCache, READ_EVENTS_ROUTE } from '../lib/index.js';

const SOURCE = 'http://127.0.0.1:8080';
const ARTICLE = {
  id: 'guid-one', title: 'Example', url: 'https://example.com/news?id=1',
  score: 8.8, publishedAt: new Date().toISOString(), topics: ['Technology'], category: 'technology',
};
const KEY = articleKeyFor(ARTICLE, SOURCE);
const exposure = (eventId, articleKey = KEY) => ({ type: 'exposure', eventId, articleKey });

async function stateFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'newscope-read-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'read-state.json');
}

function successFetch(counter, xml) {
  return async (url) => {
    counter.calls.push(url);
    if (url.includes('/api/v1/articles?')) return new Response(null, { status: 404 });
    if (url.includes('/api/v1/status')) return Response.json({ status: 'ok', version: 'test' });
    return new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  };
}

const xml = `<?xml version="1.0"?><rss><channel><item>
<title>[8.8] Example</title><link>https://example.com/news?id=1</link><guid>guid-one</guid>
<description>Score: 8.8/10</description><pubDate>${new Date().toUTCString()}</pubDate><category>Technology</category>
</item></channel></rss>`;

test('article keys survive translation and URL tracking changes but isolate Newscope instances', () => {
  const other = articleKeyFor({ ...ARTICLE, title: '已翻译标题', score: 1 }, SOURCE);
  assert.equal(other, KEY);
  const reordered = articleKeyFor({ ...ARTICLE, url: 'https://example.com/news?utm_source=x&id=1#top' }, SOURCE);
  assert.equal(reordered, KEY);
  const queryOrder = articleKeyFor({ ...ARTICLE, url: 'https://example.com/news?id=1&utm_medium=email' }, SOURCE);
  assert.equal(queryOrder, KEY);
  assert.notEqual(articleKeyFor(ARTICLE, 'http://other-newscope:8080'), KEY);
  assert.notEqual(articleKeyFor({ ...ARTICLE, url: 'https://example.com/news?id=2' }, SOURCE), KEY);
  assert.equal(articleKeyFor(ARTICLE, 'http://127.0.0.1:8080/'), KEY);
  const keys = articleKeysFor({ ...ARTICLE, newscopeId: 42 }, SOURCE);
  assert.match(keys[0], /^newscope:/);
  assert.equal(keys[1], KEY);
});

test('exposure count and read state persist across instances with idempotent retries', async (t) => {
  const file = await stateFile(t);
  const first = new ReadStateStore({ file });
  const initial = await first.recordEvents([exposure('event-1'), exposure('event-2')]);
  assert.equal(initial.accepted, 2);
  assert.equal(initial.exposureStates[KEY].exposureCount, 2);
  assert.equal(initial.exposureStates[KEY].read, false);

  const beforeRead = await first.present([ARTICLE], { source: SOURCE });
  assert.equal(beforeRead.items.length, 1);
  assert.equal(beforeRead.exposureStates[KEY].exposureCount, 2);

  const restarted = new ReadStateStore({ file });
  const third = await restarted.recordEvents([exposure('event-3')]);
  assert.equal(third.exposureStates[KEY].exposureCount, 3);
  assert.equal(third.exposureStates[KEY].read, true);
  assert.equal(third.exposureStates[KEY].readReason, 'exposure');

  const afterRestart = new ReadStateStore({ file });
  const filtered = await afterRestart.present([ARTICLE], { source: SOURCE });
  assert.equal(filtered.items.length, 0);
  const revision = filtered.readVersion;
  const duplicate = await afterRestart.recordEvents([exposure('event-3')]);
  assert.equal(duplicate.accepted, 0);
  assert.equal(duplicate.duplicates, 1);
  assert.equal(duplicate.readVersion, revision);
  assert.equal(duplicate.exposureStates[KEY].exposureCount, 3);

  await assert.rejects(
    afterRestart.recordEvents([{ type: 'open', eventId: 'event-3', articleKey: KEY }]),
    (error) => error.statusCode === 409,
  );
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.revision, revision);
  assert.equal(persisted.eventLog.length, 3);
});

test('batch duplicates are atomic and open is an optional immediate read signal', async (t) => {
  const file = await stateFile(t);
  const store = new ReadStateStore({ file });
  const batch = await store.recordEvents([exposure('same-event'), exposure('same-event')]);
  assert.equal(batch.accepted, 1);
  assert.equal(batch.duplicates, 1);
  assert.equal(batch.exposureStates[KEY].exposureCount, 1);

  const opened = await store.recordEvents([{ type: 'open', eventId: 'opened', articleKey: KEY }]);
  assert.equal(opened.exposureStates[KEY].read, true);
  assert.equal(opened.exposureStates[KEY].readReason, 'open');
  assert.equal(opened.exposureStates[KEY].exposureCount, 1);
  const filtered = await store.present([ARTICLE], { source: SOURCE });
  assert.equal(filtered.items.length, 0);
});

test('two stores serialize writes without losing events or double-counting retries', async (t) => {
  const file = await stateFile(t);
  const left = new ReadStateStore({ file });
  const right = new ReadStateStore({ file });
  const events = Array.from({ length: 20 }, (_, index) => exposure(`concurrent-${index}`));
  await Promise.all(events.map((event, index) => (index % 2 ? left : right).recordEvents([event], { readAfterExposures: 100 })));

  const duplicate = exposure('concurrent-0');
  await Promise.all([left.recordEvents([duplicate], { readAfterExposures: 100 }), right.recordEvents([duplicate], { readAfterExposures: 100 })]);
  const restarted = new ReadStateStore({ file });
  const presented = await restarted.present([ARTICLE], { source: SOURCE });
  assert.equal(presented.exposureStates[KEY].exposureCount, 20);
  assert.equal(presented.readVersion, 20);
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.eventLog.length, 20);
});

test('write and rename failures never create fake read state and lost responses retry safely', async (t) => {
  const file = await stateFile(t);
  let failWrite = false;
  let failRename = false;
  let commitThenFail = false;
  const store = new ReadStateStore({
    file,
    writeFile: async (...args) => {
      if (failWrite) throw new Error('injected write failure');
      return fsWriteFile(...args);
    },
    rename: async (...args) => {
      if (commitThenFail) {
        await fsRename(...args);
        throw new Error('injected lost response');
      }
      if (failRename) throw new Error('injected rename failure');
      return fsRename(...args);
    },
  });
  await store.recordEvents([exposure('event-1')]);
  const originalDisk = await readFile(file, 'utf8');

  failWrite = true;
  await assert.rejects(store.recordEvents([exposure('event-2')]), /injected write failure/);
  failWrite = false;
  let presented = await store.present([ARTICLE], { source: SOURCE });
  assert.equal(presented.exposureStates[KEY].exposureCount, 1);
  assert.equal(await readFile(file, 'utf8'), originalDisk);

  failRename = true;
  await assert.rejects(store.recordEvents([exposure('event-2')]), /injected rename failure/);
  failRename = false;
  presented = await store.present([ARTICLE], { source: SOURCE });
  assert.equal(presented.exposureStates[KEY].exposureCount, 1);
  assert.equal(await readFile(file, 'utf8'), originalDisk);

  commitThenFail = true;
  await assert.rejects(store.recordEvents([exposure('event-2')]), /injected lost response/);
  commitThenFail = false;
  const retry = await store.recordEvents([exposure('event-2')]);
  assert.equal(retry.accepted, 0);
  assert.equal(retry.duplicates, 1);
  assert.equal(retry.exposureStates[KEY].exposureCount, 2);
  assert.equal(retry.exposureStates[KEY].read, false);
});

test('damaged persistent state fails closed instead of rebuilding an empty history', async (t) => {
  const file = await stateFile(t);
  await writeFile(file, '{"version":1,"revision":0,"articles":', 'utf8');
  const store = new ReadStateStore({ file });
  await assert.rejects(store.present([ARTICLE], { source: SOURCE }), /damaged or unreadable/);

  const counter = { calls: [] };
  const cache = new NewsCache(successFetch(counter, xml), { readState: store });
  const snapshot = await cache.snapshot({});
  assert.equal(snapshot.service, 'read-state-unavailable');
  assert.equal(snapshot.items.length, 0);
  assert.equal(snapshot.readVersion, null);
  assert.match(snapshot.error, /damaged or unreadable/);

  await writeFile(file, JSON.stringify({
    version: 1, revision: 0,
    articles: { [KEY]: { exposureCount: -1 } }, eventLog: [],
  }), 'utf8');
  const invalidSchema = new ReadStateStore({ file });
  await assert.rejects(invalidSchema.present([ARTICLE], { source: SOURCE }), /damaged or unreadable/);
});

test('NewsCache keeps read truth and explicitly labels known-local replay without source fetches', async (t) => {
  const file = await stateFile(t);
  const readState = new ReadStateStore({ file });
  const counter = { calls: [] };
  let fail = false;
  const cache = new NewsCache(async (url) => {
    if (fail) throw new Error('offline');
    return successFetch(counter, xml)(url);
  }, { readState });

  const first = await cache.snapshot({});
  const key = first.items[0].articleKey;
  assert.equal(key, KEY);
  assert.equal(first.exposureStates[key].exposureCount, 0);
  await readState.recordEvents([exposure('snapshot-1', key), exposure('snapshot-2', key)]);
  const second = await cache.snapshot({});
  assert.equal(second.items.length, 1);
  assert.equal(second.exposureStates[key].exposureCount, 2);

  await readState.recordEvents([exposure('snapshot-3', key)]);
  const third = await cache.snapshot({});
  assert.equal(third.items.length, 1);
  assert.equal(third.items[0].replay, true);
  assert.equal(third.exposureStates[key].read, true);
  assert.equal(third.capabilities.inventoryScope, 'known-local');
  assert.equal(third.service, 'ok');
  cache.cache.fetchedAt = Date.now() - 600_000;
  fail = true;
  const stale = await cache.snapshot({});
  assert.equal(stale.service, 'cache');
  assert.equal(stale.items.length, 1);
  assert.equal(stale.items[0].replay, true);
  assert.equal(stale.exposureStates[key].exposureCount, 3);
  assert.equal(counter.calls.some((url) => /\/feeds(?:\/|\?)/.test(url)), false);
});

function routeHarness(readState) {
  const registrations = [];
  const ctx = {
    llm: {}, agentDefaultModel: { currentSelection: () => ({}) },
    effect(fn) { return fn(); },
    webServer: { register(options) { registrations.push(options); return () => {}; } },
  };
  apply(ctx, {}, { readState });
  return registrations.find((entry) => entry.path === READ_EVENTS_ROUTE);
}

function request(body, { method = 'POST', headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = method;
  req.headers = {
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    host: '127.0.0.1:3080',
    ...headers,
  };
  return req;
}

function response() {
  return {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

test('read-events route validates method, origin, content type, JSON and body size', async (t) => {
  const file = await stateFile(t);
  const route = routeHarness(new ReadStateStore({ file }));

  let res = response();
  await route.handler(request(undefined, { method: 'GET' }), res);
  assert.equal(res.status, 405);

  res = response();
  await route.handler(request('{}', { headers: { 'content-type': 'text/plain' } }), res);
  assert.equal(res.status, 415);

  res = response();
  await route.handler(request('{}', { headers: { 'sec-fetch-site': 'cross-site' } }), res);
  assert.equal(res.status, 403);

  res = response();
  await route.handler(request('{}', { headers: { origin: 'https://evil.example' } }), res);
  assert.equal(res.status, 403);

  res = response();
  await route.handler(request('{bad json'), res);
  assert.equal(res.status, 400);

  res = response();
  await route.handler(request('{}'), res);
  assert.equal(res.status, 400);

  res = response();
  await route.handler(request(Buffer.alloc(64 * 1024 + 1)), res);
  assert.equal(res.status, 413);

  const tooMany = Array.from({ length: 101 }, (_, index) => exposure(`overflow-${index}`));
  res = response();
  await route.handler(request(JSON.stringify({ events: tooMany })), res);
  assert.equal(res.status, 400);

  const persisted = await readFile(file, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.equal(persisted, null);
});

test('read-events route commits batches idempotently and reports event conflicts', async (t) => {
  const file = await stateFile(t);
  const route = routeHarness(new ReadStateStore({ file }));
  const body = JSON.stringify({ events: [exposure('http-1'), exposure('http-2')] });
  let res = response();
  await route.handler(request(body), res);
  assert.equal(res.status, 200);
  let payload = JSON.parse(res.body);
  assert.equal(payload.accepted, 2);
  assert.equal(payload.exposureStates[KEY].exposureCount, 2);

  res = response();
  await route.handler(request(body, { headers: { origin: 'http://127.0.0.1:3080' } }), res);
  assert.equal(res.status, 200);
  payload = JSON.parse(res.body);
  assert.equal(payload.accepted, 0);
  assert.equal(payload.duplicates, 2);
  assert.equal(payload.exposureStates[KEY].exposureCount, 2);

  res = response();
  await route.handler(request(JSON.stringify({ events: [{ type: 'open', eventId: 'http-1', articleKey: KEY }] })), res);
  assert.equal(res.status, 409);
  const restarted = new ReadStateStore({ file });
  const presented = await restarted.present([ARTICLE], { source: SOURCE });
  assert.equal(presented.exposureStates[KEY].exposureCount, 2);
  assert.equal(presented.items.length, 1);
});
