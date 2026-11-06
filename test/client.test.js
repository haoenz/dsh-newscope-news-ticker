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
      displayMode: 'running', pauseOnHover: true, openInNewTab: true,
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
  globalThis.IntersectionObserver = undefined;
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

test('feedback buttons submit through Host, prevent duplicates, switch actions and recover after failure', async () => {
  payload = basePayload();
  const key = 'url:' + 'a'.repeat(64) + ':' + 'b'.repeat(64);
  payload.items = [{ ...article('feedback'), newscopeId: '123', articleKey: key }];
  const originalFetch = globalThis.fetch;
  const requests = [];
  let failure = false;
  let release;
  globalThis.fetch = async (url, options = {}) => {
    if (url !== '/plugins/dsh-newscope-news-ticker/feedback') return originalFetch(url, options);
    requests.push({ url, options });
    if (failure) return Response.json({ error: 'rejected' }, { status: 500 });
    return new Promise((resolve) => {
      release = () => resolve(Response.json({ ok: true, articleKey: key, action: JSON.parse(options.body).action, statePersisted: true }));
    });
  };
  await start();
  const group = document.querySelector('[data-newscope-group]:not([data-newscope-clone])');
  const track = document.querySelector('[data-newscope-track]');
  const like = group.querySelector('[data-newscope-feedback-action="like"]');
  const dislike = group.querySelector('[data-newscope-feedback-action="dislike"]');
  const cloneLike = document.querySelector('[data-newscope-clone] [data-newscope-feedback-action="like"]');
  assert.equal(like.disabled, false);
  assert.equal(like.getAttribute('aria-pressed'), 'false');

  like.click();
  assert.equal(requests.length, 1);
  assert.equal(like.disabled, true, 'pending feedback disables the normal button');
  assert.equal(cloneLike.disabled, true, 'pending feedback also disables the clone');
  like.click();
  cloneLike.click();
  assert.equal(requests.length, 1, 'pending and cloned controls cannot double-submit');
  release();
  await flush();
  assert.equal(like.getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('[data-newscope-track]'), track, 'feedback must not rebuild the moving track');
  assert.equal(like.disabled, true, 'current feedback stays disabled to avoid another score adjustment');
  assert.equal(dislike.disabled, false);
  like.click();
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].options.body), { articleKey: key, action: 'like' });
  assert.equal(requests[0].options.credentials, 'same-origin');

  payload = { ...basePayload(), items: [{ ...article('feedback'), newscopeId: '123', articleKey: key }] };
  document.dispatchEvent(new window.Event('visibilitychange'));
  await flush();
  assert.equal(like.getAttribute('aria-pressed'), 'true', 'a stale Host news cache must not clear confirmed browser feedback');
  assert.equal(like.disabled, true);

  dislike.click();
  assert.equal(requests.length, 2);
  release();
  await flush();
  assert.equal(dislike.getAttribute('aria-pressed'), 'true');
  assert.equal(like.disabled, false);

  failure = true;
  like.click();
  await flush();
  assert.equal(requests.length, 3);
  assert.equal(like.disabled, false, 'failed feedback can be retried');
  assert.equal(like.dataset.newscopeFeedbackError, 'true');
  assert.match(like.title, /反馈失败/);
});

test('confirmed feedback marks an article read without three exposures and retires it', async () => {
  payload = basePayload();
  const key = 'url:' + 'c'.repeat(64) + ':' + 'd'.repeat(64);
  payload.items = [{ ...article('read-on-feedback'), newscopeId: '321', articleKey: key }];
  const originalFetch = globalThis.fetch;
  let readEventCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/plugins/dsh-newscope-news-ticker/feedback') {
      return Response.json({ ok: true, articleKey: key, action: 'like', statePersisted: true,
        readPersisted: true, readVersion: 1,
        exposureStates: { [key]: { read: true, readAt: new Date().toISOString(), readReason: 'manual', exposureCount: 0, lastShownAt: null } } });
    }
    if (url === '/plugins/dsh-newscope-news-ticker/read-events') readEventCalls++;
    return originalFetch(url, options);
  };
  await start();
  document.querySelector('[data-newscope-group]:not([data-newscope-clone]) [data-newscope-feedback-action="like"]').click();
  await flush();
  assert.equal(document.querySelector('[data-newscope-item]'), null, 'Host-confirmed feedback retires the article immediately in this geometry');
  assert.equal(readEventCalls, 0, 'feedback confirmation does not use the exposure event path');
});

test('failed feedback neither marks read nor retires the article', async () => {
  payload = basePayload();
  const key = 'url:' + 'e'.repeat(64) + ':' + 'f'.repeat(64);
  payload.items = [{ ...article('failed-feedback'), newscopeId: '654', articleKey: key }];
  const originalFetch = globalThis.fetch;
  let readEventCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/plugins/dsh-newscope-news-ticker/feedback') return Response.json({ error: 'rejected' }, { status: 500 });
    if (url === '/plugins/dsh-newscope-news-ticker/read-events') readEventCalls++;
    return originalFetch(url, options);
  };
  await start();
  const like = document.querySelector('[data-newscope-group]:not([data-newscope-clone]) [data-newscope-feedback-action="like"]');
  like.click();
  await flush();
  assert.ok(document.querySelector('[data-newscope-item]'));
  assert.equal(like.dataset.newscopeFeedbackError, 'true');
  assert.equal(readEventCalls, 0);
});

test('feedback controls explain and disable RSS-only articles without a Newscope ID', async () => {
  payload = basePayload();
  const originalFetch = globalThis.fetch;
  let feedbackCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (url === '/plugins/dsh-newscope-news-ticker/feedback') feedbackCalls++;
    return originalFetch(url, options);
  };
  await start();
  const button = document.querySelector('[data-newscope-group]:not([data-newscope-clone]) [data-newscope-feedback-action="like"]');
  assert.equal(button.disabled, true);
  assert.match(button.title, /Newscope 数字 ID/);
  button.click();
  assert.equal(feedbackCalls, 0);
});

test('always display mode mounts the idle ticker in the scrolling chat column', async () => {
  document.body.innerHTML = '<div data-chat-flow><div data-slot="conversation.chat.flow"><span>last message</span></div></div><div id="composer"><div data-composer-card><span>composer</span></div><div data-composer-dock><div data-slot="conversation.composer.dock"></div><span>cache hit</span></div></div>';
  payload = basePayload();
  const configuration = createConfiguration();
  await start({ running: false, configuration });
  assert.equal(document.querySelector('[data-newscope-ticker]'), null);

  await configuration.mutate([{ op: 'set', path: ['displayMode'], value: 'always' }], 7);
  await flush();
  const flow = document.querySelector('[data-chat-flow]');
  const composer = document.querySelector('#composer');
  const card = composer.querySelector('[data-composer-card]');
  const ticker = flow.querySelector(':scope > [data-newscope-ticker]');
  assert.ok(ticker, 'Always must show in the chat flow without waiting for a manual refresh');
  assert.equal(ticker, flow.lastElementChild, 'the idle ticker uses the same content column and width as the running row');
  assert.equal(composer.querySelector('[data-newscope-ticker]'), null, 'the sticky composer must not keep the ticker on screen');
  assert.equal(document.querySelector('[data-composer-dock] [data-newscope-ticker]'), null, 'the usage/context dock must remain untouched');
  assert.equal(card.classList.contains('dsh-newscope-running-content'), false, 'running-row styles must not alter the input card');
  assert.ok(ticker.hasAttribute('data-newscope-idle'));

  await configuration.mutate([{ op: 'set', path: ['displayMode'], value: 'off' }], 8);
  assert.equal(document.querySelector('[data-newscope-ticker]'), null, 'Off must remove the idle ticker immediately');
});

test('running display keeps the current immediate-hide behavior by default', async () => {
  payload = basePayload();
  await start();
  document.querySelector('[data-chat-running]').remove();
  document.body.insertAdjacentHTML('beforeend', '<div data-chat-flow><div data-slot="conversation.chat.flow"><span>last message</span></div></div><div id="composer"><div data-composer-card><span>composer</span></div><div data-composer-dock><div data-slot="conversation.composer.dock"></div><span>cache hit</span></div></div>');
  await flush();
  assert.equal(document.querySelector('[data-newscope-ticker]'), null);
});

test('delayed hide keeps scrolling in the chat flow and disappears at the deadline', async (t) => {
  payload = basePayload();
  const configuration = createConfiguration({ ...DEFAULT_CONFIG, runningIdleBehavior: 'delay', runningIdleDelaySeconds: 5 });
  await start({ configuration });
  const timers = new Map();
  let nextTimer = 1000;
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const originalNow = Date.now;
  const now = originalNow();
  Date.now = () => now;
  window.setTimeout = (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, delay }); return id; };
  window.clearTimeout = (id) => { timers.delete(id); originalClearTimeout(id); };
  t.after(() => {
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
    Date.now = originalNow;
  });

  document.querySelector('[data-chat-running]').remove();
  document.body.insertAdjacentHTML('beforeend', '<div data-chat-flow><div data-slot="conversation.chat.flow"><span>last message</span></div></div><div id="composer"><div data-composer-card><span>composer</span></div><div data-composer-dock><div data-slot="conversation.composer.dock"></div><span>cache hit</span></div></div>');
  await flush();
  const flow = document.querySelector('[data-chat-flow]');
  const ticker = flow.querySelector(':scope > [data-newscope-ticker]');
  assert.ok(ticker, 'the running ticker moves into the chat flow during the grace period');
  assert.equal(ticker, flow.lastElementChild);
  assert.equal(document.querySelector('#composer [data-newscope-ticker]'), null);
  assert.equal(document.querySelector('[data-composer-dock] [data-newscope-ticker]'), null);
  assert.equal(ticker.dataset.paused, 'false');
  const timer = [...timers.values()].find((entry) => entry.delay === 5000);
  assert.ok(timer, 'the configured five-second hide timer is armed');
  frame(1000);
  frame(1016);
  assert.match(ticker.querySelector('[data-newscope-track]').style.transform, /-0\.72px/, 'delay mode continues scrolling');
  Date.now = () => now + 5000;
  timer.fn();
  assert.equal(document.querySelector('[data-newscope-ticker]'), null);
});

test('keep-paused applies only after a run, stays static while idle and resumes on the next run', async () => {
  document.body.innerHTML = '<div data-chat-flow><div data-slot="conversation.chat.flow"><span>last message</span></div></div><div id="composer"><div data-composer-card><span>composer</span></div><div data-composer-dock><div data-slot="conversation.composer.dock"></div><span>cache hit</span></div></div>';
  payload = basePayload();
  const configuration = createConfiguration({ ...DEFAULT_CONFIG, runningIdleBehavior: 'pause' });
  await start({ running: false, configuration });
  assert.equal(document.querySelector('[data-newscope-ticker]'), null, 'initial idle alone must not create a ticker');

  document.body.insertAdjacentHTML('beforeend', '<div data-chat-running><span class="runningContent"><span class="runningText">running</span></span></div>');
  await flush();
  assert.ok(document.querySelector('[data-chat-running] [data-newscope-ticker]'));
  document.querySelector('[data-chat-running]').remove();
  await flush();
  const idle = document.querySelector('[data-chat-flow] > [data-newscope-ticker]');
  assert.ok(idle, 'the completed run leaves a ticker in the scrolling chat column');
  assert.equal(idle, document.querySelector('[data-chat-flow]').lastElementChild);
  assert.equal(document.querySelector('#composer [data-newscope-ticker]'), null, 'the static ticker must not stick to the composer');
  assert.equal(document.querySelector('[data-composer-dock] [data-newscope-ticker]'), null, 'the static ticker must not occupy the usage/context dock');
  assert.equal(idle.dataset.paused, 'true');
  const track = idle.querySelector('[data-newscope-track]');
  const initialTransform = track.style.transform;
  frame(1000);
  frame(1016);
  assert.equal(track.style.transform, initialTransform, 'idle pause must not advance the track');

  document.body.insertAdjacentHTML('beforeend', '<div data-chat-running><span class="runningContent"><span class="runningText">next run</span></span></div>');
  await flush();
  const running = document.querySelector('[data-chat-running] [data-newscope-ticker]');
  assert.ok(running);
  assert.equal(document.querySelector('[data-newscope-idle]'), null);
  assert.equal(running.dataset.paused, 'false');
  frame(2000);
  frame(2016);
  assert.match(running.querySelector('[data-newscope-track]').style.transform, /-0\.72px/, 'the next run resumes scrolling');
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

test('scrolling the ticker outside the viewport pauses without losing playback position', async () => {
  document.body.innerHTML = '<div data-chat-flow><div data-slot="conversation.chat.flow"><span>last message</span></div></div>';
  let observerCallback;
  let observed;
  globalThis.IntersectionObserver = class {
    constructor(callback) { observerCallback = callback; }
    observe(target) { observed = target; }
    disconnect() {}
  };
  payload = basePayload();
  await start({ running: false, configuration: createConfiguration({ ...DEFAULT_CONFIG, displayMode: 'always' }) });
  const ticker = document.querySelector('[data-newscope-ticker]');
  const track = ticker.querySelector('[data-newscope-track]');
  assert.equal(observed, ticker);
  const intersect = (visible) => observerCallback([{ target: ticker, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]);
  intersect(true);
  frame(1000); frame(1016);
  assert.match(track.style.transform, /-0\.72px/);

  intersect(false);
  assert.equal(ticker.dataset.paused, 'true');
  const hiddenTransform = track.style.transform;
  frame(5000); frame(5016);
  assert.equal(track.style.transform, hiddenTransform, 'hidden time must not advance the track');

  intersect(true);
  assert.equal(ticker.dataset.paused, 'false');
  frame(6000);
  assert.equal(track.style.transform, hiddenTransform, 'the first resumed frame establishes a fresh clock');
  frame(6016);
  assert.match(track.style.transform, /-1\.44px/, 'playback resumes from the exact pre-hide offset');
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
  payload = basePayload();
  const configuration = createConfiguration({ ...DEFAULT_CONFIG, displayMode: 'off' });
  await start({ configuration });
  assert.equal(document.querySelector('[data-newscope-ticker]'), null);
  await configuration.mutate([{ op: 'set', path: ['displayMode'], value: 'running' }], 7);
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

test('native settings expose three display modes and automatically save every valid edit', async (t) => {
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
  assert.equal(container.querySelector('[data-newscope-save]'), null, 'automatic settings must not need a Save button');
  assert.ok(container.textContent.includes('无需点击保存'));
  const translationSelect = container.querySelector('select[data-setting="translationModel"]');
  assert.ok(translationSelect, 'translation model should be a catalog select, not a text input');
  assert.ok(translationSelect.textContent.includes('DeepSeek Flash · KT'));
  assert.ok(translationSelect.textContent.includes('跟随 DSH 默认模型（kt/deepseek-flash）'));
  const displaySelect = container.querySelector('select[data-setting="displayMode"]');
  assert.equal(displaySelect.value, 'running');
  assert.equal('enabled' in configuration.getSnapshot().value, false);
  assert.equal('onlyWhenRunning' in configuration.getSnapshot().value, false);
  assert.deepEqual([...displaySelect.options].map((option) => [option.value, option.textContent]), [
    ['off', '关闭'], ['running', '运行时显示'], ['always', '总是显示'],
  ]);
  assert.ok(document.querySelector('[data-newscope-ticker]'));

  const translationToggle = container.querySelector('[data-setting="translationEnabled"]');
  await act(async () => { translationToggle.click(); });
  assert.equal(translationToggle.checked, true);
  assert.deepEqual(configuration.calls, [{
    ops: [{ op: 'set', path: ['translationEnabled'], value: true }],
    expectedRevision: 7,
  }]);
  assert.equal(configuration.getSnapshot().value.translationEnabled, true);
  assert.ok(container.textContent.includes('已自动保存'));

  await act(async () => {
    translationSelect.value = 'kt/deepseek-flash';
    Simulate.change(translationSelect, { target: { value: 'kt/deepseek-flash' } });
  });
  assert.deepEqual(configuration.calls[1], {
    ops: [{ op: 'set', path: ['translationModel'], value: 'kt/deepseek-flash' }],
    expectedRevision: 8,
  });

  const changeDisplay = async (value) => {
    await act(async () => { Simulate.change(displaySelect, { target: { value } }); });
  };
  await changeDisplay('always');
  assert.deepEqual(configuration.calls[2], {
    ops: [{ op: 'set', path: ['displayMode'], value: 'always' }], expectedRevision: 9,
  });
  assert.ok(document.querySelector('[data-newscope-ticker]'));
  await changeDisplay('off');
  assert.deepEqual(configuration.calls[3], {
    ops: [{ op: 'set', path: ['displayMode'], value: 'off' }], expectedRevision: 10,
  });
  assert.equal(document.querySelector('[data-newscope-ticker]'), null, 'Off must detach the visible ticker immediately');
  await changeDisplay('running');
  assert.deepEqual(configuration.calls[4], {
    ops: [{ op: 'set', path: ['displayMode'], value: 'running' }], expectedRevision: 11,
  });
  assert.ok(document.querySelector('[data-newscope-ticker]'), 'Running must restore the ticker immediately');

  const scoreInput = container.querySelector('[data-setting="minScore"]');
  await act(async () => {
    scoreInput.value = '11';
    Simulate.change(scoreInput, { target: { value: '11' } });
  });
  assert.equal(scoreInput.value, '11');
  assert.equal(configuration.calls.length, 5, 'invalid values must not reach the Host');
  assert.ok(container.textContent.includes('本次修改尚未生效'));
});

test('automatic settings serialize rapid edits and use each newly accepted revision', async (t) => {
  payload = basePayload();
  const { configuration, edit } = await mountSettings(t);
  const mutate = configuration.mutate.bind(configuration);
  let releaseFirst;
  let first = true;
  configuration.mutate = async (ops, expectedRevision) => {
    if (first) {
      first = false;
      await new Promise((resolve) => { releaseFirst = resolve; });
    }
    return mutate(ops, expectedRevision);
  };

  await edit('scrollSpeed', 'fast');
  await edit('scrollSpeed', 'slow');
  assert.equal(configuration.calls.length, 0, 'the first write is deliberately held open');
  await act(async () => { releaseFirst(); await flush(); });
  assert.deepEqual(configuration.calls, [
    { ops: [{ op: 'set', path: ['scrollSpeed'], value: 'fast' }], expectedRevision: 7 },
    { ops: [{ op: 'set', path: ['scrollSpeed'], value: 'slow' }], expectedRevision: 8 },
  ]);
  assert.equal(configuration.getSnapshot().value.scrollSpeed, 'slow');
});

test('running idle settings are conditional, validated and automatically saved', async (t) => {
  payload = basePayload();
  const { configuration, container, edit } = await mountSettings(t);
  const behavior = container.querySelector('[data-setting="runningIdleBehavior"]');
  assert.ok(behavior);
  assert.equal(behavior.value, 'hide');
  assert.equal(container.querySelector('[data-setting="runningIdleDelaySeconds"]'), null);

  await edit('runningIdleBehavior', 'delay');
  assert.deepEqual(configuration.calls[0].ops, [{ op: 'set', path: ['runningIdleBehavior'], value: 'delay' }]);
  const delay = container.querySelector('[data-setting="runningIdleDelaySeconds"]');
  assert.ok(delay);
  assert.equal(delay.min, '1');
  assert.equal(delay.max, '300');
  for (const invalid of [0, 301, 1.5]) {
    await edit('runningIdleDelaySeconds', invalid);
    assert.equal(configuration.calls.length, 1);
  }
  await edit('runningIdleDelaySeconds', 12);
  assert.deepEqual(configuration.calls[1].ops, [{ op: 'set', path: ['runningIdleDelaySeconds'], value: 12 }]);
  await edit('runningIdleBehavior', 'pause');
  assert.equal(container.querySelector('[data-setting="runningIdleDelaySeconds"]'), null);
  await edit('displayMode', 'always');
  assert.equal(container.querySelector('[data-setting="runningIdleBehavior"]'), null, 'always mode does not show running-only options');
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
  const refresh = async () => { await act(async () => container.querySelector('[data-newscope-refresh-status]').click()); };
  const status = (key) => container.querySelector('[data-newscope-status="' + key + '"]')?.textContent;
  return { configuration, container, edit, refresh, status, unmount };
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

test('inventory settings default missing fields without writing unedited or hidden fields', async (t) => {
  payload = basePayload();
  const legacy = structuredClone(DEFAULT_CONFIG);
  delete legacy.inventory;
  delete legacy.readAfterExposures;
  legacy.hiddenSetting = { keep: true };
  const { container, configuration, edit, status } = await mountSettings(t, legacy);
  for (const [key, value] of Object.entries(inventoryDefaults)) {
    assert.equal(container.querySelector('[data-setting="' + key + '"]').value, String(value));
  }
  for (const key of ['service', 'stale', 'tier', 'unreadCount', 'replay', 'queriedAt',
    'inventoryScope', 'coverage', 'remoteWindowComplete', 'localInventory', 'retainedCount', 'firstCollectedAt', 'updatedAt', 'pruned']) assert.equal(status(key), '未知');
  assert.match(status('effective'), /未知/);
  assert.match(status('capabilities'), /未知/);
  await edit('minScore', 8);
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
  const { configuration, edit, container } = await mountSettings(t, initial);
  const changes = { readAfterExposures: 100, 'inventory.targetInventory': 100, 'inventory.lowWatermark': 0,
    'inventory.refillDebounceSeconds': 3600, 'inventory.level1.minScore': 0, 'inventory.level1.maxAgeHours': 720,
    'inventory.level2.minScore': 10, 'inventory.level2.maxAgeHours': 1 };
  for (const [key, value] of Object.entries(changes)) await edit(key, value);
  assert.equal(configuration.calls.length, Object.entries(changes).length, 'each valid edit should save immediately');
  assert.deepEqual(configuration.calls.map((call) => call.ops), Object.entries(changes).map(([key, value]) => [{ op: 'set', path: key.split('.'), value }]));
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
  const { configuration, edit, container } = await mountSettings(t);
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
    assert.equal(configuration.calls.length, 0, key + '=' + value);
    assert.match(container.textContent, /低水位不大于目标库存/);
    await edit(key, inventoryDefaults[key]);
  }
  await edit('inventory.targetInventory', 1);
  await edit('inventory.lowWatermark', 1);
  await edit('readAfterExposures', 1);
  await edit('inventory.refillDebounceSeconds', 1);
  await edit('inventory.level1.minScore', 6.5);
  assert.equal(configuration.calls.length, 4, 'valid cross-field edits and fractional scores should save automatically');
  assert.deepEqual(configuration.calls[0].ops, [
    { op: 'set', path: ['inventory', 'targetInventory'], value: 1 },
    { op: 'set', path: ['inventory', 'lowWatermark'], value: 1 },
  ]);
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

test('known-local RSS and HTML inventory expose scope, store metadata and limited coverage without disabling tiers', async (t) => {
  payload = { ...inventoryPayload('L2+replay'),
    capabilities: { inventoryScope: 'known-local', remoteWindowComplete: false, coverage: 'rss-window',
      localInventory: true, source: 'rss', history: true, truncated: false },
    inventoryStore: { retainedCount: 120, firstCollectedAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-05T12:00:00.000Z', pruned: 12 } };
  const { status, container, refresh } = await mountSettings(t);
  for (const key of ['inventoryScope', 'coverage', 'remoteWindowComplete', 'localInventory']) {
    assert.equal(status(key), String(payload.capabilities[key]));
  }
  for (const key of ['retainedCount', 'firstCollectedAt', 'updatedAt', 'pruned']) {
    assert.equal(status(key), String(payload.inventoryStore[key]));
  }
  assert.equal(status('tier'), 'L2+replay');
  assert.match(container.textContent, /首次采集时间（不是完整历史起点）/);
  assert.match(container.textContent, /放宽与重播仅针对本插件已收集候选，无法证明远端高档未读耗尽/);
  assert.ok(container.querySelector('[data-newscope-warning="rss"]').textContent.includes('L0/L1/L2 与重播'));
  assert.equal(container.querySelector('[data-newscope-warning="history"]'), null);
  assert.equal(container.querySelector('[data-newscope-warning="remote-window"]'), null);
  payload.capabilities.source = 'rss+html';
  payload.capabilities.coverage = 'best-effort';
  await refresh();
  assert.equal(status('coverage'), 'best-effort');
  assert.ok(container.querySelector('[data-newscope-warning="rss"]'));
  assert.match(container.querySelector('[data-newscope-warning="best-effort"]').textContent, /页码分页.*并发.*漏项/);
  payload.capabilities.coverage = 'partial';
  payload.capabilities.truncated = true;
  payload.inventoryStore.retainedCount = 0;
  payload.inventoryStore.pruned = 0;
  await refresh();
  assert.equal(status('retainedCount'), '0');
  assert.equal(status('pruned'), '0');
  assert.equal(status('coverage'), 'partial');
  assert.match(container.querySelector('[data-newscope-warning="partial"]').textContent, /覆盖不完整/);
  assert.match(container.querySelector('[data-newscope-warning="truncated"]').textContent, /已截断/);
  assert.equal(container.querySelector('[data-newscope-warning="best-effort"]'), null);
});

test('candidate store counts accept only nonnegative integers', async (t) => {
  payload = { ...inventoryPayload(), inventoryStore: { retainedCount: 42, pruned: 5 } };
  const { status, container, refresh } = await mountSettings(t, DEFAULT_CONFIG, 'en');
  assert.equal(status('retainedCount'), '42');
  assert.equal(status('pruned'), '5');
  assert.match(container.textContent, /Retained candidates for this source/);
  assert.match(container.textContent, /Candidates pruned globally in this operation/);
  for (const invalid of [true, false, -1, 0.5, '5', null]) {
    payload.inventoryStore = { retainedCount: invalid, pruned: invalid };
    await refresh();
    assert.equal(status('retainedCount'), 'Unknown');
    assert.equal(status('pruned'), 'Unknown');
  }
});

test('remote completeness is limited to the queried JSON window and missing legacy fields stay unknown', async (t) => {
  payload = { ...inventoryPayload(), capabilities: { inventoryScope: 'remote-window', remoteWindowComplete: true,
    coverage: 'queried-window', localInventory: true, source: 'articles', history: true, truncated: false } };
  const { status, container, refresh } = await mountSettings(t, DEFAULT_CONFIG, 'en');
  assert.equal(status('inventoryScope'), 'remote-window');
  assert.equal(status('remoteWindowComplete'), 'true');
  assert.equal(status('coverage'), 'queried-window');
  assert.equal(status('retainedCount'), 'Unknown');
  assert.equal(status('firstCollectedAt'), 'Unknown');
  assert.match(container.querySelector('[data-newscope-warning="remote-window"]').textContent, /not a fixed snapshot of the entire database/);
  assert.match(container.textContent, /history describes available known history, not remote completeness/);
  payload = inventoryPayload();
  await refresh();
  for (const key of ['inventoryScope', 'coverage', 'remoteWindowComplete', 'localInventory',
    'retainedCount', 'firstCollectedAt', 'updatedAt', 'pruned']) assert.equal(status(key), 'Unknown');
  assert.equal(container.querySelector('[data-newscope-warning="remote-window"]'), null);
  payload.capabilities = { history: false, source: 'rss+html', truncated: false };
  await refresh();
  assert.match(container.querySelector('[data-newscope-warning="history"]').textContent, /legacy response compatible/);
  assert.ok(container.querySelector('[data-newscope-warning="rss"]'));
  assert.doesNotMatch(container.textContent, /only the standard tier is reliable|replay (?:is )?disabled/i);
  assert.equal(status('remoteWindowComplete'), 'Unknown');
  payload.capabilities = { inventoryScope: 'known-local', coverage: 'best-effort', source: 'rss+html' };
  await refresh();
  assert.match(container.querySelector('[data-newscope-warning="known-local"]').textContent, /only to candidates collected by this plugin/);
  assert.match(container.querySelector('[data-newscope-warning="best-effort"]').textContent, /concurrent changes during page-number pagination may cause missed items/);
  payload.capabilities.coverage = 'partial';
  await refresh();
  assert.match(container.querySelector('[data-newscope-warning="partial"]').textContent, /Coverage is partial/);
});

test('host warning strings and status dangertext render as escaped React text only', async (t) => {
  const danger = '<img src=x onerror=alert(1)><script>alert(2)</script>&"';
  payload = { ...inventoryPayload(), warnings: [danger, 'partial: <b>not complete</b>', null, { message: danger }, 7],
    capabilities: { ...inventoryPayload().capabilities, inventoryScope: danger, coverage: danger, source: danger },
    inventoryStore: { retainedCount: 7, firstCollectedAt: danger, updatedAt: danger, pruned: 0 } };
  const { status, container, refresh } = await mountSettings(t);
  assert.equal(status('warnings'), danger + 'partial: <b>not complete</b>');
  assert.equal(container.querySelectorAll('[data-newscope-status="warnings"] li').length, 2);
  for (const key of ['inventoryScope', 'coverage', 'firstCollectedAt', 'updatedAt']) assert.equal(status(key), danger);
  assert.equal(container.querySelector('img, script, b'), null);
  assert.match(container.querySelector('[data-newscope-status="warnings"]').innerHTML, /&lt;img/);
  payload.warnings = danger;
  await refresh();
  assert.equal(status('warnings'), undefined, 'only a string array is accepted');
});

for (const locale of ['zh', 'en']) test('candidate persistence failure is distinct from read-state failure (' + locale + ')', async (t) => {
  payload = inventoryPayload();
  const { status, refresh } = await mountSettings(t, DEFAULT_CONFIG, locale);
  globalThis.fetch = async () => Response.json({ service: 'candidate-state-unavailable' }, { status: 503 });
  await refresh();
  assert.equal(status('service'), 'candidate-state-unavailable');
  assert.match(status('error'), /^candidate-state-unavailable/);
  assert.match(status('error'), locale === 'zh' ? /候选持久化不可用，这不是空库存/ : /persistent candidate storage is unavailable; this is not an empty inventory/);
  assert.equal(status('retainedCount'), locale === 'zh' ? '未知' : 'Unknown');
  assert.equal(status('unreadCount'), locale === 'zh' ? '未知' : 'Unknown');
  globalThis.fetch = async () => Response.json({ service: 'read-state-unavailable' }, { status: 503 });
  await refresh();
  assert.match(status('error'), /^read-state-unavailable/);
  assert.doesNotMatch(status('error'), /candidate-state-unavailable/);
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
  payload.capabilities.inventoryScope = 'known-local';
  await start();
  const ticker = document.querySelector('[data-newscope-ticker]');
  assert.match(ticker.title, /L1/);
  assert.match(ticker.title, /库存范围: known-local/);
  assert.equal(ticker.getAttribute('aria-label'), ticker.title);
  assert.equal(ticker.children.length, 1, 'track remains the only viewport child');
  assert.ok(ticker.firstElementChild.hasAttribute('data-newscope-track'));
});
