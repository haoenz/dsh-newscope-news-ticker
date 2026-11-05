import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../lib/config.js';
import { parseNewscopeArticles, scheduleArticles } from '../lib/news.js';

const NOW = Date.parse('2026-11-04T08:00:00Z');
const date = (hoursAgo) => new Date(NOW - hoursAgo * 3600_000).toUTCString();
const item = ({ id, title, url, score = 8, topics = [], age = 1 }) => `
  <item><title>[${score.toFixed(1)}] ${title}</title><link>${url}</link><guid>${id}</guid>
  <description>Score: ${score.toFixed(1)}/10 - relevant</description><pubDate>${date(age)}</pubDate>
  ${topics.map((topic) => `<category>${topic}</category>`).join('')}</item>`;
const feed = (items) => `<?xml version="1.0"?><rss><channel><title>Newscope</title>${items.join('')}</channel></rss>`;

test('parses actual Newscope RSS fields, filters, classifies and deduplicates', () => {
  const config = resolveConfig();
  const articles = parseNewscopeArticles(feed([
    item({ id: 'f1', title: '货币政策 &amp; 市场', url: 'https://feeds.bloomberg.com/story?utm_source=x#top', score: 9.2, topics: ['Economy'] }),
    item({ id: 'f1', title: 'duplicate GUID', url: 'https://example.com/duplicate', topics: ['Finance'] }),
    item({ id: 't1', title: 'A new LLM', url: 'https://news.ycombinator.com/item?id=1', topics: ['AI', 'LLM'] }),
    item({ id: 's1', title: 'Astronomy result', url: 'https://phys.org/story', topics: ['Astronomy'] }),
    item({ id: 'old', title: 'Old finance', url: 'https://example.com/old', topics: ['Finance'], age: 49 }),
    item({ id: 'low', title: 'Low score', url: 'https://example.com/low', score: 6.9, topics: ['Finance'] }),
    item({ id: 'bad', title: 'Unsafe URL', url: 'javascript:alert(1)', topics: ['Finance'] }),
    item({ id: 't2', title: 'A new LLM!', url: 'https://example.com/same-title', topics: ['Technology'] }),
  ]), config, NOW);

  assert.deepEqual(articles.map((a) => a.id), ['f1', 't1', 's1']);
  assert.equal(articles[0].title, '货币政策 & 市场');
  assert.equal(articles[0].category, 'finance');
  assert.equal(articles[0].source, 'Bloomberg');
  assert.equal(articles[0].url, 'https://feeds.bloomberg.com/story');
  assert.equal(articles[1].category, 'technology');
  assert.equal(articles[2].category, 'science');
});

test('source mapping is configurable and unknown topics fall back to general', () => {
  const config = resolveConfig({ sourceMap: { finance: ['example.com'] } });
  const [article] = parseNewscopeArticles(feed([
    item({ id: 'x', title: 'Custom source', url: 'https://example.com/story', topics: ['Unclassified phrase'] }),
  ]), config, NOW);
  assert.equal(article.category, 'finance');
});

test('smooth weighted scheduling reaches 55/25/15/5 with ample supply', () => {
  const articles = [];
  for (const category of ['finance', 'technology', 'science', 'general']) {
    for (let i = 0; i < 100; i++) articles.push({ id: `${category}-${i}`, category });
  }
  const scheduled = scheduleArticles(articles, { finance: 55, technology: 25, science: 15, general: 5 });
  assert.equal(scheduled.length, 100);
  const counts = Object.fromEntries(['finance', 'technology', 'science', 'general'].map((c) => [c, scheduled.filter((a) => a.category === c).length]));
  assert.deepEqual(counts, { finance: 55, technology: 25, science: 15, general: 5 });
  assert.equal(new Set(scheduled.map((a) => a.id)).size, 100);
});

test('empty categories yield their quota instead of forcing stale or low-score items', () => {
  const scheduled = scheduleArticles([
    { id: 'f', category: 'finance' },
    { id: 't1', category: 'technology' },
    { id: 't2', category: 'technology' },
    { id: 's', category: 'science' },
  ], { finance: 55, technology: 25, science: 15, general: 5 });
  assert.deepEqual(scheduled.map((a) => a.id).sort(), ['f', 's', 't1', 't2']);
  assert.equal(scheduleArticles([{ id: 'x', category: 'finance' }], { finance: 0, technology: 0, science: 0, general: 0 }).length, 0);
});
