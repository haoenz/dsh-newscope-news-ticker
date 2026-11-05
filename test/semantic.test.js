import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticDeduplicator } from '../lib/semantic.js';
import { NewsCache } from '../lib/index.js';

const items = [
  { id: 'a', title: 'Federal Reserve cuts rates by 25 basis points', source: 'Bloomberg', topics: ['Finance'], score: 9.5 },
  { id: 'b', title: 'US central bank lowers borrowing costs', source: 'Reuters', topics: ['Economy'], score: 8.8 },
  { id: 'c', title: 'New AI model released', source: 'Techmeme', topics: ['Technology'], score: 8.5 },
  { id: 'd', title: 'Researchers discover water on Mars', source: 'Quanta', topics: ['Science'], score: 8.1 },
];

async function temporaryCache(t) {
  const directory = await mkdtemp(join(tmpdir(), 'newscope-semantic-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'translations.json');
}

function fakeLlm(calls, handler) {
  return {
    async *stream(options) {
      calls.push(options);
      const payload = handler(options);
      yield { type: 'text-delta', index: 0, text: JSON.stringify(payload) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

test('disabled semantic dedup returns the identical array without model calls', async () => {
  const deduper = new SemanticDeduplicator({ llm: { stream() { throw new Error('must not call'); } } });
  assert.strictEqual(await deduper.deduplicate(items, { semanticDedupEnabled: false }), items);
});

test('cross-source semantic groups keep the first sorted representative and cache results', async () => {
  const calls = [];
  const llm = fakeLlm(calls, (options) => {
    assert.equal(options.provider, 'kt');
    assert.equal(options.model, 'semantic-model');
    const input = JSON.parse(options.messages[0].content[0].text).items;
    assert.deepEqual(input.map((item) => item.source), ['Bloomberg', 'Reuters', 'Techmeme', 'Quanta']);
    return { groups: [['1', '0'], ['2', '2'], ['9', '10']] };
  });
  const deduper = new SemanticDeduplicator({ llm });
  const config = { semanticDedupEnabled: true, semanticDedupModel: 'kt/semantic-model' };
  const output = await deduper.deduplicate(items, config);
  assert.deepEqual(output.map((article) => article.id), ['a', 'c', 'd']);
  assert.equal(calls.length, 1);

  const cached = await deduper.deduplicate(items, config);
  assert.deepEqual(cached.map((article) => article.id), ['a', 'c', 'd']);
  assert.equal(calls.length, 1);

  const changed = items.map((article, index) => index === 3 ? { ...article, title: 'A different science result' } : article);
  await deduper.deduplicate(changed, config);
  assert.equal(calls.length, 2);
});

test('malformed semantic ids invalidate their whole group without deleting articles', async () => {
  for (const invalid of [null, '', false, {}, '01', '-1', '1.5']) {
    const llm = fakeLlm([], () => ({ groups: [[invalid, '1']] }));
    const deduper = new SemanticDeduplicator({ llm });
    const output = await deduper.deduplicate(items, {
      semanticDedupEnabled: true,
      semanticDedupModel: 'kt/semantic-model',
    });
    assert.deepEqual(output, items);
  }
});

test('semantic model failures and malformed responses preserve local dedup results', async () => {
  const failing = new SemanticDeduplicator({
    llm: {
      async *stream() {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'offline' } } };
      },
    },
  });
  const output = await failing.deduplicate(items, { semanticDedupEnabled: true, semanticDedupModel: 'kt/semantic-model' });
  assert.deepEqual(output, items);

  const malformed = new SemanticDeduplicator({ llm: fakeLlm([], () => ({})) });
  assert.deepEqual(await malformed.deduplicate(items, { semanticDedupEnabled: true, semanticDedupModel: 'kt/semantic-model' }), items);
});

test('semantic dedup can reuse translationModel or use its own DSH route', async () => {
  const calls = [];
  const llm = fakeLlm(calls, () => ({ groups: [] }));
  const deduper = new SemanticDeduplicator({ llm });
  await deduper.deduplicate(items, {
    semanticDedupEnabled: true,
    semanticDedupModel: '',
    translationModel: 'kt/fallback-model',
  });
  assert.equal(calls[0].model, 'fallback-model');

  await deduper.deduplicate(items.map((article) => ({ ...article, title: article.title + ' updated' })), {
    semanticDedupEnabled: true,
    semanticDedupModel: 'kt/dedup-only',
    translationModel: 'kt/fallback-model',
  });
  assert.equal(calls[1].model, 'dedup-only');
});

test('semantic candidate analysis is capped at one hundred truncated titles', async () => {
  const calls = [];
  const llm = fakeLlm(calls, (options) => {
    const input = JSON.parse(options.messages[0].content[0].text).items;
    assert.equal(input.length, 100);
    assert.ok(input.every((item) => item.title.length <= 300));
    assert.ok(input.every((item) => item.source.length <= 100));
    assert.ok(input.every((item) => item.topics.every((topic) => topic.length <= 50)));
    return { groups: [] };
  });
  const input = Array.from({ length: 105 }, (_, index) => ({
    id: String(index),
    title: String(index) + 'x'.repeat(350),
    source: 's'.repeat(150),
    topics: ['t'.repeat(80)],
  }));
  const output = await new SemanticDeduplicator({ llm }).deduplicate(input, {
    semanticDedupEnabled: true,
    semanticDedupModel: 'kt/semantic-model',
  });
  assert.equal(output.length, 100);
  assert.equal(calls.length, 1);
});

test('Host deduplicates before translation and only translates the retained article', async (t) => {
  const translationCacheFile = await temporaryCache(t);
  const calls = [];
  const xml = '<?xml version="1.0"?><rss><channel>'
    + '<item><title>[9.5] Federal Reserve cuts rates by 25 basis points</title><link>https://bloomberg.com/one</link><guid>a</guid>'
    + '<pubDate>' + new Date().toUTCString() + '</pubDate><category>Finance</category></item>'
    + '<item><title>[8.8] US central bank lowers borrowing costs</title><link>https://reuters.com/two</link><guid>b</guid>'
    + '<pubDate>' + new Date().toUTCString() + '</pubDate><category>Finance</category></item>'
    + '</channel></rss>';
  const llm = fakeLlm(calls, (options) => {
    if (options.system.includes('Identify duplicate')) return { groups: [['1', '0']] };
    const input = JSON.parse(options.messages[0].content[0].text).items;
    assert.deepEqual(input.map((item) => item.title), ['Federal Reserve cuts rates by 25 basis points']);
    return { translations: [{ id: '0', title: '美联储降息' }] };
  });
  const cache = new NewsCache(async (url) => {
    if (url.includes('/api/v1/articles?')) return new Response(null, { status: 404 });
    if (url.includes('/api/v1/status')) return Response.json({ status: 'ok' });
    return new Response(xml, { status: 200 });
  }, { llm, translationCacheFile });
  const snapshot = await cache.snapshot({
    semanticDedupEnabled: true,
    semanticDedupModel: 'kt/semantic-model',
    translationEnabled: true,
    translationModel: 'kt/translation-model',
  });
  assert.equal(snapshot.service, 'ok');
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].title, '美联储降息');
  assert.equal(snapshot.items[0].url, 'https://bloomberg.com/one');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].system.includes('Identify duplicate'));
  assert.ok(calls[1].system.includes('Translate news headlines'));
});
