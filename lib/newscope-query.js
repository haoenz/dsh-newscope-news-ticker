import { parseNewscopeArticles, parseNewscopeMetadata } from './news.js';
import { inventoryBounds } from './inventory.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const DEADLINE_MS = 20_000;

async function boundedText(response, maxBytes) {
  if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new Error('Newscope response is too large');
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Newscope response is too large');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

// Only reads Newscope's existing metadata. Never invokes feed-fetch jobs.
export async function queryNewscope(fetchImpl, config, { now = Date.now() } = {}) {
  const base = new URL(config.newscopeUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid Newscope URL');
  const endpoint = base.toString().replace(/[/]+$/, '');
  const bounds = inventoryBounds(config);
  const after = new Date(now - bounds.maxAgeHours * 3600_000).toISOString();
  const started = Date.now();
  let bytes = 0;
  let cursor = null;
  let previous = null;
  const seenCursors = new Set();
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const remaining = DEADLINE_MS - (Date.now() - started);
    if (remaining <= 0) throw new Error('Newscope metadata query exceeded its deadline');
    const query = new URLSearchParams({ min_score: String(bounds.minScore), published_after: after, limit: String(PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    const response = await fetchImpl(endpoint + '/api/v1/articles?' + query, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(Math.min(8000, remaining)),
    });
    if (page === 0 && [404, 405, 501].includes(response.status)) {
      const rss = await fetchImpl(endpoint + '/rss?min_score=' + encodeURIComponent(config.minScore), {
        headers: { accept: 'application/rss+xml' }, signal: AbortSignal.timeout(8000),
      });
      if (!rss.ok) throw new Error('Newscope RSS returned HTTP ' + rss.status);
      return { articles: parseNewscopeArticles(await boundedText(rss, 5 * MAX_PAGE_BYTES), config, now), endpoint,
        capabilities: { history: false, source: 'rss', truncated: false } };
    }
    if (!response.ok) throw new Error('Newscope articles returned HTTP ' + response.status);
    const text = await boundedText(response, Math.min(MAX_PAGE_BYTES, MAX_TOTAL_BYTES - bytes));
    bytes += Buffer.byteLength(text);
    const payload = JSON.parse(text);
    if (!payload || !Array.isArray(payload.items) || payload.items.length > PAGE_SIZE
      || !(payload.nextCursor === null || typeof payload.nextCursor === 'string')
      || (payload.nextCursor && (payload.nextCursor.length > 2048 || !payload.items.length))) {
      throw new Error('Invalid Newscope metadata page');
    }
    for (const item of payload.items) {
      const id = String(item?.id ?? '');
      const time = Date.parse(item?.publishedAt);
      if (!/^[1-9][0-9]{0,18}$/.test(id) || (typeof item.id === 'number' && !Number.isSafeInteger(item.id)) || !Number.isFinite(time)) {
        throw new Error('Invalid Newscope metadata identity or timestamp');
      }
      if (previous && (time > previous.time || (time === previous.time && BigInt(id) >= previous.id))) {
        throw new Error('Newscope metadata cursor did not advance in stable order');
      }
      previous = { time, id: BigInt(id) };
      rows.push(item);
    }
    cursor = payload.nextCursor || null;
    if (!cursor) return { articles: parseNewscopeMetadata(rows, config, now), endpoint,
      capabilities: { history: true, source: 'articles', truncated: false } };
    if (seenCursors.has(cursor)) throw new Error('Newscope metadata repeated a cursor');
    seenCursors.add(cursor);
  }
  // A bounded scan is not proof that a higher-priority historical pool is empty.
  return { articles: parseNewscopeMetadata(rows, config, now), endpoint,
    capabilities: { history: false, source: 'articles', truncated: true } };
}
