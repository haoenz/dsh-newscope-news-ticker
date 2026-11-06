import { XMLParser, XMLValidator } from 'fast-xml-parser';
const rssRootParser = new XMLParser({ ignoreAttributes: false, ignoreDeclaration: true, ignorePiTags: true,
  removeNSPrefix: true, parseTagValue: false, processEntities: false });
import { parseNewscopeArticles, parseNewscopeMetadata } from './news.js';
import { inventoryBounds } from './inventory.js';
import { normalizeArticleUrl } from './article-identity.js';
import { decodeHTML } from 'entities';
import { queryNewscopeHtml } from './newscope-html.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const DEADLINE_MS = 20_000;

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function boundedText(response, maxBytes, signal) {
  if (Number(response.headers.get('content-length') || 0) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Newscope response is too large');
  }
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return '';
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Newscope response is too large');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
export function knownInventoryCapabilities(source = 'rss', coverage = 'rss-window', truncated = false) {
  return { history: true, source, truncated, inventoryScope: 'known-local',
    remoteWindowComplete: false, coverage, localInventory: true };
}
function apiCapabilities(complete) {
  return complete
    ? { history: true, source: 'articles', truncated: false, inventoryScope: 'remote-window',
      remoteWindowComplete: true, coverage: 'queried-window', localInventory: true }
    : knownInventoryCapabilities('articles', 'partial', true);
}
function warning(error) {
  return String(error?.message || error).replace(/https?:[/][/][^\s]+/gi, '[remote URL]').slice(0, 240);
}

export async function queryNewscopeVersion(fetchImpl, endpoint, { timeoutMs = 2500 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await abortable(fetchImpl(endpoint + '/api/v1/status', {
    method: 'GET', redirect: 'error', signal, headers: { accept: 'application/json' },
  }), signal);
  if (!response.ok) { void response.body?.cancel().catch(() => {}); return undefined; }
  const payload = JSON.parse(await boundedText(response, 32 * 1024, signal));
  return typeof payload?.version === 'string' ? payload.version.slice(0, 200) : undefined;
}

// All network paths query stored inventory. They never invoke feed-fetch jobs.
// RSS/HTML are an explicitly partial known-candidate scope, not remote exhaustion.
export async function queryNewscope(fetchImpl, config, {
  now = Date.now(), preferRss = false, shouldSupplement = async () => true,
  htmlQuery = queryNewscopeHtml, deadlineMs = DEADLINE_MS, onApiUnsupported = () => {},
} = {}) {
  const base = new URL(config.newscopeUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid Newscope URL');
  base.search = ''; base.hash = '';
  const endpoint = base.toString().replace(/[/]+$/, '');
  const bounds = inventoryBounds(config);
  const broad = { ...config, ...bounds };
  const signal = AbortSignal.timeout(deadlineMs);
  const get = (url, accept) => abortable(fetchImpl(url, { method: 'GET', redirect: 'error',
    headers: { accept }, signal }), signal);
  async function rssInventory() {
    const rss = await get(endpoint + '/rss?min_score=' + encodeURIComponent(bounds.minScore), 'application/rss+xml');
    if (!rss.ok) throw new Error('Newscope RSS returned HTTP ' + rss.status);
    const xml = await boundedText(rss, 5 * MAX_PAGE_BYTES, signal);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid Newscope RSS document');
    const root = rssRootParser.parse(xml);
    const names = Object.keys(root || {});
    const channel = root?.rss?.channel;
    const validRss = names.length === 1 && names[0] === 'rss'
      && (channel === '' || (channel && typeof channel === 'object' && !Array.isArray(channel)));
    const validAtom = names.length === 1 && names[0] === 'feed'
      && (root.feed === '' || (root.feed && typeof root.feed === 'object' && !Array.isArray(root.feed)));
    if (!validRss && !validAtom) throw new Error('Invalid Newscope RSS document root');
    const articles = parseNewscopeArticles(xml, broad, now);
    const result = { articles, endpoint, apiUnsupported: true,
      capabilities: knownInventoryCapabilities(), warnings: [] };
    if (await shouldSupplement(articles)) {
      try {
        const html = await htmlQuery(fetchImpl, broad, { now, signal });
        // The persistent candidate store merges URL/API aliases and keeps identity upgrades.
        result.articles = [...articles, ...html.articles];
        result.capabilities = knownInventoryCapabilities('rss+html', html.coverage === 'window-scanned' ? 'best-effort' : 'partial', html.truncated);
        result.supplement = { pages: html.pages, stopReason: html.stopReason };
        result.warnings.push(...html.warnings);
      } catch (error) {
        result.warnings.push('HTML history supplement unavailable; using known candidates: ' + warning(error));
      }
    }
    return result;
  }
  if (preferRss) return rssInventory();
  const after = new Date(now - bounds.maxAgeHours * 3600_000).toISOString();
  let bytes = 0, cursor = null, previous = null;
  const seenCursors = new Set(), rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ min_score: String(bounds.minScore), published_after: after, limit: String(PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    const response = await get(endpoint + '/api/v1/articles?' + query, 'application/json');
    if (page === 0 && [404, 405, 501].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      await onApiUnsupported();
      return rssInventory();
    }
    if (!response.ok) throw new Error('Newscope articles returned HTTP ' + response.status);
    const text = await boundedText(response, Math.min(MAX_PAGE_BYTES, MAX_TOTAL_BYTES - bytes), signal);
    bytes += Buffer.byteLength(text);
    const payload = JSON.parse(text);
    if (!payload || !Array.isArray(payload.items) || payload.items.length > PAGE_SIZE
      || !(payload.nextCursor === null || typeof payload.nextCursor === 'string')
      || (payload.nextCursor && (payload.nextCursor.length > 2048 || !payload.items.length))) throw new Error('Invalid Newscope metadata page');
    for (const item of payload.items) {
      const id = String(item?.id ?? '');
      const time = Date.parse(item?.publishedAt);
      if (!/^[1-9][0-9]{0,18}$/.test(id) || (typeof item.id === 'number' && !Number.isSafeInteger(item.id)) || !Number.isFinite(time)) throw new Error('Invalid Newscope metadata identity or timestamp');
      if (typeof item.title !== 'string' || !decodeHTML(item.title).trim() || !normalizeArticleUrl(item.url)
        || typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 10) {
        throw new Error('Invalid Newscope metadata fields');
      }
      if (previous && (time > previous.time || (time === previous.time && BigInt(id) >= previous.id))) throw new Error('Newscope metadata cursor did not advance in stable order');
      previous = { time, id: BigInt(id) };
      rows.push(item);
    }
    cursor = payload.nextCursor || null;
    if (!cursor) return { articles: parseNewscopeMetadata(rows, config, now), endpoint, capabilities: apiCapabilities(true) };
    if (seenCursors.has(cursor)) throw new Error('Newscope metadata repeated a cursor');
    seenCursors.add(cursor);
  }
  return { articles: parseNewscopeMetadata(rows, config, now), endpoint, capabilities: apiCapabilities(false) };
}
