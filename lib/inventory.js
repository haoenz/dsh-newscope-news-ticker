import { CATEGORIES, resolveConfig } from './config.js';
import { scheduleArticles } from './news.js';

function levelsFor(config) {
  const L0 = { minScore: config.minScore, maxAgeHours: config.maxAgeHours };
  const relax = (previous, configured) => ({
    minScore: Math.min(previous.minScore, configured.minScore),
    maxAgeHours: Math.max(previous.maxAgeHours, configured.maxAgeHours),
  });
  const L1 = relax(L0, config.inventory.level1);
  const L2 = relax(L1, config.inventory.level2);
  return { L0, L1, L2 };
}

/** Effective, monotonically widening filters; L0 is always the user's baseline. */
export function effectiveLevels(config) {
  return levelsFor(resolveConfig(config));
}

/** Fetch this superset once rather than making one request per inventory tier. */
export function inventoryBounds(config) {
  return effectiveLevels(config).L2;
}

function timestamp(value) {
  return typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
}

function stateFor(states, key) {
  if (states instanceof Map) return states.get(key);
  return states && Object.hasOwn(states, key) ? states[key] : undefined;
}

function lastShown(state) {
  const time = timestamp(state?.lastShownAt);
  // A missing/invalid timestamp represents no recorded showing, before all others.
  return Number.isFinite(time) ? time : -Infinity;
}

/**
 * Select one unread tier, then (only at L2) append read replay candidates.
 * Never updates article objects or exposure state; every snapshot restarts at L0.
 * pool.unreadCount is the entire chosen unread tier, not the capped item count.
 * pool.effective is the chosen filter (the widest attempted filter when empty).
 */
export function selectInventory(articles, exposureStates, config, { now = Date.now(), history = true } = {}) {
  const resolved = resolveConfig(config);
  const levels = levelsFor(resolved);
  const { targetInventory, lowWatermark } = resolved.inventory;
  const filters = history ? [levels.L0, levels.L1, levels.L2] : [levels.L0];
  const candidates = [];
  const seen = new Set();
  for (const article of articles || []) {
    if (!article || typeof article.articleKey !== 'string' || !article.articleKey || seen.has(article.articleKey)) continue;
    const publishedAt = timestamp(article.publishedAt);
    if (!Number.isFinite(article.score) || !Number.isFinite(publishedAt) || !Number.isFinite(now) || publishedAt > now) continue;
    const tier = filters.findIndex(({ minScore, maxAgeHours }) => article.score >= minScore && publishedAt >= now - maxAgeHours * 3600_000);
    if (tier < 0) continue;
    seen.add(article.articleKey);
    candidates.push({ article, publishedAt, tier, state: stateFor(exposureStates, article.articleKey) });
  }

  let selectedTier = filters.length - 1;
  let unread = [];
  for (let tier = 0; tier < filters.length; tier++) {
    unread = candidates.filter((candidate) => candidate.tier <= tier && candidate.state?.read !== true);
    selectedTier = tier;
    if (unread.length) break;
  }
  unread.sort((a, b) => b.article.score - a.article.score || b.publishedAt - a.publishedAt);
  const items = scheduleArticles(unread.map(({ article }) => ({ ...article, replay: false })), resolved.weights, targetInventory);
  let tier = unread.length ? `L${selectedTier}` : 'empty';
  if (history && selectedTier === 2 && unread.length < targetInventory) {
    const replay = candidates.filter((candidate) => candidate.state?.read === true);
    replay.sort((a, b) => a.tier - b.tier
      || lastShown(a.state) - lastShown(b.state)
      || b.article.score - a.article.score
      || b.publishedAt - a.publishedAt);
    items.push(...replay.slice(0, targetInventory - items.length).map(({ article }) => ({ ...article, replay: true })));
    if (items.some((article) => article.replay)) tier = unread.length ? 'L2+replay' : 'replay';
  }
  return {
    // All-zero weights disable display, including replay, without hiding pool status.
    items: CATEGORIES.some((category) => Number(resolved.weights[category]) > 0) ? items : [],
    pool: { tier, unreadCount: unread.length, targetInventory, lowWatermark, effective: { ...filters[selectedTier] } },
  };
}
