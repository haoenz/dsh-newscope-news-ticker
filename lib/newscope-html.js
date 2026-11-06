import { parse } from 'parse5';
import { parseNewscopeMetadata } from './news.js';
import { normalizeArticleUrl } from './article-identity.js';

// Read-only compatibility with the original src/server/htmx_handlers.go,
// templates/{article-card,articles,pagination}.html. This is deliberately not a
// generic scraper: unknown/login/truncated pages must not masquerade as empty.
const EMPTY_TEXT = 'No articles found. Try lowering the score filter or wait for classification to run.';
const attr = (node, name) => node?.attrs?.find((item) => item.name === name)?.value;
const hasClass = (node, name) => (attr(node, 'class') || '').split(/\s+/).includes(name);
function descendants(root, predicate) {
  const found = [];
  const stack = [...(root?.childNodes || [])].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (predicate(node)) found.push(node);
    // Template/script contents are never metadata, nor are they executed.
    if (!['script', 'style', 'template'].includes(node.tagName)) {
      for (let i = (node.childNodes?.length || 0) - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
  }
  return found;
}
function text(node) {
  return descendants(node, (child) => child.nodeName === '#text').map((child) => child.value).join('').trim();
}
function fail(code, message) {
  const error = new Error('Newscope HTML: ' + message);
  error.code = code;
  return error;
}
function invalid(message) { throw fail('invalid-html', message); }
function one(nodes, description) {
  if (nodes.length !== 1) invalid('missing or ambiguous ' + description);
  return nodes[0];
}
function closed(node) {
  if (!node?.sourceCodeLocation?.endTag) invalid('incomplete HTML element');
  return node;
}
function timestamp(value) {
  // Go's Published.Format("2006-01-02T15:04:05Z07:00"), not Date.parse's
  // permissive natural-language dates or normalization of impossible days.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(value || '');
  if (!m) invalid('invalid card date');
  const [, y, month, day, hour, minute, second, zone] = m;
  const year = Number(y);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (+month < 1 || +month > 12 || +day < 1 || +day > days[+month - 1]
      || +hour > 23 || +minute > 59 || +second > 59
      || (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) invalid('invalid card date');
  const result = Date.parse(value);
  if (!Number.isFinite(result)) invalid('invalid card date');
  return result;
}
function cardRow(card) {
  closed(card);
  const scoreText = attr(card, 'data-score') || '';
  if (!/^\d+(?:\.\d+)?$/.test(scoreText) || +scoreText > 10) invalid('invalid card score');
  const content = one(descendants(card, (n) => n.tagName === 'div' && /^content-[1-9]\d{0,18}$/.test(attr(n, 'id') || '')), 'card identity');
  const id = attr(content, 'id').slice(8);
  // ID is never converted to Number: the upstream database uses int64.
  if (BigInt(id) > 9223372036854775807n) invalid('card identity exceeds int64');
  const feedback = descendants(card, (n) => n.tagName === 'button' && hasClass(n, 'btn-feedback'));
  if (!feedback.length || feedback.some((n) => !new RegExp('^/api/v1/feedback/' + id + '/(?:like|dislike)$').test(attr(n, 'hx-post') || ''))) invalid('inconsistent card identity');
  let feedbackState;
  for (const button of feedback) {
    const action = /(?:like|dislike)$/.exec(attr(button, 'hx-post') || '')?.[0];
    if (!hasClass(button, 'active')) continue;
    if (feedbackState && feedbackState !== action) invalid('conflicting feedback state');
    feedbackState = action;
  }
  const header = one(descendants(card, (n) => hasClass(n, 'article-header')), 'expanded card header');
  const h3 = one(descendants(header, (n) => n.tagName === 'h3'), 'card title');
  const link = one(descendants(h3, (n) => n.tagName === 'a'), 'card link');
  const title = text(link);
  const href = attr(link, 'href') || '';
  // Reject URL parser repairs (relative URLs, whitespace, backslashes), unsafe
  // protocols and credentials before applying the shared URL normalization.
  const url = /^https?:\/\//i.test(href) && !/[\s\\\u0000-\u001f\u007f]/u.test(href) ? normalizeArticleUrl(href) : null;
  if (!title || !url) invalid('invalid card title or URL');
  const time = one(descendants(header, (n) => n.tagName === 'time'), 'card date');
  const publishedAt = new Date(timestamp(attr(time, 'datetime'))).toISOString();
  const feed = one(descendants(header, (n) => hasClass(n, 'feed-name')), 'card feed');
  const topics = descendants(card, (n) => hasClass(n, 'topic-tag')).map((n) => attr(n, 'data-topic') ?? text(n));
  // parse5 already decoded entities. Protect literal ampersands from the shared
  // metadata parser's single decode, preserving the browser-visible title.
  return { id, title: title.replace(/&/g, '&amp;'), url, score: +scoreText, publishedAt, topics, feed: { title: text(feed) },
    ...(feedbackState ? { feedback: feedbackState } : {}) };
}
function parsePage(html) {
  const errors = [];
  const root = parse(html, { sourceCodeLocationInfo: true, onParseError: (error) => {
    // Fragments omit doctype; unknown/literal entity spellings are harmless
    // text, not broken page structure. parse5 still decodes them as a browser.
    if (!['missing-doctype', 'unknown-named-character-reference', 'missing-semicolon-after-character-reference'].includes(error.code)) errors.push(error);
  } });
  if (errors.length) invalid('malformed HTML');
  if (descendants(root, (n) => n.tagName === 'input' && (attr(n, 'type') || '').toLowerCase() === 'password').length) invalid('login page');
  const container = closed(one(descendants(root, (n) => attr(n, 'id') === 'articles-container'), 'articles container'));
  const list = closed(one(descendants(container, (n) => attr(n, 'id') === 'articles-list'), 'articles list'));
  const pagination = closed(one(descendants(root, (n) => attr(n, 'id') === 'pagination' && hasClass(n, 'pagination')), 'pagination'));
  const count = one(descendants(root, (n) => attr(n, 'id') === 'article-count'), 'article count');
  const countMatch = /^\((\d+)\/(\d+)\)$/.exec(text(count));
  const cards = descendants(list, (n) => n.tagName === 'article' && hasClass(n, 'article-card'));
  if (!countMatch || +countMatch[1] !== cards.length) invalid('inconsistent article count');
  const empty = descendants(list, (n) => n.tagName === 'p' && hasClass(n, 'no-articles'));
  if ((!cards.length && (empty.length !== 1 || text(empty[0]) !== EMPTY_TEXT)) || (cards.length && empty.length)) invalid('unknown empty state');
  const rows = cards.map(cardRow);
  for (let i = 1; i < rows.length; i++) {
    if (Date.parse(rows[i].publishedAt) > Date.parse(rows[i - 1].publishedAt)) invalid('cards not sorted by published date');
  }
  const infos = descendants(pagination, (n) => hasClass(n, 'pagination-info'));
  let currentPage = null;
  let hasNext = false;
  if (infos.length) {
    const info = one(infos, 'pagination info');
    const m = /^Showing (\d+) of (\d+) articles \(Page (\d+) of (\d+)\)$/.exec(text(info).replace(/\s+/g, ' '));
    if (!m || +m[1] !== rows.length || +m[2] !== +countMatch[2]
        || !Number.isSafeInteger(+m[3]) || +m[3] < 1 || !Number.isSafeInteger(+m[4]) || +m[4] < 2) invalid('invalid pagination info');
    currentPage = +m[3];
    hasNext = currentPage < +m[4];
    const next = descendants(pagination, (n) => n.tagName === 'a' && attr(n, 'title') === 'Next page');
    if (next.length !== (hasNext ? 1 : 0)) invalid('inconsistent next-page control');
  } else if (text(pagination) || descendants(pagination, (n) => !!n.tagName).length) invalid('unknown pagination structure');
  return { rows, currentPage, hasNext };
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
function cancelBody(response) { try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* already locked */ } }
async function readBody(response, signal, maxPageBytes, remainingBytes) {
  const ceiling = Math.min(maxPageBytes, remainingBytes);
  const code = remainingBytes < maxPageBytes ? 'max-total-bytes' : 'max-page-bytes';
  const declared = response.headers?.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > ceiling) {
    cancelBody(response);
    throw fail(code, 'response byte limit exceeded');
  }
  const reader = response.body?.getReader();
  if (!reader) throw fail('invalid-html', 'missing response body');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > ceiling) throw fail(code, 'response byte limit exceeded');
      chunks.push(Buffer.from(value));
    }
    let html;
    try { html = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw fail('invalid-html', 'invalid UTF-8 response'); }
    return { html, bytes };
  } catch (error) {
    // Do not await cancellation: a broken stream must not defeat the deadline.
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* closed */ }
    throw error;
  } finally { reader.releaseLock(); }
}

/**
 * Scan original Newscope HTML with caller-supplied widest L2 filters. pages is
 * the number of fully parsed/validated responses (including a repeated page).
 * window-scanned means an observed boundary/end, NOT a consistent snapshot:
 * concurrent inserts/deletes can shift offset pages and cause unseen omissions.
 * A bad first page throws; subsequent failures retain earlier metadata as partial.
 * No summary, description, explanation, or extracted article body is retained.
 */
export async function queryNewscopeHtml(fetchImpl, config, {
  now = Date.now(), signal, maxPages = 20, maxItems = 2000,
  maxPageBytes = 1048576, maxTotalBytes = 8388608, timeoutMs = 8000,
} = {}) {
  const base = new URL(config.newscopeUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid Newscope URL');
  if (!Number.isFinite(now) || !Number.isFinite(config.minScore) || config.minScore < 0 || config.minScore > 10
      || !Number.isFinite(config.maxAgeHours) || config.maxAgeHours <= 0) throw new Error('Invalid Newscope HTML filters');
  for (const value of [maxPages, maxItems, maxPageBytes, maxTotalBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Newscope HTML limit');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('Invalid Newscope HTML timeout');
  base.search = '';
  base.hash = '';
  base.pathname = base.pathname.replace(/\/+$/, '') + '/articles';
  const controller = new AbortController();
  const externalAbort = () => controller.abort(fail('aborted', 'query aborted'));
  if (signal?.aborted) externalAbort();
  else signal?.addEventListener('abort', externalAbort, { once: true });
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(fail('timeout', 'total deadline exceeded')), timeoutMs);
  const checkDeadline = () => {
    if (Date.now() >= deadline && !controller.signal.aborted) controller.abort(fail('timeout', 'total deadline exceeded'));
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  const rows = [];
  const ids = new Set();
  const urls = new Set();
  const signatures = new Set();
  const warnings = [];
  let pages = 0;
  let bytes = 0;
  const cutoff = now - config.maxAgeHours * 3600000;
  const finish = (stopReason, complete = false) => ({
    articles: parseNewscopeMetadata(rows, config, now), coverage: complete ? 'window-scanned' : 'partial',
    truncated: !complete, pages, stopReason, warnings,
  });
  try {
    for (let page = 1; page <= maxPages; page++) {
      checkDeadline();
      if (ids.size >= maxItems) return finish('max-items');
      if (bytes >= maxTotalBytes) return finish('max-total-bytes');
      base.search = new URLSearchParams({ score: String(config.minScore), sort: 'published', page: String(page) }).toString();
      let parsed;
      try {
        const pending = Promise.resolve(fetchImpl(base.href, {
          method: 'GET', headers: { 'HX-Request': 'true', accept: 'text/html' },
          redirect: 'manual', signal: controller.signal,
        }));
        // Even an injected fetch that ignores AbortSignal cannot hold the scan
        // open, and its eventual unread response is cancelled after timeout.
        pending.then((response) => { if (controller.signal.aborted) cancelBody(response); }, () => {});
        const response = await abortable(pending, controller.signal);
        if (response.redirected || (response.status >= 300 && response.status < 400)
            || response.type === 'opaqueredirect' || response.headers?.get('hx-redirect') || response.headers?.get('hx-location')) {
          cancelBody(response);
          throw fail('redirect', 'redirect refused');
        }
        if (!response.ok) { cancelBody(response); throw fail('http-error', 'HTTP ' + response.status); }
        const contentType = response.headers?.get('content-type');
        // Stock Go HTMX starts by writing <span id="article-count"> without
        // setting Content-Type (htmx_handlers.go:251-268). net/http's sniffing
        // classifies that fragment as text/plain; accept precisely these two
        // media types, then require the same strict Newscope DOM/field checks.
        if (contentType && !/^text\/(?:html|plain)(?:\s*;|$)/i.test(contentType)) { cancelBody(response); throw fail('invalid-html', 'non-HTML response'); }
        const body = await readBody(response, controller.signal, maxPageBytes, maxTotalBytes - bytes);
        bytes += body.bytes;
        checkDeadline();
        parsed = parsePage(body.html);
        checkDeadline();
      } catch (error) {
        if (!pages) throw error;
        const reason = controller.signal.aborted ? controller.signal.reason.code : error.code || 'network-error';
        warnings.push('Page ' + page + ': ' + (error.code ? error.message : 'response could not be read or parsed'));
        return finish(reason);
      }
      if (page === 1 && parsed.currentPage !== null && parsed.currentPage !== page) invalid('unexpected page number');
      pages++;
      const signature = parsed.rows.map((row) => row.id).join(',');
      if (parsed.rows.length && signatures.has(signature)) {
        warnings.push('Repeated article page; offset pagination did not advance.');
        return finish('repeated-page');
      }
      signatures.add(signature);
      if (parsed.currentPage !== null && parsed.currentPage !== page) {
        warnings.push('Unexpected page number; offset pagination did not advance.');
        return finish('no-progress');
      }
      let progress = 0;
      let boundary = false;
      let overlap = false;
      for (const row of parsed.rows) {
        const published = Date.parse(row.publishedAt);
        if (published < cutoff) { boundary = true; break; }
        if (ids.has(row.id)) { overlap = true; continue; }
        if (ids.size >= maxItems) return finish('max-items');
        ids.add(row.id);
        progress++;
        // Original HTML handler uses "score", not RSS's "min_score".
        // Enforce the same filter locally too; never widen the caller's L2.
        if (row.score >= config.minScore && published <= now && !urls.has(row.url)) {
          urls.add(row.url);
          rows.push(row);
        }
      }
      if (overlap && !warnings.includes('Overlapping offset pages were deduplicated; concurrent changes may omit articles.')) warnings.push('Overlapping offset pages were deduplicated; concurrent changes may omit articles.');
      if (boundary) return finish('window-boundary', true);
      if (parsed.rows.length && !progress) {
        warnings.push('No new article identities; offset pagination did not advance.');
        return finish('no-progress');
      }
      if (!parsed.hasNext) return finish('end-of-list', true);
      if (!parsed.rows.length) { warnings.push('Empty page advertised more pages.'); return finish('no-progress'); }
    }
    return finish('max-pages');
  } catch (error) {
    if (!pages) throw error;
    warnings.push(error.code ? error.message : 'HTML scan interrupted');
    return finish(controller.signal.aborted ? controller.signal.reason.code : error.code || 'network-error');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', externalAbort);
  }
}
