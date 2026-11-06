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
let eventResponder;
let feedResponder;
let articleWidths;
let rootWidth;
let resizeCallbacks;

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
      displayMode: 'running', pauseOnHover: true, openInNewTab: true,
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
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.fetch = async (url, options = {}) => {
    if (url === READ_EVENTS_URL) {
      const events = JSON.parse(options.body).events;
      eventRequests.push({ events, keepalive: options.keepalive === true });
      if (eventFailures > 0) { eventFailures--; throw new Error('event network failure'); }
      if (eventResponder) return eventResponder(events, options);
      if (eventStatus) return Response.json({ error: 'rejected' }, { status: eventStatus });
      return Response.json(processEvents(events));
    }
    if (feedResponder) return feedResponder();
    if (fetchError) throw fetchError;
    const items = payload.items.filter((item) => item.replay === true || !hostStates[item.articleKey]?.read);
    return Response.json({ ...payload, items, readVersion: hostVersion, exposureStates: hostStates });
  };
  raf = new Map();
  timeouts = new Map();
  let nextId = 1;
  window.requestAnimationFrame = (fn) => { const id = nextId++; raf.set(id, fn); return id; };
  window.cancelAnimationFrame = (id) => raf.delete(id);
  window.setInterval = () => nextId++;
  window.clearInterval = () => {};
  window.setTimeout = (fn, delay) => { const id = nextId++; timeouts.set(id, { fn, delay }); return id; };
  window.clearTimeout = (id) => timeouts.delete(id);
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  resizeCallbacks = new Set();
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; resizeCallbacks.add(callback); }
    observe() {}
    disconnect() { resizeCallbacks.delete(this.callback); }
  };
  Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      if (this.closest('[data-chat-running]')?.style.display === 'none') {
        return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
      }
      const track = this.closest('[data-newscope-track]') || this.querySelector('[data-newscope-track]');
      const transform = track?.style.transform || '';
      const match = transform.match(/translate3d\((-?\d+(?:\.\d+)?)px/);
      const position = match ? -Number(match[1]) : 0;
      let left = 0;
      let width = rootWidth;
      const itemWidth = (item) => articleWidths[item.dataset.newscopeItem] || 200;
      if (this.hasAttribute('data-newscope-item')) {
        const group = this.parentElement;
        const groupIndex = [...track.children].indexOf(group);
        const itemIndex = [...group.children].indexOf(this);
        const widths = [...group.children].map(itemWidth);
        const groupWidth = widths.reduce((sum, value) => sum + value, 0);
        left = -position + groupIndex * groupWidth + widths.slice(0, itemIndex).reduce((sum, value) => sum + value, 0);
        width = hideItems ? 0 : itemWidth(this);
      } else if (this.hasAttribute('data-newscope-group')) {
        const groupIndex = [...track.children].indexOf(this);
        width = [...this.children].map(itemWidth).reduce((sum, value) => sum + value, 0);
        left = -position + groupIndex * width;
      } else if (this.hasAttribute('data-newscope-track')) {
        left = -position;
      }
      return { left, top: 0, width, height: 26, right: left + width, bottom: 26 };
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
  while (clock < target) frame(Math.min(target, clock + 16));
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
  eventResponder = null;
  feedResponder = null;
  articleWidths = {};
  rootWidth = 800;
  eventStatus = 0;
  eventRequests = [];
  hostEvents = new Map();
  hostStates = {};
  hostVersion = 0;
  clock = 1000;
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  dom?.window.close();
  fetchError = null;
});

test('three qualified loop exposures are batched and confirmed read removes only after leaving view', async () => {
  payload = basePayload();
  await start();
  frame(1000);
  advanceTo(1999);
  assert.equal(eventRequests.length, 0);
  advanceTo(2100);
  await flushEvents();
  assert.equal(hostStates[payload.items[0].articleKey].exposureCount, 1);

  advanceTo(6000);
  hideItems = true;
  advanceTo(6200);
  hideItems = false;
  advanceTo(7400);
  await flushEvents();
  assert.equal(hostStates[payload.items[0].articleKey].exposureCount, 2);
  advanceTo(11000);
  hideItems = true;
  advanceTo(11200);
  hideItems = false;
  advanceTo(12400);
  await flushEvents();
  const state = hostStates[payload.items[0].articleKey];
  assert.equal(state.exposureCount, 3);
  assert.equal(state.read, true);
  assert.equal(state.readReason, 'exposure');
  assert.equal(eventRequests.length, 3);
  assert.ok(eventRequests.every((request) => request.events.length === 1 && request.events[0].type === 'exposure'));
  assert.ok(document.querySelector('[data-newscope-ticker]'), 'visible item must not vanish during Host confirmation');

  hideItems = true;
  advanceTo(12600);
  await flush();
  assert.equal(document.querySelector('[data-newscope-ticker]'), null);
});

test('offscreen and background content does not count; clones and DOM rebuilds share one occurrence', async () => {
  hideItems = true;
  payload = basePayload();
  await start();
  frame(1000);
  advanceTo(2000);
  assert.equal(eventRequests.length, 0);

  hideItems = false;
  advanceTo(2016);
  advanceTo(3200);
  await flushEvents();
  assert.equal(eventRequests.length, 1);
  assert.equal(eventRequests[0].events.length, 1, 'normal and clone groups must emit only one event');
  assert.equal(hostStates[payload.items[0].articleKey].exposureCount, 1);

  payload = { ...payload, items: [{ ...payload.items[0], title: 'Updated title' }] };
  document.dispatchEvent(new window.Event('visibilitychange'));
  await flush();
  advanceTo(5000);
  await flushEvents();
  assert.equal(hostEvents.size, 1, 'rebuilding the same occurrence must not count again');

  hidden = true;
  document.dispatchEvent(new window.Event('visibilitychange'));
  advanceTo(9000);
  assert.equal(hostStates[payload.items[0].articleKey].exposureCount, 1);
});

test('failed event delivery retries the same event without confirming read early', async () => {
  payload = basePayload();
  await start();
  frame(1000);
  advanceTo(2200);
  eventFailures = 1;
  await flushEvents();
  assert.equal(hostEvents.size, 0);
  assert.ok(document.querySelector('[data-newscope-ticker]'));

  await flushEvents();
  assert.equal(eventRequests.length, 2);
  assert.equal(eventRequests[0].events[0].eventId, eventRequests[1].events[0].eventId);
  assert.equal(hostStates[payload.items[0].articleKey].exposureCount, 1);
  assert.equal(hostStates[payload.items[0].articleKey].read, false);
});

test('page refresh retries the same occurrence idempotently and pagehide uses keepalive', async () => {
  payload = basePayload();
  await start();
  frame(1000);
  advanceTo(2100);
  window.dispatchEvent(new window.Event('pagehide'));
  await flush();
  assert.equal(eventRequests.length, 1);
  assert.equal(eventRequests[0].keepalive, true);
  assert.equal(hostStates[payload.items[0].articleKey].exposureCount, 1);

  cleanup(); cleanup = null;
  await start();
  frame(3000);
  advanceTo(4000);
  await flushEvents();
  assert.equal(hostStates[payload.items[0].articleKey].exposureCount, 1);
  assert.equal(hostEvents.size, 1);
  assert.equal(eventRequests.at(-1).events[0].eventId, eventRequests[0].events[0].eventId);
});

test('click is an optional immediate read signal with deferred removal', async () => {
  payload = basePayload();
  await start();
  const link = document.querySelector('[data-newscope-ticker] a');
  link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flushEvents();
  const state = hostStates[payload.items[0].articleKey];
  assert.equal(state.read, true);
  assert.equal(state.readReason, 'open');
  assert.equal(state.exposureCount, 0);
  assert.equal(eventRequests.length, 1, 'duplicate click is coalesced');
  assert.ok(document.querySelector('[data-newscope-ticker]'));

  hideItems = true;
  frame(2000);
  await flush();
  assert.equal(document.querySelector('[data-newscope-ticker]'), null);
});

test('content updates preserve the current article anchor instead of only the pixel offset', async () => {
  payload = basePayload(['a', 'b']);
  await start();
  frame(1000);
  frame(1016);
  const before = document.querySelector('[data-newscope-key="' + payload.items[1].articleKey + '"]').getBoundingClientRect().left;
  payload = basePayload(['x', 'a', 'b']);
  document.dispatchEvent(new window.Event('visibilitychange'));
  await flush();
  const after = document.querySelector('[data-newscope-key="' + payload.items[2].articleKey + '"]').getBoundingClientRect().left;
  assert.ok(Math.abs(after - before) < 0.01, `anchor moved from ${before} to ${after}`);
  assert.match(document.querySelector('[data-newscope-track]').style.transform, /-200\.72px/);
});

function openArticle(id) {
  document.querySelector('[data-newscope-key="' + articleKey(id) + '"] a')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function playbackState() {
  return JSON.parse(window.sessionStorage.getItem('dsh-newscope-news-ticker:playback:v1'));
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const status of [429, 500]) {
  test('HTTP ' + status + ' retries with bounded backoff and stable event IDs', async () => {
    payload = basePayload(); await start(); frame(1000); advanceTo(2200);
    eventStatus = status;
    for (let retry = 0; retry < 7; retry++) {
      await flushEvents();
      assert.equal(hostEvents.size, 0);
      assert.ok([...timeouts.values()].every(({ delay }) => delay <= 30000));
    }
    eventStatus = 0; await flushEvents();
    assert.equal(new Set(eventRequests.map(({ events }) => events[0].eventId)).size, 1);
    assert.equal(hostStates[articleKey('a')].exposureCount, 1);
  });
}

test('Host commit followed by malformed JSON retries idempotently', async () => {
  payload = basePayload(); await start(); frame(1000); advanceTo(2200);
  eventResponder = (events) => { processEvents(events); return new Response('{broken'); };
  await flushEvents();
  assert.equal(hostStates[articleKey('a')].exposureCount, 1);
  eventResponder = null; await flushEvents();
  assert.equal(hostStates[articleKey('a')].exposureCount, 1);
  assert.equal(hostEvents.size, 1);
  assert.equal(eventRequests[0].events[0].eventId, eventRequests[1].events[0].eventId);
});

test('a 200 response without a complete acknowledgement cannot confirm or discard pending reads', async () => {
  payload = basePayload(); await start(); openArticle('a');
  eventResponder = () => Response.json({ exposureStates: { [articleKey('a')]: { read: true } } });
  await flushEvents(); hideItems = true; frame(1000); await flush();
  assert.ok(document.querySelector('[data-newscope-key]'));
  assert.equal(hostEvents.size, 0);
  eventResponder = null; await flushEvents();
  assert.equal(hostStates[articleKey('a')].read, true);
  assert.equal(eventRequests.length, 2);
});

test('unconfirmed events survive refresh, keeping the exact pending event ID', async () => {
  payload = basePayload(); await start(); frame(1000); advanceTo(2200);
  eventFailures = 2; await flushEvents();
  const id = eventRequests[0].events[0].eventId;
  cleanup(); cleanup = null; await flush();
  assert.equal(hostEvents.size, 0);
  await start(); await flushEvents();
  assert.equal(hostStates[articleKey('a')].exposureCount, 1);
  assert.ok(eventRequests.every(({ events }) => events[0].eventId === id));
  assert.equal(JSON.parse(window.sessionStorage.getItem('dsh-newscope-news-ticker:read-queue:v1')).pending.length, 0);
});

test('single flight includes pagehide; 101 events drain in batches of at most 100', async () => {
  payload = basePayload(Array.from({ length: 101 }, (_, index) => 'a' + index)); await start();
  for (const item of payload.items) openArticle(item.id);
  const gate = deferred(); eventResponder = () => gate.promise;
  await flushEvents();
  assert.equal(eventRequests.length, 1); assert.equal(eventRequests[0].events.length, 100);
  window.dispatchEvent(new window.Event('pagehide')); await flush();
  assert.equal(eventRequests.length, 1);
  gate.resolve(Response.json(processEvents(eventRequests[0].events))); await flush();
  eventResponder = null; await flushEvents();
  assert.equal(eventRequests.length, 2); assert.equal(eventRequests[1].events.length, 1);
  assert.equal(hostEvents.size, 101);
  assert.equal(Object.values(hostStates).filter((state) => state.read).length, 101);
});

test('an older news response cannot overwrite a track after a newer read acknowledgement', async () => {
  payload = basePayload(['a', 'b']); await start();
  const gate = deferred(); feedResponder = () => gate.promise;
  document.dispatchEvent(new window.Event('visibilitychange')); await flush();
  openArticle('a'); await flushEvents();
  gate.resolve(Response.json({ ...basePayload(['x', 'a']), readVersion: 0, exposureStates: {} })); await flush();
  assert.equal(document.querySelector('[data-newscope-item="x"]'), null);
  assert.ok(document.querySelector('[data-newscope-item="b"]'));
  assert.ok(document.querySelector('[data-newscope-item="a"]'), 'read article remains until safe removal');
  hideItems = true; frame(1000); await flush();
  assert.equal(document.querySelector('[data-newscope-item="a"]'), null);
  assert.ok(document.querySelector('[data-newscope-item="b"]'));
});

test('snapshot-filtered articles without exposureStates retire safely rather than disappearing on refresh', async () => {
  payload = basePayload(['a', 'b']); await start();
  feedResponder = () => Response.json({ ...basePayload(['b']), readVersion: 1, exposureStates: {} });
  document.dispatchEvent(new window.Event('visibilitychange')); await flush();
  assert.ok(document.querySelector('[data-newscope-item="a"]'));
  hideItems = true; frame(1000); await flush();
  assert.equal(document.querySelector('[data-newscope-item="a"]'), null);
  assert.ok(document.querySelector('[data-newscope-item="b"]'));
});

test('late event acknowledgements after disposal never recreate UI or retry timers', async () => {
  payload = basePayload(); await start();
  const gate = deferred(); eventResponder = () => gate.promise;
  openArticle('a'); await flushEvents(); cleanup(); cleanup = null;
  gate.resolve(Response.json(processEvents(eventRequests[0].events))); await flush();
  assert.equal(document.querySelector('[data-newscope-ticker]'), null);
  assert.equal(raf.size, 0); assert.equal(timeouts.size, 0);
});

test('multiple running rows share a monotone cycle and pause the shared clock together', async () => {
  payload = basePayload(); await start();
  const row = document.createElement('div'); row.dataset.chatRunning = '';
  row.innerHTML = '<span class="runningContent">second</span>';
  document.body.appendChild(row); await flush();
  const roots = [...document.querySelectorAll('[data-newscope-ticker]')];
  assert.equal(roots.length, 2);
  frame(1000); advanceTo(5600);
  window.dispatchEvent(new window.Event('pagehide')); await flush();
  const before = playbackState(); assert.equal(before.cycle, 1);
  roots[1].dispatchEvent(new window.Event('mouseenter')); advanceTo(9000);
  window.dispatchEvent(new window.Event('pagehide')); await flush();
  assert.equal(playbackState().cycle, before.cycle); assert.equal(playbackState().position, before.position);
  roots[1].dispatchEvent(new window.Event('mouseleave')); advanceTo(10000);
  assert.equal(new Set(roots.map((root) => root.firstChild.style.transform)).size, 1);
  roots[0].parentElement.remove(); await flush(); advanceTo(15000);
  window.dispatchEvent(new window.Event('pagehide')); await flush();
  assert.ok(playbackState().cycle > before.cycle);
  assert.equal(hostStates[articleKey('a')].exposureCount, 1, 'two rows are one continuous occurrence');
});


test('an unread item returning in a newer snapshot cancels its pending retirement', async () => {
  payload = basePayload(['a', 'b']); await start();
  payload = basePayload(['b']);
  document.dispatchEvent(new window.Event('visibilitychange')); await flush();
  assert.ok(document.querySelector('[data-newscope-item="a"]'));
  payload = basePayload(['a', 'b']);
  document.dispatchEvent(new window.Event('visibilitychange')); await flush();
  hideItems = true; frame(1000);
  // Before observer reconciliation, the returned unread article must never be removed.
  assert.ok(document.querySelector('[data-newscope-item="a"]'));
});

test('terminal request errors discard invalid events without confirming read or retrying forever', async () => {
  payload = basePayload(); await start(); openArticle('a');
  eventStatus = 409; await flushEvents();
  assert.equal(timeouts.size, 0); assert.equal(hostEvents.size, 0);
  hideItems = true; frame(1000); await flush();
  assert.ok(document.querySelector('[data-newscope-item="a"]'));
  assert.equal(JSON.parse(window.sessionStorage.getItem('dsh-newscope-news-ticker:read-queue:v1')).pending.length, 0);
});

test('playback cycle advances only on a true wrap and is persisted at that boundary', async () => {
  payload = basePayload(); await start(); frame(1000); advanceTo(5400);
  assert.equal(playbackState().cycle, 0);
  advanceTo(5500);
  assert.equal(playbackState().cycle, 1, 'the boundary write must bypass wall-clock throttling');
  const before = playbackState();
  hidden = true; document.dispatchEvent(new window.Event('visibilitychange'));
  frame(60000);
  hidden = false; document.dispatchEvent(new window.Event('visibilitychange')); await flush();
  frame(61000);
  window.dispatchEvent(new window.Event('pagehide')); await flush();
  assert.equal(playbackState().cycle, before.cycle);
  assert.ok(Math.abs(playbackState().position - before.position) < 5, 'background time is never added to movement');
});


test('a stalled request times out and retries the same event instead of wedging the queue', async () => {
  payload = basePayload(); await start(); openArticle('a');
  eventResponder = (events, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await flushEvents();
  assert.equal(eventRequests.length, 1);
  assert.equal([...timeouts.values()][0].delay, 15000);
  await flushEvents();
  assert.equal(hostEvents.size, 0);
  eventResponder = null; await flushEvents();
  assert.equal(hostStates[articleKey('a')].read, true);
  assert.equal(eventRequests[0].events[0].eventId, eventRequests[1].events[0].eventId);
});


test('a hidden zero-width owner hands the clock to a visible running row', async () => {
  payload = basePayload(); await start();
  const first = document.querySelector('[data-chat-running]');
  const second = document.createElement('div'); second.dataset.chatRunning = '';
  second.innerHTML = '<span class="runningContent">second</span>';
  document.body.appendChild(second); await flush();
  frame(1000); advanceTo(2000);
  const before = second.querySelector('[data-newscope-track]').style.transform;
  first.style.display = 'none';
  for (const callback of resizeCallbacks) callback([]);
  advanceTo(2200);
  assert.notEqual(second.querySelector('[data-newscope-track]').style.transform, before);
  assert.notEqual(second.querySelector('[data-newscope-track]').style.transform, 'translate3d(0px,0,0)');
  advanceTo(10000);
  window.dispatchEvent(new window.Event('pagehide')); await flush();
  assert.ok(playbackState().cycle >= 1, 'the visible peer must continue real loops');
});

test('prefix retirement preserves the current article when the remaining group is shorter than its old offset', async () => {
  articleWidths = { a: 300, b: 300, c: 400 }; rootWidth = 1000;
  payload = basePayload(['a', 'b', 'c']); await start();
  frame(1000); advanceTo(23200);
  openArticle('a'); openArticle('b'); await flushEvents();
  assert.ok(document.querySelector('[data-newscope-item="a"]'));
  frame(23300); await flush();
  assert.equal(document.querySelector('[data-newscope-item="a"]'), null);
  const current = document.querySelector('[data-newscope-item="c"]');
  assert.ok(Math.abs(current.getBoundingClientRect().left - 596.5) < 0.05,
    'the C anchor at ~600px must not normalize one group-width to ~200px');
  frame(23400);
  assert.ok(Math.abs(current.getBoundingClientRect().left - 592) < 0.05, 'next frame consumes the leading gap smoothly');
  window.dispatchEvent(new window.Event('pagehide')); await flush();
  cleanup(); cleanup = null; await start();
  assert.ok(Math.abs(document.querySelector('[data-newscope-item="c"]').getBoundingClientRect().left - 592) < 0.05,
    'refresh preserves a temporary leading-gap offset too');
});


test('explicit replay survives confirmed-read filtering and reports new visible opportunities without becoming unread', async () => {
  payload = basePayload(); payload.items[0].replay = true;
  const key = articleKey('a');
  hostStates[key] = { exposureCount: 3, read: true, readAt: '2026-11-05T10:00:00Z', readReason: 'exposure' };
  hostVersion = 1;
  await start();
  assert.ok(document.querySelector('[data-newscope-replay="true"]'));
  assert.match(document.querySelector('[data-newscope-ticker]').textContent, /重播/);
  frame(1000); advanceTo(2200); await flushEvents();
  assert.equal(eventRequests.length, 1); assert.equal(eventRequests[0].events[0].type, 'exposure');
  assert.equal(hostStates[key].exposureCount, 3); assert.equal(hostStates[key].read, true);
  advanceTo(8000); await flushEvents();
  assert.ok(document.querySelector('[data-newscope-item="a"]'), 'confirmed replay is not retired by its own ACK');
  assert.equal(eventRequests.length, 1, 'continuous replay is still one appearance');
  payload = basePayload(['b']);
  document.dispatchEvent(new window.Event('visibilitychange')); await flush();
  assert.ok(document.querySelector('[data-newscope-item="b"]'), 'fresh unread inventory can take over');
  hideItems = true; frame(8100); await flush();
  assert.equal(document.querySelector('[data-newscope-item="a"]'), null);
});

test('confirmed consumption asks the Host for replacement inventory without waiting for the refresh interval', async () => {
  payload = basePayload(); await start();
  let requested = 0;
  feedResponder = () => { requested++; return Response.json({ ...basePayload(['b']), readVersion: hostVersion, exposureStates: hostStates }); };
  openArticle('a'); await flushEvents();
  assert.equal(requested, 1);
  assert.ok(document.querySelector('[data-newscope-item="b"]'));
  assert.ok(document.querySelector('[data-newscope-item="a"]'), 'safe retirement still applies before replacement');
});
