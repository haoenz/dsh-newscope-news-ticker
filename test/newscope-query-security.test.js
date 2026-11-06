import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../lib/config.js';
import { queryNewscope, queryNewscopeVersion } from '../lib/newscope-query.js';

// Pure fetch mocks only: no live Newscope, database, listener, or POST.
const NOW = Date.parse('2026-11-05T12:00:00Z');
const ENDPOINT = 'https://newscope.invalid/base';
const CONFIG = resolveConfig({ newscopeUrl: ENDPOINT });
const EMPTY_RSS = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Newscope</title><link>https://newscope.invalid/</link><description>News</description></channel></rss>';
const rssResponse = (body) => new Response(body, { headers: { 'content-type': 'application/rss+xml' } });
const query = (fetch, options = {}) => queryNewscope(fetch, CONFIG, { now: NOW, shouldSupplement: () => false, ...options });
function sequence(entries) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const entry = entries[calls.length - 1];
    assert.notEqual(entry, undefined, 'unexpected request/fallback');
    return typeof entry === 'function' ? entry(url, options) : entry;
  };
  return { calls, fetch };
}
function holdEventLoop(t) {
  // AbortSignal.timeout is unref'ed; a mock has no network socket to keep Node
  // alive. This handle belongs only to the test and is always cleared.
  const timer = setInterval(() => {}, 1000);
  t.after(() => clearInterval(timer));
}
const timedOut = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';

for (const [name, xml] of [
  ['nested rss under HTML', '<html><rss><channel/></rss></html>'],
  ['comment pretending to be rss', '<!-- <rss> --><html><body>Login</body></html>'],
  ['comment pretending to be Atom', '<!-- <feed> --><html><body>Login</body></html>'],
  ['unknown root', '<response><channel/></response>'],
  ['rss without channel', '<rss><title>Missing channel</title></rss>'],
  ['multiple channel elements', '<rss><channel/><channel/></rss>'],
  ['multiple roots', '<rss><channel/></rss><html/>'],
  ['text-only channel', '<rss><channel>Not an RSS channel</channel></rss>'],
  ['text-only Atom feed', '<feed>Not a feed</feed>'],
  ['malformed XML', '<rss><channel></rss>'],
]) {
  test('RSS validation rejects ' + name + ' instead of claiming empty inventory', async () => {
    const io = sequence([rssResponse(xml)]);
    let supplemented = false;
    await assert.rejects(query(io.fetch, { preferRss: true, shouldSupplement: () => { supplemented = true; return false; } }), /Invalid Newscope RSS/);
    assert.equal(io.calls.length, 1);
    assert.equal(supplemented, false);
  });
}

test('genuine empty Newscope RSS and empty channel remain valid', async () => {
  for (const xml of [EMPTY_RSS, '<rss><channel/></rss>', '<!-- harmless comment --><rss><channel></channel></rss>']) {
    const result = await query(sequence([rssResponse(xml)]).fetch, { preferRss: true });
    assert.deepEqual(result.articles, []);
    assert.equal(result.apiUnsupported, true);
    assert.equal(result.capabilities.source, 'rss');
    assert.equal(result.capabilities.remoteWindowComplete, false);
    assert.equal(result.capabilities.inventoryScope, 'known-local');
  }
});

test('Atom root is supported including namespace and genuine empty feed', async () => {
  for (const xml of ['<feed/>', '<feed xmlns="http://www.w3.org/2005/Atom"><title>Newscope</title></feed>']) {
    const result = await query(sequence([rssResponse(xml)]).fetch, { preferRss: true });
    assert.deepEqual(result.articles, []);
  }
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><title>Newscope</title><entry><id>story1</id><title>[8.5] An Atom story</title><link rel="alternate" href="https://example.invalid/story"/><published>2026-11-05T11:00:00Z</published></entry></feed>';
  const result = await query(sequence([rssResponse(atom)]).fetch, { preferRss: true });
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].title, 'An Atom story');
  assert.equal(result.articles[0].url, 'https://example.invalid/story');
});

for (const [name, xml] of [
  ['internal DTD', '<!DOCTYPE rss [<!ENTITY title "entity expansion">]><rss><channel><title>&title;</title></channel></rss>'],
  ['external DTD', '<!DOCTYPE rss SYSTEM "https://external.invalid/rss.dtd"><rss><channel/></rss>'],
  ['standalone entity declaration', '<!ENTITY title "secret"><rss><channel/></rss>'],
]) {
  test('RSS validation refuses ' + name, async () => {
    const io = sequence([rssResponse(xml)]);
    await assert.rejects(query(io.fetch, { preferRss: true }), /Invalid Newscope RSS/);
    assert.equal(io.calls.length, 1);
  });
}

for (const status of [401, 403, 429, 500, 503]) {
  test('API HTTP ' + status + ' is not downgraded to RSS/HTML', async () => {
    const io = sequence([new Response('Unavailable', { status })]);
    let supplemented = false;
    await assert.rejects(query(io.fetch, { shouldSupplement: () => { supplemented = true; return false; } }), new RegExp('HTTP ' + status));
    assert.equal(io.calls.length, 1);
    assert.equal(new URL(io.calls[0].url).pathname, '/base/api/v1/articles');
    assert.equal(supplemented, false);
  });
}

for (const status of [404, 405, 501]) {
  test('only first-page API HTTP ' + status + ' enables RSS fallback', async () => {
    let cancelled = false;
    const missing = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
    const io = sequence([missing, rssResponse(EMPTY_RSS)]);
    const result = await query(io.fetch);
    assert.deepEqual(io.calls.map(({ url }) => new URL(url).pathname), ['/base/api/v1/articles', '/base/rss']);
    assert.equal(result.apiUnsupported, true);
    assert.equal(result.capabilities.source, 'rss');
    assert.equal(cancelled, true);
  });
}

for (const status of [404, 405, 501]) {
  test('later-page API HTTP ' + status + ' remains a query failure, not unsupported capability', async () => {
    const first = Response.json({ items: [{ id: '2', title: 'Article', url: 'https://example.invalid/article', score: 8, publishedAt: '2026-11-05T11:00:00Z' }], nextCursor: 'next-page' });
    const io = sequence([first, new Response('Missing', { status })]);
    await assert.rejects(query(io.fetch), new RegExp('HTTP ' + status));
    assert.equal(io.calls.length, 2);
    assert.ok(io.calls.every(({ url }) => new URL(url).pathname === '/base/api/v1/articles'));
    assert.equal(new URL(io.calls[1].url).searchParams.get('cursor'), 'next-page');
  });
}

test('API malformed JSON is not treated as unsupported capability', async () => {
  const io = sequence([new Response('<html>Login</html>')]);
  await assert.rejects(query(io.fetch));
  assert.equal(io.calls.length, 1);
});

test('successful empty API does not probe RSS or claim unsupported API', async () => {
  const io = sequence([Response.json({ items: [], nextCursor: null })]);
  const result = await query(io.fetch);
  assert.equal(io.calls.length, 1);
  assert.equal(result.apiUnsupported, undefined);
  assert.equal(result.capabilities.remoteWindowComplete, true);
});

test('API deadline stops hanging fetch without RSS fallback', async (t) => {
  holdEventLoop(t);
  let signal;
  const io = sequence([(_url, options) => { signal = options.signal; return new Promise(() => {}); }]);
  await assert.rejects(query(io.fetch, { deadlineMs: 20 }), timedOut);
  assert.equal(signal.aborted, true);
  assert.equal(io.calls.length, 1);
});

test('RSS deadline cancels hanging body instead of treating it as empty', async (t) => {
  holdEventLoop(t);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('<rss>')); }, cancel() { cancelled = true; } });
  await assert.rejects(query(sequence([rssResponse(stream)]).fetch, { preferRss: true, deadlineMs: 20 }), timedOut);
  assert.equal(cancelled, true);
});

test('version lookup uses bounded read-only GET and truncates version text', async () => {
  const io = sequence([Response.json({ version: 'x'.repeat(300), ignored: true })]);
  const version = await queryNewscopeVersion(io.fetch, ENDPOINT);
  assert.equal(version, 'x'.repeat(200));
  assert.equal(io.calls[0].url, ENDPOINT + '/api/v1/status');
  assert.equal(io.calls[0].options.headers.accept, 'application/json');
});

test('version lookup rejects redirect at fetch policy and never follows Location', async () => {
  const nativePolicy = sequence([() => { throw new TypeError('fetch failed: redirect mode is error'); }]);
  await assert.rejects(queryNewscopeVersion(nativePolicy.fetch, ENDPOINT), /redirect/);
  assert.equal(nativePolicy.calls.length, 1);
  let cancelled = false;
  const returnedRedirect = sequence([new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { location: 'https://external.invalid/status' } })]);
  assert.equal(await queryNewscopeVersion(returnedRedirect.fetch, ENDPOINT), undefined);
  assert.equal(returnedRedirect.calls.length, 1);
  assert.equal(cancelled, true);
});

test('version lookup rejects declared over-limit body and cancels without reading JSON', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const io = sequence([new Response(stream, { headers: { 'content-length': String(32 * 1024 + 1) } })]);
  await assert.rejects(queryNewscopeVersion(io.fetch, ENDPOINT), /too large/);
  assert.equal(cancelled, true);
});

test('version lookup caps an endless stream by actual bytes and cancels it', async () => {
  let cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(4096).fill(32)); }, cancel() { cancelled = true; } });
  await assert.rejects(queryNewscopeVersion(sequence([new Response(stream)]).fetch, ENDPOINT), /too large/);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 11, 'bounded read must stop after crossing 32 KiB');
});

test('version byte ceiling is UTF-8 bytes, not characters', async () => {
  const body = JSON.stringify({ version: '一'.repeat(12000) });
  assert.ok(body.length < 32 * 1024);
  assert.ok(Buffer.byteLength(body) > 32 * 1024);
  await assert.rejects(queryNewscopeVersion(sequence([new Response(body)]).fetch, ENDPOINT), /too large/);
});

test('version handles non-string, malformed and unsuccessful responses safely', async () => {
  for (const value of [null, {}, { version: 123 }]) {
    assert.equal(await queryNewscopeVersion(sequence([Response.json(value)]).fetch, ENDPOINT), undefined);
  }
  await assert.rejects(queryNewscopeVersion(sequence([new Response('<html>Login</html>')]).fetch, ENDPOINT));
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
  assert.equal(await queryNewscopeVersion(sequence([response]).fetch, ENDPOINT), undefined);
  assert.equal(cancelled, true);
});

test('version timeout bounds fetch even when an injected fetch ignores signal', async (t) => {
  holdEventLoop(t);
  let signal;
  const io = sequence([(_url, options) => { signal = options.signal; return new Promise(() => {}); }]);
  await assert.rejects(queryNewscopeVersion(io.fetch, ENDPOINT, { timeoutMs: 20 }), timedOut);
  assert.equal(signal.aborted, true);
  assert.equal(io.calls.length, 1);
});

test('version timeout includes streamed body and does not await hung cancellation', async (t) => {
  holdEventLoop(t);
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"version":"')); }, cancel() { cancelled = true; return new Promise(() => {}); } });
  await assert.rejects(queryNewscopeVersion(sequence([new Response(body)]).fetch, ENDPOINT, { timeoutMs: 20 }), timedOut);
  assert.equal(cancelled, true);
});

test('unsupported capability callback records real first-page probes before RSS succeeds or fails', async () => {
  for (const status of [404, 405, 501]) {
    for (const rssStatus of [200, 503]) {
      let probes = 0;
      const io = sequence([
        new Response('', { status }),
        () => {
          assert.equal(probes, 1, 'unsupported capability must be recorded before RSS starts');
          return rssStatus === 200 ? rssResponse(EMPTY_RSS) : new Response('', { status: rssStatus });
        },
      ]);
      const pending = query(io.fetch, { onApiUnsupported: () => { probes++; } });
      if (rssStatus === 200) assert.equal((await pending).apiUnsupported, true);
      else await assert.rejects(pending, /RSS returned HTTP 503/);
      assert.equal(probes, 1, 'RSS failure must not erase or repeat the observed probe');
    }
  }
});

test('preferRss skips capability probe callback even across an existing TTL expiry', async () => {
  let clock = NOW;
  let expiry = NOW + 1;
  let probes = 0;
  const io = sequence([() => { clock += 2; return rssResponse(EMPTY_RSS); }]);
  const result = await query(io.fetch, {
    preferRss: expiry > clock,
    onApiUnsupported: () => { probes++; expiry = clock + 15 * 60000; },
  });
  assert.equal(result.apiUnsupported, true, 'RSS mode identifies source, not a new capability observation');
  assert.equal(probes, 0);
  assert.equal(expiry, NOW + 1, 'cached RSS must not renew API unsupported TTL');
  assert.ok(clock > expiry);
  assert.equal(new URL(io.calls[0].url).pathname, '/base/rss');
});

test('auth, server errors and non-head unsupported responses never call capability callback', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    let probes = 0;
    await assert.rejects(query(sequence([new Response('', { status })]).fetch, { onApiUnsupported: () => { probes++; } }));
    assert.equal(probes, 0);
  }
  for (const status of [404, 405, 501]) {
    let probes = 0;
    const first = Response.json({ items: [{ id: '2', title: 'Article', url: 'https://example.invalid/article', score: 8, publishedAt: '2026-11-05T11:00:00Z' }], nextCursor: 'next' });
    await assert.rejects(query(sequence([first, new Response('', { status })]).fetch, { onApiUnsupported: () => { probes++; } }));
    assert.equal(probes, 0);
  }
});

test('base search/hash are cleared before constructing API, RSS and version URLs', async () => {
  const config = resolveConfig({ ...CONFIG, newscopeUrl: ENDPOINT + '/?token=discard#fragment' });
  const io = sequence([new Response('', { status: 404 }), rssResponse(EMPTY_RSS)]);
  const result = await queryNewscope(io.fetch, config, { now: NOW, shouldSupplement: () => false });
  assert.equal(result.endpoint, ENDPOINT);
  assert.deepEqual(io.calls.map(({ url }) => new URL(url).pathname), ['/base/api/v1/articles', '/base/rss']);
  for (const { url } of io.calls) {
    assert.equal(new URL(url).hash, '');
    assert.equal(new URL(url).searchParams.has('token'), false);
  }
  const status = sequence([Response.json({ version: '1.0' })]);
  await queryNewscopeVersion(status.fetch, result.endpoint);
  assert.equal(status.calls[0].url, ENDPOINT + '/api/v1/status');
});

for (const [name, patch] of [
  ['non-numeric score', { score: 'NaN' }],
  ['numeric string score', { score: '8' }],
  ['null score', { score: null }],
  ['negative score', { score: -1 }],
  ['out-of-range score', { score: 10.1 }],
  ['missing title', { title: undefined }],
  ['blank title', { title: '   ' }],
  ['entity-only blank title', { title: '&nbsp;' }],
  ['unsafe URL', { url: 'javascript:alert(1)' }],
  ['relative URL', { url: '/relative' }],
  ['URL credentials', { url: 'https://user:pass@example.invalid/item' }],
]) {
  test('invalid API ' + name + ' cannot silently become a complete empty window', async () => {
    const row = { id: '1', title: 'Article', url: 'https://example.invalid/article', score: 8, publishedAt: '2026-11-05T11:00:00Z', ...patch };
    const io = sequence([Response.json({ items: [row], nextCursor: null })]);
    let probes = 0;
    await assert.rejects(query(io.fetch, { onApiUnsupported: () => { probes++; } }), /Invalid Newscope metadata fields/);
    assert.equal(io.calls.length, 1);
    assert.equal(probes, 0);
  });
}

test('L2 score below five is sent unchanged to API and RSS min_score', async () => {
  const config = resolveConfig({ ...CONFIG, minScore: 2 });
  const io = sequence([new Response('', { status: 404 }), rssResponse(EMPTY_RSS)]);
  await queryNewscope(io.fetch, config, { now: NOW, shouldSupplement: () => false });
  assert.deepEqual(io.calls.map(({ url }) => new URL(url).searchParams.get('min_score')), ['2', '2']);
  assert.ok(io.calls.every(({ url }) => !new URL(url).searchParams.has('score')));
});
