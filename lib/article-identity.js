import { createHash } from 'node:crypto';

export function normalizeArticleUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    if (url.href.length > 4096) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|spm$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeNewscopeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function sourceHash(source) {
  const normalized = normalizeNewscopeUrl(source);
  if (!normalized) throw new Error('A valid Newscope URL is required for article identity');
  return createHash('sha256').update(normalized).digest('hex');
}

export function articleKeysFor(article, source) {
  const namespace = sourceHash(source);
  const keys = [];
  const newscopeId = article?.newscopeId;
  if (typeof newscopeId === 'string' && /^[1-9]\d{0,18}$/.test(newscopeId)) {
    keys.push(`newscope:${namespace}:${newscopeId}`);
  } else if (Number.isSafeInteger(newscopeId) && newscopeId > 0) {
    keys.push(`newscope:${namespace}:${newscopeId}`);
  }
  const normalized = normalizeArticleUrl(article?.url);
  if (normalized) {
    const identityUrl = new URL(normalized);
    identityUrl.searchParams.sort();
    keys.push(`url:${namespace}:${createHash('sha256').update(identityUrl.toString()).digest('hex')}`);
  }
  if (!keys.length) throw new Error('Article has no stable identity');
  return [...new Set(keys)];
}

export function articleKeyFor(article, source) {
  return articleKeysFor(article, source)[0];
}
