import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { DEFAULT_CONFIG } from '../lib/config.js';

let definition;
let cleanup;
let dom;
let raf;
let intervals;
let payload;
let fetchError;

const article = (id, category = 'finance') => ({
  id, category, title: `Title ${id}`, url: `https://example.com/${id}`,
  source: 'Example', score: 8, publishedAt: new Date().toISOString(), topics: [],
});

function basePayload() {
  return {
    config: {
      enabled: true, onlyWhenRunning: true, pauseOnHover: true, openInNewTab: true,
      scrollSpeed: 'medium', refreshMinutes: 5,
    },
    items: [article('a'), article('b', 'technology')],
  };
}

function installDom({ reducedMotion = false } = {}) {
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:3080' });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => false });
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.fetch = async (url) => {
    if (fetchError) throw fetchError;
    if (url === '/plugins/dsh-newscope-news-ticker/models.json') return Response.json(modelCatalogPayload());
    return Response.json(payload);
  };
  raf = new Map();
  intervals = [];
  let nextRaf = 1;
  window.requestAnimationFrame = (fn) => { const id = nextRaf++; raf.set(id, fn); return id; };
  window.cancelAnimationFrame = (id) => raf.delete(id);
  window.setInterval = (fn, delay) => { intervals.push({ fn, delay }); return intervals.length; };
  window.clearInterval = () => {};
  window.matchMedia = () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() { return { width: this.hasAttribute('data-newscope-group') ? 400 : 800 }; },
  });
}

function createConfiguration(initial = DEFAULT_CONFIG) {
  const listeners = new Set();
  const calls = [];
  let snapshot = {
    status: 'ready', value: structuredClone(initial), base: undefined, user: undefined,
    revision: 7, writable: true,
  };
  return {
    calls,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async mutate(ops, expectedRevision) {
      calls.push({ ops, expectedRevision });
      const value = structuredClone(snapshot.value);
      for (const operation of ops) {
        let target = value;
        for (const part of operation.path.slice(0, -1)) target = target[part] ||= {};
        const key = operation.path.at(-1);
        if (operation.op === 'set') target[key] = structuredClone(operation.value);
        else delete target[key];
      }
      snapshot = { ...snapshot, value, revision: snapshot.revision + 1 };
      for (const listener of listeners) listener();
      return true;
    },
  };
}

function modelCatalogPayload() {
  return {
    default: { provider: 'kt', model: 'deepseek-flash' },
    groups: [{ id: 'kt', name: 'KT', models: [
      { id: 'deepseek-flash', name: 'DeepSeek Flash' },
      { id: 'other-model', name: 'Other Model' },
    ] }],
  };
}

function translation(dicts, key) {
  return dicts.zh[key] || key;
}

async function start({ running = true, duplicateLocale = false, configuration = createConfiguration() } = {}) {
  if (!definition) {
    globalThis.window.__ModuleLoader__ = { load(value) { definition = value; } };
    await import('../client.js');
  }
  if (running) document.body.innerHTML = '<div data-chat-running><span class="runningContent"><span class="runningText">深度求索中，用时 1秒</span></span></div>';
  const effects = [];
  const registrations = [];
  const ctx = {
    locale: {
      register(ns, dicts) {
        this.ns = ns;
        this.dicts = dicts;
        if (duplicateLocale) throw new Error(`locale namespace "${ns}" already has locale "en"`);
      },
      bind(ns) { assert.equal(ns, this.ns); return (key) => translation(this.dicts, key); },
    },
    slots: {
      inject(name, callback) { registrations.push({ name, callback }); return () => {}; },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
    configForms: {
      get(ns) { assert.equal(ns, 'newscope-news-ticker'); return configuration; },
      whileServed(namespaces, register) {
        assert.deepEqual(namespaces, ['newscope-news-ticker']);
        return register();
      },
    },
    effect(fn) { effects.push(fn()); },
  };
  const plugin = definition.factory((name) => name === 'react' ? React : assert.fail(name));
  plugin.apply(ctx);
  await flush();
  cleanup = () => effects.forEach((dispose) => dispose?.());
  return { ctx, registrations };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function frame(time) {
  const callbacks = [...raf.values()];
  raf.clear();
  callbacks.forEach((fn) => fn(time));
}

beforeEach(() => {
  installDom();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  dom?.window.close();
  fetchError = null;
});

test('client module registers and preserves the native running label', async () => {
  payload = basePayload();
  await start();
  const ticker = document.querySelector('[data-newscope-ticker]');
  assert.ok(ticker);
  assert.equal(document.querySelector('.runningText').textContent, '深度求索中，用时 1秒');
  const runningContent = document.querySelector('.runningContent');
  assert.equal(ticker.parentElement, document.querySelector('[data-chat-running]'));
  assert.equal(ticker.nextElementSibling, runningContent, 'ticker should be above the native running line');
  assert.equal(ticker.textContent.includes('Example'), false, 'source should not be visible');
  assert.equal(ticker.textContent.includes('财经'), false, 'category should not be visible');
  assert.equal(document.querySelectorAll('[data-newscope-ticker]').length, 1);
  assert.equal(document.querySelectorAll('[data-newscope-item]').length, 4);
  const link = ticker.querySelector('a');
  assert.equal(link.href, 'https://example.com/a');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.title, 'Title a');
});

test('onlyWhenRunning=false shows the ticker above the composer dock while idle', async () => {
  document.body.innerHTML = '<div data-slot="conversation.composer.dock"><span>composer</span></div>';
  payload = basePayload();
  await start({ running: false });
  assert.equal(document.querySelector('[data-newscope-ticker]'), null);

  payload = { ...basePayload(), config: { ...basePayload().config, onlyWhenRunning: false } };
  document.dispatchEvent(new window.Event('visibilitychange'));
  await flush();
  const dock = document.querySelector('[data-slot="conversation.composer.dock"]');
  const ticker = dock.querySelector('[data-newscope-ticker]');
  assert.ok(ticker);
  assert.equal(dock.firstElementChild, ticker);
  assert.ok(ticker.hasAttribute('data-newscope-idle'));
});

test('translated Chinese title is shown without leaking the original English title', async () => {
  payload = basePayload();
  payload.items = [{
    ...article('translated'),
    title: '美联储降息',
    originalTitle: 'Federal Reserve cuts rates',
  }];
  await start();
  const ticker = document.querySelector('[data-newscope-ticker]');
  assert.ok(ticker.textContent.includes('美联储降息'));
  assert.equal(ticker.textContent.includes('Federal Reserve cuts rates'), false);
  assert.equal(ticker.querySelector('a').href, 'https://example.com/translated');
});

test('reactivation tolerates a previously leaked package locale registration', async () => {
  payload = basePayload();
  await start({ duplicateLocale: true });
  assert.ok(document.querySelector('[data-newscope-ticker]'));
});

test('real horizontal motion pauses on hover/focus and resumes without resetting position', async () => {
  payload = basePayload();
  await start();
  const ticker = document.querySelector('[data-newscope-ticker]');
  const track = ticker.querySelector('[data-newscope-track]');
  frame(1000);
  frame(1016);
  assert.match(track.style.transform, /-0\.72px/);
  ticker.dispatchEvent(new window.Event('mouseenter'));
  assert.equal(ticker.dataset.paused, 'true');
  frame(1032);
  frame(1200);
  assert.match(track.style.transform, /-0\.72px/);
  ticker.dispatchEvent(new window.Event('mouseleave'));
  frame(1216);
  frame(1232);
  assert.match(track.style.transform, /-1\.44px/);
  ticker.querySelector('a').dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  assert.equal(ticker.dataset.paused, 'true');
  frame(1300);
  assert.match(track.style.transform, /-1\.44px/);
  ticker.querySelector('a').dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  frame(1316);
  frame(1332);
  assert.match(track.style.transform, /-2\.16px/);
});

test('refresh reuses the mounted ticker, keeps its position and updates article links', async () => {
  payload = basePayload();
  await start();
  const ticker = document.querySelector('[data-newscope-ticker]');
  frame(1000); frame(1016);
  payload = { ...basePayload(), items: [article('new', 'science')] };
  document.dispatchEvent(new window.Event('visibilitychange'));
  await flush();
  assert.equal(document.querySelector('[data-newscope-ticker]'), ticker);
  assert.equal(ticker.querySelector('a').href, 'https://example.com/new');
  assert.match(ticker.querySelector('[data-newscope-track]').style.transform, /-0\.72px/);
  assert.equal(document.querySelectorAll('[data-newscope-ticker]').length, 1);
});

test('a new model run resumes at the previous position without flashing the first article', async () => {
  payload = basePayload();
  await start();
  const firstTrack = document.querySelector('[data-newscope-track]');
  frame(1000); frame(1016);
  assert.match(firstTrack.style.transform, /-0\.72px/);

  const oldRow = document.querySelector('[data-chat-running]');
  oldRow.remove();
  document.body.insertAdjacentHTML('beforeend', '<div data-chat-running><span class="runningContent"><span class="runningText">next model run</span></span></div>');
  await flush();
  const nextTrack = document.querySelector('[data-newscope-track]');
  assert.notEqual(nextTrack, firstTrack);
  assert.match(nextTrack.style.transform, /-0\.72px/, 'the new row should restore position on its first render');
  frame(1032);
  assert.match(nextTrack.style.transform, /-0\.72px/);
  frame(1048);
  assert.match(nextTrack.style.transform, /-1\.44px/, 'the next run should continue forward, not restart');
});

test('page refresh restores the shared playback position from sessionStorage', async () => {
  payload = basePayload();
  await start();
  frame(1000); frame(1016);
  window.dispatchEvent(new window.Event('pagehide'));
  const stored = JSON.parse(window.sessionStorage.getItem('dsh-newscope-news-ticker:playback:v1'));
  assert.ok(Math.abs(stored.position - 0.72) < 1e-9);

  cleanup(); cleanup = null;
  await start();
  const track = document.querySelector('[data-newscope-track]');
  assert.match(track.style.transform, /-0\.72px/, 'the refreshed plugin should restore position immediately');
  frame(1032); frame(1048);
  assert.match(track.style.transform, /-1\.44px/, 'playback should continue after refresh');
});

test('initial outage leaves native UI alone; later failure uses last browser snapshot', async () => {
  payload = basePayload();
  fetchError = new Error('offline');
  await start();
  assert.equal(document.querySelector('[data-newscope-ticker]'), null);
  assert.ok(document.querySelector('.runningText'));
  fetchError = null;
  document.dispatchEvent(new window.Event('visibilitychange'));
  await flush();
  assert.ok(document.querySelector('[data-newscope-ticker]'));
  fetchError = new Error('offline again');
  document.dispatchEvent(new window.Event('visibilitychange'));
  await flush();
  assert.ok(document.querySelector('[data-newscope-ticker]'));
});

test('disabled config, session replacement and teardown restore the original status row', async () => {
  payload = { ...basePayload(), config: { ...basePayload().config, enabled: false } };
  await start();
  assert.equal(document.querySelector('[data-newscope-ticker]'), null);
  payload = basePayload();
  document.dispatchEvent(new window.Event('visibilitychange'));
  await flush();
  const oldRow = document.querySelector('[data-chat-running]');
  assert.ok(oldRow.querySelector('[data-newscope-ticker]'));
  oldRow.remove();
  document.body.insertAdjacentHTML('beforeend', '<div data-chat-running><span class="runningContent"><span class="runningText">new session</span></span></div>');
  await flush();
  assert.equal(oldRow.querySelector('[data-newscope-ticker]'), null);
  assert.equal(document.querySelectorAll('[data-newscope-ticker]').length, 1);
  cleanup(); cleanup = null;
  assert.equal(document.querySelector('[data-newscope-ticker]'), null);
  assert.equal(document.querySelector('.runningText').textContent, 'new session');
  assert.equal(raf.size, 0);
});

test('system reduced motion is always ignored so the ticker still scrolls', async () => {
  installDom({ reducedMotion: true });
  payload = basePayload();
  await start();
  assert.equal(document.querySelectorAll('[data-newscope-group]').length, 2);
  assert.equal(document.querySelector('[data-newscope-ticker]').dataset.reducedMotion, 'false');
  frame(1000); frame(1016);
  assert.match(document.querySelector('[data-newscope-track]').style.transform, /-0\.72px/);
});

test('native bundle and row settings render and write changed fields through configForms', async (t) => {
  payload = basePayload();
  const configuration = createConfiguration();
  const { ctx, registrations } = await start({ configuration });
  assert.equal(ctx.locale.ns, 'dsh-newscope-news-ticker-client', 'client labels must not share the plugin metadata namespace');
  assert.equal(ctx.locale.dicts.zh['settings.newscopeUrl'], 'Newscope Host 地址', 'locale entries must use DSH flat dot-key lookup');
  const injection = registrations.find((entry) => entry.name === 'plugins.row.config');
  assert.ok(injection, 'row configuration slot should be registered');
  injection.callback();
  const bundleInjection = registrations.find((entry) => entry.name === 'plugins.bundle.config');
  assert.ok(bundleInjection, 'package detail should also expose the settings form');
  bundleInjection.callback();
  assert.ok(registrations.some((entry) => entry.options?.key === 'dsh-newscope-news-ticker' && entry.options?.name === 'plugins.bundle.config'));
  const sectionInjection = registrations.find((entry) => entry.name === 'settings.section');
  assert.ok(sectionInjection, 'DSH Settings should also expose a Newscope section');
  sectionInjection.callback();
  assert.ok(registrations.some((entry) => entry.options?.id === 'newscope-news-ticker' && entry.options?.name === 'settings.section'));
  const contribution = registrations.find((entry) => entry.options?.key === 'dsh-newscope-news-ticker#newscope-news-ticker');
  assert.ok(contribution, 'row key should match the Cordis patch id');

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  await act(async () => { root.render(React.createElement(contribution.component, { view: 'page' })); });
  assert.ok(container.textContent.includes('新闻来源'));
  assert.ok(container.textContent.includes('Newscope Host 地址'));
  assert.equal(container.textContent.includes('settings.newscopeUrl'), false, 'internal locale keys must never reach the visible form');
  assert.ok(container.querySelector('[data-setting="newscopeUrl"]'));
  const translationSelect = container.querySelector('select[data-setting="translationModel"]');
  assert.ok(translationSelect, 'translation model should be a catalog select, not a text input');
  assert.ok(translationSelect.textContent.includes('DeepSeek Flash · KT'));
  assert.ok(translationSelect.textContent.includes('跟随 DSH 默认模型（kt/deepseek-flash）'));
  assert.equal(container.querySelector('[data-newscope-save]').disabled, true);

  const translationToggle = container.querySelector('[data-setting="translationEnabled"]');
  await act(async () => { translationToggle.click(); });
  assert.equal(translationToggle.checked, true);
  const saveButton = container.querySelector('[data-newscope-save]');
  assert.equal(saveButton.disabled, false);
  await act(async () => { saveButton.click(); });
  assert.deepEqual(configuration.calls, [{
    ops: [{ op: 'set', path: ['translationEnabled'], value: true }],
    expectedRevision: 7,
  }]);
  assert.equal(configuration.getSnapshot().value.translationEnabled, true);
  assert.ok(container.textContent.includes('已保存'));

  await act(async () => {
    translationSelect.value = 'kt/deepseek-flash';
    Simulate.change(translationSelect, { target: { value: 'kt/deepseek-flash' } });
  });
  await act(async () => { saveButton.click(); });
  assert.deepEqual(configuration.calls[1], {
    ops: [{ op: 'set', path: ['translationModel'], value: 'kt/deepseek-flash' }],
    expectedRevision: 8,
  });

  const scoreInput = container.querySelector('[data-setting="minScore"]');
  await act(async () => {
    scoreInput.value = '11';
    Simulate.change(scoreInput, { target: { value: '11' } });
  });
  assert.equal(scoreInput.value, '11');
  assert.equal(saveButton.disabled, false, 'numeric edit should stage a change');
  await act(async () => { saveButton.click(); });
  assert.equal(configuration.calls.length, 2, 'invalid values must not reach the Host');
  assert.ok(container.textContent.includes('低水位不大于目标库存'));
});

async function mountSettings(t, initial = DEFAULT_CONFIG, locale = 'zh') {
  const configuration = createConfiguration(initial);
  const { ctx, registrations } = await start({ configuration, running: false });
  registrations.find((entry) => entry.name === 'settings.section').callback();
  const component = registrations.find((entry) => entry.options?.name === 'settings.section').component;
  if (locale === 'en') ctx.locale.dicts.zh = ctx.locale.dicts.en;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let mounted = true;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const unmount = () => {
    if (mounted) act(() => root.unmount());
    mounted = false;
    container.remove();
  };
  t.after(() => { unmount(); delete globalThis.IS_REACT_ACT_ENVIRONMENT; });
  await act(async () => { root.render(React.createElement(component, { view: 'page' })); });
  const edit = async (key, value) => {
    const input = container.querySelector('[data-setting="' + key + '"]');
    assert.ok(input, key);
    await act(async () => { Simulate.change(input, { target: { value: String(value) } }); });
  };
  const save = async () => { await act(async () => container.querySelector('[data-newscope-save]').click()); };
  const refresh = async () => { await act(async () => container.querySelector('[data-newscope-refresh-status]').click()); };
  const status = (key) => container.querySelector('[data-newscope-status="' + key + '"]')?.textContent;
  return { configuration, container, edit, save, refresh, status, unmount };
}

const inventoryPayload = (tier = 'L0') => ({
  ...basePayload(), service: 'ok', stale: false, queriedAt: '2026-11-05T12:00:00.000Z',
  pool: { tier, unreadCount: 19, effective: { minScore: 7, maxAgeHours: 48 } },
  capabilities: { history: true, source: 'articles', truncated: false },
  items: [{ ...article('a'), replay: false }, { ...article('b'), replay: true }],
});

const inventoryDefaults = {
  readAfterExposures: 3, 'inventory.targetInventory': 30, 'inventory.lowWatermark': 10,
  'inventory.refillDebounceSeconds': 30, 'inventory.level1.minScore': 6, 'inventory.level1.maxAgeHours': 72,
  'inventory.level2.minScore': 5, 'inventory.level2.maxAgeHours': 168,
};

test('inventory settings default legacy configs without writing unedited or hidden fields', async (t) => {
  payload = basePayload();
  const legacy = structuredClone(DEFAULT_CONFIG);
  delete legacy.inventory;
  delete legacy.readAfterExposures;
  legacy.hiddenSetting = { keep: true };
  const { container, configuration, edit, save, status } = await mountSettings(t, legacy);
  for (const [key, value] of Object.entries(inventoryDefaults)) {
    assert.equal(container.querySelector('[data-setting="' + key + '"]').value, String(value));
  }
  for (const key of ['service', 'stale', 'tier', 'unreadCount', 'replay', 'queriedAt']) assert.equal(status(key), '未知');
  assert.match(status('effective'), /未知/);
  assert.match(status('capabilities'), /未知/);
  await edit('minScore', 8);
  await save();
  assert.deepEqual(configuration.calls[0].ops, [{ op: 'set', path: ['minScore'], value: 8 }]);
  assert.deepEqual(configuration.getSnapshot().value.hiddenSetting, { keep: true });
  assert.equal(configuration.getSnapshot().value.inventory, undefined);
});

test('inventory settings mutate leaf paths only, preserve future fields and never change L0', async (t) => {
  payload = inventoryPayload();
  const initial = structuredClone(DEFAULT_CONFIG);
  initial.hiddenSetting = 'keep';
  initial.inventory.futurePolicy = { keep: true };
  initial.inventory.level1.futureThreshold = 42;
  const { configuration, edit, save, container } = await mountSettings(t, initial);
  const changes = { readAfterExposures: 100, 'inventory.targetInventory': 100, 'inventory.lowWatermark': 0,
    'inventory.refillDebounceSeconds': 3600, 'inventory.level1.minScore': 0, 'inventory.level1.maxAgeHours': 720,
    'inventory.level2.minScore': 10, 'inventory.level2.maxAgeHours': 1 };
  for (const [key, value] of Object.entries(changes)) await edit(key, value);
  await save();
  assert.equal(configuration.calls.length, 1);
  assert.deepEqual(configuration.calls[0].ops, Object.entries(changes).map(([key, value]) => ({ op: 'set', path: key.split('.'), value })));
  const result = configuration.getSnapshot().value;
  assert.equal(result.minScore, 7);
  assert.equal(result.maxAgeHours, 48);
  assert.equal(result.hiddenSetting, 'keep');
  assert.deepEqual(result.inventory.futurePolicy, { keep: true });
  assert.equal(result.inventory.level1.futureThreshold, 42);
  assert.equal(container.querySelector('[data-setting="inventory.level1.maxAgeHours"]').max, '720');
  assert.match(container.textContent, /未读耗尽才放宽/);
  assert.match(container.textContent, /不会永久修改 L0/);
});

test('inventory settings reject invalid ranges, empty values, fractional counts and low above target', async (t) => {
  payload = basePayload();
  const { configuration, edit, save, container } = await mountSettings(t);
  const invalid = [
    ['readAfterExposures', 0], ['readAfterExposures', 101], ['readAfterExposures', 1.5], ['readAfterExposures', ''],
    ['inventory.targetInventory', 0], ['inventory.targetInventory', 101], ['inventory.targetInventory', 1.5],
    ['inventory.lowWatermark', -1], ['inventory.lowWatermark', 31], ['inventory.lowWatermark', 0.5],
    ['inventory.refillDebounceSeconds', 0], ['inventory.refillDebounceSeconds', 3601], ['inventory.refillDebounceSeconds', 1.5],
    ['inventory.level1.minScore', -1], ['inventory.level1.minScore', 11], ['inventory.level1.minScore', 'Infinity'],
    ['inventory.level1.maxAgeHours', 0], ['inventory.level1.maxAgeHours', 721],
    ['inventory.level2.minScore', -1], ['inventory.level2.minScore', 11],
    ['inventory.level2.maxAgeHours', 0], ['inventory.level2.maxAgeHours', 721],
  ];
  for (const [key, value] of invalid) {
    await edit(key, value);
    await save();
    assert.equal(configuration.calls.length, 0, key + '=' + value);
    assert.match(container.textContent, /低水位不大于目标库存/);
    await edit(key, inventoryDefaults[key]);
  }
  await edit('inventory.targetInventory', 1);
  await edit('inventory.lowWatermark', 1);
  await edit('readAfterExposures', 1);
  await edit('inventory.refillDebounceSeconds', 1);
  await edit('inventory.level1.minScore', 6.5);
  await save();
  assert.equal(configuration.calls.length, 1, 'inclusive lower bounds and fractional scores are valid');
});

test('inventory status reflects tiers, true zero, replay, stale and capability warnings through same-origin GET', async (t) => {
  payload = inventoryPayload();
  const calls = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return fetch(url, options); };
  const { status, refresh, container } = await mountSettings(t);
  assert.equal(status('service'), 'ok');
  assert.equal(status('stale'), 'false');
  assert.equal(status('unreadCount'), '19');
  assert.equal(status('replay'), '1');
  assert.equal(status('queriedAt'), payload.queriedAt);
  assert.equal(status('effective'), 'minScore: 7 / maxAgeHours: 48');
  for (const tier of ['L0', 'L1', 'L2', 'L2+replay', 'replay', 'empty']) {
    payload = inventoryPayload(tier);
    payload.pool.unreadCount = 0;
    await refresh();
    assert.equal(status('tier'), tier);
    assert.equal(status('unreadCount'), '0');
  }
  payload = { ...inventoryPayload(), service: 'cache', stale: true,
    capabilities: { history: false, source: 'rss', truncated: true } };
  await refresh();
  assert.equal(status('service'), 'cache');
  assert.equal(status('stale'), 'true');
  for (const warning of ['history', 'rss', 'truncated']) assert.ok(container.querySelector('[data-newscope-warning="' + warning + '"]'));
  const statusCalls = calls.filter(({ options }) => options?.signal);
  assert.ok(statusCalls.length >= 8);
  for (const { url, options } of statusCalls) {
    assert.equal(url, '/plugins/dsh-newscope-news-ticker/news.json');
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
  }
  assert.ok(calls.every(({ url }) => !url.includes('/fetch') && !url.includes('read-events')));
});

test('inventory errors are explicit, escaped and not presented as empty stock; English labels exist', async (t) => {
  payload = inventoryPayload();
  const { status, refresh, container } = await mountSettings(t, DEFAULT_CONFIG, 'en');
  assert.match(container.textContent, /Live inventory status/);
  assert.match(container.textContent, /never permanently change L0/);
  assert.equal(container.textContent.includes('settings.inventory'), false);
  payload = { service: 'read-state-unavailable', error: '<img src=x onerror=alert(1)>' };
  await refresh();
  assert.match(status('error'), /read-state-unavailable/);
  assert.match(status('error'), /not an empty pool/);
  assert.equal(status('unreadCount'), 'Unknown');
  assert.equal(container.querySelector('img'), null);
  fetchError = new Error('offline');
  await refresh();
  assert.match(status('error'), /Could not load inventory status/);
  assert.equal(status('tier'), 'Unknown');
  fetchError = null;
  payload = inventoryPayload();
  await refresh();
  assert.equal(status('error'), undefined);
  assert.equal(status('service'), 'ok');
  globalThis.fetch = async () => Response.json({ service: 'read-state-unavailable' }, { status: 503 });
  await refresh();
  assert.match(status('error'), /read-state-unavailable/);
  globalThis.fetch = async () => new Response('bad json', { status: 500 });
  await refresh();
  assert.match(status('error'), /Could not load inventory status/);
  assert.equal(status('replay'), 'Unknown');
});

test('inventory status polling is bounded, single flight, abortable and ignores late results after timeout or unmount', async (t) => {
  payload = inventoryPayload();
  const timers = new Map();
  let nextId = 1000;
  const originalTimeout = window.setTimeout;
  const originalClear = window.clearTimeout;
  window.setTimeout = (fn, delay) => { const id = nextId++; timers.set(id, { fn, delay }); return id; };
  window.clearTimeout = (id) => timers.delete(id);
  t.after(() => { window.setTimeout = originalTimeout; window.clearTimeout = originalClear; });
  const { container, status, refresh, unmount } = await mountSettings(t);
  assert.ok([...timers.values()].some(({ delay }) => delay === 30000));
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  const hiddenTimer = [...timers.entries()].find(([, timer]) => timer.delay === 30000);
  timers.delete(hiddenTimer[0]);
  await act(async () => hiddenTimer[1].fn());
  assert.equal(container.querySelector('[data-newscope-refresh-status]').disabled, false, 'hidden panel skips polling');
  assert.ok([...timers.values()].some(({ delay }) => delay === 30000));
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  const pending = [];
  globalThis.fetch = (url, options) => new Promise((resolve) => pending.push({ url, options, resolve }));
  await refresh();
  await refresh();
  assert.equal(pending.length, 1);
  assert.equal(container.querySelector('[data-newscope-refresh-status]').disabled, true);
  const deadline = [...timers.entries()].find(([, timer]) => timer.delay === 15000);
  timers.delete(deadline[0]);
  await act(async () => deadline[1].fn());
  assert.equal(pending[0].options.signal.aborted, true);
  assert.match(status('error'), /超时/);
  await refresh();
  assert.equal(pending.length, 2);
  await act(async () => { pending[0].resolve(Response.json(inventoryPayload('L1'))); });
  assert.equal(status('tier'), '未知', 'timed-out request cannot overwrite a newer request');
  await act(async () => { pending[1].resolve(Response.json(inventoryPayload('L2'))); });
  assert.equal(status('tier'), 'L2');
  const periodic = [...timers.entries()].find(([, timer]) => timer.delay === 30000);
  timers.delete(periodic[0]);
  await act(async () => periodic[1].fn());
  assert.equal(pending.length, 3);
  unmount();
  assert.equal(pending[2].options.signal.aborted, true);
  assert.equal(timers.size, 0);
  await act(async () => { pending[2].resolve(Response.json(inventoryPayload('replay'))); });
  assert.equal(timers.size, 0, 'late completion must not rearm polling');
  assert.equal(document.querySelector('[data-newscope-inventory-status]'), null);
});

test('ticker tier metadata uses only title and aria-label, with no viewport badge', async () => {
  payload = inventoryPayload('L1');
  await start();
  const ticker = document.querySelector('[data-newscope-ticker]');
  assert.match(ticker.title, /L1/);
  assert.equal(ticker.getAttribute('aria-label'), ticker.title);
  assert.equal(ticker.children.length, 1, 'track remains the only viewport child');
  assert.ok(ticker.firstElementChild.hasAttribute('data-newscope-track'));
});
