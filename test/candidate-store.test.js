import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CandidateStore, defaultCandidateStoreFile } from '../lib/candidate-store.js';
import { articleKeyFor } from '../lib/article-identity.js';
import { defaultReadStateFile } from '../lib/read-state.js';

const NOW = Date.parse('2026-11-05T10:00:00Z');
const HOUR = 3600_000;
const SOURCE = 'https://newscope.test/base';
const OTHER = 'https://other.test/base';
const iso = (time) => new Date(time).toISOString();
const article = (id, extra = {}) => ({
  id: `rss-${id}`, title: `Article ${id}`, url: `https://news.test/${id}`,
  score: 7, publishedAt: iso(NOW - HOUR), topics: ['AI'], source: 'News', ...extra,
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'candidate-store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'inventory', 'candidate-inventory.json');
  const store = (options = {}) => new CandidateStore({ file, now: () => NOW, ...options });
  return { dir, file, store };
}

async function assertClean(file) {
  const entries = await readdir(dirname(file));
  assert.equal(entries.some((name) => name.endsWith('.tmp') || name.endsWith('.lock')), false, entries.join(', '));
}

test('default inventory is a separate sibling of read-state, without opening either file', () => {
  assert.equal(defaultCandidateStoreFile(), join(dirname(defaultReadStateFile()), 'candidate-inventory.json'));
  assert.notEqual(defaultCandidateStoreFile(), defaultReadStateFile());
});

test('memory mode is isolated, immutable to callers, and never calls persistence hooks', async () => {
  const store = new CandidateStore({ now: () => NOW, writeFile: () => assert.fail('disk write'), rename: () => assert.fail('rename') });
  assert.deepEqual(await store.snapshot(SOURCE), { articles: [], aliasesByKey: {}, firstCollectedAt: null, updatedAt: null, pruned: 0, retainedCount: 0 });
  const input = article(1);
  const pending = store.merge(SOURCE, [input]);
  input.title = 'mutated';
  const merged = await pending;
  assert.equal(merged.articles[0].title, 'Article 1');
  assert.equal(merged.firstCollectedAt, iso(NOW));
  merged.articles[0].topics.push('mutated');
  assert.deepEqual((await store.snapshot(SOURCE)).articles[0].topics, ['AI']);
  assert.equal((await new CandidateStore({ now: () => NOW }).snapshot(SOURCE)).retainedCount, 0);
});

test('restart accumulates RSS inventory, repeated or absent items do not delete history', async (t) => {
  const { file, store } = await fixture(t);
  const first = await store().merge(SOURCE, [article(1), article(2)]);
  const second = await store({ now: () => NOW + HOUR }).merge(SOURCE, [article(2, { title: 'updated' }), article(3)]);
  assert.equal(second.retainedCount, 3);
  assert.equal(second.firstCollectedAt, first.firstCollectedAt);
  assert.equal(second.updatedAt, iso(NOW + HOUR));
  assert.equal(second.pruned, 0);
  const thirdStore = store({ now: () => NOW + HOUR });
  assert.equal((await thirdStore.merge(SOURCE, [])).retainedCount, 3);
  assert.equal((await thirdStore.merge(SOURCE, [article(2, { title: 'updated' })])).retainedCount, 3);
  assert.equal((await thirdStore.snapshot(SOURCE)).articles.find((item) => item.id === 'rss-2').title, 'updated');
  assert.equal(first.firstCollectedAt, iso(NOW));
  assert.notEqual(first.firstCollectedAt, article(1).publishedAt);
  await assertClean(file);
});

test('API IDs upgrade URL identity and survive later RSS-only updates and restart', async (t) => {
  const { store } = await fixture(t);
  await store().merge(SOURCE, [article(1)]);
  const upgraded = await store().merge(SOURCE, [article(1, { newscopeId: 42 })]);
  assert.equal(upgraded.retainedCount, 1);
  assert.equal(upgraded.articles[0].newscopeId, '42');
  assert.equal(upgraded.articles[0].articleKey, articleKeyFor({ newscopeId: '42' }, SOURCE));
  const rss = await store().merge(SOURCE, [article(1, { title: 'RSS revision', articleKey: 'newscope:polluted:3' })]);
  assert.equal(rss.articles[0].title, 'RSS revision');
  assert.equal(rss.articles[0].id, '42');
  assert.equal(rss.articles[0].newscopeId, '42');
  assert.equal(rss.articles[0].articleKey, upgraded.articles[0].articleKey);
  assert.deepEqual((await store().snapshot(SOURCE)).articles, rss.articles);
});

test('URL and API aliases bridge records, changed URLs and changed API IDs without duplication', async (t) => {
  const { store } = await fixture(t);
  await store().merge(SOURCE, [article('old', { newscopeId: '7' }), article('new')]);
  let result = await store().merge(SOURCE, [article('new', { newscopeId: '7' })]);
  assert.equal(result.retainedCount, 1);
  result = await store().merge(SOURCE, [article('new', { newscopeId: '8' })]);
  assert.equal(result.articles[0].newscopeId, '8');
  result = await store().merge(SOURCE, [article('old')]);
  assert.equal(result.retainedCount, 1);
  assert.equal(result.articles[0].newscopeId, '8');
  result = await store().merge(SOURCE, [article('third', { newscopeId: '7' })]);
  assert.equal(result.retainedCount, 1);
  assert.equal(result.articles[0].newscopeId, '7');
});

test('normalized namespace isolation and URL canonicalization reject identity pollution', async () => {
  const store = new CandidateStore({ now: () => NOW });
  await store.merge('https://NEWSCOPE.test:443/base///?secret=x#fragment', [article(1, { newscopeId: '5', url: 'https://NEWS.test:443/1?b=2&utm_source=bad&a=1#frag' })]);
  const duplicate = await store.merge(SOURCE, [article(1, { url: 'https://news.test/1?a=1&b=2' })]);
  assert.equal(duplicate.retainedCount, 1);
  assert.equal(duplicate.articles[0].newscopeId, '5');
  assert.equal((await store.snapshot(OTHER)).retainedCount, 0);
  const other = await store.merge(OTHER, [article(1, { newscopeId: '5' })]);
  assert.notEqual(other.articles[0].articleKey, duplicate.articles[0].articleKey);
  assert.equal((await store.snapshot('https://newscope.test/another-path')).retainedCount, 0);
});

test('only bounded whitelisted metadata survives; invalid URLs, scores and future dates are dropped', async (t) => {
  const { file, store } = await fixture(t);
  const input = article(1, {
    title: 'T'.repeat(1999) + ' ' + 'x'.repeat(10), id: 'i'.repeat(5000), guid: 'g'.repeat(5000),
    source: 's'.repeat(300), category: 'c'.repeat(200),
    topics: Array.from({ length: 40 }, (_, i) => `${i}${'t'.repeat(300)}`),
    url: 'https://news.test/1?utm_source=private#fragment',
    articleKey: articleKeyFor({ newscopeId: '999' }, OTHER),
    description: 'FORBIDDEN-BODY', body: 'FORBIDDEN-BODY', content: 'FORBIDDEN-BODY',
    read: true, readCount: 5, replay: true, aliases: ['FORGED'], ignoredFunction: () => 'not metadata',
  });
  const invalid = [
    article(2, { score: -1 }), article(3, { score: 10.01 }), article(4, { score: '8' }),
    article(5, { score: NaN }), article(6, { score: Infinity }), article(7, { publishedAt: iso(NOW + 1) }),
    article(8, { publishedAt: 'yesterday' }), article(9, { url: 'javascript:alert(1)' }),
    article(10, { url: 'https://user:password@news.test/10' }), article(11, { title: '' }),
    article(12, { url: `https://news.test/${'a'.repeat(5000)}` }), null,
  ];
  const result = await store().merge(SOURCE, [input, ...invalid, article('zero', { score: 0 }), article('ten', { score: 10 })]);
  assert.equal(result.retainedCount, 3);
  const saved = result.articles.find((item) => item.url === 'https://news.test/1');
  assert.equal(saved.title.length, 1999);
  assert.equal(saved.id.length, 4096);
  assert.equal(saved.guid.length, 4096);
  assert.equal(saved.source.length, 200);
  assert.equal(saved.category.length, 100);
  assert.equal(saved.topics.length, 12);
  assert.ok(saved.topics.every((topic) => topic.length <= 200));
  assert.equal(saved.articleKey, articleKeyFor(saved, SOURCE));
  for (const key of ['body', 'description', 'content', 'read', 'readCount', 'replay', 'aliases']) assert.equal(key in saved, false);
  assert.equal((await readFile(file, 'utf8')).includes('FORBIDDEN-BODY'), false);
  assert.equal((await store().snapshot(SOURCE)).retainedCount, 3);
});

test('retention is at least eight days, configurable age plus 24h, and capped at 31 days', async () => {
  for (const [maxAgeHours, keepHours] of [[1, 192], [168, 192], [240, 264], [2000, 744]]) {
    const store = new CandidateStore({ now: () => NOW });
    const result = await store.merge(SOURCE, [
      article('boundary', { publishedAt: iso(NOW - keepHours * HOUR) }),
      article('expired', { publishedAt: iso(NOW - keepHours * HOUR - 1) }),
      article('fresh'),
    ], { maxAgeHours });
    assert.equal(result.retainedCount, 2, `${maxAgeHours}h`);
    assert.equal(result.pruned, 1);
    const later = await store.snapshot(SOURCE, { now: NOW + 1, maxAgeHours });
    assert.equal(later.retainedCount, 1);
    assert.equal(later.pruned, 1);
    assert.equal(later.updatedAt, iso(NOW));
    assert.equal(later.firstCollectedAt, iso(NOW));
  }
});

test('snapshot expiry is durable and never edits a separate read-state fixture or its lock', async (t) => {
  const { file, store } = await fixture(t);
  await store().merge(SOURCE, [article(1)]);
  const readState = join(dirname(file), 'read-state.json');
  await writeFile(readState, 'test-only read-state sentinel');
  await writeFile(`${readState}.lock`, 'independent read lock');
  const result = await store({ now: () => NOW + 9 * 24 * HOUR }).snapshot(SOURCE);
  assert.equal(result.pruned, 1);
  assert.equal(result.retainedCount, 0);
  assert.equal(result.firstCollectedAt, iso(NOW));
  assert.equal((await store({ now: () => NOW + 9 * 24 * HOUR }).snapshot(SOURCE)).pruned, 0);
  assert.equal(await readFile(readState, 'utf8'), 'test-only read-state sentinel');
  assert.equal(await readFile(`${readState}.lock`, 'utf8'), 'independent read lock');
});

test('global count cap evicts oldest publications across sources, not per source', async (t) => {
  const { store } = await fixture(t);
  await store({ maxItems: 3 }).merge(SOURCE, [article('a', { publishedAt: iso(NOW - 5 * HOUR) }), article('b', { publishedAt: iso(NOW - 4 * HOUR) })]);
  const result = await store({ maxItems: 3 }).merge(OTHER, [article('c'), article('d', { publishedAt: iso(NOW) })]);
  assert.equal(result.pruned, 1);
  assert.equal(result.retainedCount, 2);
  assert.deepEqual((await store({ maxItems: 3 }).snapshot(SOURCE)).articles.map((item) => item.id), ['rss-b']);
});

test('item and byte hard limits cannot be enlarged through options', async (t) => {
  const { file, store } = await fixture(t);
  const instance = store({ maxItems: 50_000, maxBytes: 50 * 1024 * 1024 });
  assert.equal(instance.maxItems, 5000);
  assert.equal(instance.maxBytes, 20 * 1024 * 1024);
  const result = await instance.merge(SOURCE, Array.from({ length: 5005 }, (_, i) => article(i, { publishedAt: iso(NOW - i) })));
  assert.equal(result.retainedCount, 5000);
  assert.equal(result.pruned, 5);
  assert.equal(result.articles[0].id, 'rss-0');
  assert.equal(result.articles.at(-1).id, 'rss-4999');
  assert.ok((await stat(file)).size <= 20 * 1024 * 1024);
});

test('byte cap includes UTF-8 metadata and namespace overhead, prioritizing newest records', async (t) => {
  const { file, store } = await fixture(t);
  const maxBytes = 2200;
  await store({ maxBytes }).merge(SOURCE, [article('old', { publishedAt: iso(NOW - 2 * HOUR), title: '旧'.repeat(200) })]);
  const result = await store({ maxBytes }).merge(OTHER, [article('new', { title: '新'.repeat(200) })]);
  assert.equal(result.retainedCount, 1);
  assert.equal(result.pruned, 1);
  assert.equal((await store({ maxBytes }).snapshot(SOURCE)).retainedCount, 0);
  assert.ok((await stat(file)).size <= maxBytes);
  for (let i = 0; i < 30; i++) await store({ maxBytes }).merge(`https://empty-${i}.test`, []);
  assert.ok((await stat(file)).size <= maxBytes);
  const disk = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(Object.keys(disk.sources).length < 30);
});

test('20 MiB hard cap is enforced on actual persisted multilingual metadata', async (t) => {
  const { file, store } = await fixture(t);
  const result = await store().merge(SOURCE, Array.from({ length: 3600 }, (_, i) => article(i, { title: '文'.repeat(2000), publishedAt: iso(NOW - i) })));
  assert.ok(result.retainedCount < 3600);
  assert.ok(result.retainedCount > 1000);
  assert.equal(result.articles[0].id, 'rss-0');
  assert.equal(result.pruned, 3600 - result.retainedCount);
  assert.ok((await stat(file)).size <= 20 * 1024 * 1024);
  assert.equal((await store().snapshot(SOURCE)).retainedCount, result.retainedCount);
});

test('snapshot without pruning does not rewrite data or advance collection timestamps', async (t) => {
  const { file, store } = await fixture(t);
  await store().merge(SOURCE, [article(1)]);
  const before = await stat(file);
  const result = await store({ now: () => NOW + HOUR, writeFile: () => assert.fail('unexpected rewrite') }).snapshot(SOURCE, { maxAgeHours: 300 });
  assert.equal(result.updatedAt, iso(NOW));
  assert.equal(result.firstCollectedAt, iso(NOW));
  assert.equal(result.pruned, 0);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
});

test('malformed JSON, unsupported versions, and contaminated records fail closed without overwrite', async (t) => {
  const { file, store } = await fixture(t);
  await store().merge(SOURCE, [article(1, { newscopeId: '42' })]);
  const valid = JSON.parse(await readFile(file, 'utf8'));
  const corruptions = [
    () => '{broken',
    (state) => { state.version = 99; },
    (state) => { state.sources = []; },
    (state) => { state.sources[SOURCE].firstCollectedAt = iso(NOW + 1); },
    (state) => { state.sources[SOURCE].retentionHours = 1000; },
    (state) => { state.sources[SOURCE].items[0].article.score = 11; },
    (state) => { state.sources[SOURCE].items[0].article.publishedAt = iso(NOW + 1); },
    (state) => { state.sources[SOURCE].items[0].article.description = 'forbidden'; },
    (state) => { state.sources[SOURCE].items[0].article.articleKey = articleKeyFor(article(1), OTHER); },
    (state) => { state.sources[SOURCE].items[0].aliases.push(articleKeyFor(article(1), OTHER)); },
    (state) => { state.sources[SOURCE].items.push(structuredClone(state.sources[SOURCE].items[0])); },
    (state) => { state.sources[`${SOURCE}/`] = state.sources[SOURCE]; delete state.sources[SOURCE]; },
  ];
  const cached = store();
  await cached.snapshot(SOURCE);
  for (const corrupt of corruptions) {
    const state = structuredClone(valid);
    const raw = corrupt(state) || JSON.stringify(state);
    await writeFile(file, raw);
    await assert.rejects(() => cached.snapshot(SOURCE), { code: 'CANDIDATE_STATE_UNAVAILABLE' });
    await assert.rejects(() => cached.merge(SOURCE, [article(2)]), /Invalid candidate inventory/);
    assert.equal(await readFile(file, 'utf8'), raw);
    await assertClean(file);
  }
  // Recovery is explicit; restoring the fixture permits the same store to retry.
  await writeFile(file, JSON.stringify(valid));
  assert.equal((await cached.snapshot(SOURCE)).retainedCount, 1);
});

test('oversize existing inventory fails closed instead of being treated as missing', async (t) => {
  const { file, store } = await fixture(t);
  await mkdir(dirname(file));
  await writeFile(file, ' '.repeat(20 * 1024 * 1024 + 1));
  await assert.rejects(() => store().merge(SOURCE, [article(1)]), { code: 'CANDIDATE_STATE_UNAVAILABLE' });
  assert.equal((await stat(file)).size, 20 * 1024 * 1024 + 1);
  await assertClean(file);
});

test('write and rename failures leave disk and memory uncommitted, clean artifacts, and allow retry', async (t) => {
  for (const stage of ['write', 'rename']) {
    await t.test(stage, async (t) => {
      const { file, store } = await fixture(t);
      let failing = false;
      const instance = store({
        writeFile: async (...args) => {
          if (failing && stage === 'write') { await writeFile(args[0], 'partial', args[2]); throw new Error('injected write failure'); }
          return writeFile(...args);
        },
        rename: async (...args) => { if (failing && stage === 'rename') throw new Error('injected rename failure'); return rename(...args); },
      });
      await instance.merge(SOURCE, [article(1)]);
      const before = await readFile(file, 'utf8');
      const memory = structuredClone(instance.state);
      failing = true;
      await assert.rejects(() => instance.merge(SOURCE, [article(2)]), /injected/);
      assert.deepEqual(instance.state, memory);
      assert.equal(await readFile(file, 'utf8'), before);
      assert.equal((await store().snapshot(SOURCE)).retainedCount, 1);
      await assertClean(file);
      failing = false;
      assert.equal((await instance.merge(SOURCE, [article(2)])).retainedCount, 2);
    });
  }
});

test('failure on first write does not invent collection metadata', async (t) => {
  const { file, store } = await fixture(t);
  const instance = store({ writeFile: async () => { throw new Error('disk full'); } });
  await assert.rejects(() => instance.merge(SOURCE, [article(1)]), /disk full/);
  assert.deepEqual(instance.state, { version: 1, sources: {} });
  await assert.rejects(() => stat(file), { code: 'ENOENT' });
  assert.equal((await instance.snapshot(SOURCE)).firstCollectedAt, null);
  await assertClean(file);
});

test('private directory, temporary file, lock and renamed destination modes are enforced', async (t) => {
  const { file, store } = await fixture(t);
  await mkdir(dirname(file), { mode: 0o777 });
  await chmod(dirname(file), 0o777);
  let inspected = false;
  const instance = store({
    writeFile: async (temporary, payload, options) => {
      assert.equal(options.mode, 0o600);
      assert.equal(options.flag, 'wx');
      await writeFile(temporary, payload, options);
      assert.equal((await stat(temporary)).mode & 0o777, 0o600);
      assert.equal((await stat(`${file}.lock`)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(file))).mode & 0o777, 0o700);
      inspected = true;
    },
  });
  await instance.merge(SOURCE, [article(1)]);
  assert.ok(inspected);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await chmod(file, 0o666);
  await instance.snapshot(SOURCE);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assertClean(file);
});

test('symlink destination and immediate directory are rejected, not overwritten or traversed', async (t) => {
  const { dir, file, store } = await fixture(t);
  await mkdir(dirname(file));
  const target = join(dir, 'untouched');
  await writeFile(target, 'untouched');
  await symlink(target, file);
  await assert.rejects(() => store().merge(SOURCE, [article(1)]), /ELOOP/);
  assert.equal(await readFile(target, 'utf8'), 'untouched');
  await assertClean(file);
  const linkDir = join(dir, 'linked');
  await symlink(dirname(file), linkDir);
  await assert.rejects(() => store({ file: join(linkDir, 'second.json') }).merge(SOURCE, [article(1)]), /must not be a symlink/);
});

test('cross-store and same-store concurrent merges reload under their independent lock', async (t) => {
  const { file, store } = await fixture(t);
  const shared = store();
  await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? shared : store()).merge(i % 3 ? SOURCE : OTHER, [article(i)])));
  const left = await store().snapshot(SOURCE);
  const right = await store().snapshot(OTHER);
  assert.equal(left.retainedCount, 20);
  assert.equal(right.retainedCount, 10);
  await assertClean(file);
});

test('independent processes merge without lost updates and exit without dirty locks', async (t) => {
  const { file, store } = await fixture(t);
  const moduleUrl = new URL('../lib/candidate-store.js', import.meta.url).href;
  const run = promisify(execFile);
  await Promise.all(Array.from({ length: 4 }, (_, batch) => run(process.execPath, ['--input-type=module', '-e', `
    import { CandidateStore } from ${JSON.stringify(moduleUrl)};
    const store = new CandidateStore({ file: ${JSON.stringify(file)}, now: () => ${NOW} });
    for (let i = 0; i < 5; i++) {
      await store.merge(${JSON.stringify(SOURCE)}, [{
        id: String(${batch} * 5 + i), title: 'process article',
        url: 'https://news.test/process/' + (${batch} * 5 + i), score: 8,
        publishedAt: ${JSON.stringify(iso(NOW - HOUR))}
      }]);
    }
  `], { timeout: 15_000 })) );
  assert.equal((await store().snapshot(SOURCE)).retainedCount, 20);
  await assertClean(file);
});

test('lock timeout does not steal another writer lock; explicit recovery can retry', async (t) => {
  const { file, store } = await fixture(t);
  await mkdir(dirname(file));
  const lock = JSON.stringify({ token: 'another-writer', pid: process.pid });
  await writeFile(`${file}.lock`, lock, { mode: 0o600 });
  const instance = store({ lockTimeoutMs: 1 });
  await assert.rejects(() => instance.merge(SOURCE, [article(1)]), /Timed out waiting for the candidate inventory lock/);
  assert.equal(await readFile(`${file}.lock`, 'utf8'), lock);
  await rm(`${file}.lock`);
  assert.equal((await instance.merge(SOURCE, [article(1)])).retainedCount, 1);
  await assertClean(file);
});

test('failed snapshot pruning leaves memory and disk intact until a successful retry', async (t) => {
  const { file, store } = await fixture(t);
  let fail = false;
  const instance = store({ rename: async (...args) => {
    if (fail) throw new Error('pruning rename failure');
    return rename(...args);
  } });
  await instance.merge(SOURCE, [article(1)]);
  const before = await readFile(file, 'utf8');
  const memory = structuredClone(instance.state);
  fail = true;
  await assert.rejects(() => instance.snapshot(SOURCE, { now: NOW + 9 * 24 * HOUR }), /pruning rename failure/);
  assert.deepEqual(instance.state, memory);
  assert.equal(await readFile(file, 'utf8'), before);
  await assertClean(file);
  fail = false;
  assert.equal((await instance.snapshot(SOURCE, { now: NOW + 9 * 24 * HOUR })).pruned, 1);
});

test('identity alias bound fails atomically instead of silently forgetting identity history', async (t) => {
  const { file, store } = await fixture(t);
  const instance = store();
  await instance.merge(SOURCE, Array.from({ length: 31 }, (_, i) => article(i, { newscopeId: '1' })));
  const before = await readFile(file, 'utf8');
  assert.equal((await instance.snapshot(SOURCE)).retainedCount, 1);
  await assert.rejects(() => instance.merge(SOURCE, [article(32, { newscopeId: '1' })]), /alias limit exceeded/);
  assert.equal(await readFile(file, 'utf8'), before);
  await assertClean(file);
  assert.equal((await instance.merge(SOURCE, [article(0)])).retainedCount, 1);
});

test('global pruning honors each inactive source retention policy', async (t) => {
  const { store } = await fixture(t);
  await store().merge(SOURCE, [article('long', { publishedAt: iso(NOW - 20 * 24 * HOUR) })], { maxAgeHours: 30 * 24 });
  await store().merge(OTHER, [article('short')]);
  const result = await store({ now: () => NOW + 9 * 24 * HOUR }).merge('https://third.test', []);
  assert.equal(result.pruned, 1);
  assert.equal((await store({ now: () => NOW + 9 * 24 * HOUR }).snapshot(SOURCE, { maxAgeHours: 30 * 24 })).retainedCount, 1);
  assert.equal((await store({ now: () => NOW + 9 * 24 * HOUR }).snapshot(OTHER)).retainedCount, 0);
});

test('invalid arguments are rejected before persistence', async () => {
  for (const options of [{ maxItems: 0 }, { maxItems: 1.5 }, { maxBytes: 100 }, { lockTimeoutMs: -1 }, { now: 0 }, { file: '' }]) {
    assert.throws(() => new CandidateStore(options), TypeError);
  }
  const store = new CandidateStore({ now: () => NOW });
  await assert.rejects(() => store.snapshot('file:///tmp/source'), TypeError);
  await assert.rejects(() => store.snapshot(SOURCE, { now: NaN }), TypeError);
  await assert.rejects(() => store.snapshot(SOURCE, { maxAgeHours: -1 }), TypeError);
  await assert.rejects(() => store.merge(SOURCE, {}), TypeError);
});
