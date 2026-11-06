import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { apply, FEEDBACK_ROUTE } from '../lib/index.js';
import { articleKeyFor } from '../lib/article-identity.js';
import { CandidateStore } from '../lib/candidate-store.js';
import { resolveConfig } from '../lib/config.js';
import { normalizeFeedbackRequest, submitNewscopeFeedback } from '../lib/feedback.js';
import { ReadStateStore } from '../lib/read-state.js';

const SOURCE = 'https://newscope.test/base/';
const config = resolveConfig({ newscopeUrl: SOURCE });
const article = (id = '1') => ({
  id, newscopeId: id, title: 'Article ' + id, url: 'https://news.test/' + id,
  score: 8, publishedAt: new Date().toISOString(), topics: [], source: 'News',
});
const keyFor = (id = '1') => articleKeyFor(article(id), SOURCE);

async function storeWith(value = article()) {
  const candidateStore = new CandidateStore();
  await candidateStore.merge(SOURCE, [value]);
  return candidateStore;
}

const accepted = () => new Response('<article>upstream HTML must stay private</article>', {
  status: 200, headers: { 'content-type': 'text/html' },
});

function request(body, { method = 'POST', headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = method;
  req.headers = {
    'content-type': 'application/json', 'sec-fetch-site': 'same-origin', host: '127.0.0.1:3080', ...headers,
  };
  return req;
}

function response() {
  return {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

function feedbackRoute(candidateStore, fetch, readState = new ReadStateStore({ file: null })) {
  const registrations = [];
  const ctx = {
    llm: {}, agentDefaultModel: { currentSelection: () => ({}) },
    effect(fn) { return fn(); },
    webServer: { register(options) { registrations.push(options); return () => {}; } },
  };
  apply(ctx, { newscopeUrl: SOURCE }, { candidateStore, fetch, readState });
  const route = registrations.find((entry) => entry.path === FEEDBACK_ROUTE);
  route.readState = readState;
  return route;
}

test('feedback resolves stable identity, avoids same-action duplicates and persists changes', async () => {
  const candidateStore = await storeWith();
  const calls = [];
  const fetch = async (url, options) => { calls.push({ url, options }); return accepted(); };
  const input = { articleKey: keyFor(), action: 'like' };
  const first = await submitNewscopeFeedback({ fetch, candidateStore, config, input });
  assert.deepEqual(first, { ok: true, articleKey: keyFor(), action: 'like', duplicate: false, statePersisted: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://newscope.test/base/api/v1/feedback/1/like');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.accept, 'text/html');
  assert.equal((await candidateStore.snapshot(SOURCE)).articles[0].feedback, 'like');

  const duplicate = await submitNewscopeFeedback({ fetch, candidateStore, config, input });
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls.length, 1, 'same current feedback must not adjust the native score twice');
  const changed = await submitNewscopeFeedback({ fetch, candidateStore, config,
    input: { articleKey: keyFor(), action: 'dislike' } });
  assert.equal(changed.duplicate, false);
  assert.equal(calls[1].url.endsWith('/1/dislike'), true);
  assert.equal((await candidateStore.snapshot(SOURCE)).articles[0].feedback, 'dislike');
});

test('feedback rejects malformed, unknown and RSS-only targets without remote writes', async () => {
  for (const value of [null, [], {}, { articleKey: keyFor() }, { articleKey: keyFor(), action: 'save' },
    { articleKey: 'newscope:bad:1', action: 'like' }, { articleKey: keyFor(), action: 'like', newscopeId: '999' }]) {
    assert.throws(() => normalizeFeedbackRequest(value), (error) => error.statusCode === 400);
  }
  let calls = 0;
  const fetch = async () => { calls++; return accepted(); };
  const candidateStore = await storeWith();
  await assert.rejects(submitNewscopeFeedback({ fetch, candidateStore, config,
    input: { articleKey: keyFor('999'), action: 'like' } }), (error) => error.statusCode === 404);
  const rssOnly = new CandidateStore();
  const rss = article('2');
  delete rss.newscopeId;
  rss.id = 'rss-guid';
  await rssOnly.merge(SOURCE, [rss]);
  await assert.rejects(submitNewscopeFeedback({ fetch, candidateStore: rssOnly, config,
    input: { articleKey: articleKeyFor(rss, SOURCE), action: 'like' } }), (error) => error.statusCode === 422);
  assert.equal(calls, 0);
});

test('upstream failure and timeout never persist success locally', async () => {
  const candidateStore = await storeWith();
  const input = { articleKey: keyFor(), action: 'like' };
  await assert.rejects(submitNewscopeFeedback({ fetch: async () => new Response('no', { status: 500 }),
    candidateStore, config, input }), (error) => error.statusCode === 502);
  await assert.rejects(submitNewscopeFeedback({ fetch: async () => { throw new Error('offline'); },
    candidateStore, config, input }), (error) => error.statusCode === 502);
  await assert.rejects(submitNewscopeFeedback({ fetch: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), candidateStore, config, input, timeoutMs: 10 }), (error) => error.statusCode === 504);
  assert.equal((await candidateStore.snapshot(SOURCE)).articles[0].feedback, undefined);
});

test('remote acceptance with local persistence failure is acknowledged without a retryable error', async () => {
  const candidateStore = await storeWith();
  candidateStore.recordFeedback = async () => { throw new Error('disk full'); };
  let calls = 0;
  const result = await submitNewscopeFeedback({ fetch: async () => { calls++; return accepted(); },
    candidateStore, config, input: { articleKey: keyFor(), action: 'like' } });
  assert.equal(result.ok, true);
  assert.equal(result.statePersisted, false);
  assert.equal(result.duplicate, false);
  assert.equal(calls, 1);
});

test('feedback route enforces same-origin JSON and bounded validated input', async () => {
  const candidateStore = await storeWith();
  let calls = 0;
  const route = feedbackRoute(candidateStore, async () => { calls++; return accepted(); });
  const cases = [
    [undefined, { method: 'GET' }, 405],
    ['{}', { headers: { 'content-type': 'text/plain' } }, 415],
    ['{}', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    ['{}', { headers: { origin: 'https://evil.example' } }, 403],
    ['{bad json', {}, 400],
    ['{}', {}, 400],
    ['x'.repeat(4097), {}, 413],
  ];
  for (const [body, options, status] of cases) {
    const res = response();
    await route.handler(request(body, options), res);
    assert.equal(res.status, status);
  }
  assert.equal(calls, 0);
});


test('feedback route persists manual read immediately with zero exposures and stable duplicate IDs', async () => {
  const candidateStore = await storeWith();
  const readState = new ReadStateStore({ file: null });
  let calls = 0;
  const route = feedbackRoute(candidateStore, async () => { calls++; return accepted(); }, readState);
  const body = JSON.stringify({ articleKey: keyFor(), action: 'like' });
  let res = response();
  await route.handler(request(body), res);
  let payload = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(payload.readPersisted, true);
  assert.equal(payload.readVersion, 1);
  assert.deepEqual(payload.exposureStates[keyFor()], {
    read: true, readAt: payload.exposureStates[keyFor()].readAt, exposureCount: 0, readReason: 'manual', lastShownAt: null,
  });
  assert.ok(payload.exposureStates[keyFor()].readAt);

  res = response();
  await route.handler(request(body), res);
  payload = JSON.parse(res.body);
  assert.equal(payload.duplicate, true);
  assert.equal(payload.readVersion, 1, 'same feedback event remains idempotent');
  assert.equal(calls, 1);

  res = response();
  await route.handler(request(JSON.stringify({ articleKey: keyFor(), action: 'dislike' })), res);
  payload = JSON.parse(res.body);
  assert.equal(payload.readVersion, 2);
  assert.equal(payload.exposureStates[keyFor()].read, true);
  assert.equal(payload.exposureStates[keyFor()].exposureCount, 0);
  assert.equal(payload.exposureStates[keyFor()].readReason, 'manual');
  assert.equal(calls, 2);
});

test('failed upstream or read-state persistence never fabricates a confirmed read', async () => {
  const candidateStore = await storeWith();
  const readState = new ReadStateStore({ file: null });
  const failedRoute = feedbackRoute(candidateStore, async () => new Response('no', { status: 500 }), readState);
  let res = response();
  await failedRoute.handler(request(JSON.stringify({ articleKey: keyFor(), action: 'like' })), res);
  assert.equal(res.status, 502);
  assert.equal(JSON.parse(res.body).readPersisted, undefined);

  const acceptedRoute = feedbackRoute(candidateStore, async () => accepted(), readState);
  readState.recordEvents = async () => { throw new Error('read state unavailable'); };
  res = response();
  await acceptedRoute.handler(request(JSON.stringify({ articleKey: keyFor(), action: 'like' })), res);
  const payload = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.readPersisted, false);
  assert.equal(payload.exposureStates, undefined);
});

test('feedback route serializes concurrent duplicate clicks and never exposes upstream HTML', async () => {
  const candidateStore = await storeWith();
  let release;
  let announce;
  const started = new Promise((resolve) => { announce = resolve; });
  let calls = 0;
  const route = feedbackRoute(candidateStore, async () => {
    calls++;
    announce();
    return new Promise((resolve) => { release = resolve; });
  });
  const body = JSON.stringify({ articleKey: keyFor(), action: 'like' });
  const firstResponse = response();
  const secondResponse = response();
  const first = route.handler(request(body), firstResponse);
  await started;
  const second = route.handler(request(body), secondResponse);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'concurrent clicks share one upstream write per article queue');
  release(accepted());
  await Promise.all([first, second]);
  const payloads = [firstResponse, secondResponse].map((res) => {
    assert.equal(res.status, 200);
    assert.equal(res.body.includes('upstream HTML'), false);
    return JSON.parse(res.body);
  });
  assert.ok(payloads.every((item) => item.ok && item.action === 'like'));
  assert.equal((await candidateStore.snapshot(SOURCE)).articles[0].feedback, 'like');
});
