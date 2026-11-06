import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveConfig } from '../lib/config.js';
import { queryNewscopeHtml } from '../lib/newscope-html.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const BIG_ID = '9223372036854775807';
const [CARD, PAGE, EMPTY] = await Promise.all(['html-card.html', 'html-page.html', 'html-empty.html'].map((name) => readFile(new URL('./fixtures/' + name, import.meta.url), 'utf8')));
const config = resolveConfig({ newscopeUrl: 'https://newscope.test/prefix/', minScore: 5, maxAgeHours: 48 });
function card({ id = '1', age = 2, score = '8.5', title, url } = {}) {
  let html = CARD.replaceAll(BIG_ID, String(id))
    .replaceAll('2026-11-05T10:00:00Z', new Date(NOW - age * 3600000).toISOString().replace('.000Z', 'Z'))
    .replace('data-score="8.5"', 'data-score="' + score + '"')
    .replaceAll('https://example.com/story?a=1&amp;b=2', url ?? 'https://example.com/story/' + id);
  if (title !== undefined) html = html.replaceAll('Chip&#39;s &quot;future&quot; &amp; science &#x2014; &hellip;', title);
  return html;
}
function page(cards, current = 1, totalPages = 1, nextUrl = '/articles?page=' + (current + 1)) {
  const total = totalPages > 1 ? 1000 : cards.length;
  // pagination.html emits an empty #pagination for zero/one total pages.
  const pagination = totalPages > 1
    ? '<div class="pagination-info">Showing ' + cards.length + ' of ' + total + ' articles (Page ' + current + ' of ' + totalPages + ')</div>'
      + '<div class="pagination-controls"><span class="pagination-btn current">' + current + '</span>'
      + (current < totalPages ? '<a class="pagination-btn" title="Next page" href="' + nextUrl + '" hx-get="' + nextUrl + '">▶</a>' : '') + '</div>'
    : '';
  return PAGE.replace('{{COUNT}}', cards.length).replace('{{TOTAL}}', total).replace('{{CARDS}}', cards.join('')).replace('{{PAGINATION}}', pagination);
}
const response = (html, init = {}) => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
function mock(pages) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['HX-Request'], 'true');
    assert.equal(new URL(url).origin, 'https://newscope.test');
    assert.equal(new URL(url).pathname, '/prefix/articles');
    const entry = pages[calls.length - 1];
    assert.notEqual(entry, undefined, 'unexpected extra page fetch');
    return typeof entry === 'function' ? entry(url, options) : typeof entry === 'string' ? response(entry) : entry;
  };
  return { calls, fetch };
}
const run = (fetch, options = {}, filters = config) => queryNewscopeHtml(fetch, filters, { now: NOW, ...options });

test('original HTMX pages scan beyond RSS 100 with safe constructed GETs', async () => {
  const cards = Array.from({ length: 125 }, (_, i) => card({ id: String(i + 1), age: 1 + i / 10 }));
  const io = mock([page(cards.slice(0, 60), 1, 3, 'https://evil.test/steal'), page(cards.slice(60, 120), 2, 3), page(cards.slice(120), 3, 3)]);
  const result = await run(io.fetch);
  assert.equal(result.articles.length, 125);
  assert.equal(result.pages, 3);
  assert.equal(result.coverage, 'window-scanned');
  assert.equal(result.truncated, false);
  assert.equal(result.stopReason, 'end-of-list');
  assert.deepEqual(result.warnings, []);
  for (const [i, call] of io.calls.entries()) {
    assert.deepEqual([...new URL(call.url).searchParams], [['score', '5'], ['sort', 'published'], ['page', String(i + 1)]]);
  }
});

test('HTML uses score=2 (RSS uses min_score), and enforces low L2 score locally', async () => {
  const io = mock([page([card({ id: '1', score: '2' }), card({ id: '2', score: '1.9' })])]);
  const result = await run(io.fetch, {}, { ...config, minScore: 2 });
  assert.equal(new URL(io.calls[0].url).searchParams.get('score'), '2');
  assert.equal(new URL(io.calls[0].url).searchParams.has('min_score'), false);
  assert.deepEqual(result.articles.map((a) => a.id), ['1']);
  const zero = await run(mock([page([card({ score: '0' })])]).fetch, {}, { ...config, minScore: 0 });
  assert.equal(zero.articles.length, 1);
});

test('strict int64 identity, decoded entities and shared metadata model without bodies', async () => {
  const result = await run(mock([page([CARD])]).fetch);
  const article = result.articles[0];
  assert.equal(article.newscopeId, BIG_ID);
  assert.equal(article.id, BIG_ID);
  assert.equal(typeof article.newscopeId, 'string');
  assert.match(article.articleKey, new RegExp(':' + BIG_ID + '$'));
  assert.equal(article.title, 'Chip\'s "future" & science — …');
  assert.equal(article.url, 'https://example.com/story?a=1&b=2');
  assert.equal(article.source, 'Research & News');
  assert.deepEqual(article.topics, ['AI & Science']);
  assert.equal(article.publishedAt, '2026-11-05T10:00:00.000Z');
  assert.equal(article.score, 8.5);
  assert.equal(article.category, 'technology');
  assert.doesNotMatch(JSON.stringify(result), /BODY_MUST|EXPLANATION_MUST|article-summary|hx-post/);
  assert.deepEqual(Object.keys(article).sort(), ['articleKey', 'category', 'guid', 'id', 'newscopeId', 'publishedAt', 'score', 'source', 'title', 'topics', 'url'].sort());
});

test('original active feedback is metadata-only and conflicting states fail closed', async () => {
  const liked = card({ id: BIG_ID })
    .replace('btn-like-small"', 'btn-like-small active"')
    .replace('btn-like"', 'btn-like active"');
  const result = await run(mock([page([liked])]).fetch);
  assert.equal(result.articles[0].feedback, 'like');
  assert.equal(result.articles[0].newscopeId, BIG_ID);
  assert.doesNotMatch(JSON.stringify(result), /hx-post|article-card/);

  const conflicting = card({ id: BIG_ID })
    .replace('btn-like-small"', 'btn-like-small active"')
    .replace('btn-dislike"', 'btn-dislike active"');
  await assert.rejects(run(mock([page([conflicting])]).fetch), /conflicting feedback state/);
});

test('entities are decoded once from HTML, literal entity text is preserved', async () => {
  const result = await run(mock([page([card({ title: 'Literal &amp;#39; &amp;amp; &lt;b&gt; &bogus;' })])]).fetch);
  assert.equal(result.articles[0].title, 'Literal &#39; &amp; <b> &bogus;');
});

test('stops at inclusive age boundary without fetching later pages', async () => {
  const io = mock([page([card({ id: '1', age: 2 }), card({ id: '2', age: 48 }), card({ id: '3', age: 49 })], 1, 5)]);
  const result = await run(io.fetch);
  assert.equal(result.stopReason, 'window-boundary');
  assert.equal(result.coverage, 'window-scanned');
  assert.deepEqual(result.articles.map((a) => a.id), ['1', '2']);
  assert.equal(io.calls.length, 1);
});

test('genuine original empty state is successful; arbitrary empty/login pages throw', async () => {
  const result = await run(mock([EMPTY]).fetch);
  assert.deepEqual(result, { articles: [], coverage: 'window-scanned', truncated: false, pages: 1, stopReason: 'end-of-list', warnings: [] });
  for (const html of ['', '<html><form action="/login"><input type="password"></form></html>', '<p class="no-articles">No articles found.</p>', EMPTY.replace('no-articles', 'unknown'), EMPTY.replace('(0/0)', '(1/1)')]) {
    await assert.rejects(run(mock([html]).fetch), /Newscope HTML/);
  }
});

test('full articles.html wrapper is accepted as well as HX fragments', async () => {
  const html = '<!DOCTYPE html><html><head><title>Articles - Newscope</title></head><body><div id="articles-with-pagination">' + page([card()]) + '</div></body></html>';
  assert.equal((await run(mock([html]).fetch)).articles.length, 1);
});

for (const [label, transform] of [
  ['missing card ID', (html) => html.replace('id="content-1"', 'id="content-missing"')],
  ['conflicting card IDs', (html) => html.replace('/feedback/1/like', '/feedback/2/like')],
  ['overflow int64', (html) => html.replaceAll('9223372036854775807', '9223372036854775808')],
  ['score junk', (html) => html.replace('data-score="8.5"', 'data-score="8.5oops"')],
  ['score Infinity', (html) => html.replace('data-score="8.5"', 'data-score="Infinity"')],
  ['score >10', (html) => html.replace('data-score="8.5"', 'data-score="10.01"')],
  ['missing score', (html) => html.replace('data-score="8.5"', '')],
  ['invalid calendar date', (html) => html.replaceAll('2026-11-05T10:00:00Z', '2026-02-30T10:00:00Z')],
  ['natural-language date', (html) => html.replaceAll('2026-11-05T10:00:00Z', 'Nov 5 2026')],
  ['invalid time zone', (html) => html.replaceAll('2026-11-05T10:00:00Z', '2026-11-05T10:00:00+24:00')],
  ['unsafe URL', (html) => html.replaceAll('https://example.com/story/1', 'javascript:alert(1)')],
  ['relative URL', (html) => html.replaceAll('https://example.com/story/1', '/story/1')],
  ['URL credentials', (html) => html.replaceAll('https://example.com/story/1', 'https://user:pass@example.com/story/1')],
  ['URL whitespace', (html) => html.replaceAll('https://example.com/story/1', 'https://example.com/a b')],
  ['truncated HTML', (html) => html.slice(0, html.lastIndexOf('</div>'))],
  ['bad pagination', (html) => html.replace('id="pagination"', 'id="unrecognized"')],
]) {
  test('first-page bad field/structure throws: ' + label, async () => {
    const base = label === 'overflow int64' ? page([CARD]) : page([card()]);
    await assert.rejects(run(mock([transform(base)]).fetch), /Newscope HTML/);
  });
}

test('timestamps with numeric timezone are normalized, future rows excluded', async () => {
  const html = page([card({ id: '2', age: -1 }), card({ id: '1' })]).replaceAll('2026-11-05T10:00:00Z', '2026-11-05T12:00:00+02:00');
  const result = await run(mock([html]).fetch);
  assert.deepEqual(result.articles.map((a) => a.id), ['1']);
  assert.equal(result.articles[0].publishedAt, '2026-11-05T10:00:00.000Z');
});

test('out-of-order cards are not falsely declared window-scanned', async () => {
  await assert.rejects(run(mock([page([card({ id: '1', age: 49 }), card({ id: '2', age: 2 })])]).fetch), /not sorted/);
});

test('overlapping offset pages deduplicate reliable IDs and canonical URLs', async () => {
  const io = mock([page([card({ id: '1', age: 1 }), card({ id: '2', age: 2 })], 1, 2), page([card({ id: '2', age: 2 }), card({ id: '3', age: 3, url: 'https://example.com/story/1?utm_source=duplicate' }), card({ id: '4', age: 4 })], 2, 2)]);
  const result = await run(io.fetch);
  assert.deepEqual(result.articles.map((a) => a.id), ['1', '2', '4']);
  assert.equal(result.coverage, 'window-scanned');
  assert.match(result.warnings.join(' '), /Overlapping/);
});

test('repeated pages stop partial even if page metadata changes', async () => {
  const io = mock([page([card()], 1, 3), page([card()], 2, 3)]);
  const result = await run(io.fetch);
  assert.equal(result.stopReason, 'repeated-page');
  assert.equal(result.coverage, 'partial');
  assert.equal(result.truncated, true);
  assert.equal(result.pages, 2);
  assert.equal(result.articles.length, 1);
  assert.ok(result.warnings.length);
});

test('different page with no new identities stops partial', async () => {
  const io = mock([page([card({ id: '1' }), card({ id: '2' })], 1, 3), page([card({ id: '2' }), card({ id: '1' })], 2, 3)]);
  assert.equal((await run(io.fetch)).stopReason, 'no-progress');
});

test('max pages and max unique scanned items return partial without overfetching', async () => {
  const io = mock([page([card({ id: '1' })], 1, 3)]);
  assert.equal((await run(io.fetch, { maxPages: 1 })).stopReason, 'max-pages');
  const limited = await run(mock([page([card({ id: '1' }), card({ id: '2' }), card({ id: '3' })])]).fetch, { maxItems: 2 });
  assert.equal(limited.stopReason, 'max-items');
  assert.equal(limited.articles.length, 2);
  assert.equal(limited.coverage, 'partial');
  const low = await run(mock([page([card({ id: '1', score: '1' }), card({ id: '2', score: '1' }), card({ id: '3' })])]).fetch, { maxItems: 2 });
  assert.equal(low.stopReason, 'max-items');
  assert.equal(low.articles.length, 0);
});

test('page/aggregate streaming byte limits apply to UTF-8 bytes and cancel', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('一'.repeat(40))); }, cancel() { cancelled = true; } });
  await assert.rejects(run(mock([response(stream)]).fetch, { maxPageBytes: 100 }), (error) => error.code === 'max-page-bytes');
  assert.equal(cancelled, true);
  const first = page([card({ id: '1' })], 1, 2);
  const second = page([card({ id: '2' })], 2, 2);
  const result = await run(mock([first, second]).fetch, { maxTotalBytes: Buffer.byteLength(first) + 100 });
  assert.equal(result.stopReason, 'max-total-bytes');
  assert.equal(result.pages, 1);
  assert.equal(result.articles.length, 1);
  assert.ok(result.warnings.length);
  await assert.rejects(run(mock([response(EMPTY, { headers: { 'content-type': 'text/html', 'content-length': '1000000' } })]).fetch, { maxPageBytes: 100 }), /byte limit/);
});

test('bad first HTTP throws, later 503 retains already parsed rows with warning', async () => {
  await assert.rejects(run(mock([response('Unavailable', { status: 503 })]).fetch), /HTTP 503/);
  const result = await run(mock([page([card()], 1, 2), response('Unavailable', { status: 503 })]).fetch);
  assert.equal(result.stopReason, 'http-error');
  assert.equal(result.coverage, 'partial');
  assert.equal(result.pages, 1);
  assert.equal(result.articles.length, 1);
  assert.match(result.warnings[0], /503/);
});

test('later unknown HTML/card failure preserves only earlier complete pages', async () => {
  for (const html of ['<html>Sign in</html>', page([card({ id: '2', score: 'NaN' })], 2, 2)]) {
    const result = await run(mock([page([card()], 1, 2), html]).fetch);
    assert.equal(result.stopReason, 'invalid-html');
    assert.equal(result.pages, 1);
    assert.equal(result.articles.length, 1);
    assert.ok(result.warnings.length);
  }
});

test('redirects and HTMX redirect headers never trigger another request', async () => {
  for (const redirect of [response('', { status: 302, headers: { location: 'https://evil.test/' } }), response(EMPTY, { headers: { 'hx-redirect': '/login' } }), response(EMPTY, { headers: { 'hx-location': '{"path":"/login"}' } })]) {
    const io = mock([redirect]);
    await assert.rejects(run(io.fetch), (error) => error.code === 'redirect');
    assert.equal(io.calls.length, 1);
  }
  const result = await run(mock([page([card()], 1, 2), response('', { status: 307, headers: { location: '/login' } })]).fetch);
  assert.equal(result.stopReason, 'redirect');
  assert.equal(result.coverage, 'partial');
});

test('total deadline cancels a hanging fetch even if fetch ignores AbortSignal', async () => {
  let requestSignal;
  await assert.rejects(run((_url, { signal }) => { requestSignal = signal; return new Promise(() => {}); }, { timeoutMs: 20 }), (error) => error.code === 'timeout');
  assert.equal(requestSignal.aborted, true);
});

test('total deadline also cancels an unending response body', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('<div>')); }, cancel() { cancelled = true; } });
  await assert.rejects(run(mock([response(body)]).fetch, { timeoutMs: 20 }), (error) => error.code === 'timeout');
  assert.equal(cancelled, true);
});

test('one deadline spans pages, and later timeout returns partial metadata', async () => {
  const started = Date.now();
  const first = page([card()], 1, 2);
  const io = mock([async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return response(first); }, () => new Promise(() => {})]);
  const result = await run(io.fetch, { timeoutMs: 70 });
  assert.equal(result.stopReason, 'timeout');
  assert.equal(result.pages, 1);
  assert.equal(result.articles.length, 1);
  assert.equal(result.coverage, 'partial');
  assert.ok(Date.now() - started < 1000);
});

test('external abort is merged with deadline for fetch and streamed body', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(run(() => assert.fail('must not fetch'), { signal: before.signal }), (error) => error.code === 'aborted');
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const promise = run(mock([response(body)]).fetch, { signal: controller.signal, timeoutMs: 1000 });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, (error) => error.code === 'aborted');
  assert.equal(cancelled, true);
});

test('scripts are inert and their text/body is never exported', async () => {
  const original = globalThis.__newscopeHtmlExecuted;
  const html = page([card()]).replace('</article>', '<script>globalThis.__newscopeHtmlExecuted = true</script></article>');
  assert.equal((await run(mock([html]).fetch)).articles.length, 1);
  assert.equal(globalThis.__newscopeHtmlExecuted, original);
});

test('base URL query/hash cannot leak into the articles request', async () => {
  const io = mock([EMPTY]);
  await run(io.fetch, {}, { ...config, newscopeUrl: 'https://newscope.test/prefix/?secret=discard#fragment' });
  assert.equal(io.calls[0].url, 'https://newscope.test/prefix/articles?score=5&sort=published&page=1');
  for (const newscopeUrl of ['file:///tmp/article', 'https://user:pass@newscope.test']) {
    await assert.rejects(run(() => assert.fail('must not fetch'), {}, { ...config, newscopeUrl }), /Invalid Newscope URL/);
  }
});

test('stock Go HX text/plain MIME accepts validated multi-page fragments and genuine empty state', async () => {
  // Verified on the unmodified 9c02bfa HTMX handler, isolated fixture port 8082:
  // its first fmt.Fprintf writes <span>, so net/http sniffs text/plain, not HTML.
  const plain = (html) => response(html, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const io = mock([plain(page([card({ id: '1', age: 1 })], 1, 2)), plain(page([card({ id: '2', age: 2 })], 2, 2))]);
  const result = await run(io.fetch);
  assert.equal(result.coverage, 'window-scanned');
  assert.equal(result.pages, 2);
  assert.deepEqual(result.articles.map((article) => article.id), ['1', '2']);
  assert.equal((await run(mock([plain(EMPTY)]).fetch)).stopReason, 'end-of-list');
});

test('accepting stock plain-text MIME does not accept login, error text, or broken cards', async () => {
  for (const html of ['Login required', '<form><input type="password"></form>', page([card({ score: 'invalid' })]), '']) {
    const plain = response(html, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    await assert.rejects(run(mock([plain]).fetch), (error) => error.code === 'invalid-html');
  }
});

test('MIME compatibility stays limited to text/html and stock text/plain', async () => {
  for (const contentType of ['application/json', 'application/octet-stream', 'application/xhtml+xml', 'text/csv', 'text/html-junk', 'text/plain-junk']) {
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(page([card()]))); }, cancel() { cancelled = true; } });
    const io = mock([response(body, { headers: { 'content-type': contentType } })]);
    await assert.rejects(run(io.fetch), /non-HTML response/);
    assert.equal(cancelled, true);
  }
});
