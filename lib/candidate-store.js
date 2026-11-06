import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename as fsRename, unlink, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { articleKeyFor, articleKeysFor, normalizeArticleUrl, normalizeNewscopeUrl } from './article-identity.js';
import { defaultReadStateFile } from './read-state.js';

const VERSION = 1;
const HARD_ITEMS = 5000;
const HARD_BYTES = 20 * 1024 * 1024;
const MAX_ALIASES = 32;
const HOUR = 60 * 60 * 1000;
const emptyState = () => ({ version: VERSION, sources: {} });
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit).trimEnd() : '';

export function defaultCandidateStoreFile() {
  return join(dirname(defaultReadStateFile()), 'candidate-inventory.json');
}

function invalid(message) {
  const error = new Error(`Invalid candidate inventory: ${message}. Preserve the file and restore a known-good backup, or explicitly move it aside to start a new inventory.`);
  error.code = 'CANDIDATE_STATE_UNAVAILABLE';
  return error;
}

function exactKeys(value, allowed) {
  return object(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function validId(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) ? value : null;
}

function cleanArticle(value, source, now) {
  if (!object(value)) return null;
  const url = normalizeArticleUrl(value.url);
  const title = text(value.title, 2000);
  const published = typeof value.publishedAt === 'string' && value.publishedAt.length <= 40 ? Date.parse(value.publishedAt) : NaN;
  if (!url || !title || typeof value.score !== 'number' || !Number.isFinite(value.score)
    || value.score < 0 || value.score > 10 || !Number.isFinite(published) || published < 0 || published > now) return null;
  const article = {
    id: text(value.id, 4096) || url, title, url, score: value.score,
    publishedAt: new Date(published).toISOString(),
    topics: Array.isArray(value.topics) ? [...new Set(value.topics.slice(0, 12).map((topic) => text(topic, 200)).filter(Boolean))].slice(0, 12) : [],
    source: text(value.source, 200) || new URL(url).hostname,
  };
  const newscopeId = validId(value.newscopeId);
  if (newscopeId) {
    article.newscopeId = newscopeId;
    article.id = newscopeId;
  }
  const guid = text(value.guid, 4096);
  const category = text(value.category, 100);
  if (guid) article.guid = guid;
  if (category) article.category = category;
  article.articleKey = articleKeyFor(article, source);
  return article;
}

function date(value, now) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
    && Date.parse(value) >= 0 && Date.parse(value) <= now && new Date(value).toISOString() === value;
}

function validateState(state, now) {
  if (!exactKeys(state, ['version', 'sources']) || state.version !== VERSION || !object(state.sources)) throw invalid('unsupported version or root structure');
  const sources = Object.entries(state.sources);
  if (sources.length > HARD_ITEMS) throw invalid('too many source namespaces');
  let count = 0;
  for (const [source, inventory] of sources) {
    if (source.length > 4096 || normalizeNewscopeUrl(source) !== source
      || !exactKeys(inventory, ['firstCollectedAt', 'updatedAt', 'retentionHours', 'items'])
      || !date(inventory.firstCollectedAt, now) || !date(inventory.updatedAt, now)
      || inventory.firstCollectedAt > inventory.updatedAt
      || !Number.isFinite(inventory.retentionHours) || inventory.retentionHours < 192 || inventory.retentionHours > 744
      || !Array.isArray(inventory.items)) throw invalid('invalid source metadata');
    count += inventory.items.length;
    if (count > HARD_ITEMS) throw invalid('global article limit exceeded');
    const seen = new Set();
    for (const item of inventory.items) {
      if (!exactKeys(item, ['article', 'aliases'])) throw invalid('invalid article record');
      const article = cleanArticle(item.article, source, now);
      if (!article || !isDeepStrictEqual(article, item.article)) throw invalid('invalid or noncanonical article metadata');
      const keys = articleKeysFor(article, source);
      const namespace = keys[0].split(':')[1];
      const pattern = new RegExp(`^(?:url:${namespace}:[a-f0-9]{64}|newscope:${namespace}:[1-9]\\d{0,18})$`);
      if (!Array.isArray(item.aliases) || !item.aliases.length || item.aliases.length > MAX_ALIASES
        || item.aliases.some((key) => typeof key !== 'string' || !pattern.test(key) || seen.has(key))
        || new Set(item.aliases).size !== item.aliases.length || keys.some((key) => !item.aliases.includes(key))) throw invalid('invalid or overlapping identity aliases');
      for (const key of item.aliases) seen.add(key);
    }
  }
  return state;
}

function mergeArticles(inventory, articles, source, now) {
  const records = new Set(inventory.items);
  const index = new Map();
  for (const item of records) for (const alias of item.aliases) index.set(alias, item);
  for (const raw of articles) {
    let article = cleanArticle(raw, source, now);
    if (!article) continue;
    const keys = articleKeysFor(article, source);
    const previous = [...new Set(keys.map((key) => index.get(key)).filter(Boolean))];
    // RSS IDs are not API IDs. Preserve an already-known API identity on RSS refresh.
    const api = previous.find((item) => item.article.newscopeId);
    if (!article.newscopeId && api) {
      article = { ...article, id: api.article.newscopeId, newscopeId: api.article.newscopeId };
      article.articleKey = articleKeyFor(article, source);
    }
    const aliases = [...new Set([...articleKeysFor(article, source), ...keys, ...previous.flatMap((item) => item.aliases)])];
    if (aliases.length > MAX_ALIASES) throw new Error('Candidate inventory identity alias limit exceeded');
    for (const item of previous) records.delete(item);
    const item = { article, aliases };
    records.add(item);
    for (const alias of aliases) index.set(alias, item);
  }
  inventory.items = [...records];
}

// Bounds apply to the entire file, never once per namespace. Eviction is metadata-only:
// it neither touches read-state nor claims complete history before firstCollectedAt.
function prune(state, now, maxItems, maxBytes, requestedSource, retentionHours) {
  let pruned = 0;
  const all = [];
  for (const [source, inventory] of Object.entries(state.sources)) {
    const cutoff = now - (source === requestedSource ? retentionHours : inventory.retentionHours) * HOUR;
    inventory.items = inventory.items.filter((item) => {
      if (Date.parse(item.article.publishedAt) < cutoff) { pruned++; return false; }
      all.push({ source, item });
      return true;
    });
  }
  all.sort((a, b) => a.item.article.publishedAt.localeCompare(b.item.article.publishedAt)
    || a.item.article.articleKey.localeCompare(b.item.article.articleKey));
  let size = bytes(state);
  const removeItem = ({ source, item }) => {
    const items = state.sources[source].items;
    size -= bytes(item) + (items.length > 1 ? 1 : 0);
    items.splice(items.indexOf(item), 1);
    pruned++;
  };
  while (all.length > maxItems) removeItem(all.shift());
  const removeSource = (source) => {
    size -= bytes(source) + 1 + bytes(state.sources[source]) + (Object.keys(state.sources).length > 1 ? 1 : 0);
    delete state.sources[source];
  };
  const oldestSources = () => Object.keys(state.sources).sort((a, b) => state.sources[a].updatedAt.localeCompare(state.sources[b].updatedAt) || a.localeCompare(b));
  // Empty namespace timestamps are retained normally, but cannot grow the file without bound.
  for (const source of oldestSources()) {
    if (size <= maxBytes && Object.keys(state.sources).length <= HARD_ITEMS) break;
    if (!state.sources[source].items.length) removeSource(source);
  }
  while (size > maxBytes && all.length) {
    const entry = all.shift();
    removeItem(entry);
    if (!state.sources[entry.source].items.length) removeSource(entry.source);
  }
  if (size > maxBytes || Object.keys(state.sources).length > HARD_ITEMS) throw new Error('Candidate inventory capacity cannot fit metadata');
  return pruned;
}

/**
 * Private, independently locked inventory (not read-state). Validated corruption is
 * never overwritten; recovery is an explicit backup restore or moving the bad file
 * aside. Normal success/failure cleans locks; abandoned crash locks are NOT stolen
 * by age. After confirming no writer is alive, an operator may remove that lock.
 * firstCollectedAt is a collection timestamp, not proof of historical completeness.
 */
export class CandidateStore {
  constructor({ file = null, now = () => Date.now(), maxItems = HARD_ITEMS, maxBytes = HARD_BYTES, lockTimeoutMs = 5000, writeFile, rename } = {}) {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 128
      || !Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0 || typeof now !== 'function'
      || (file !== null && (typeof file !== 'string' || !file))) throw new TypeError('Invalid candidate store options');
    this.file = file === null ? null : resolve(file);
    this.now = now;
    this.maxItems = Math.min(maxItems, HARD_ITEMS);
    this.maxBytes = Math.min(maxBytes, HARD_BYTES);
    this.lockTimeoutMs = lockTimeoutMs;
    this.writeFile = writeFile || fsWriteFile;
    this.rename = rename || fsRename;
    this.state = emptyState();
    this.queue = Promise.resolve();
  }

  async snapshot(sourceUrl, { now = this.now(), maxAgeHours = 168 } = {}) {
    return this.run(sourceUrl, null, now, maxAgeHours);
  }

  async merge(sourceUrl, articles, { now = this.now(), maxAgeHours = 168 } = {}) {
    if (!Array.isArray(articles)) throw new TypeError('Candidate articles must be an array');
    return this.run(sourceUrl, articles, now, maxAgeHours);
  }

  run(sourceUrl, articles, now, maxAgeHours) {
    const source = normalizeNewscopeUrl(sourceUrl);
    if (!source || source.length > 4096 || !Number.isFinite(now) || now < 0 || !Number.isFinite(new Date(now).getTime())
      || !Number.isFinite(maxAgeHours) || maxAgeHours < 0) return Promise.reject(new TypeError('Invalid candidate source or time window'));
    // Detach only whitelisted fields before queueing; never clone bodies/read-state
    // or require irrelevant uncloneable fields to be serializable.
    const input = articles === null ? null : articles.map((article) => cleanArticle(article, source, now)).filter(Boolean);
    const operation = this.queue.then(() => this.transaction(source, input, now, Math.min(744, Math.max(192, maxAgeHours + 24))));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async prepareDirectory() {
    const directory = dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Candidate inventory directory must not be a symlink');
    await chmod(directory, 0o700);
  }

  async acquireLock() {
    const lockFile = `${this.file}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      let handle;
      try {
        handle = await open(lockFile, 'wx', 0o600);
        const token = randomUUID();
        await handle.writeFile(JSON.stringify({ token, pid: process.pid }), 'utf8');
        await handle.sync();
        return { handle, lockFile, token };
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => {});
          await unlink(lockFile).catch(() => {});
          throw error;
        }
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the candidate inventory lock; verify no writer is alive before manually recovering an abandoned lock');
        await delay(10);
      }
    }
  }

  async releaseLock(lock) {
    if (!lock) return;
    await lock.handle.close().catch(() => {});
    const payload = JSON.parse(await readFile(lock.lockFile, 'utf8'));
    if (payload.token === lock.token) await unlink(lock.lockFile);
  }

  async readDisk(now) {
    let handle;
    try {
      handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.size > HARD_BYTES) throw invalid('not a regular file or exceeds the 20 MiB global limit');
      await handle.chmod(0o600);
      let state;
      try { state = JSON.parse(await handle.readFile('utf8')); } catch (error) {
        if (error instanceof SyntaxError) throw invalid('malformed JSON');
        throw error;
      }
      return validateState(state, now);
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async persist(state) {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.chmod(0o600);
        await handle.sync();
      } finally { await handle.close(); }
      await this.rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async transaction(source, articles, now, retentionHours) {
    let lock;
    try {
      if (this.file) {
        await this.prepareDirectory();
        lock = await this.acquireLock();
      }
      // A caller can wait behind a writer whose collection timestamp is newer.
      const validationNow = Math.max(now, this.now());
      const base = this.file ? await this.readDisk(validationNow) : this.state;
      const next = structuredClone(base);
      let inventory = next.sources[source];
      if (articles !== null) {
        const timestamp = new Date(now).toISOString();
        inventory ??= next.sources[source] = { firstCollectedAt: timestamp, updatedAt: timestamp, retentionHours, items: [] };
        inventory.updatedAt = inventory.updatedAt > timestamp ? inventory.updatedAt : timestamp;
        inventory.retentionHours = retentionHours;
        mergeArticles(inventory, articles, source, now);
      }
      const pruned = prune(next, now, this.maxItems, this.maxBytes, source, retentionHours);
      if (this.file && !isDeepStrictEqual(base, next)) await this.persist(next);
      // Neither failed writes nor failed renames publish uncommitted memory.
      this.state = next;
      inventory = next.sources[source];
      return {
        articles: structuredClone(inventory?.items.map((item) => item.article) || []).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.articleKey.localeCompare(b.articleKey)),
        // Internal Host-only identity evidence; never serialized into the public news payload.
        aliasesByKey: Object.fromEntries((inventory?.items || []).map(item => [item.article.articleKey, [...item.aliases]])),
        firstCollectedAt: inventory?.firstCollectedAt ?? null,
        updatedAt: inventory?.updatedAt ?? null,
        pruned, retainedCount: inventory?.items.length ?? 0,
      };
    } finally { await this.releaseLock(lock); }
  }
}
