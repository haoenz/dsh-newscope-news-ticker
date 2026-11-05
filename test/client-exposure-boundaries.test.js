import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { DEFAULT_CONFIG } from '../lib/config.js';

const READ_EVENTS_URL = '/plugins/dsh-newscope-news-ticker/read-events';
let definition;
let cleanup;
let dom;
let raf;
let timeouts;
let payload;
let fetchError;
let eventFailures;
let eventStatus;
let eventRequests;
let hostEvents;
let hostStates;
let hostVersion;
let hidden;
let hideItems;
let clock;
let geometry;
let resizeObservers;
let intervals;

function articleKey(id) {
  return `url:${'a'.repeat(64)}:${Buffer.from(id).toString('hex').padStart(64, '0').slice(-64)}`;
}

function article(id, category = 'finance') {
  return {
    id, articleKey: articleKey(id), category, title: `Title ${id}`, url: `https://example.com/${id}`,
    source: 'Example', score: 8, publishedAt: new Date().toISOString(), topics: [],
  };
}

function basePayload(ids = ['a']) {
  return {
    config: {
      enabled: true, onlyWhenRunning: true, pauseOnHover: true, openInNewTab: true,
      scrollSpeed: 'medium', refreshMinutes: 5,
    },
    items: ids.map((id) => article(id)),
  };
}

function processEvents(events) {
  let accepted = 0;
  let duplicates = 0;
  for (const event of events) {
    if (hostEvents.has(event.eventId)) { duplicates++; continue; }
    hostEvents.set(event.eventId, event);
    accepted++;
    const state = hostStates[event.articleKey] || { exposureCount: 0, read: false, readAt: null, readReason: null };
    if (event.type === 'exposure' && !state.read) state.exposureCount++;
    if (event.type !== 'exposure' || state.exposureCount >= 3) {
      state.read = true;
      state.readAt = new Date().toISOString();
      state.readReason = event.type;
    }
    hostStates[event.articleKey] = state;
  }
  if (accepted) hostVersion++;
  return { readVersion: hostVersion, accepted, duplicates, exposureStates: hostStates };
}

function installDom() {
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:3080' });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  hidden = false;
  hideItems = false;
  geometry = { rootLeft: 0, rootTop: 0, rootWidth: 800, itemLeft: 0, itemWidth: 200, moving: false };
  resizeObservers = new Set();
  intervals = new Map();
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.fetch = async (url, options = {}) => {
    if (url === READ_EVENTS_URL) {
      const events = JSON.parse(options.body).events;
      eventRequests.push({ events, keepalive: options.keepalive === true });
      if (eventFailures > 0) { eventFailures--; throw new Error('event network failure'); }
      if (eventStatus) return Response.json({ error: 'rejected' }, { status: eventStatus });
      return Response.json(processEvents(events));
    }
    if (fetchError) throw fetchError;
    const items = payload.items.filter((item) => !hostStates[item.articleKey]?.read);
    return Response.json({ ...payload, items, readVersion: hostVersion, exposureStates: hostStates });
  };
  raf = new Map();
  timeouts = new Map();
  let nextId = 1;
  window.requestAnimationFrame = (fn) => { const id = nextId++; raf.set(id, fn); return id; };
  window.cancelAnimationFrame = (id) => raf.delete(id);
  window.setInterval = (fn) => { const id = nextId++; intervals.set(id, fn); return id; };
  window.clearInterval = (id) => intervals.delete(id);
  window.setTimeout = (fn, delay) => { const id = nextId++; timeouts.set(id, { fn, delay }); return id; };
  window.clearTimeout = (id) => timeouts.delete(id);
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; resizeObservers.add(this); }
    observe() {}
    disconnect() { resizeObservers.delete(this); }
  };
  Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value() {
      const track = document.querySelector('[data-newscope-track]');
      const transform = track?.style.transform || '';
      const match = transform.match(/translate3d\((-?\d+(?:\.\d+)?)px/);
      const position = match ? -Number(match[1]) : 0;
      let left = geometry.rootLeft;
      let top = geometry.rootTop;
      let width = geometry.rootWidth;
      if (this.hasAttribute('data-newscope-item')) {
        const group = this.parentElement;
        const groupIndex = [...track.children].indexOf(group);
        const itemIndex = [...group.children].indexOf(this);
        // Fixed rectangles isolate geometric qualification from animation. The
        // moving case below uses track transforms and real clone spacing.
        left += geometry.moving
          ? -position + groupIndex * group.children.length * geometry.itemWidth + itemIndex * geometry.itemWidth
          : geometry.itemLeft + (groupIndex ? 10000 : 0);
        width = hideItems ? 0 : geometry.itemWidth;
      } else if (this.hasAttribute('data-newscope-group')) {
        const groupIndex = [...track.children].indexOf(this);
        width = this.children.length * geometry.itemWidth;
        left += -position + groupIndex * width;
      } else if (this.hasAttribute('data-newscope-track')) {
        left -= position;
      }
      return { left, top, width, height: 26, right: left + width, bottom: top + 26 };
    },
  });
}

function configuration() {
  return {
    getSnapshot: () => ({ status: 'ready', value: structuredClone(DEFAULT_CONFIG), revision: 1, writable: true }),
    subscribe: () => () => {},
    mutate: async () => true,
  };
}

function translation(dicts, key) {
  return key.split('.').reduce((value, part) => value?.[part], dicts.zh) || key;
}

async function start() {
  if (!definition) {
    globalThis.window.__ModuleLoader__ = { load(value) { definition = value; } };
    await import('../client.js');
  }
  document.body.innerHTML = '<div data-chat-running><span class="runningContent"><span class="runningText">running</span></span></div>';
  const effects = [];
  const ctx = {
    locale: {
      register(ns, dicts) { this.dicts = dicts; },
      bind() { return (key) => translation(this.dicts, key); },
    },
    slots: { inject() { return () => {}; }, register() { return () => {}; } },
    configForms: {
      get() { return configuration(); },
      whileServed(namespaces, register) { return register(); },
    },
    effect(fn) { effects.push(fn()); },
  };
  const plugin = definition.factory((name) => name === 'react' ? React : assert.fail(name));
  plugin.apply(ctx);
  await flush();
  cleanup = () => effects.forEach((dispose) => dispose?.());
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
  clock = time;
}

function advanceTo(target) {
  while (clock < target) frame(Math.min(target, clock + 100));
}

async function flushEvents() {
  const entry = [...timeouts.entries()].sort((left, right) => left[1].delay - right[1].delay)[0];
  if (!entry) { await flush(); return false; }
  timeouts.delete(entry[0]);
  entry[1].fn();
  await flush();
  return true;
}

beforeEach(() => {
  installDom();
  eventFailures = 0;
  eventStatus = 0;
  eventRequests = [];
  hostEvents = new Map();
  hostStates = {};
  hostVersion = 0;
  clock = 1000;
  payload = basePayload();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  dom?.window.close();
  fetchError = null;
});

// Assertions observe the Host projection and its idempotently accepted events,
// not client queue length. Drain transport timers before every assertion.
async function assertHostCount(expected, message) {
  for (let attempts = 0; timeouts.size && attempts < 20; attempts++) await flushEvents();
  await flush();
  const key = payload.items[0].articleKey;
  assert.equal(hostStates[key]?.exposureCount || 0, expected, message);
  assert.equal([...hostEvents.values()].filter((event) => event.articleKey === key && event.type === 'exposure').length,
    expected, message + ' (accepted Host events)');
}

function tickerEvent(type) {
  document.querySelector('[data-newscope-ticker]').dispatchEvent(new window.Event(type));
}

function visibility(value) {
  hidden = value;
  document.dispatchEvent(new window.Event('visibilitychange'));
}

async function refreshFeed() {
  assert.ok(intervals.size, 'feed refresh interval is installed');
  for (const callback of [...intervals.values()]) await callback();
  await flush();
}

for (const { label, rootWidth, itemWidth, threshold } of [
  { label: 'short item requires its entire width', rootWidth: 800, itemWidth: 80, threshold: 80 },
  { label: 'narrow ticker requires half its width', rootWidth: 240, itemWidth: 300, threshold: 120 },
  { label: 'wide ticker uses the 160px cap', rootWidth: 800, itemWidth: 400, threshold: 160 },
]) {
  test('geometry threshold: ' + label, async () => {
    Object.assign(geometry, { rootWidth, itemWidth, itemLeft: rootWidth - threshold + 0.01 });
    await start();
    frame(1000);
    advanceTo(2500);
    await assertHostCount(0, 'even a long dwell 0.01px below threshold must not count');

    geometry.itemLeft = rootWidth - threshold;
    frame(2600);
    advanceTo(3599);
    await assertHostCount(0, 'exactly sufficient geometry still needs a full continuous 1000ms');
    frame(3600);
    await assertHostCount(1, 'exact threshold and exactly 1000ms qualify');
  });
}

test('viewport clipping contributes to the visible-width threshold', async () => {
  Object.assign(geometry, { rootLeft: window.innerWidth - 159.99, itemWidth: 400 });
  await start();
  frame(1000);
  advanceTo(2500);
  await assertHostCount(0, 'root overlap alone cannot bypass the viewport clip');
  geometry.rootLeft = window.innerWidth - 160;
  frame(2600);
  advanceTo(3600);
  await assertHostCount(1, '160px inside the viewport qualifies after a fresh dwell');
});

test('a vertically offscreen ticker cannot accrue exposure', async () => {
  geometry.rootTop = window.innerHeight;
  await start();
  frame(1000);
  advanceTo(2500);
  await assertHostCount(0, 'zero vertical intersection does not count');
  geometry.rootTop = 0;
  frame(2600);
  advanceTo(3600);
  await assertHostCount(1, 'visible ticker starts its own dwell');
});

test('falling below geometric threshold interrupts rather than accumulates dwell', async () => {
  await start();
  frame(1000);
  advanceTo(1600);
  geometry.itemLeft = 800 - 159.99;
  frame(1700);
  geometry.itemLeft = 0;
  frame(1800);
  advanceTo(2700);
  await assertHostCount(0, '600ms before interruption plus 900ms after is not one exposure');
  frame(2800);
  await assertHostCount(1, 'a full fresh dwell qualifies');
});

test('background dwell is discarded even when no animation frame runs while hidden', async () => {
  await start();
  frame(1000);
  advanceTo(1600);
  visibility(true);
  // Browsers can suspend rAF in background tabs. No frame is run here.
  clock = 5000;
  visibility(false);
  await flush();
  frame(5000);
  advanceTo(5900);
  await assertHostCount(0, 'returning from background cannot reuse the previous 600ms');
  frame(6000);
  await assertHostCount(1, 'foreground requires a fresh 1000ms');
});

test('background animation callbacks cannot produce exposure', async () => {
  await start();
  frame(1000);
  advanceTo(1600);
  visibility(true);
  advanceTo(5000);
  await assertHostCount(0, 'hidden time never counts even if rAF callbacks arrive');
  visibility(false);
  await flush();
  frame(5100);
  advanceTo(6000);
  await assertHostCount(0, 'hidden callbacks do not prefill foreground dwell');
  frame(6100);
  await assertHostCount(1, 'fresh foreground dwell qualifies');
});

for (const [label, enter, leave] of [
  ['hover', 'mouseenter', 'mouseleave'],
  ['keyboard focus', 'focusin', 'focusout'],
]) {
  // Pause stops motion, not real visibility: dwell remains eligible, but a
  // stationary occurrence must never become repeated exposures.
  test(label + ' pause preserves visible dwell but cannot repeat exposure', async () => {
    await start();
    frame(1000);
    advanceTo(1600);
    tickerEvent(enter);
    const pausedTransform = document.querySelector('[data-newscope-track]').style.transform;
    advanceTo(1999);
    await assertHostCount(0, 'motion pause does not bypass the full 1000ms dwell');
    frame(2000);
    await assertHostCount(1, 'visible content qualifies while motion is paused');
    advanceTo(6000);
    assert.equal(document.querySelector('[data-newscope-track]').style.transform, pausedTransform,
      'test must exercise an actual motion pause');
    await assertHostCount(1, 'remaining paused and visible is still one occurrence');
    tickerEvent(leave);
    advanceTo(10000);
    await assertHostCount(1, 'resuming motion without a visibility exit cannot recount');
  });

  test(label + ' motion pause does not hide a geometric dwell interruption', async () => {
    await start();
    frame(1000);
    advanceTo(1600);
    tickerEvent(enter);
    geometry.itemLeft = 800 - 159.99;
    frame(1700);
    geometry.itemLeft = 0;
    frame(1800);
    advanceTo(2700);
    await assertHostCount(0, '600ms before a visibility interruption cannot be accumulated while paused');
    frame(2800);
    await assertHostCount(1, 'a fresh continuous visible dwell qualifies even while paused');
    advanceTo(6000);
    await assertHostCount(1, 'continued motion pause must not repeat exposure');
  });
}

test('continuous visibility across several cycles and clones counts only once', async () => {
  geometry.moving = true;
  await start();
  frame(1000);
  advanceTo(2100);
  await assertHostCount(1, 'first continuous occurrence qualifies');
  advanceTo(16000);
  window.dispatchEvent(new window.Event('pagehide'));
  await flush();
  const playback = JSON.parse(window.sessionStorage.getItem('dsh-newscope-news-ticker:playback:v1'));
  assert.ok(playback.cycle >= 3, 'test must actually cross at least three cycle boundaries');
  await assertHostCount(1, 'clone handoff and cycle wrap are not exits and re-entries');
  assert.equal(hostStates[payload.items[0].articleKey].read, false, 'continuous visibility alone must not auto-read');
});

test('ResizeObserver measurement without DOM reconstruction preserves visible dwell', async () => {
  await start();
  frame(1000);
  advanceTo(1600);
  const oldItem = document.querySelector('[data-newscope-item]');
  geometry.rootWidth = 600;
  assert.ok(resizeObservers.size, 'a real observer callback must be exercised');
  for (const observer of [...resizeObservers]) observer.callback([]);
  assert.equal(document.querySelector('[data-newscope-item]'), oldItem, 'measurement alone must not reconstruct DOM');
  advanceTo(1999);
  await assertHostCount(0, 'measurement cannot bypass the full dwell');
  frame(2000);
  await assertHostCount(1, 'unchanged visible DOM retains its continuous dwell');
  advanceTo(5000);
  await assertHostCount(1, 'measurement cannot manufacture another occurrence');
});

test('feed-driven DOM reconstruction cannot accumulate partial dwell', async () => {
  await start();
  frame(1000);
  advanceTo(1600);
  const oldItem = document.querySelector('[data-newscope-item]');
  payload = { ...payload, items: [{ ...payload.items[0], title: 'A newly laid out title' }] };
  await refreshFeed();
  assert.notEqual(document.querySelector('[data-newscope-item]'), oldItem, 'test must rebuild the item DOM');
  frame(1700);
  advanceTo(2600);
  await assertHostCount(0, 'reconstruction cannot carry a partial dwell to the replacement element');
  frame(2700);
  await assertHostCount(1, 'replacement layout needs a fresh dwell');
});

test('running-row replacement cannot accumulate partial dwell', async () => {
  await start();
  frame(1000);
  advanceTo(1600);
  const oldTicker = document.querySelector('[data-newscope-ticker]');
  document.body.innerHTML = '<div data-chat-running><span class="runningContent">replacement row</span></div>';
  await flush();
  assert.notEqual(document.querySelector('[data-newscope-ticker]'), oldTicker, 'controller must actually be replaced');
  frame(1700);
  advanceTo(2600);
  await assertHostCount(0, 'replacement controller cannot inherit partial dwell');
  frame(2700);
  await assertHostCount(1, 'new controller needs its own continuous dwell');
});

for (const css of ['display:none', 'visibility:hidden', 'opacity:0']) {
  test('a hidden ancestor (' + css + ') cannot accrue exposure', async () => {
    await start();
    const host = document.querySelector('[data-chat-running]');
    host.style.cssText = css;
    frame(1000); advanceTo(2500); await assertHostCount(0, 'hidden ancestry prevents exposure');
    host.style.cssText = '';
    frame(2600); advanceTo(3600); await assertHostCount(1, 'visibility requires a fresh dwell');
  });
}

test('a zero-sized ticker and an ancestor clipping it below threshold cannot accrue exposure', async () => {
  await start();
  const root = document.querySelector('[data-newscope-ticker]');
  const original = root.getBoundingClientRect.bind(root);
  root.getBoundingClientRect = () => ({ ...original(), height: 0, bottom: 0 });
  frame(1000); advanceTo(2500); await assertHostCount(0, 'zero height is not visible');
  root.getBoundingClientRect = original;
  const host = document.querySelector('[data-chat-running]');
  host.style.overflow = 'hidden';
  host.getBoundingClientRect = () => ({ left: 0, top: 0, right: 159.99, bottom: 26, width: 159.99, height: 26 });
  frame(2600); advanceTo(4100); await assertHostCount(0, 'ancestor clip is part of the actual view');
  host.getBoundingClientRect = () => ({ left: 0, top: 0, right: 160, bottom: 26, width: 160, height: 26 });
  frame(4200); advanceTo(5200); await assertHostCount(1, 'enough width through ancestor clip qualifies');
});

test('normal and clone visible widths are never added together to meet the threshold', async () => {
  await start();
  const elements = [...document.querySelectorAll('[data-newscope-key]')];
  elements[0].getBoundingClientRect = () => ({ left: -100, top: 0, right: 100, bottom: 26, width: 200, height: 26 });
  elements[1].getBoundingClientRect = () => ({ left: 700, top: 0, right: 900, bottom: 26, width: 200, height: 26 });
  frame(1000); advanceTo(2500); await assertHostCount(0, '100px + 100px is not an eligible copy');
  elements[1].getBoundingClientRect = () => ({ left: 640, top: 0, right: 840, bottom: 26, width: 200, height: 26 });
  frame(2600); advanceTo(3600); await assertHostCount(1, 'one independently eligible copy qualifies');
});
