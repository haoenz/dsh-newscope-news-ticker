import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, NewsCache, MODELS_ROUTE } from '../lib/index.js';

const xml = `<?xml version="1.0"?><rss><channel><item>
<title>[8.8] Example</title><link>https://example.com/news</link><guid>one</guid>
<description>Score: 8.8/10</description><pubDate>${new Date().toUTCString()}</pubDate><category>Technology</category>
</item></channel></rss>`;

function successFetch(counter) {
  return async (url) => {
    counter.calls.push(url);
    if (url.includes('/api/v1/articles?')) return new Response(null, { status: 404 });
    if (url.includes('/api/v1/status')) return Response.json({ status: 'ok', version: 'test' });
    return new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  };
}

test('host cache refreshes once, reuses fresh data and schedules without another fetch', async () => {
  const counter = { calls: [] };
  const cache = new NewsCache(successFetch(counter));
  const first = await cache.snapshot({ refreshMinutes: 5 });
  const second = await cache.snapshot({ refreshMinutes: 5, weights: { finance: 0, technology: 100, science: 0, general: 0 } });
  assert.equal(first.service, 'ok');
  assert.equal(first.items[0].url, 'https://example.com/news');
  assert.equal(second.items[0].id, 'one');
  assert.equal(counter.calls.filter((url) => url.includes('/rss?')).length, 1);
});

test('failed refresh serves the last good host cache', async () => {
  const counter = { calls: [] };
  let fail = false;
  const cache = new NewsCache(async (url) => {
    counter.calls.push(url);
    if (fail) throw new Error('offline');
    return successFetch(counter)(url);
  });
  await cache.snapshot({ refreshMinutes: 5 });
  cache.cache.fetchedAt = Date.now() - 600000;
  fail = true;
  const snapshot = await cache.snapshot({ refreshMinutes: 5 });
  assert.equal(snapshot.service, 'cache');
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.items.length, 1);
});

test('unavailable Newscope without cache returns an empty graceful payload', async () => {
  const cache = new NewsCache(async () => { throw new Error('offline at http://127.0.0.1:9'); });
  const snapshot = await cache.snapshot({});
  assert.equal(snapshot.service, 'unavailable');
  assert.deepEqual(snapshot.items, []);
  assert.doesNotMatch(snapshot.error, /127\.0\.0\.1/);
});

test('models route exposes the DSH catalog through the Host without credentials', async () => {
  const registrations = [];
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'kt', name: 'KT' }],
      listModels: async (provider) => {
        assert.equal(provider, 'kt');
        return [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }];
      },
      resolveModelInfo: async () => ({}),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'kt', model: 'deepseek-flash' }) },
    effect(fn) { return fn(); },
    webServer: { register(options) { registrations.push(options); return () => {}; } },
  };
  apply(ctx);
  const route = registrations.find((entry) => entry.path === MODELS_ROUTE);
  assert.ok(route);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
  await route.handler(req, res);
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.deepEqual(payload.default, { provider: 'kt', model: 'deepseek-flash' });
  assert.equal(payload.groups[0].id, 'kt');
  assert.equal(payload.groups[0].models[0].name, 'DeepSeek Flash');
  assert.equal('apiKey' in payload, false);
});

test('disabled ticker performs no Newscope requests', async () => {
  let calls = 0;
  const cache = new NewsCache(async () => { calls++; throw new Error('unexpected'); });
  const snapshot = await cache.snapshot({ enabled: false });
  assert.equal(snapshot.service, 'disabled');
  assert.equal(calls, 0);
});
