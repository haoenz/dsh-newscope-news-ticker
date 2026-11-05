import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TitleTranslator } from '../lib/translate.js';
import { NewsCache } from '../lib/index.js';

const config = {
  translationEnabled: true,
  translationModel: 'kt/test-translator',
};

const articles = [
  { id: 'one', title: 'Federal Reserve cuts rates', url: 'https://example.com/one' },
  { id: 'zh', title: '已经是中文的标题', url: 'https://example.com/zh' },
  { id: 'two', title: 'New AI model released', url: 'https://example.com/two' },
  { id: 'mixed', title: 'Breaking 新闻: Federal Reserve cuts rates', url: 'https://example.com/mixed' },
  { id: 'ja', title: '日銀が利上げを決定', url: 'https://example.com/ja' },
];

const chineseTitles = {
  'Federal Reserve cuts rates': '美联储降息',
  'New AI model released': '新AI模型发布',
  'A new market event': '市场出现新事件',
  'Breaking 新闻: Federal Reserve cuts rates': '重大新闻：美联储降息',
  'English headline': '英文新闻标题',
  '日銀が利上げを決定': '日本央行决定加息',
};

function translationFor(title) {
  return chineseTitles[title] || '中文新闻标题';
}

async function temporaryCache(t) {
  const directory = await mkdtemp(join(tmpdir(), 'newscope-translation-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'translations.json');
}

function successfulLlm(calls) {
  return {
    async *stream(options) {
      calls.push(options);
      assert.equal(options.provider, 'kt');
      assert.equal(options.model, 'test-translator');
      assert.equal(options.temperature, 0);
      const items = JSON.parse(options.messages[0].content[0].text).items;
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          translations: items.map((item) => ({ id: item.id, title: translationFor(item.title) })),
        }),
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

test('uses the selected DSH model and reuses persistent cache without an LLM service', async (t) => {
  const cacheFile = await temporaryCache(t);
  const calls = [];
  const translator = new TitleTranslator({ llm: successfulLlm(calls), cacheFile });
  const translated = await translator.translate(articles, config);
  assert.deepEqual(translated.map((article) => article.id), ['one', 'zh', 'two', 'mixed', 'ja']);
  assert.equal(translated[0].title, '美联储降息');
  assert.equal(translated[0].originalTitle, 'Federal Reserve cuts rates');
  assert.equal(translated[1].title, '已经是中文的标题');
  assert.equal(calls.length, 1);
  const items = JSON.parse(calls[0].messages[0].content[0].text).items;
  assert.deepEqual(items.map((item) => item.title), ['Federal Reserve cuts rates', 'New AI model released', 'Breaking 新闻: Federal Reserve cuts rates', '日銀が利上げを決定']);

  const cached = new TitleTranslator({ cacheFile });
  const restored = await cached.translate(articles, config);
  assert.deepEqual(restored.map((article) => article.title), translated.map((article) => article.title));
});

test('failed or non-Chinese translations never leak English titles', async (t) => {
  const cacheFile = await temporaryCache(t);
  const failing = new TitleTranslator({
    cacheFile,
    llm: {
      async *stream() {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'offline' } } };
      },
    },
  });
  const partial = await failing.translate(articles, config);
  assert.deepEqual(partial.map((article) => article.id), ['zh']);
  await assert.rejects(failing.translate([articles[0]], config), /offline/);

  const invalid = new TitleTranslator({
    cacheFile,
    llm: {
      async *stream() {
        yield {
          type: 'text-delta',
          index: 0,
          text: JSON.stringify({ translations: [{ id: '0', title: '中文：Federal Reserve cuts rates' }] }),
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  });
  assert.deepEqual(await invalid.translate([articles[0]], config), []);
});

test('Host integration keeps Chinese stale cache but not across DSH model changes', async (t) => {
  const cacheFile = await temporaryCache(t);
  let failTranslation = false;
  const calls = [];
  const llm = {
    async *stream(options) {
      calls.push(options);
      if (failTranslation) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'offline' } } };
        return;
      }
      const items = JSON.parse(options.messages[0].content[0].text).items;
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          translations: items.map((item) => ({ id: item.id, title: translationFor(item.title) })),
        }),
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  let headline = 'Federal Reserve cuts rates';
  const xml = () => '<?xml version="1.0"?><rss><channel><item>'
    + '<title>[8.8] ' + headline + '</title><link>https://example.com/news</link><guid>one</guid>'
    + '<description>Score: 8.8/10</description><pubDate>' + new Date().toUTCString() + '</pubDate><category>Finance</category>'
    + '</item></channel></rss>';
  const fetchImpl = async (url) => {
    if (url.includes('/api/v1/articles?')) return new Response(null, { status: 404 });
    if (url.includes('/api/v1/status')) return Response.json({ status: 'ok', version: 'test' });
    return new Response(xml(), { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  };
  const cache = new NewsCache(fetchImpl, { llm, translationCacheFile: cacheFile });
  const first = await cache.snapshot(config);
  assert.equal(first.service, 'ok');
  assert.equal(first.items[0].title, '美联储降息');
  assert.equal('translationApiKeyEnv' in first.config, false);
  assert.equal('translationEndpoint' in first.config, false);

  failTranslation = true;
  headline = 'A new market event';
  cache.cache.fetchedAt = Date.now() - 600000;
  const stale = await cache.snapshot(config);
  assert.equal(stale.service, 'cache');
  assert.equal(stale.items[0].title, '美联储降息');

  const changed = await cache.snapshot({ ...config, translationModel: 'kt/other-model' });
  assert.equal(changed.service, 'unavailable');
  assert.deepEqual(changed.items, []);
  assert.ok(calls.length >= 2);
});

test('concurrent translation settings never share in-flight articles', async (t) => {
  const cacheFile = await temporaryCache(t);
  let markStarted;
  let releaseTranslation;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseTranslation = resolve; });
  const llm = {
    async *stream() {
      markStarted();
      await gate;
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ translations: [{ id: '0', title: '中文标题' }] }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const xml = '<?xml version="1.0"?><rss><channel><item>'
    + '<title>[8.8] English headline</title><link>https://example.com/news</link><guid>one</guid>'
    + '<description>Score: 8.8/10</description><pubDate>' + new Date().toUTCString() + '</pubDate><category>Finance</category>'
    + '</item></channel></rss>';
  const cache = new NewsCache(async (url) => {
    if (url.includes('/api/v1/articles?')) return new Response(null, { status: 404 });
    if (url.includes('/api/v1/status')) return Response.json({ status: 'ok' });
    return new Response(xml, { status: 200 });
  }, { llm, translationCacheFile: cacheFile });

  const enabledRequest = cache.snapshot(config);
  await started;
  let timer;
  try {
    const disabled = await Promise.race([
      cache.snapshot({ translationEnabled: false }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('disabled request shared the translation request')), 500); }),
    ]);
    assert.equal(disabled.items[0].title, 'English headline');
  } finally {
    clearTimeout(timer);
    releaseTranslation();
  }
  const enabled = await enabledRequest;
  assert.equal(enabled.items[0].title, '中文标题');
});

test('different settings completing together still return their own loaded snapshot', async (t) => {
  const cacheFile = await temporaryCache(t);
  const llm = {
    async *stream() {
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ translations: [{ id: '0', title: '中文标题' }] }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const xml = '<?xml version="1.0"?><rss><channel><item>'
    + '<title>[8.8] English headline</title><link>https://example.com/news</link><guid>one</guid>'
    + '<description>Score: 8.8/10</description><pubDate>' + new Date().toUTCString() + '</pubDate><category>Finance</category>'
    + '</item></channel></rss>';
  let releaseFeeds;
  let markBothStarted;
  let rssStarts = 0;
  const feedGate = new Promise((resolve) => { releaseFeeds = resolve; });
  const bothStarted = new Promise((resolve) => { markBothStarted = resolve; });
  const cache = new NewsCache(async (url) => {
    if (url.includes('/api/v1/articles?')) return new Response(null, { status: 404 });
    if (url.includes('/api/v1/status')) return Response.json({ status: 'ok' });
    rssStarts += 1;
    if (rssStarts === 2) markBothStarted();
    await feedGate;
    return new Response(xml, { status: 200 });
  }, { llm, translationCacheFile: cacheFile });

  const disabledRequest = cache.snapshot({ translationEnabled: false });
  const enabledRequest = cache.snapshot(config);
  await bothStarted;
  releaseFeeds();
  const [disabled, enabled] = await Promise.all([disabledRequest, enabledRequest]);
  assert.equal(disabled.items[0].title, 'English headline');
  assert.equal(enabled.items[0].title, '中文标题');
});

test('disabled title translation returns the identical array without LLM or cache I/O', async () => {
  const translator = new TitleTranslator({
    cacheFile: join(tmpdir(), 'newscope-cache-must-not-be-read'),
    llm: { stream() { throw new Error('must not call LLM'); } },
  });
  const input = [articles[0]];
  assert.strictEqual(await translator.translate(input, { translationEnabled: false }), input);
});

test('translation work is capped at one hundred titles and ten batches', async (t) => {
  const cacheFile = await temporaryCache(t);
  let calls = 0;
  const llm = {
    async *stream(options) {
      calls += 1;
      const items = JSON.parse(options.messages[0].content[0].text).items;
      assert.ok(items.length <= 10);
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({ translations: items.map((item) => ({ id: item.id, title: '中文新闻标题' + item.id })) }),
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const input = Array.from({ length: 105 }, (_, index) => ({ id: String(index), title: 'English headline ' + index }));
  const output = await new TitleTranslator({ llm, cacheFile }).translate(input, config);
  assert.equal(output.length, 100);
  assert.equal(calls, 10);
});

test('concurrent models and translator instances merge persistent cache writes', async (t) => {
  const cacheFile = await temporaryCache(t);
  const makeLlm = () => ({
    async *stream(options) {
      const items = JSON.parse(options.messages[0].content[0].text).items;
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({ translations: items.map((item) => ({ id: item.id, title: translationFor(item.title) })) }),
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  const left = new TitleTranslator({ llm: makeLlm(), cacheFile });
  const right = new TitleTranslator({ llm: makeLlm(), cacheFile });
  await Promise.all([left.loadCache(), right.loadCache()]);
  await Promise.all([
    left.translate([{ id: 'left', title: 'Headline A' }], config),
    right.translate([{ id: 'right', title: 'Headline B' }], { ...config, translationModel: 'kt/other-model' }),
  ]);
  const stored = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.equal(Object.keys(stored.entries).length, 2);
  assert.deepEqual(Object.values(stored.entries).map((entry) => entry.originalTitle).sort(), ['Headline A', 'Headline B']);
});

test('DSH streams are assembled by block and require a normal finish', async (t) => {
  const cacheFile = await temporaryCache(t);
  const first = '{"translations":[{"id":"0","title":"美联储';
  const second = '降息"}]}';
  const assembled = new TitleTranslator({
    cacheFile,
    llm: {
      async *stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-start', index: 1, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'discarded partial text' };
        yield { type: 'block-end', index: 1, block: { type: 'text', text: second } };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: first } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  });
  const output = await assembled.translate([articles[0]], config);
  assert.equal(output[0].title, '美联储降息');

  const noFinish = new TitleTranslator({
    cacheFile,
    llm: { async *stream() { yield { type: 'text-delta', index: 0, text: first + second }; } },
  });
  await assert.rejects(noFinish.translate([{ id: 'no-finish', title: 'No finish headline' }], config), /finish/);

  const maxTokens = new TitleTranslator({
    cacheFile,
    llm: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: first + second };
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
      },
    },
  });
  await assert.rejects(maxTokens.translate([{ id: 'max-tokens', title: 'Maximum tokens headline' }], config), /max-tokens/);

  const toolCall = new TitleTranslator({
    cacheFile,
    llm: { async *stream() { yield { type: 'block-start', index: 0, blockType: 'tool-call' }; } },
  });
  await assert.rejects(toolCall.translate([{ id: 'tool-call', title: 'Tool call headline' }], config), /text only/);
});

test('blank model settings follow the current DSH default and invalidate its old cache route', async (t) => {
  const cacheFile = await temporaryCache(t);
  const selection = { provider: 'kt', model: 'deepseek-flash' };
  const calls = [];
  const llm = {
    async *stream(options) {
      calls.push(options);
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ translations: [{ id: '0', title: '中文标题' }] }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const xml = '<?xml version="1.0"?><rss><channel><item>'
    + '<title>[8.8] English headline</title><link>https://example.com/news</link><guid>one</guid>'
    + '<description>Score: 8.8/10</description><pubDate>' + new Date().toUTCString() + '</pubDate><category>Finance</category>'
    + '</item></channel></rss>';
  const cache = new NewsCache(async (url) => {
    if (url.includes('/api/v1/articles?')) return new Response(null, { status: 404 });
    if (url.includes('/api/v1/status')) return Response.json({ status: 'ok' });
    return new Response(xml, { status: 200 });
  }, {
    llm,
    defaultModel: { currentSelection: () => ({ ...selection }) },
    translationCacheFile: cacheFile,
  });
  const config = { translationEnabled: true, translationModel: '' };
  const first = await cache.snapshot(config);
  assert.equal(first.service, 'ok');
  assert.equal(calls[0].provider, 'kt');
  assert.equal(calls[0].model, 'deepseek-flash');

  selection.model = 'other-model';
  cache.cache.fetchedAt = Date.now() - 600000;
  const second = await cache.snapshot(config);
  assert.equal(second.service, 'ok');
  assert.equal(calls.length, 2, 'changing the default model must select a new cache route');
  assert.equal(calls[1].model, 'other-model');
});
