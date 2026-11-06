import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, DEFAULT_CONFIG, resolveConfig } from '../lib/config.js';
import { effectiveLevels, inventoryBounds, selectInventory } from '../lib/inventory.js';
import { scheduleArticles } from '../lib/news.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const HOUR = 3600_000;
const article = (articleKey, score = 8, hoursAgo = 1, category = 'finance') => ({
  articleKey, score, publishedAt: new Date(NOW - hoursAgo * HOUR).toISOString(), category,
});
const select = (articles, states = {}, config = {}, options = {}) => selectInventory(articles, states, config, { now: NOW, ...options });
const keys = (result) => result.items.map((item) => item.articleKey);
const readState = (lastShownAt = NOW - HOUR) => ({ read: true, lastShownAt });

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

test('inventory schema and runtime defaults match, including nested partial defaults', () => {
  const expected = {
    targetInventory: 30, lowWatermark: 10, refillDebounceSeconds: 30,
    level1: { minScore: 6, maxAgeHours: 72 }, level2: { minScore: 5, maxAgeHours: 168 },
  };
  assert.deepEqual(resolveConfig().inventory, expected);
  assert.deepEqual(resolveConfig(Config({})).inventory, expected);
  const partial = { inventory: { targetInventory: 5, level1: { minScore: 4 } } };
  const actual = { ...expected, targetInventory: 5, lowWatermark: 5, level1: { minScore: 4, maxAgeHours: 72 } };
  assert.deepEqual(resolveConfig(partial).inventory, actual);
  assert.deepEqual(resolveConfig(Config(structuredClone(partial))).inventory, actual);
});

test('inventory defaults are independent copies and do not mutate supplied config', () => {
  const input = freeze({ inventory: { level1: { minScore: 4 } } });
  const result = resolveConfig(input);
  result.inventory.level1.minScore = 0;
  result.inventory.level2.maxAgeHours = 500;
  assert.equal(input.inventory.level1.minScore, 4);
  assert.equal(DEFAULT_CONFIG.inventory.level1.minScore, 6);
  assert.equal(resolveConfig().inventory.level2.maxAgeHours, 168);
});

test('configuration handles malformed objects and volatile nested values', () => {
  for (const malformed of [null, [], false, 42, 'bad']) {
    assert.deepEqual(resolveConfig({ inventory: malformed }).inventory, DEFAULT_CONFIG.inventory);
    assert.deepEqual(resolveConfig({ inventory: { level1: malformed } }).inventory.level1, DEFAULT_CONFIG.inventory.level1);
  }
  assert.deepEqual(resolveConfig(null).inventory, DEFAULT_CONFIG.inventory);
  const get = (value) => ({ get: () => value });
  assert.deepEqual(resolveConfig({ inventory: get({ targetInventory: get(2), level1: get({ minScore: get(3) }) }) }).inventory,
    { ...DEFAULT_CONFIG.inventory, targetInventory: 2, lowWatermark: 2, level1: { minScore: 3, maxAgeHours: 72 } });
});

test('inventory numeric fields reject nonfinite, wrong-type, fractional and out-of-range values', () => {
  for (const value of [NaN, Infinity, -Infinity, null, false, '3', {}, [], -1, 1.5]) {
    const inventory = resolveConfig({ inventory: { targetInventory: value, lowWatermark: value, refillDebounceSeconds: value } }).inventory;
    assert.equal(inventory.targetInventory, 30);
    assert.equal(inventory.lowWatermark, 10);
    assert.equal(inventory.refillDebounceSeconds, 30);
  }
  assert.equal(resolveConfig({ inventory: { targetInventory: 0 } }).inventory.targetInventory, 30);
  assert.equal(resolveConfig({ inventory: { targetInventory: 101 } }).inventory.targetInventory, 30);
  assert.equal(resolveConfig({ inventory: { lowWatermark: 101 } }).inventory.lowWatermark, 10);
  for (const refillDebounceSeconds of [0, 3601]) assert.equal(resolveConfig({ inventory: { refillDebounceSeconds } }).inventory.refillDebounceSeconds, 30);
  for (const value of [NaN, Infinity, null, '5', -1, 721]) {
    const config = resolveConfig({ minScore: value, maxAgeHours: value, inventory: { level1: { minScore: value, maxAgeHours: value } } });
    assert.equal(config.minScore, 7);
    assert.equal(config.maxAgeHours, 48);
    assert.deepEqual(config.inventory.level1, { minScore: 6, maxAgeHours: 72 });
  }
});

test('configuration accepts exact range boundaries and caps low watermark at target', () => {
  for (const [targetInventory, lowWatermark, refillDebounceSeconds] of [[1, 0, 1], [100, 100, 3600], [1, 100, 30]]) {
    const inventory = resolveConfig({ inventory: { targetInventory, lowWatermark, refillDebounceSeconds } }).inventory;
    assert.equal(inventory.targetInventory, targetInventory);
    assert.equal(inventory.lowWatermark, Math.min(targetInventory, lowWatermark));
    assert.equal(inventory.refillDebounceSeconds, refillDebounceSeconds);
  }
  assert.deepEqual(effectiveLevels({ minScore: 0, maxAgeHours: 720 }).L0, { minScore: 0, maxAgeHours: 720 });
  assert.deepEqual(effectiveLevels({ minScore: 10, maxAgeHours: 1 }).L0, { minScore: 10, maxAgeHours: 1 });
  for (const inventory of [{ targetInventory: 0 }, { targetInventory: 101 }, { targetInventory: 1.5 }, { lowWatermark: -1 }, { refillDebounceSeconds: 3601 }, { level2: { minScore: 11 } }]) {
    assert.throws(() => Config({ inventory }));
  }
});

test('effective levels widen cumulatively even when configured tiers contradict each other', () => {
  assert.deepEqual(effectiveLevels(), {
    L0: { minScore: 7, maxAgeHours: 48 }, L1: { minScore: 6, maxAgeHours: 72 }, L2: { minScore: 5, maxAgeHours: 168 },
  });
  const config = { minScore: 4, maxAgeHours: 200, inventory: { level1: { minScore: 3, maxAgeHours: 300 }, level2: { minScore: 9, maxAgeHours: 10 } } };
  assert.deepEqual(effectiveLevels(config), {
    L0: { minScore: 4, maxAgeHours: 200 }, L1: { minScore: 3, maxAgeHours: 300 }, L2: { minScore: 3, maxAgeHours: 300 },
  });
  assert.deepEqual(inventoryBounds(config), { minScore: 3, maxAgeHours: 300 });
  assert.deepEqual(inventoryBounds({ minScore: 2, maxAgeHours: 400 }), { minScore: 2, maxAgeHours: 400 });
});

test('low L0 inventory never mixes L1, L2 or replay just to reach target', () => {
  const result = select([article('l0'), article('l1', 6), article('l2', 5), article('read')], { read: readState() });
  assert.deepEqual(keys(result), ['l0']);
  assert.deepEqual(result.pool, { tier: 'L0', unreadCount: 1, targetInventory: 30, lowWatermark: 10, effective: { minScore: 7, maxAgeHours: 48 } });
  assert.equal(result.items[0].replay, false);
});

test('L1 only enters when L0 unread is zero and never pads with L2 or replay', () => {
  const result = select([article('read'), article('l1', 6), article('l2', 5)], { read: readState() });
  assert.deepEqual(keys(result), ['l1']);
  assert.equal(result.pool.tier, 'L1');
  assert.equal(result.pool.unreadCount, 1);
  assert.deepEqual(result.pool.effective, { minScore: 6, maxAgeHours: 72 });
});

test('priority restores L1 and then L0 on the next snapshot without sticky degradation', () => {
  const articles = [article('read'), article('l2', 5)];
  const states = { read: readState() };
  assert.equal(select(articles, states).pool.tier, 'L2+replay');
  articles.push(article('new-l1', 6));
  assert.deepEqual(keys(select(articles, states)), ['new-l1']);
  articles.push(article('new-l0'));
  assert.deepEqual(keys(select(articles, states)), ['new-l0']);
  states['new-l0'] = readState();
  assert.equal(select(articles, states).pool.tier, 'L1');
  states['new-l1'] = readState();
  assert.equal(select(articles, states).pool.tier, 'L2+replay');
});

test('every tier accepts exact score/age boundary; one millisecond older falls through', () => {
  for (const [tier, minScore, maxAgeHours] of [['L0', 7, 48], ['L1', 6, 72], ['L2', 5, 168]]) {
    const exact = select([article('boundary', minScore, maxAgeHours)]);
    assert.equal(exact.pool.tier, tier);
    assert.deepEqual(keys(exact), ['boundary']);
    const older = select([{ ...article('older', minScore), publishedAt: NOW - maxAgeHours * HOUR - 1 }]);
    assert.equal(older.pool.tier, tier === 'L0' ? 'L1' : tier === 'L1' ? 'L2' : 'empty');
    const lower = select([article('lower', minScore - 0.001)]);
    assert.equal(lower.pool.tier, tier === 'L0' ? 'L1' : tier === 'L1' ? 'L2' : 'empty');
  }
});

test('invalid publication times and all future timestamps are excluded, including replay', () => {
  const invalid = [NaN, Infinity, null, undefined, '', 'not-a-date', NOW + 1, new Date(NOW + 1).toISOString()];
  const articles = invalid.map((publishedAt, i) => ({ ...article('invalid-' + i), publishedAt }));
  articles.push(article('now', 7, 0));
  assert.deepEqual(keys(select(articles)), ['now']);
  const states = Object.fromEntries(articles.map((a) => [a.articleKey, readState()]));
  assert.deepEqual(keys(select(articles, states)), ['now']);
  assert.equal(select(articles, states).pool.tier, 'replay');
});

test('bad scores, absent keys, expired and below-L2 candidates cannot reappear as replay', () => {
  const articles = [article('old', 10, 168 + 1 / HOUR), article('low', 4.99), ...[NaN, Infinity, undefined, '8'].map((score, i) => ({ ...article('bad-' + i), score })), { ...article(''), score: 9 }];
  const states = Object.fromEntries(articles.map((a) => [a.articleKey, readState()]));
  assert.equal(select(articles).pool.tier, 'empty');
  assert.equal(select(articles, states).pool.tier, 'empty');
});

test('L2 appends replay by quality tier then oldest lastShownAt, never by weights or score first', () => {
  const articles = [
    article('l2-unread', 5), article('l0-newer', 10, 1, 'finance'), article('l2-read', 5),
    article('l0-older', 7, 1, 'general'), article('l1-read', 6),
  ];
  const states = { 'l0-newer': readState(NOW - HOUR), 'l0-older': readState(new Date(NOW - 2 * HOUR).toISOString()), 'l1-read': readState(1), 'l2-read': readState(0) };
  const result = select(articles, states, { weights: { finance: 1000, technology: 0, science: 0, general: 0 } });
  assert.deepEqual(keys(result), ['l2-unread', 'l0-older', 'l0-newer', 'l1-read', 'l2-read']);
  assert.deepEqual(result.items.map((item) => item.replay), [false, true, true, true, true]);
  assert.equal(result.pool.tier, 'L2+replay');
  assert.equal(result.pool.unreadCount, 1);
  assert.deepEqual(result.pool.effective, { minScore: 5, maxAgeHours: 168 });
});

test('replay only fills remaining L2 capacity and never displaces unread articles', () => {
  const articles = [article('read'), article('u1', 5), article('u2', 5), article('u3', 5)];
  for (const targetInventory of [1, 2, 3, 4]) {
    const result = select(articles, { read: readState() }, { inventory: { targetInventory } });
    assert.equal(result.items.length, targetInventory);
    assert.equal(result.pool.unreadCount, 3);
    assert.equal(result.pool.tier, targetInventory <= 3 ? 'L2' : 'L2+replay');
    assert.deepEqual(result.items.map((item) => item.replay), Array(Math.min(3, targetInventory)).fill(false).concat(targetInventory === 4 ? [true] : []));
  }
});

test('pure replay retains read history, tolerates missing lastShownAt and honors capacity', () => {
  const articles = freeze([article('recent', 10), article('never', 7), article('old', 8)]);
  const states = freeze({ recent: readState(NOW), never: readState(null), old: readState(0) });
  const before = structuredClone(states);
  const result = select(articles, states, { inventory: { targetInventory: 2 } });
  assert.deepEqual(keys(result), ['never', 'old']);
  assert.equal(result.pool.tier, 'replay');
  assert.equal(result.pool.unreadCount, 0);
  assert.ok(result.items.every((item) => item.replay === true));
  assert.deepEqual(states, before);
  assert.ok(articles.every((item) => !Object.hasOwn(item, 'replay')));
});

test('unread scheduling uses full tier, quality/time order and existing category weights', () => {
  const articles = [];
  for (const category of ['finance', 'technology', 'science', 'general']) {
    for (let i = 0; i < 60; i++) articles.push(article(category + i, 7 + i % 3, 1 + i % 10, category));
  }
  articles.reverse();
  const config = resolveConfig({ inventory: { targetInventory: 100 } });
  const sorted = articles.slice().sort((a, b) => b.score - a.score || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const expected = scheduleArticles(sorted, config.weights, 100).map((a) => a.articleKey);
  const result = select(freeze(articles), {}, config);
  assert.deepEqual(keys(result), expected);
  assert.equal(result.items.length, 100);
  assert.equal(result.pool.unreadCount, 240);
  assert.deepEqual(['finance', 'technology', 'science', 'general'].map((category) => result.items.filter((a) => a.category === category).length), [55, 25, 15, 5]);
});

test('explicit replay flags override stale input flags without changing input/state', () => {
  const input = freeze([{ ...article('u', 5), replay: true }, { ...article('r'), replay: false }]);
  const states = freeze({ u: { read: false, exposures: 2 }, r: { ...readState(), exposures: 3 } });
  const result = select(input, states);
  assert.deepEqual(result.items.map((a) => a.replay), [false, true]);
  assert.deepEqual(input.map((a) => a.replay), [true, false]);
  assert.equal(states.u.exposures, 2);
  assert.equal(states.r.exposures, 3);
});

test('explicitly unavailable history returns only L0 unread, never relaxed tiers or replay', () => {
  const articles = [article('u'), article('read'), article('l1', 6), article('l2', 5)];
  const states = { read: readState() };
  const result = select(articles, states, {}, { history: false });
  assert.deepEqual(keys(result), ['u']);
  assert.equal(result.pool.tier, 'L0');
  assert.ok(result.items.every((a) => a.replay === false));
  states.u = readState();
  const empty = select(articles, states, {}, { history: false });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.pool.tier, 'empty');
  assert.equal(empty.pool.unreadCount, 0);
  assert.deepEqual(empty.pool.effective, { minScore: 7, maxAgeHours: 48 });
});

test('empty history and RSS inventories disclose only their attempted effective filters', () => {
  assert.deepEqual(select([]), { items: [], pool: { tier: 'empty', unreadCount: 0, targetInventory: 30, lowWatermark: 10, effective: { minScore: 5, maxAgeHours: 168 } } });
  assert.deepEqual(select([], {}, {}, { history: false }).pool.effective, { minScore: 7, maxAgeHours: 48 });
});

test('states support Map and ignore inherited keys; duplicate article keys are not replayed twice', () => {
  const articles = [article('constructor'), article('read'), article('read')];
  const states = new Map([['read', readState()]]);
  assert.deepEqual(keys(select(articles, states)), ['constructor']);
  assert.deepEqual(keys(select([article('read'), article('read')], states)), ['read']);
  assert.equal(select([article('constructor')], {}).items[0].replay, false);
});

test('zero weights suppress L2 replay and pure replay but retain inventory metadata', () => {
  const config = { weights: { finance: 0, technology: 0, science: 0, general: 0 } };
  const states = { read: readState() };
  for (const [articles, tier, unreadCount] of [
    [[article('l2', 5), article('read')], 'L2+replay', 1],
    [[article('read')], 'replay', 0],
    [[article('l2', 5)], 'L2', 1],
  ]) {
    const result = select(articles, states, config);
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.pool, { tier, unreadCount, targetInventory: 30, lowWatermark: 10, effective: { minScore: 5, maxAgeHours: 168 } });
  }
});

test('zero weights preserve existing scheduler behavior without forcing a lower tier', () => {
  const result = select([article('l0'), article('l1', 6)], {}, { weights: { finance: 0, technology: 0, science: 0, general: 0 } });
  assert.deepEqual(result.items, []);
  assert.equal(result.pool.tier, 'L0');
  assert.equal(result.pool.unreadCount, 1);
});
