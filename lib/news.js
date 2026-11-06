import { XMLParser } from 'fast-xml-parser';
import { decodeHTML } from 'entities';
import { CATEGORIES } from './config.js';
import { articleKeyFor, normalizeArticleUrl } from './article-identity.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === 'item' || name === 'entry' || name === 'category',
});

const SOURCE_NAMES = {
  'feeds.bloomberg.com': 'Bloomberg',
  'bloomberg.com': 'Bloomberg',
  'wallstreetcn.com': '华尔街见闻',
  'cls.cn': '财联社',
  'techmeme.com': 'Techmeme',
  'news.ycombinator.com': 'Hacker News',
  'hnrss.org': 'Hacker News',
  '36kr.com': '36氪',
  'quantamagazine.org': 'Quanta Magazine',
  'phys.org': 'Phys.org',
  'feeds.bbci.co.uk': 'BBC World',
  'bbc.com': 'BBC',
  'bbc.co.uk': 'BBC',
};

function textOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (typeof value === 'object') return textOf(value['#text'] ?? value.text ?? value['@_href'] ?? '');
  return '';
}

function atomLink(value) {
  const links = Array.isArray(value) ? value : [value];
  const selected = links.find((link) => link?.['@_rel'] === 'alternate') || links[0];
  return textOf(selected?.['@_href'] ?? selected);
}

function sourceName(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const [pattern, name] of Object.entries(SOURCE_NAMES)) {
      const normalized = pattern.replace(/^www\./, '');
      if (hostname === normalized || hostname.endsWith(`.${normalized}`)) return name;
    }
    return hostname || 'Newscope';
  } catch {
    return 'Newscope';
  }
}

function matchesAny(value, patterns) {
  const haystack = String(value || '').toLocaleLowerCase();
  return (patterns || []).some((pattern) => {
    const needle = String(pattern).trim().toLocaleLowerCase();
    return needle && haystack.includes(needle);
  });
}

export function classifyArticle(article, config) {
  const topics = article.topics.join(' ');
  for (const category of CATEGORIES) {
    if (matchesAny(topics, config.topicMap[category])) return category;
  }
  const source = `${article.source} ${article.url}`;
  for (const category of CATEGORIES) {
    if (matchesAny(source, config.sourceMap[category])) return category;
  }
  return 'general';
}

function titleKey(title) {
  return title.toLocaleLowerCase().normalize('NFKC').replace(/[\p{P}\p{S}\s]+/gu, '');
}

function titleTokens(title) {
  return new Set(title.toLocaleLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || []);
}

function nearDuplicate(left, right) {
  const a = titleKey(left);
  const b = titleKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 18 && (a.includes(b) || b.includes(a))) return true;
  const ta = titleTokens(left);
  const tb = titleTokens(right);
  if (ta.size < 4 || tb.size < 4) return false;
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection++;
  return intersection / Math.min(ta.size, tb.size) >= 0.85;
}

export function parseNewscopeArticles(xml, config, now = Date.now()) {
  const document = xmlParser.parse(xml);
  const channel = document.rss?.channel;
  const entries = channel?.item || document.feed?.entry || [];
  const cutoff = now - config.maxAgeHours * 3600_000;
  const result = [];
  const seenIds = new Set();
  const seenUrls = new Set();

  for (const entry of entries) {
    // Newscope sources may pre-encode titles with numeric or named HTML
    // entities. fast-xml-parser only handles the five XML entities here.
    const rawTitle = decodeHTML(textOf(entry.title));
    const scoreMatch = rawTitle.match(/^\[(\d+(?:\.\d+)?)\]\s*/);
    const description = textOf(entry.description);
    const score = Number(scoreMatch?.[1] || description.match(/Score:\s*(\d+(?:\.\d+)?)/i)?.[1] || 0);
    const title = rawTitle.replace(/^\[\d+(?:\.\d+)?\]\s*/, '').trim();
    const rawUrl = entry.link && typeof entry.link === 'object' ? atomLink(entry.link) : entry.link;
    const url = normalizeArticleUrl(textOf(rawUrl));
    const publishedAt = Date.parse(textOf(entry.pubDate || entry.published || entry.updated));
    if (!title || !url || !Number.isFinite(score) || score < config.minScore) continue;
    if (!Number.isFinite(publishedAt) || publishedAt < cutoff) continue;
    const guid = textOf(entry.guid || entry.id);
    const id = guid || url;
    if (seenIds.has(id) || seenUrls.has(url)) continue;
    seenIds.add(id);
    seenUrls.add(url);
    const topics = (entry.category || []).map(textOf).filter(Boolean).slice(0, 12);
    result.push({
      id, title, url, score, topics,
      articleKey: articleKeyFor({ url }, config.newscopeUrl),
      publishedAt: new Date(publishedAt).toISOString(),
      source: sourceName(url),
    });
  }

  const unique = [];
  for (const article of result.sort((a, b) => b.score - a.score || Date.parse(b.publishedAt) - Date.parse(a.publishedAt))) {
    if (unique.some((other) => nearDuplicate(article.title, other.title))) continue;
    unique.push({ ...article, category: classifyArticle(article, config) });
  }
  return unique;
}

export function parseNewscopeMetadata(rows, config, now = Date.now()) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const url = normalizeArticleUrl(row.url);
    const title = typeof row.title === 'string' ? decodeHTML(row.title).trim().slice(0, 2000) : '';
    const score = row.score;
    const publishedAt = Date.parse(row.publishedAt);
    if (!url || !title || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10
      || !Number.isFinite(publishedAt) || publishedAt > now || seen.has(url)) continue;
    seen.add(url);
    const article = {
      id: String(row.id), newscopeId: String(row.id), guid: String(row.guid || ''), title, url, score,
      publishedAt: new Date(publishedAt).toISOString(),
      topics: Array.isArray(row.topics) ? row.topics.filter((topic) => typeof topic === 'string').slice(0, 12) : [],
      source: typeof row.feed?.title === 'string' && row.feed.title.trim() ? row.feed.title.trim().slice(0, 200) : sourceName(url),
    };
    if (row.feedback === 'like' || row.feedback === 'dislike') article.feedback = row.feedback;
    article.articleKey = articleKeyFor(article, config.newscopeUrl);
    article.category = classifyArticle(article, config);
    result.push(article);
  }
  return result.sort((a, b) => b.score - a.score || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

export function scheduleArticles(articles, weights, limit = 100) {
  const queues = Object.fromEntries(CATEGORIES.map((category) => [category, articles.filter((item) => item.category === category)]));
  const cursors = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  const credits = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  const totalWeight = CATEGORIES.reduce((sum, category) => sum + Math.max(0, Number(weights[category]) || 0), 0);
  if (!totalWeight) return [];
  const output = [];
  const total = Math.min(limit, articles.length);

  while (output.length < total) {
    for (const category of CATEGORIES) credits[category] += Math.max(0, Number(weights[category]) || 0);
    const available = CATEGORIES.filter((category) => cursors[category] < queues[category].length);
    if (!available.length) break;
    available.sort((a, b) => credits[b] - credits[a] || CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b));
    const selected = available[0];
    credits[selected] -= totalWeight;
    output.push(queues[selected][cursors[selected]++]);
  }
  return output;
}
