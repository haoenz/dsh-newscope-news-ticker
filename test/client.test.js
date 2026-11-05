import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';

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
      showCategory: true, scrollSpeed: 'medium', refreshMinutes: 5,
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
  globalThis.fetch = async () => {
    if (fetchError) throw fetchError;
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

function translation(dicts, key) {
  const dict = dicts.zh;
  return key.split('.').reduce((value, part) => value?.[part], dict) || key;
}

async function start({ running = true, duplicateLocale = false } = {}) {
  if (running) document.body.innerHTML = '<div data-chat-running><span class="runningContent"><span class="runningText">深度求索中，用时 1秒</span></span></div>';
  const effects = [];
  const registrations = [];
  const ctx = {
    locale: {
      register(ns, dicts) {
        this.dicts = dicts;
        if (duplicateLocale) throw new Error(`locale namespace "${ns}" already has locale "en"`);
      },
      bind() { return (key) => translation(this.dicts, key); },
    },
    slots: {
      inject(name, callback) { registrations.push({ name, callback }); return () => {}; },
      register(options, component) { return () => { registrations.push({ options, component }); }; },
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

test('client module registers and preserves the native running label', async (t) => {
  if (!definition) {
    globalThis.window.__ModuleLoader__ = { load(value) { definition = value; } };
    await import('../client.js');
  }
  payload = basePayload();
  await start();
  const ticker = document.querySelector('[data-newscope-ticker]');
  assert.ok(ticker);
  assert.equal(document.querySelector('.runningText').textContent, '深度求索中，用时 1秒');
  assert.equal(document.querySelectorAll('[data-newscope-ticker]').length, 1);
  assert.equal(document.querySelectorAll('[data-newscope-item]').length, 4);
  const link = ticker.querySelector('a');
  assert.equal(link.href, 'https://example.com/a');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
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

test('reduced motion renders one static group and no animation frame', async () => {
  installDom({ reducedMotion: true });
  payload = basePayload();
  await start();
  assert.equal(document.querySelectorAll('[data-newscope-group]').length, 1);
  assert.equal(document.querySelector('[data-newscope-ticker]').dataset.reducedMotion, 'true');
  assert.equal(raf.size, 0);
});
