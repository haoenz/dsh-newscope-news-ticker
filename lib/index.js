import { resolveConfig } from './config.js';
import { parseNewscopeArticles, scheduleArticles } from './news.js';

export const name = 'newscope-news-ticker';
export const inject = ['webServer'];
export { Config } from './config.js';

export const NEWS_ROUTE = '/plugins/dsh-newscope-news-ticker/news.json';
export const MANAGE_ROUTE = '/plugins/dsh-newscope-news-ticker/manage';
const MAX_FEED_BYTES = 5 * 1024 * 1024;

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/gi, '[remote URL]').slice(0, 240);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

async function responseText(response) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_FEED_BYTES) throw new Error('Newscope RSS response is too large');
  const text = await response.text();
  if (text.length > MAX_FEED_BYTES) throw new Error('Newscope RSS response is too large');
  return text;
}

export class NewsCache {
  constructor(fetchImpl = globalThis.fetch) {
    this.fetch = fetchImpl;
    this.cache = null;
    this.inFlight = null;
  }

  async load(config) {
    const endpoint = safeHttpUrl(config.newscopeUrl);
    if (!endpoint) throw new Error('newscopeUrl must be a valid HTTP(S) URL');
    const feedUrl = `${endpoint}/rss?min_score=${encodeURIComponent(config.minScore)}`;
    const response = await this.fetch(feedUrl, {
      headers: { accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Newscope RSS returned HTTP ${response.status}`);
    const xml = await responseText(response);
    const articles = parseNewscopeArticles(xml, config);
    let version;
    try {
      const statusResponse = await this.fetch(`${endpoint}/api/v1/status`, { signal: AbortSignal.timeout(2500) });
      if (statusResponse.ok) version = (await statusResponse.json()).version;
    } catch {
      // RSS remains authoritative when the optional health endpoint is unavailable.
    }
    return { articles, version, endpoint };
  }

  async snapshot(input) {
    const config = resolveConfig(input);
    if (!config.enabled) return { config, items: [], fetchedAt: null, stale: false, service: 'disabled' };
    const cacheKey = `${config.newscopeUrl}\0${config.minScore}`;
    const now = Date.now();
    const fresh = this.cache && this.cache.key === cacheKey && now - this.cache.fetchedAt < config.refreshMinutes * 60_000;
    if (!fresh) {
      if (!this.inFlight) {
        this.inFlight = this.load(config)
          .then((loaded) => {
            this.cache = { ...loaded, key: cacheKey, fetchedAt: Date.now() };
            return this.cache;
          })
          .finally(() => { this.inFlight = null; });
      }
      try {
        await this.inFlight;
      } catch (error) {
        if (this.cache) {
          return {
            config,
            items: scheduleArticles(this.cache.articles, config.weights),
            fetchedAt: new Date(this.cache.fetchedAt).toISOString(),
            stale: true,
            service: 'cache',
            error: errorMessage(error),
          };
        }
        return { config, items: [], fetchedAt: null, stale: false, service: 'unavailable', error: errorMessage(error) };
      }
    }

    const cache = this.cache;
    return {
      config,
      items: scheduleArticles(cache.articles, config.weights),
      fetchedAt: new Date(cache.fetchedAt).toISOString(),
      stale: false,
      service: 'ok',
      version: cache.version,
    };
  }
}

function allowRead(req, res) {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Cross-site access denied');
    return false;
  }
  return true;
}

function jsonResponse(res, payload, head = false) {
  const body = JSON.stringify(payload);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(head ? undefined : body);
}

function isLoopbackRequest(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

function isLoopbackUrl(value) {
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function apply(ctx, rawConfig = {}) {
  const news = new NewsCache();
  ctx.effect(() => {
    const disposeNews = ctx.webServer.register({
      kind: 'exact',
      path: NEWS_ROUTE,
      handler: async (req, res) => {
        if (!allowRead(req, res)) return;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' });
          res.end();
          return;
        }
        const payload = await news.snapshot(rawConfig);
        jsonResponse(res, payload, req.method === 'HEAD');
      },
    });
    const disposeManage = ctx.webServer.register({
      kind: 'exact',
      path: MANAGE_ROUTE,
      handler: (req, res) => {
        if (!allowRead(req, res)) return;
        const config = resolveConfig(rawConfig);
        const target = safeHttpUrl(config.managementUrl || config.newscopeUrl);
        const localTarget = target && isLoopbackUrl(target);
        if (target && (!localTarget || isLoopbackRequest(req))) {
          res.writeHead(302, { location: `${target}/`, 'cache-control': 'no-store' });
          res.end();
          return;
        }
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('This Newscope address is local to the DSH Host. Set managementUrl to a browser-reachable address before opening it remotely.');
      },
    });
    return () => {
      disposeNews();
      disposeManage();
    };
  }, 'newscope-news-ticker: HTTP routes');
}
