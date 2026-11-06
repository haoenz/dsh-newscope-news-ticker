import { resolveConfig } from './config.js';
import { inventoryBounds, selectInventory } from './inventory.js';
import { queryNewscope, queryNewscopeVersion, knownInventoryCapabilities } from './newscope-query.js';
import { CandidateStore } from './candidate-store.js';
import { dirname, join } from 'node:path';
import { classifyArticle } from './news.js';
import { TitleTranslator } from './translate.js';
import { SemanticDeduplicator, semanticDedupModel } from './semantic.js';
import { buildModelCatalog } from '@deepseek-ai/dsh-api-session-controller';
import { DEFAULT_READ_AFTER_EXPOSURES, defaultReadStateFile, normalizeReadEvents, ReadStateStore } from './read-state.js';

export const name = 'newscope-news-ticker';
export const inject = ['webServer', 'llm', 'agentDefaultModel'];
export { Config } from './config.js';

export const NEWS_ROUTE = '/plugins/dsh-newscope-news-ticker/news.json';
export const MANAGE_ROUTE = '/plugins/dsh-newscope-news-ticker/manage';
export const MODELS_ROUTE = '/plugins/dsh-newscope-news-ticker/models.json';
export const READ_EVENTS_ROUTE = '/plugins/dsh-newscope-news-ticker/read-events';
const MAX_READ_EVENTS_BODY_BYTES = 64 * 1024;

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

export class NewsCache {
  constructor(fetchImpl = globalThis.fetch, options = {}) {
    this.fetch = fetchImpl;
    this.now = options.now || (() => Date.now());
    this.defaultModel = options.defaultModel;
    this.translator = options.translator ?? new TitleTranslator({ llm: options.llm, cacheFile: options.translationCacheFile });
    this.deduplicator = options.deduplicator ?? new SemanticDeduplicator({ llm: options.llm });
    this.readState = options.readState ?? new ReadStateStore();
    this.candidates = options.candidateStore ?? new CandidateStore({ file: options.candidateStoreFile ?? null, now: this.now });
    this.apiUnavailable = new Map();
    this.htmlAttempts = new Map();
    this.htmlQuery = options.htmlQuery;
    this.cache = null;
    this.caches = new Map();
    this.inFlights = new Map();
    this.attempts = new Map();
    this.lastGood = new Map();
    this.prepared = new Map();
    this.preparing = new Map();
  }

  remember(map, key, value, limit = 16) {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
    return value;
  }

  async candidateOperation(method, config, articles) {
    try {
      const options = { now: this.now(), maxAgeHours: inventoryBounds(config).maxAgeHours };
      return method === 'merge'
        ? await this.candidates.merge(config.newscopeUrl, articles, options)
        : await this.candidates.snapshot(config.newscopeUrl, options);
    } catch (cause) {
      const error = new Error('Candidate inventory unavailable: ' + errorMessage(cause));
      error.code = 'CANDIDATE_STATE_UNAVAILABLE';
      throw error;
    }
  }

  candidateMetadata(stored) {
    const { firstCollectedAt, updatedAt, pruned, retainedCount } = stored;
    return { firstCollectedAt, updatedAt, pruned, retainedCount };
  }

  async load(config) {
    const before = await this.candidateOperation('snapshot', config);
    const htmlKey = JSON.stringify([config.newscopeUrl, inventoryBounds(config)]);
    const loaded = await queryNewscope(this.fetch, config, {
      now: this.now(),
      preferRss: (this.apiUnavailable.get(config.newscopeUrl) || 0) > this.now(),
      htmlQuery: this.htmlQuery,
      onApiUnsupported: () => this.remember(this.apiUnavailable, config.newscopeUrl, this.now() + 15 * 60_000),
      shouldSupplement: async (articles) => {
        const stored = await this.candidateOperation('merge', config, articles);
        const selected = await this.project(config, stored.articles, knownInventoryCapabilities(), stored.aliasesByKey);
        const last = this.htmlAttempts.get(htmlKey);
        const eligible = !before.retainedCount || selected.pool.unreadCount < config.inventory.lowWatermark || selected.pool.tier !== 'L0';
        if (!eligible || (last !== undefined && this.now() - last < 60_000)) return false;
        this.remember(this.htmlAttempts, htmlKey, this.now());
        return true;
      },
    });
    if (!loaded.apiUnsupported) this.apiUnavailable.delete(config.newscopeUrl);
    const stored = await this.candidateOperation('merge', config, loaded.articles);
    loaded.inventoryStore = this.candidateMetadata(stored);
    loaded.identityAliases = stored.aliasesByKey;
    // Complete API queries are authoritative for their filter window. Never
    // resurrect remotely removed articles by unioning an old local archive.
    if (!loaded.capabilities.remoteWindowComplete) loaded.articles = stored.articles;
    loaded.articles = loaded.articles.map(article => ({ ...article, category: classifyArticle(article, config) }));
    try {
      loaded.version = await queryNewscopeVersion(this.fetch, loaded.endpoint);
    } catch { /* Health/version is optional, never a source-fetch trigger. */ }
    return loaded;
  }

  resolveModelRoutes(config) {
    let fallback = '';
    try {
      const selection = this.defaultModel?.currentSelection?.();
      if (selection?.provider && selection?.model) fallback = selection.provider + '/' + selection.model;
    } catch { /* An unavailable default-model service must not break the feed. */ }
    const translationModel = String(config.translationModel || fallback).trim();
    const semanticDedupModel = String(config.semanticDedupModel || translationModel).trim();
    return { ...config, translationModel, semanticDedupModel };
  }

  cacheKey(config) {
    return JSON.stringify([config.newscopeUrl, inventoryBounds(config), config.minScore, config.maxAgeHours,
      config.topicMap, config.sourceMap,
      config.translationEnabled ? config.translationModel : 'off',
      config.semanticDedupEnabled ? semanticDedupModel(config) : 'off']);
  }

  async refresh(config, key) {
    if (this.inFlights.has(key)) return this.inFlights.get(key);
    this.remember(this.attempts, key, { at: this.now(), error: null });
    const request = this.load(config).then((loaded) => {
      const cache = { ...loaded, key, fetchedAt: this.now() };
      this.cache = this.remember(this.caches, key, cache);
      this.remember(this.attempts, key, { at: this.now(), error: null });
      return cache;
    }).catch((error) => {
      this.remember(this.attempts, key, { at: this.now(), error: errorMessage(error), errorCode: error.code });
      throw error;
    }).finally(() => { this.inFlights.delete(key); });
    this.inFlights.set(key, request);
    return request;
  }

  async project(config, articles, capabilities, trustedAliases = {}) {
    const presented = await this.readState.present(articles, { source: config.newscopeUrl, includeRead: true, trustedAliases });
    const selected = selectInventory(presented.items, presented.exposureStates, config, {
      now: this.now(), history: capabilities?.history === true,
    });
    return { ...presented, ...selected, pool: { ...selected.pool,
      scope: capabilities?.inventoryScope || 'unknown', remoteWindowComplete: capabilities?.remoteWindowComplete ?? null } };
  }

  async prepare(items, config, key) {
    // Translation and semantic work stays bounded by one display inventory, not the whole history scan.
    const signature = JSON.stringify([key, items]);
    if (this.prepared.has(signature)) return this.prepared.get(signature);
    if (this.preparing.has(signature)) return this.preparing.get(signature);
    const request = (async () => {
      const deduplicated = await this.deduplicator.deduplicate(items, config);
      const translated = await this.translator.translate(deduplicated, config);
      const translatedKeys = new Set(translated.map((item) => item.articleKey));
      if (deduplicated.every((item) => translatedKeys.has(item.articleKey))) {
        this.remember(this.prepared, signature, translated, 32);
      }
      return translated;
    })().finally(() => { this.preparing.delete(signature); });
    this.preparing.set(signature, request);
    return request;
  }

  async snapshot(input) {
    const config = this.resolveModelRoutes(resolveConfig(input));
    if (config.displayMode === 'off') return { config, items: [], fetchedAt: null, stale: false, service: 'disabled', capabilities: { history: false } };
    const key = this.cacheKey(config);
    let cache = this.caches.get(key);
    let error;
    let errorCode;
    let selected;
    const debounce = config.inventory.refillDebounceSeconds * 1000;
    try {
      if (cache) selected = await this.project(config, cache.articles, cache.capabilities, cache.identityAliases);
    } catch (failure) {
      return { config, items: [], exposureStates: {}, readVersion: null, service: 'read-state-unavailable',
        fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : null, stale: false,
        capabilities: cache?.capabilities || { history: false }, error: errorMessage(failure) };
    }
    const attempt = this.attempts.get(key);
    const expired = !cache || this.now() - cache.fetchedAt >= config.refreshMinutes * 60000;
    const low = selected && selected.pool.unreadCount < config.inventory.lowWatermark;
    const canQuery = !attempt || this.now() - attempt.at >= debounce;
    if (this.inFlights.has(key) || (expired && (!attempt?.error || canQuery)) || (low && canQuery)) {
      try { cache = await this.refresh(config, key); }
      catch (failure) { error = errorMessage(failure); errorCode = failure.code; }
    } else if (attempt?.error) { error = attempt.error; errorCode = attempt.errorCode; }
    // A restart during an outage can still use durable known candidates. This
    // is stale local inventory, never a successful remote query or RSS downgrade.
    if (!cache && error && errorCode !== 'CANDIDATE_STATE_UNAVAILABLE') {
      try {
        const stored = await this.candidateOperation('snapshot', config);
        if (stored.retainedCount) {
          const savedAt = Date.parse(stored.updatedAt);
          cache = { articles: stored.articles.map(article => ({ ...article, category: classifyArticle(article, config) })),
            fetchedAt: Number.isFinite(savedAt) ? savedAt : this.now(),
            capabilities: knownInventoryCapabilities('local', 'partial'), inventoryStore: this.candidateMetadata(stored), identityAliases: stored.aliasesByKey,
            warnings: ['Remote inventory unavailable; displaying stale locally collected candidates.'] };
          this.remember(this.caches, key, cache);
        }
      } catch (failure) { error = errorMessage(failure); errorCode = failure.code; }
    }
    const capabilities = cache?.capabilities || { history: false, source: 'unavailable', truncated: false };
    const base = { config, fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
      queriedAt: this.attempts.has(key) ? new Date(this.attempts.get(key).at).toISOString() : null,
      stale: Boolean(error && cache), service: error ? (cache ? 'cache' : 'unavailable') : 'ok',
      capabilities, version: cache?.version, inventoryStore: cache?.inventoryStore,
      warnings: cache?.warnings || [], supplement: cache?.supplement, ...(error ? { error } : {}) };
    if (errorCode === 'CANDIDATE_STATE_UNAVAILABLE') return { ...base, service: 'candidate-state-unavailable',
      items: [], exposureStates: {}, readVersion: null };
    try { selected = await this.project(config, cache?.articles || [], capabilities, cache?.identityAliases); }
    catch (failure) { return { ...base, items: [], exposureStates: {}, readVersion: null,
      service: 'read-state-unavailable', error: errorMessage(failure) }; }
    try {
      const prepared = await this.prepare(selected.items, config, key);
      const attempted = new Set(selected.items.map((item) => item.articleKey));
      const ready = new Map(prepared.map((item) => [item.articleKey, item]));
      // Read state may change during an LLM request. Recompute priority from the
      // complete candidate superset, never from a partial display or translated subset.
      let current = await this.project(config, cache?.articles || [], capabilities, cache?.identityAliases);
      const missing = current.items.filter((item) => !attempted.has(item.articleKey)).slice(0, 100 - attempted.size);
      if (missing.length) {
        for (const item of await this.prepare(missing, config, key)) ready.set(item.articleKey, item);
        current = await this.project(config, cache?.articles || [], capabilities, cache?.identityAliases);
      }
      const visible = current.items.filter((item) => ready.has(item.articleKey))
        .map((item) => ({ ...ready.get(item.articleKey), ...item, title: ready.get(item.articleKey).title,
          ...(ready.get(item.articleKey).originalTitle ? { originalTitle: ready.get(item.articleKey).originalTitle } : {}) }));
      this.remember(this.lastGood, key, { items: visible, fetchedAt: cache?.fetchedAt });
      return { ...base, items: visible, pool: current.pool, readVersion: current.readVersion,
        exposureStates: Object.fromEntries(visible.map((item) => [item.articleKey, current.exposureStates[item.articleKey]])) };
    } catch (failure) {
      const previous = this.lastGood.get(key);
      try {
        const fallback = await this.project(config, cache?.articles || [], capabilities, cache?.identityAliases);
        const ready = new Map((previous?.items || []).map((item) => [item.articleKey, item]));
        const items = fallback.items.filter((item) => ready.has(item.articleKey))
          .map((item) => ({ ...ready.get(item.articleKey), ...item, title: ready.get(item.articleKey).title }));
        return { ...base, pool: fallback.pool, readVersion: fallback.readVersion, items,
          exposureStates: Object.fromEntries(items.map((item) => [item.articleKey, fallback.exposureStates[item.articleKey]])),
          stale: Boolean(previous), service: previous ? 'cache' : 'unavailable',
          fetchedAt: previous?.fetchedAt ? new Date(previous.fetchedAt).toISOString() : base.fetchedAt,
          error: errorMessage(failure) };
      } catch (stateError) { return { ...base, items: [], exposureStates: {}, readVersion: null,
        service: 'read-state-unavailable', error: errorMessage(stateError) }; }
    }
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

function allowWrite(req, res) {
  const site = req.headers['sec-fetch-site'];
  let originAllowed = true;
  if (req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin);
      originAllowed = ['http:', 'https:'].includes(origin.protocol)
        && Boolean(req.headers.host)
        && origin.host.toLowerCase() === String(req.headers.host).toLowerCase();
    } catch {
      originAllowed = false;
    }
  }
  if ((site && site !== 'same-origin') || !originAllowed) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Cross-site write denied');
    return false;
  }
  return true;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_READ_EVENTS_BODY_BYTES) throw httpError(413, 'Read event request is too large');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Invalid JSON request body');
  }
}

function jsonResponse(res, payload, head = false, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
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

export function apply(ctx, rawConfig = {}, options = {}) {
  const readState = options.readState ?? new ReadStateStore({ file: options.readStateFile ?? defaultReadStateFile() });
  const candidateStore = options.candidateStore ?? new CandidateStore({
    file: options.candidateStoreFile ?? (readState.file ? join(dirname(readState.file), 'candidate-inventory.json') : null),
  });
  const news = new NewsCache(globalThis.fetch, { llm: ctx.llm, defaultModel: ctx.agentDefaultModel, readState, candidateStore });
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
    const disposeReadEvents = ctx.webServer.register({
      kind: 'exact',
      path: READ_EVENTS_ROUTE,
      handler: async (req, res) => {
        if (!allowWrite(req, res)) return;
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' });
          res.end();
          return;
        }
        const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/json') {
          jsonResponse(res, { error: 'Expected application/json' }, false, 415);
          return;
        }
        try {
          const events = normalizeReadEvents(await readJsonBody(req));
          const config = resolveConfig(rawConfig);
          const readAfterExposures = config.readAfterExposures ?? DEFAULT_READ_AFTER_EXPOSURES;
          const payload = await readState.recordEvents(events, { readAfterExposures });
          jsonResponse(res, payload);
        } catch (error) {
          const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
          jsonResponse(res, { error: errorMessage(error) }, false, status);
        }
      },
    });
    const disposeModels = ctx.webServer.register({
      kind: 'exact',
      path: MODELS_ROUTE,
      handler: async (req, res) => {
        if (!allowRead(req, res)) return;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' });
          res.end();
          return;
        }
        try {
          const catalog = await buildModelCatalog(ctx);
          jsonResponse(res, catalog, req.method === 'HEAD');
        } catch (error) {
          jsonResponse(res, { error: errorMessage(error) }, req.method === 'HEAD', 500);
        }
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
      disposeReadEvents();
      disposeModels();
      disposeManage();
    };
  }, 'newscope-news-ticker: HTTP routes');
}
