import z from '@deepseek-ai/schemastery';

export const CATEGORIES = ['finance', 'technology', 'science', 'general'];

export const DEFAULT_CONFIG = {
  enabled: true,
  newscopeUrl: 'http://127.0.0.1:8080',
  managementUrl: '',
  minScore: 7,
  maxAgeHours: 48,
  refreshMinutes: 5,
  weights: { finance: 55, technology: 25, science: 15, general: 5 },
  topicMap: {
    finance: ['finance', 'economy', 'economics', 'markets', 'market', 'business', '宏观', '财经', '金融', '货币'],
    technology: ['technology', 'tech', 'ai', 'llm', 'software', 'programming', 'open source', 'semiconductor', '科技', '人工智能'],
    science: ['science', 'physics', 'astronomy', 'mathematics', 'math', 'computer science', 'research', '科学', '物理', '天文'],
    general: ['world', 'news', 'politics', 'international', 'general', '时事', '国际'],
  },
  sourceMap: {
    finance: ['bloomberg', 'wallstreetcn', 'cls.cn', 'ft.com', 'reuters.com/markets', '财联社', '华尔街见闻'],
    technology: ['techmeme', 'hackernews', 'news.ycombinator.com', 'hnrss.org', '36kr', 'github'],
    science: ['quantamagazine', 'phys.org', 'nature.com', 'science.org', 'arxiv'],
    general: ['bbc.', 'reuters.com/world', 'apnews'],
  },
  scrollSpeed: 'medium',
  pauseOnHover: true,
  openInNewTab: true,
  onlyWhenRunning: true,
  showCategory: true,
};

const mappingSchema = z.object({
  finance: z.array(z.string()).default(DEFAULT_CONFIG.topicMap.finance),
  technology: z.array(z.string()).default(DEFAULT_CONFIG.topicMap.technology),
  science: z.array(z.string()).default(DEFAULT_CONFIG.topicMap.science),
  general: z.array(z.string()).default(DEFAULT_CONFIG.topicMap.general),
});

export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('Show the Newscope ticker in the running status line.'),
  newscopeUrl: z.string().default(DEFAULT_CONFIG.newscopeUrl).volatile().description('Host-side Newscope base URL, for example http://127.0.0.1:8080.'),
  managementUrl: z.string().default('').volatile().description('Optional browser-reachable Newscope URL. Leave blank for a local-only management link.'),
  minScore: z.number().min(0).max(10).default(7).volatile().description('Minimum Newscope relevance score (0–10).'),
  maxAgeHours: z.number().min(1).max(720).default(48).volatile().description('Hide articles older than this many hours.'),
  refreshMinutes: z.number().min(1).max(1440).default(5).volatile().description('Minutes between Host-side Newscope cache refreshes.'),
  weights: z.object({
    finance: z.number().min(0).max(1000).default(55),
    technology: z.number().min(0).max(1000).default(25),
    science: z.number().min(0).max(1000).default(15),
    general: z.number().min(0).max(1000).default(5),
  }).default(DEFAULT_CONFIG.weights).volatile().description('Target exposure weights for finance, technology, science and general news.'),
  topicMap: mappingSchema.default(DEFAULT_CONFIG.topicMap).volatile().description('Case-insensitive topic fragments mapped to each display category; Newscope topic names are not fixed.'),
  sourceMap: mappingSchema.default(DEFAULT_CONFIG.sourceMap).volatile().description('Case-insensitive source/hostname fragments used when topics do not identify a category.'),
  scrollSpeed: z.union(['slow', 'medium', 'fast']).default('medium').volatile().description('Ticker movement speed: slow 25, medium 45, fast 75 CSS pixels per second.'),
  pauseOnHover: z.boolean().default(true).volatile().description('Pause the ticker while the pointer is over it. Keyboard focus always pauses.'),
  openInNewTab: z.boolean().default(true).volatile().description('Open original article links in a new tab with noopener/noreferrer.'),
  onlyWhenRunning: z.boolean().default(true).volatile().description('Show only in the native Agent running row; when off, use a one-line composer dock while idle.'),
  showCategory: z.boolean().default(true).volatile().description('Show the mapped category label before each article.'),
}).default({});

export function readVolatile(value) {
  return value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

export function resolveConfig(input = {}) {
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
    const value = readVolatile(input[key]);
    result[key] = value === undefined ? structuredClone(fallback) : value;
  }
  result.weights = { ...DEFAULT_CONFIG.weights, ...(result.weights || {}) };
  result.topicMap = { ...DEFAULT_CONFIG.topicMap, ...(result.topicMap || {}) };
  result.sourceMap = { ...DEFAULT_CONFIG.sourceMap, ...(result.sourceMap || {}) };
  result.newscopeUrl = String(result.newscopeUrl).replace(/\/+$/, '');
  result.managementUrl = String(result.managementUrl || '').trim();
  return result;
}
