import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename as fsRename, stat, unlink, writeFile as fsWriteFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { articleKeysFor } from './article-identity.js';

const STATE_VERSION = 1;
const MAX_EVENTS_PER_BATCH = 100;
const MAX_BODY_ARTICLES = 10_000;
const MAX_IDENTITY_KEYS = MAX_BODY_ARTICLES * 9; // canonical + schema v1's eight aliases
const MAX_EVENT_LOG = 10_000;
const MAX_STATE_BYTES = 24 * 1024 * 1024;
const EVENT_TYPES = new Set(['exposure', 'open', 'manual']);

export const DEFAULT_READ_AFTER_EXPOSURES = 3;

export function defaultReadStateFile() {
  const dataHome = String(process.env.XDG_DATA_HOME || '').trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'dsh-newscope-news-ticker', 'read-state.json');
}

export function isArticleKey(value) {
  return typeof value === 'string'
    && /^(?:url:[a-f0-9]{64}:[a-f0-9]{64}|newscope:[a-f0-9]{64}:[1-9]\d{0,18})$/.test(value);
}

function isEventId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validationError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function normalizeReadEvents(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.events)) {
    throw validationError('Expected an events array');
  }
  if (!payload.events.length || payload.events.length > MAX_EVENTS_PER_BATCH) {
    throw validationError(`Expected between 1 and ${MAX_EVENTS_PER_BATCH} events`);
  }
  return payload.events.map((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw validationError('Invalid read event');
    if (!EVENT_TYPES.has(event.type)) throw validationError('Invalid read event type');
    if (!isEventId(event.eventId)) throw validationError('Invalid read event ID');
    if (!isArticleKey(event.articleKey)) throw validationError('Invalid article key');
    return { type: event.type, eventId: event.eventId, articleKey: event.articleKey };
  });
}

function emptyState() {
  return { version: STATE_VERSION, revision: 0, articles: {}, eventLog: [] };
}

function emptyRecord() {
  return {
    aliases: [], exposureCount: 0,
    firstReadAt: null, lastReadAt: null, readReason: null,
    lastShownAt: null, updatedAt: null,
  };
}

function nullableDate(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid read state ${field}`);
  }
  return new Date(value).toISOString();
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid read state article');
  const exposureCount = record.exposureCount ?? 0;
  if (!Number.isSafeInteger(exposureCount) || exposureCount < 0 || exposureCount > 1_000_000) {
    throw new Error('Invalid read state exposure count');
  }
  const aliases = record.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.length > 8 || aliases.some((key) => !isArticleKey(key))) {
    throw new Error('Invalid read state aliases');
  }
  const readReason = record.readReason ?? null;
  if (readReason !== null && !EVENT_TYPES.has(readReason)) throw new Error('Invalid read state reason');
  const firstReadAt = nullableDate(record.firstReadAt, 'firstReadAt');
  const lastReadAt = nullableDate(record.lastReadAt, 'lastReadAt');
  if (!firstReadAt && (lastReadAt || readReason)) throw new Error('Incomplete read state record');
  return {
    aliases: [...new Set(aliases)], exposureCount,
    firstReadAt, lastReadAt, readReason,
    lastShownAt: nullableDate(record.lastShownAt, 'lastShownAt'),
    updatedAt: nullableDate(record.updatedAt, 'updatedAt'),
  };
}

function normalizeState(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.version !== STATE_VERSION) {
    throw new Error('Unsupported read state version');
  }
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 0) throw new Error('Invalid read state revision');
  if (!payload.articles || typeof payload.articles !== 'object' || Array.isArray(payload.articles)) {
    throw new Error('Invalid read state articles');
  }
  const entries = Object.entries(payload.articles);
  if (entries.length > MAX_BODY_ARTICLES) throw new Error('Read state article limit exceeded');
  const articles = {};
  for (const [key, record] of entries) {
    if (!isArticleKey(key)) throw new Error('Invalid read state article key');
    articles[key] = normalizeRecord(record);
  }
  if (!Array.isArray(payload.eventLog) || payload.eventLog.length > MAX_EVENT_LOG) throw new Error('Invalid read state event log');
  const eventLog = payload.eventLog.map((event) => {
    if (!event || typeof event !== 'object' || !isEventId(event.eventId)
      || !EVENT_TYPES.has(event.type) || !isArticleKey(event.articleKey)) {
      throw new Error('Invalid read state event');
    }
    return { eventId: event.eventId, type: event.type, articleKey: event.articleKey };
  });
  if (new Set(eventLog.map((event) => event.eventId)).size !== eventLog.length) throw new Error('Duplicate persisted event ID');
  return { version: STATE_VERSION, revision: payload.revision, articles, eventLog };
}

async function readDiskState(file) {
  if (!file) return null;
  try {
    const info = await stat(file);
    if (info.size > MAX_STATE_BYTES) throw new Error('Read state file is too large');
    const text = await readFile(file, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) throw new Error('Read state file is too large');
    return normalizeState(JSON.parse(text));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('Persistent read state is damaged or unreadable', { cause: error });
  }
}

function publicRecord(record) {
  return {
    exposureCount: record?.exposureCount || 0,
    read: Boolean(record?.firstReadAt),
    readAt: record?.lastReadAt || record?.firstReadAt || null,
    readReason: record?.readReason || null,
    lastShownAt: record?.lastShownAt || null,
  };
}

function identityIndex(state) {
  const index = new Map();
  for (const [key, record] of Object.entries(state.articles)) {
    for (const alias of [key, ...record.aliases]) {
      if (!index.has(alias)) index.set(alias, new Set());
      index.get(alias).add(key);
    }
  }
  return index;
}

function latest(...dates) {
  return dates.filter(Boolean).sort().at(-1) || null;
}

function mergeRecords(records) {
  // Histories may overlap: max never erases a recorded count and avoids double
  // counting it. Preserve any read marker, its earliest origin, and latest reason.
  const latestRead = records.filter((record) => record.firstReadAt)
    .sort((a, b) => (a.lastReadAt || a.firstReadAt).localeCompare(b.lastReadAt || b.firstReadAt)).at(-1);
  return {
    aliases: [],
    exposureCount: Math.max(...records.map((record) => record.exposureCount)),
    firstReadAt: records.map((record) => record.firstReadAt).filter(Boolean).sort()[0] || null,
    lastReadAt: latest(...records.map((record) => record.lastReadAt || record.firstReadAt)),
    readReason: latestRead?.readReason || null,
    lastShownAt: latest(...records.map((record) => record.lastShownAt)),
    updatedAt: latest(...records.map((record) => record.updatedAt)),
  };
}

function rememberIdentity(identities, keys) {
  // Only a bounded hint cache: durable records and their aliases are authoritative.
  // Evict entire groups so a remaining hint never silently loses half an identity.
  for (const key of keys) identities.delete(key);
  while (identities.size + keys.length > MAX_IDENTITY_KEYS) {
    for (const key of identities.values().next().value) identities.delete(key);
  }
  for (const key of keys) identities.set(key, keys);
}

function resolveIdentity(state, index, identities, keys, create = false) {
  const allKeys = new Set(keys);
  const owners = new Set();
  // Follow both persisted aliases and unpublished candidates, including collisions
  // in old files where two records independently accumulated the same identity.
  for (const key of allKeys) {
    for (const hint of identities.get(key) || []) allKeys.add(hint);
    for (const owner of index.get(key) || []) {
      if (owners.has(owner)) continue;
      owners.add(owner);
      allKeys.add(owner);
      for (const alias of state.articles[owner].aliases) allKeys.add(alias);
    }
  }
  const canonical = owners.values().next().value || keys[0];
  const original = state.articles[canonical];
  const aliases = [...new Set([...(original?.aliases || []), ...allKeys])].filter((key) => key !== canonical);
  // Keep schema v1's bound; never truncate aliases and acknowledge lost history.
  if (aliases.length > 8) throw new Error('Read state alias limit exceeded');
  rememberIdentity(identities, [canonical, ...aliases]);
  if (!original && !create) return { key: canonical, changed: false };
  if (!original && Object.keys(state.articles).length >= MAX_BODY_ARTICLES) throw new Error('Read state article limit exceeded');
  const changed = !original || owners.size > 1 || aliases.some((key) => !original.aliases.includes(key));
  if (!changed) return { key: canonical, changed: false };
  const record = owners.size > 1 ? mergeRecords([...owners].map((key) => state.articles[key])) : original || emptyRecord();
  for (const owner of owners) {
    for (const alias of [owner, ...state.articles[owner].aliases]) {
      index.get(alias)?.delete(owner);
    }
    delete state.articles[owner];
  }
  record.aliases = aliases;
  state.articles[canonical] = record;
  for (const key of [canonical, ...aliases]) {
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(canonical);
  }
  return { key: canonical, changed: true };
}

export class ReadStateStore {
  constructor({ file = null, now = () => Date.now(), lockTimeoutMs = 5_000, writeFile, rename } = {}) {
    this.file = file;
    this.now = now;
    this.lockTimeoutMs = lockTimeoutMs;
    this.writeFile = writeFile || fsWriteFile;
    this.rename = rename || fsRename;
    this.state = null;
    this.loading = null;
    this.queue = Promise.resolve();
    this.identities = new Map();
  }

  async load() {
    if (this.state) return this.state;
    if (!this.loading) {
      this.loading = (async () => {
        const disk = await readDiskState(this.file);
        this.state = disk || emptyState();
        return this.state;
      })();
    }
    try {
      return await this.loading;
    } catch (error) {
      this.loading = null;
      throw error;
    }
  }

  async refresh() {
    await this.load();
    await this.queue;
    if (this.file) {
      const disk = await readDiskState(this.file);
      if (disk && disk.revision >= this.state.revision) this.state = disk;
    }
    return this.state;
  }

  async acquireLock() {
    const lockFile = this.file + '.lock';
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const token = randomUUID();
        const handle = await open(lockFile, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ token }), 'utf8');
          await handle.sync();
          return { handle, lockFile, token };
        } catch (error) {
          await handle.close().catch(() => {});
          await unlink(lockFile).catch(() => {});
          throw error;
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        // Never delete a lock by age: a stale-check/unlink race can steal a new owner's lock.
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the read state lock');
        await delay(10);
      }
    }
  }

  async releaseLock(lock) {
    if (!lock) return;
    await lock.handle.close().catch(() => {});
    try {
      const payload = JSON.parse(await readFile(lock.lockFile, 'utf8'));
      if (payload?.token === lock.token) await unlink(lock.lockFile).catch(() => {});
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async persist(state) {
    const temporary = this.file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
      await this.writeFile(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      await this.rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async transaction(operation) {
    await this.load();
    let lock;
    try {
      let base = this.state;
      if (this.file) {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        lock = await this.acquireLock();
        const disk = await readDiskState(this.file);
        if (disk && disk.revision >= base.revision) base = disk;
      }
      const next = structuredClone(base);
      const identities = new Map(this.identities);
      const result = operation(next, identityIndex(next), identities);
      if (result.changed) {
        next.revision = Math.max(base.revision, this.state.revision) + 1;
        next.eventLog = next.eventLog.slice(-MAX_EVENT_LOG);
        if (this.file) await this.persist(next);
        this.state = next;
      } else {
        this.state = base;
      }
      // Publish neither state nor new identity hints until persistence succeeds.
      this.identities = identities;
      return { ...result.value, readVersion: this.state.revision };
    } finally {
      await this.releaseLock(lock);
    }
  }

  apply(events, readAfterExposures) {
    return this.transaction((next, index, identities) => {
      const seen = new Map(next.eventLog.map((event) => [event.eventId, event]));
      const timestamp = new Date(this.now()).toISOString();
      let accepted = 0;
      let duplicates = 0;
      let changed = false;
      for (const event of events) {
        const previous = seen.get(event.eventId);
        if (previous && (previous.type !== event.type || previous.articleKey !== event.articleKey)) {
          throw validationError('Event ID was already used for a different event', 409);
        }
        const resolved = resolveIdentity(next, index, identities, [event.articleKey], !previous);
        changed ||= resolved.changed;
        if (previous) {
          duplicates++;
          continue;
        }
        const record = next.articles[resolved.key];
        record.updatedAt = timestamp;
        if (event.type === 'exposure') {
          record.lastShownAt = timestamp;
          if (!record.firstReadAt) {
            record.exposureCount++;
            if (record.exposureCount >= readAfterExposures) {
              record.firstReadAt = timestamp;
              record.lastReadAt = timestamp;
              record.readReason = 'exposure';
            }
          }
        } else {
          if (!record.firstReadAt) record.firstReadAt = timestamp;
          record.lastReadAt = timestamp;
          record.readReason = event.type;
        }
        seen.set(event.eventId, event);
        // Keep the request key: changing it would break exact event-ID retry and
        // conflict semantics for clients still holding an older identity key.
        next.eventLog.push({ eventId: event.eventId, type: event.type, articleKey: event.articleKey });
        accepted++;
      }
      const exposureStates = {};
      for (const key of new Set(events.map((event) => event.articleKey))) {
        const canonical = index.get(key)?.values().next().value;
        exposureStates[key] = publicRecord(next.articles[canonical]);
      }
      return { changed: changed || accepted > 0, value: { accepted, duplicates, exposureStates } };
    });
  }

  recordEvents(input, { readAfterExposures = DEFAULT_READ_AFTER_EXPOSURES } = {}) {
    if (!Number.isSafeInteger(readAfterExposures) || readAfterExposures < 1 || readAfterExposures > 100) {
      return Promise.reject(new Error('readAfterExposures must be an integer between 1 and 100'));
    }
    let events;
    try {
      events = normalizeReadEvents({ events: input });
    } catch (error) {
      return Promise.reject(error);
    }
    const run = this.queue.then(() => this.apply(events, readAfterExposures));
    this.queue = run.catch(() => {});
    return run;
  }

  present(articles, { source, includeRead = false, trustedAliases = {} } = {}) {
    const run = this.queue.then(() => this.transaction((state, index, identities) => {
      const candidates = articles.map((article) => {
        const keys = articleKeysFor(article, source);
        // Only the Host candidate store supplies this separate channel, never RSS,
        // HTML attributes or a browser event. Keep persisted URL/ID bridges after restart.
        const aliases = Object.hasOwn(trustedAliases, keys[0]) ? trustedAliases[keys[0]] : [];
        if (!Array.isArray(aliases) || aliases.length > 32 || aliases.some(key => !isArticleKey(key) || key.split(':')[1] !== keys[0].split(':')[1])) {
          throw new Error('Invalid trusted candidate identity aliases');
        }
        for (const alias of aliases) if (!keys.includes(alias)) keys.push(alias);
        if (article.articleKey && isArticleKey(article.articleKey) && !keys.includes(article.articleKey)) keys.unshift(article.articleKey);
        return { article, keys };
      });
      let changed = false;
      for (const { keys } of candidates) {
        const resolved = resolveIdentity(state, index, identities, keys);
        changed ||= resolved.changed;
      }
      const items = [];
      const exposureStates = {};
      // Resolve after all merges so no earlier candidate exposes an obsolete key
      // or an unread snapshot of a record that was merged later in this batch.
      for (const { article, keys } of candidates) {
        const key = keys.map((candidate) => index.get(candidate)?.values().next().value).find(Boolean) || keys[0];
        const record = state.articles[key];
        if (!includeRead && record?.firstReadAt) continue;
        items.push({ ...article, articleKey: key });
        exposureStates[key] = publicRecord(record);
      }
      return { changed, value: { items, exposureStates } };
    }));
    this.queue = run.catch(() => {});
    return run;
  }
}
