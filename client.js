window.__ModuleLoader__.load({
  id: 'dsh-newscope-news-ticker',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PACKAGE = 'dsh-newscope-news-ticker';
    const FEED_URL = '/plugins/dsh-newscope-news-ticker/news.json';
    const MANAGE_URL = '/plugins/dsh-newscope-news-ticker/manage';
    const MODELS_URL = '/plugins/dsh-newscope-news-ticker/models.json';
    const READ_EVENTS_URL = '/plugins/dsh-newscope-news-ticker/read-events';
    const FEEDBACK_URL = '/plugins/dsh-newscope-news-ticker/feedback';
    const NS = 'newscope-news-ticker';
    const LOCALE_NS = 'dsh-newscope-news-ticker-client';
    const ROW_CONFIG_KEY = `${PACKAGE}#${NS}`;
    const SPEEDS = { slow: 25, medium: 45, fast: 75 };
    const CATEGORIES = ['finance', 'technology', 'science', 'general'];
    const PLAYBACK_STORAGE_KEY = 'dsh-newscope-news-ticker:playback:v1';
    const READ_SESSION_STORAGE_KEY = 'dsh-newscope-news-ticker:read-session:v1';
    const READ_QUEUE_STORAGE_KEY = 'dsh-newscope-news-ticker:read-queue:v1';
    const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
    const EXPOSURE_DWELL_MS = 1000;
    const EXPOSURE_CHECK_MS = 100;
    const MAX_PENDING_READ_EVENTS = 1000;
    // Leaf paths keep future/hidden inventory fields intact on save.
    const INVENTORY_FIELDS = [
      ['readAfterExposures', 1, 100, 3, true],
      ['inventory.targetInventory', 1, 100, 30, true],
      ['inventory.lowWatermark', 0, 100, 10, true],
      ['inventory.refillDebounceSeconds', 1, 3600, 30, true],
      ['inventory.level1.minScore', 0, 10, 6, false],
      ['inventory.level1.maxAgeHours', 1, 720, 72, false],
      ['inventory.level2.minScore', 0, 10, 5, false],
      ['inventory.level2.maxAgeHours', 1, 720, 168, false],
    ];
    const NUMERIC_FIELDS = [...INVENTORY_FIELDS, ['runningIdleDelaySeconds', 1, 300, 5, true]];
    const atPath = (value, path) => path.reduce((current, key) => current?.[key], value);
    function setPath(value, path, next) {
      let target = value;
      for (const key of path.slice(0, -1)) target = target[key] = { ...target[key] };
      target[path[path.length - 1]] = next;
    }
    const CONFIG_KEYS = [
      'displayMode', 'runningIdleBehavior', 'runningIdleDelaySeconds', 'newscopeUrl', 'managementUrl', 'minScore', 'maxAgeHours', 'refreshMinutes',
      'weights', 'scrollSpeed', 'pauseOnHover', 'openInNewTab',
      'translationEnabled', 'translationModel', 'semanticDedupEnabled', 'semanticDedupModel',
      'topicMap', 'sourceMap',
    ];

    function createPlaybackState() {
      let position = 0;
      let cycle = 0;
      try {
        const stored = JSON.parse(window.sessionStorage.getItem(PLAYBACK_STORAGE_KEY) || 'null');
        if (Number.isFinite(stored?.position)) position = stored.position;
        if (Number.isSafeInteger(stored?.cycle) && stored.cycle >= 0) cycle = stored.cycle;
      } catch { /* Storage can be unavailable in hardened browser contexts. */ }
      let insideKeys = [];
      try {
        const stored = JSON.parse(window.sessionStorage.getItem(PLAYBACK_STORAGE_KEY) || 'null');
        if (Array.isArray(stored?.insideKeys)) insideKeys = stored.insideKeys.filter((key) => typeof key === 'string').slice(0, 500);
      } catch { /* Ignore damaged playback metadata. */ }
      const state = { position, cycle, insideKeys: new Set(insideKeys), savedAt: 0 };
      state.persist = (force = false) => {
        const now = Date.now();
        if (!force && now - state.savedAt < 1000) return;
        state.savedAt = now;
        try {
          window.sessionStorage.setItem(PLAYBACK_STORAGE_KEY, JSON.stringify({
            position: state.position, cycle: state.cycle, insideKeys: [...state.insideKeys].slice(-500),
          }));
        } catch { /* Keep playing without persistence. */ }
      };
      return state;
    }

    const CSS = `
      [data-chat-running].dsh-newscope-running { display:flex; flex-direction:column; width:100%; min-width:0; max-width:100%; overflow:hidden; }
      .dsh-newscope-running-content { display:flex !important; align-items:center; flex:0 0 auto; width:100%; min-width:0; max-width:100%; overflow:hidden; }
      .dsh-newscope-running-content > [class*="runningText"] { flex:none; min-width:0; }
      .dsh-newscope-ticker { box-sizing:border-box; position:relative; flex:0 0 auto; width:100%; min-width:0; max-width:100%; height:26px; margin:0 0 2px; padding:0; overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:var(--dsh-content-font-size-secondary,12px); line-height:24px; white-space:nowrap; contain:layout paint; }
      .dsh-newscope-ticker:focus-visible { outline:1px solid var(--dsw-alias-brand-primary); outline-offset:1px; border-radius:2px; }
      .dsh-newscope-track { display:inline-flex; align-items:center; min-width:max-content; will-change:transform; transform:translate3d(0,0,0); }
      .dsh-newscope-group { display:inline-flex; align-items:center; flex:none; }
      .dsh-newscope-item { display:inline-flex; align-items:center; flex:none; }
      .dsh-newscope-separator { flex:none; margin:0 16px; color:var(--dsw-alias-label-secondary); opacity:.55; }
      .dsh-newscope-feedback-controls { display:inline-flex; align-items:center; flex:none; gap:3px; margin-left:7px; opacity:0; pointer-events:none; }
      .dsh-newscope-item:hover .dsh-newscope-feedback-controls, .dsh-newscope-item:focus-within .dsh-newscope-feedback-controls { opacity:1; pointer-events:auto; }
      .dsh-newscope-feedback-button { box-sizing:border-box; width:23px; height:22px; padding:0; border:1px solid var(--dsw-alias-border-l2); border-radius:4px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); cursor:pointer; font-size:13px; line-height:20px; }
      .dsh-newscope-feedback-button:hover:not(:disabled), .dsh-newscope-feedback-button[data-newscope-feedback-active=true] { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
      .dsh-newscope-feedback-button:disabled { cursor:default; opacity:.45; }
      .dsh-newscope-feedback-button[data-newscope-feedback-error=true] { border-color:var(--dsw-alias-text-danger,#d44); }
      @media (hover:none) { .dsh-newscope-feedback-controls { opacity:1; pointer-events:auto; } }
      .dsh-newscope-link { display:inline-flex; align-items:center; max-width:none; color:var(--dsw-alias-label-secondary); text-decoration:none; cursor:pointer; }
      .dsh-newscope-link:hover { color:var(--dsw-alias-brand-primary); text-decoration:underline; text-underline-offset:3px; }
      .dsh-newscope-title { flex:none; }
      .dsh-newscope-ticker[data-reduced-motion="true"] { overflow-x:auto; overscroll-behavior-x:contain; }
      .dsh-newscope-ticker[data-reduced-motion="true"] .dsh-newscope-track { transform:none !important; will-change:auto; }
      .dsh-newscope-ticker[data-reduced-motion="true"] [data-newscope-clone] { display:none; }
      .dsh-newscope-management { margin-top:16px; padding-top:16px; border-top:1px solid var(--dsw-alias-border-l1); }
      .dsh-newscope-management a { color:var(--dsw-alias-brand-primary); text-decoration:none; }
      .dsh-newscope-management a:hover { text-decoration:underline; }
      .dsh-newscope-settings { display:grid; gap:18px; max-width:820px; color:var(--dsw-alias-label-primary); }
      .dsh-newscope-settings section { display:grid; gap:12px; }
      .dsh-newscope-settings h4 { margin:0; font-size:14px; }
      .dsh-newscope-settings-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px 18px; }
      .dsh-newscope-settings-field { display:grid; align-content:start; gap:6px; min-width:0; font-size:13px; }
      .dsh-newscope-settings-field[data-wide=true] { grid-column:1/-1; }
      .dsh-newscope-settings-field > span:first-child { font-weight:500; }
      .dsh-newscope-settings-field small, .dsh-newscope-settings-note { margin:0; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.5; }
      .dsh-newscope-settings-field input:not([type=checkbox]), .dsh-newscope-settings-field select, .dsh-newscope-settings-field textarea { box-sizing:border-box; width:100%; min-width:0; padding:7px 9px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; }
      .dsh-newscope-settings-field textarea { resize:vertical; font-family:var(--ds-font-family-code,monospace); font-size:12px; line-height:1.5; }
      .dsh-newscope-settings-field input:focus, .dsh-newscope-settings-field select:focus, .dsh-newscope-settings-field textarea:focus { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
      .dsh-newscope-settings-toggle { display:flex; align-items:center; justify-content:space-between; gap:18px; min-height:32px; font-size:13px; }
      .dsh-newscope-settings-toggle > span { display:grid; gap:3px; }
      .dsh-newscope-settings-toggle input { width:18px; height:18px; flex:none; accent-color:var(--dsw-alias-brand-primary); }
      .dsh-newscope-settings details { display:grid; gap:12px; }
      .dsh-newscope-settings summary { cursor:pointer; color:var(--dsw-alias-label-secondary); font-size:13px; }
      .dsh-newscope-settings details[open] summary { margin-bottom:12px; }
      .dsh-newscope-settings-actions { display:flex; align-items:center; flex-wrap:wrap; gap:10px; padding-top:4px; }
      .dsh-newscope-settings-actions button { padding:7px 14px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); cursor:pointer; font:inherit; }
      .dsh-newscope-settings-actions button:disabled { cursor:not-allowed; opacity:.5; }
      .dsh-newscope-settings-status { color:var(--dsw-alias-label-secondary); font-size:12px; }
      .dsh-newscope-settings-status[data-error=true] { color:var(--dsw-alias-text-danger,#d44); }
      @media (max-width:600px) {
        .dsh-newscope-ticker { margin-left:0; padding-left:0; }
        .dsh-newscope-separator { margin:0 10px; }
        .dsh-newscope-settings-grid { grid-template-columns:minmax(0,1fr); }
        .dsh-newscope-settings-field[data-wide=true] { grid-column:auto; }
      }
    `;

    function articleElement(article, config, clone, t) {
      const target = config.openInNewTab ? '_blank' : undefined;
      const feedbackAvailable = typeof article.newscopeId === 'string' && /^[1-9]\d{0,18}$/.test(article.newscopeId);
      const feedbackButton = (action, icon) => h('button', {
        type: 'button', className: 'dsh-newscope-feedback-button',
        'data-newscope-feedback-action': action, 'data-newscope-feedback-active': article.feedback === action ? 'true' : 'false',
        'aria-label': t('feedback.' + action), 'aria-pressed': article.feedback === action ? 'true' : 'false',
        title: feedbackAvailable ? t('feedback.' + action) : t('feedback.unavailable'),
        tabIndex: clone ? -1 : undefined, disabled: !feedbackAvailable || article.feedback === action ? true : undefined,
      }, icon);
      const feedbackControls = h('span', {
        className: 'dsh-newscope-feedback-controls', role: 'group', 'aria-label': t('feedback.controls'),
        title: feedbackAvailable ? undefined : t('feedback.unavailable'),
      }, feedbackButton('like', '👍'), feedbackButton('dislike', '👎'));
      const anchor = h('a', {
        className: 'dsh-newscope-link', href: article.url, target,
        rel: 'noopener noreferrer', referrerPolicy: 'no-referrer',
        title: article.title,
        tabIndex: clone ? -1 : undefined,
      }, h('span', { className: 'dsh-newscope-title' }, article.title));
      return h('span', {
        className: 'dsh-newscope-item',
        'data-newscope-item': article.id,
        'data-newscope-key': article.articleKey,
        'data-newscope-replay': article.replay === true ? 'true' : undefined,
      },
        article.replay === true ? h('span', { className: 'dsh-newscope-replay', title: '已读重播', style: 'margin-right:6px;opacity:.65' }, '↻ 重播') : null,
        anchor, feedbackControls, h('span', { className: 'dsh-newscope-separator', 'aria-hidden': 'true' }, '◆'));
    }

    // The ticker uses React elements only as inert descriptors. This tiny writer
    // keeps the compatibility adapter independent of a second React root.
    function mountDescriptor(parent, descriptor) {
      if (typeof descriptor === 'string' || typeof descriptor === 'number') {
        parent.appendChild(document.createTextNode(String(descriptor)));
        return;
      }
      if (!descriptor || !descriptor.type) return;
      const element = document.createElement(descriptor.type);
      for (const [key, value] of Object.entries(descriptor.props || {})) {
        if (key === 'children' || value === undefined || value === false) continue;
        if (key === 'className') element.className = value;
        else if (key === 'tabIndex') element.tabIndex = value;
        else if (key === 'referrerPolicy') element.referrerPolicy = value;
        else if (value === true) element.setAttribute(key, '');
        else element.setAttribute(key, String(value));
      }
      const children = descriptor.props?.children;
      for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
        if (child !== null && child !== undefined && child !== false) mountDescriptor(element, child);
      }
      parent.appendChild(element);
    }


    function validArticleKey(value) {
      return typeof value === 'string'
        && /^(?:url:[a-f0-9]{64}:[a-f0-9]{64}|newscope:[a-f0-9]{64}:[1-9]\d{0,18})$/.test(value);
    }

    function eventHash(text) {
      let first = 0xdeadbeef;
      let second = 0x41c6ce57;
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        first = Math.imul(first ^ code, 2654435761);
        second = Math.imul(second ^ code, 1597334677);
      }
      first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
      second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
      return (second >>> 0).toString(16).padStart(8, '0') + (first >>> 0).toString(16).padStart(8, '0');
    }

    function readSessionId() {
      let value = '';
      try { value = window.sessionStorage.getItem(READ_SESSION_STORAGE_KEY) || ''; } catch { /* Use an in-memory ID. */ }
      if (!/^[A-Za-z0-9-]{8,64}$/.test(value)) {
        value = window.crypto?.randomUUID?.() || `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
        try { window.sessionStorage.setItem(READ_SESSION_STORAGE_KEY, value); } catch { /* Keep the in-memory ID. */ }
      }
      return value;
    }

    function rectOf(element) {
      const value = element.getBoundingClientRect();
      const left = Number(value.left) || 0;
      const top = Number(value.top) || 0;
      const width = Math.max(0, Number(value.width) || 0);
      const height = Math.max(0, Number(value.height) || 0);
      return {
        left, top, width, height,
        right: Number.isFinite(value.right) ? value.right : left + width,
        bottom: Number.isFinite(value.bottom) ? value.bottom : top + height,
      };
    }

    function visibleClip(root) {
      if (!root.isConnected || document.hidden || document.visibilityState === 'hidden') return null;
      const rect = rectOf(root);
      if (!rect.width || !rect.height) return null;
      const clip = {
        left: Math.max(0, rect.left), top: Math.max(0, rect.top),
        right: Math.min(window.innerWidth || document.documentElement.clientWidth, rect.right),
        bottom: Math.min(window.innerHeight || document.documentElement.clientHeight, rect.bottom),
      };
      for (let node = root; node; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
          || style.opacity === '0' || style.contentVisibility === 'hidden') return null;
        if (node === root) continue;
        const bounds = rectOf(node);
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX || style.overflow)) {
          clip.left = Math.max(clip.left, bounds.left);
          clip.right = Math.min(clip.right, bounds.right);
        }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY || style.overflow)) {
          clip.top = Math.max(clip.top, bounds.top);
          clip.bottom = Math.min(clip.bottom, bounds.bottom);
        }
      }
      return clip.right > clip.left && clip.bottom > clip.top ? clip : null;
    }

    function rootIsVisible(root) { return Boolean(visibleClip(root)); }

    function visibleWidth(element, root, clip = visibleClip(root)) {
      if (!clip) return 0;
      const itemRect = rectOf(element);
      if (!itemRect.height || itemRect.bottom <= clip.top || itemRect.top >= clip.bottom) return 0;
      return Math.max(0, Math.min(itemRect.right, clip.right) - Math.max(itemRect.left, clip.left));
    }

    class ReadEventCoordinator {
      constructor(onRead) {
        this.onRead = onRead;
        this.sessionId = readSessionId();
        this.pending = new Map();
        this.issued = new Set();
        this.readKeys = new Set();
        this.exposureStates = {};
        this.readVersion = 0;
        this.inFlight = null;
        this.timer = null;
        this.retryDelay = 1000;
        this.disposed = false;
        try {
          const stored = JSON.parse(window.sessionStorage.getItem(READ_QUEUE_STORAGE_KEY) || 'null');
          if (stored?.sessionId === this.sessionId) {
            for (const id of (stored.issued || []).slice(-5000)) {
              if (typeof id === 'string' && id.length <= 200) this.issued.add(id);
            }
            for (const event of (stored.pending || []).slice(0, MAX_PENDING_READ_EVENTS)) {
              if (['exposure', 'open'].includes(event.type) && validArticleKey(event.articleKey)
                && typeof event.eventId === 'string' && event.eventId.length <= 200
                && Number.isFinite(event.queuedAt) && Date.now() - event.queuedAt < MAX_EVENT_AGE_MS) {
                this.pending.set(event.eventId, event);
                this.issued.add(event.eventId);
              }
            }
          }
        } catch { /* Storage failure must not manufacture a confirmed read. */ }
        this.schedule(1000);
      }

      persist() {
        if (this.disposed) return;
        try {
          window.sessionStorage.setItem(READ_QUEUE_STORAGE_KEY, JSON.stringify({
            sessionId: this.sessionId, pending: [...this.pending.values()], issued: [...this.issued],
          }));
        } catch { /* Degrade to in-memory retries if sessionStorage is unavailable. */ }
      }

      applySnapshot(payload) {
        const version = Number(payload.readVersion);
        if ((!Number.isSafeInteger(version) && this.readVersion > 0) || version < this.readVersion) return null;
        if (Number.isSafeInteger(version) && version >= this.readVersion) {
          this.readVersion = version;
          this.mergeStates(payload.exposureStates);
        }
        return {
          ...payload,
          items: payload.items.filter((article) => article.replay === true || !this.readKeys.has(article.articleKey)),
        };
      }

      mergeStates(states) {
        if (!states || typeof states !== 'object') return;
        for (const [key, state] of Object.entries(states)) {
          if (!validArticleKey(key) || !state || typeof state !== 'object') continue;
          this.exposureStates[key] = state;
          if (state.read === true) this.readKeys.add(key);
        }
      }

      confirmFeedback(requestedKey, result) {
        const canonical = result?.articleKey;
        const state = result?.exposureStates?.[canonical];
        if (result?.readPersisted !== true || !validArticleKey(canonical) || !Number.isSafeInteger(result.readVersion)
          || result.readVersion < 0 || state?.read !== true || !Number.isSafeInteger(state.exposureCount)
          || state.exposureCount < 0) return false;
        const confirmed = {};
        for (const key of new Set([requestedKey, canonical])) if (validArticleKey(key)) confirmed[key] = state;
        this.readVersion = Math.max(this.readVersion, result.readVersion);
        this.mergeStates(confirmed);
        if (!this.disposed) this.onRead(this.readKeys);
        return true;
      }

      eventId(type, articleKey, cycle) {
        const suffix = type === 'exposure' ? `:${cycle}` : '';
        return `${type}:${this.sessionId}:${eventHash(articleKey)}${suffix}`;
      }

      enqueue(type, articleKey, cycle = 0, replay = false) {
        if (!validArticleKey(articleKey) || (this.readKeys.has(articleKey) && !replay)) return;
        const eventId = this.eventId(type, articleKey, cycle);
        if (this.issued.has(eventId)) return;
        if (this.pending.size >= MAX_PENDING_READ_EVENTS) return; // Preserve unacknowledged events first.
        this.issued.add(eventId);
        if (this.issued.size > 5000) this.issued.delete(this.issued.values().next().value);
        this.pending.set(eventId, { type, eventId, articleKey, queuedAt: Date.now() });
        this.persist();
        this.schedule(1000);
      }

      exposure(articleKey, cycle, replay = false) { this.enqueue('exposure', articleKey, cycle, replay); }
      open(articleKey) { this.enqueue('open', articleKey); }

      schedule(delay) {
        if (this.disposed || this.timer !== null || this.inFlight || !this.pending.size) return;
        this.timer = window.setTimeout(() => {
          this.timer = null;
          this.flush();
        }, delay);
      }

      flush(keepalive = false) {
        if (this.inFlight || (!this.pending.size) || (this.disposed && !keepalive)) return this.inFlight;
        if (this.timer !== null) {
          window.clearTimeout(this.timer);
          this.timer = null;
        }
        for (const [id, event] of this.pending) {
          if (Date.now() - event.queuedAt >= MAX_EVENT_AGE_MS) this.pending.delete(id);
        }
        this.persist();
        const events = [...this.pending.values()].slice(0, 100).map(({ type, eventId, articleKey }) => ({ type, eventId, articleKey }));
        if (!events.length) return null;
        this.inFlight = (async () => {
          let retry = false;
          const abort = new AbortController();
          const timeout = window.setTimeout(() => abort.abort(), 15_000);
          try {
            const response = await fetch(READ_EVENTS_URL, {
              method: 'POST', credentials: 'same-origin', keepalive, signal: abort.signal,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ events }),
            });
            if (!response.ok) {
              if (response.status >= 500 || response.status === 429) throw new Error(`HTTP ${response.status}`);
              for (const event of events) this.pending.delete(event.eventId);
            } else {
              const result = await response.json();
              if (!Number.isSafeInteger(result?.readVersion) || result.readVersion < 0
                || !Number.isSafeInteger(result.accepted) || result.accepted < 0
                || !Number.isSafeInteger(result.duplicates) || result.duplicates < 0
                || result.accepted + result.duplicates !== events.length
                || !events.every((event) => {
                  const state = result.exposureStates?.[event.articleKey];
                  return state && typeof state.read === 'boolean'
                    && Number.isSafeInteger(state.exposureCount) && state.exposureCount >= 0;
                })) throw new Error('Invalid read-event acknowledgement');
              for (const event of events) this.pending.delete(event.eventId);
              if (result.readVersion >= this.readVersion) {
                this.readVersion = result.readVersion;
                this.mergeStates(result.exposureStates);
              }
              if (!this.disposed) this.onRead(this.readKeys);
            }
          } catch {
            retry = true;
          } finally {
            window.clearTimeout(timeout);
            this.persist();
            this.inFlight = null;
            if (retry) {
              this.schedule(this.retryDelay);
              this.retryDelay = Math.min(30_000, this.retryDelay * 2);
            } else {
              this.retryDelay = 1000;
              if (this.pending.size) this.schedule(0);
            }
          }
        })();
        return this.inFlight;
      }

      resetRetry() {
        this.retryDelay = 1000;
        if (this.timer !== null) {
          window.clearTimeout(this.timer);
          this.timer = null;
        }
        this.schedule(0);
      }

      shutdown() {
        if (this.timer !== null) {
          window.clearTimeout(this.timer);
          this.timer = null;
        }
        const flushing = this.flush(true);
        this.disposed = true;
        return flushing;
      }
    }

    class TickerController {
      constructor(host, target, items, config, t, playback, events, onFeedback) {
        this.host = host;
        this.target = target;
        this.items = items;
        this.config = config;
        this.t = t;
        this.playback = playback;
        this.events = events;
        this.onFeedback = onFeedback;
        this.position = playback.position;
        this.cycle = playback.cycle;
        this.clockOwner = false;
        this.exposureInside = new Set(playback.insideKeys);
        this.groupWidth = 0;
        this.lastFrame = 0;
        this.lastExposureCheck = 0;
        this.exposureCandidates = new Map();
        this.exposureCounted = new Map();
        this.retiring = new Map();
        this.feedbackPending = new Map();
        this.feedbackErrors = new Set();
        this.idlePaused = false;
        this.hover = false;
        this.focus = false;
        // IntersectionObserver supplies a cheap, scroll-aware playback gate.
        // Start optimistically; the first callback corrects initially hidden rows.
        this.inViewport = true;
        this.disposed = false;
        this.signature = '';
        this.root = document.createElement('div');
        this.root.className = 'dsh-newscope-ticker';
        this.root.dataset.newscopeTicker = '';
        this.root.dataset.paused = 'false';
        this.root.tabIndex = 0;
        this.root.setAttribute('role', 'region');
        this.root.setAttribute('aria-label', t('ariaLabel'));
        this.root.setAttribute('aria-live', 'off');
        if (!host.hasAttribute('data-chat-running')) this.root.dataset.newscopeIdle = '';
        this.track = document.createElement('div');
        this.track.className = 'dsh-newscope-track';
        this.track.dataset.newscopeTrack = '';
        this.root.appendChild(this.track);
        host.insertBefore(this.root, target === host ? host.firstChild : target);
        if (host.hasAttribute('data-chat-running')) {
          host.classList.add('dsh-newscope-running');
          if (target !== host) target.classList.add('dsh-newscope-running-content');
        }
        this.onEnter = () => { if (this.config.pauseOnHover) { this.hover = true; this.syncPause(); } };
        this.onLeave = () => { this.hover = false; this.syncPause(); };
        this.onFocus = () => { this.focus = true; this.syncPause(); };
        this.onBlur = (event) => {
          if (event.relatedTarget && this.root.contains(event.relatedTarget)) return;
          this.focus = false;
          this.syncPause();
        };
        this.root.addEventListener('mouseenter', this.onEnter);
        this.root.addEventListener('mouseleave', this.onLeave);
        this.root.addEventListener('focusin', this.onFocus);
        this.root.addEventListener('focusout', this.onBlur);
        this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.measure()) : null;
        this.resizeObserver?.observe(this.root);
        this.intersectionObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
          const entry = entries.find((candidate) => candidate.target === this.root);
          if (this.disposed || !entry) return;
          const visible = entry.isIntersecting && entry.intersectionRatio > 0;
          if (this.inViewport === visible) return;
          this.inViewport = visible;
          // Never charge hidden time to the first visible frame on resume.
          for (const peer of this.playback.controllers || [this]) peer.lastFrame = 0;
          this.syncPause();
          this.playback.selectOwner?.();
        }) : null;
        this.intersectionObserver?.observe(this.root);
        this.render();
      }

      syncPause() {
        const paused = this.hover || this.focus || this.idlePaused || !this.inViewport;
        if (this.root.dataset.paused !== String(paused)) {
          this.root.dataset.paused = String(paused);
          this.lastFrame = 0;
          for (const peer of this.playback.controllers || []) peer.lastFrame = 0;
        }
      }

      captureAnchor() {
        if (!this.track.firstChild || !rootIsVisible(this.root)) return null;
        const rootRect = rectOf(this.root);
        let anchor = null;
        for (const element of this.track.querySelectorAll('[data-newscope-key]')) {
          const width = visibleWidth(element, this.root);
          if (width <= 0 || (anchor && width <= anchor.width + 0.5)) continue;
          const rect = rectOf(element);
          anchor = { key: element.dataset.newscopeKey, width, relative: rect.left - rootRect.left, element };
        }
        if (!anchor) return null;
        const index = this.items.findIndex((item) => item.articleKey === anchor.key);
        const ordered = index < 0 ? this.items : [...this.items.slice(index + 1), ...this.items.slice(0, index)];
        const fallback = ordered.map((item) => item.articleKey).filter((key) => key && key !== anchor.key);
        return { keys: [anchor.key, ...fallback], relative: anchor.relative, clone: Boolean(anchor.element.closest('[data-newscope-clone]')) };
      }

      measure(anchor) {
        const group = this.track.querySelector('[data-newscope-group]');
        const width = group ? rectOf(group).width || group.scrollWidth : 0;
        this.groupWidth = Math.max(0, width);
        if (this.groupWidth > 0) {
          let restored = false;
          if (anchor && group) {
            const groups = [...this.track.querySelectorAll('[data-newscope-group]')];
            for (const [index, key] of anchor.keys.entries()) {
              const occurrenceGroup = index === 0 && anchor.clone ? groups[1] || groups[0] : groups[0];
              const elements = occurrenceGroup ? [...occurrenceGroup.querySelectorAll('[data-newscope-key]')] : [];
              const element = elements.find((candidate) => candidate.dataset.newscopeKey === key);
              if (!element) continue;
              const rootRect = rectOf(this.root);
              const itemRect = rectOf(element);
              const next = this.position + itemRect.left - rootRect.left - anchor.relative;
              if (Number.isFinite(next)) {
                // A shortened track can need a temporary leading gap. Normalizing
                // a negative offset would jump the anchor by an entire new group.
                this.position = next < 0 ? next : next % this.groupWidth;
                restored = true;
              }
              break;
            }
          }
          if (!restored && this.position >= 0) this.position %= this.groupWidth;
        }
        this.syncTransform();
      }

      syncTransform(force = false) {
        if (this.clockOwner) {
          this.playback.position = this.position;
          if (this.groupWidth > 0) this.playback.phase = this.position / this.groupWidth;
          this.playback.cycle = this.cycle;
          this.playback.insideKeys = new Set(this.exposureInside);
          this.playback.persist(force);
        }
        this.track.style.transform = `translate3d(${-this.position.toFixed(2)}px,0,0)`;
      }

      render(anchor = this.captureAnchor()) {
        const signature = JSON.stringify(this.items.map((item) => [item.articleKey, item.id, item.title, item.url, item.source, item.replay === true]))
          + JSON.stringify([this.config.openInNewTab]);
        if (signature === this.signature) { this.measure(anchor); this.syncFeedback(); return; }
        this.signature = signature;
        this.root.dataset.reducedMotion = 'false';
        this.exposureCandidates.clear();
        for (const peer of this.playback.controllers || []) peer.exposureCandidates.clear();
        this.track.replaceChildren();
        for (const clone of [false, true]) {
          const group = document.createElement('span');
          group.className = 'dsh-newscope-group';
          group.dataset.newscopeGroup = '';
          if (clone) {
            group.dataset.newscopeClone = '';
            group.setAttribute('aria-hidden', 'true');
          }
          for (const item of this.items) {
            mountDescriptor(group, articleElement(item, this.config, clone, this.t));
            const element = group.lastElementChild;
            for (const button of element.querySelectorAll('[data-newscope-feedback-action]')) {
              button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.submitFeedback(item, button.dataset.newscopeFeedbackAction);
              });
            }
            const key = item.articleKey;
            if (!validArticleKey(key)) continue;
            for (const link of element.querySelectorAll('a')) {
              link.addEventListener('click', () => this.events.open(key));
              link.addEventListener('auxclick', (event) => { if (event.button === 1) this.events.open(key); });
            }
          }
          this.track.appendChild(group);
        }
        this.measure(anchor);
        this.syncFeedback();
        this.start();
      }

      resetExposure() {
        this.exposureCandidates.clear();
        this.exposureInside.clear();
        this.lastExposureCheck = 0;
        this.lastFrame = 0;
        if (this.clockOwner) this.syncTransform(true);
      }

      checkExposure(time) {
        if (time - this.lastExposureCheck < EXPOSURE_CHECK_MS) return;
        this.lastExposureCheck = time;
        const eligible = new Set();
        const replays = new Set();
        // One page-wide occurrence, even when several running rows show the track.
        for (const controller of this.playback.controllers || [this]) {
          const clip = visibleClip(controller.root);
          if (!clip) continue;
          const rootRect = rectOf(controller.root);
          for (const element of controller.track.querySelectorAll('[data-newscope-key]')) {
            const key = element.dataset.newscopeKey;
            const replay = element.dataset.newscopeReplay === 'true';
            if (!validArticleKey(key) || controller.retiring.has(key) || (this.events.readKeys.has(key) && !replay)) continue;
            if (replay) replays.add(key);
            const itemWidth = rectOf(element).width;
            const threshold = Math.min(itemWidth, rootRect.width * 0.5, 160);
            if (threshold > 0 && visibleWidth(element, controller.root, clip) >= threshold) eligible.add(key);
          }
        }
        const before = [...this.exposureInside].join(',');
        for (const key of eligible) {
          if (this.exposureInside.has(key)) continue;
          let candidate = this.exposureCandidates.get(key);
          if (!candidate) {
            candidate = { since: time };
            this.exposureCandidates.set(key, candidate);
          }
          if (time - candidate.since >= EXPOSURE_DWELL_MS && this.exposureCounted.get(key) !== this.cycle) {
            this.events.exposure(key, this.cycle, replays.has(key));
            this.exposureCounted.set(key, this.cycle);
            this.exposureInside.add(key);
            this.exposureCandidates.delete(key);
          }
        }
        for (const key of this.exposureCandidates.keys()) {
          if (!eligible.has(key)) this.exposureCandidates.delete(key);
        }
        for (const key of this.exposureInside) {
          if (!eligible.has(key)) this.exposureInside.delete(key);
        }
        if (before !== [...this.exposureInside].join(',')) this.syncTransform(true);
      }

      canRetire(key) {
        const cycle = this.retiring.get(key);
        if (cycle === undefined || this.cycle > cycle) return true;
        for (const element of this.track.querySelectorAll('[data-newscope-key]')) {
          if (element.dataset.newscopeKey === key && visibleWidth(element, this.root) > 0) return false;
        }
        return true;
      }

      retire(readKeys) {
        for (const item of this.items) {
          const key = item.articleKey;
          if (item.replay !== true && readKeys.has(key) && !this.retiring.has(key)) this.retiring.set(key, this.cycle);
        }
        this.retireReadItems();
      }

      retireReadItems() {
        if (!this.retiring.size) return;
        const remove = new Set([...this.retiring.keys()].filter((key) => this.canRetire(key)));
        for (const key of remove) this.retiring.delete(key);
        const items = this.items.filter((item) => !remove.has(item.articleKey));
        if (items.length !== this.items.length) {
          const anchor = this.captureAnchor();
          this.items = items;
          this.render(anchor);
        }
      }

      syncFeedback() {
        if (this.disposed) return;
        const articles = new Map(this.items.map((item) => [item.articleKey, item]));
        for (const element of this.track.querySelectorAll('[data-newscope-key]')) {
          const article = articles.get(element.dataset.newscopeKey);
          const key = article?.articleKey;
          const available = typeof article?.newscopeId === 'string' && /^[1-9]\d{0,18}$/.test(article.newscopeId);
          const pending = this.feedbackPending.has(key);
          const failed = this.feedbackErrors.has(key);
          for (const button of element.querySelectorAll('[data-newscope-feedback-action]')) {
            const action = button.dataset.newscopeFeedbackAction;
            const current = article?.feedback === action;
            button.disabled = !available || pending || current;
            button.dataset.newscopeFeedbackActive = String(current);
            button.dataset.newscopeFeedbackError = String(failed);
            button.setAttribute('aria-pressed', String(current));
            const title = !available ? this.t('feedback.unavailable')
              : pending ? this.t('feedback.pending')
                : failed ? this.t('feedback.error')
                  : current ? this.t('feedback.recorded') : this.t('feedback.' + action);
            button.title = title;
            button.setAttribute('aria-label', title);
          }
        }
      }
      async submitFeedback(article, action) {
        const key = article?.articleKey;
        if (this.disposed || !key || !article.newscopeId || article.feedback === action || this.feedbackPending.has(key)) return;
        this.feedbackPending.set(key, action);
        this.feedbackErrors.delete(key);
        this.syncFeedback();
        try { await this.onFeedback(article, action); }
        catch { this.feedbackErrors.add(key); }
        finally {
          this.feedbackPending.delete(key);
          this.syncFeedback();
        }
      }
      start() {
        if (this.disposed || this.raf) return;
        const frame = (time) => {
          this.raf = 0;
          if (this.disposed) return;
          if (this.clockOwner && (this.playback.controllers?.length || 0) > 1
            && (!this.groupWidth || !rootIsVisible(this.root))) this.playback.selectOwner?.();
          const elapsed = this.lastFrame ? Math.min(100, Math.max(0, time - this.lastFrame)) : 0;
          this.lastFrame = time;
          const peers = this.playback.controllers || [this];
          const paused = peers.some((controller) => controller.hover || controller.focus || controller.idlePaused)
            || !peers.some((controller) => controller.inViewport);
          if (this.clockOwner && !paused && !document.hidden && this.groupWidth > 0) {
            const speed = SPEEDS[this.config.scrollSpeed] || SPEEDS.medium;
            const advanced = this.position + elapsed * speed / 1000;
            const wraps = Math.max(0, Math.floor(advanced / this.groupWidth));
            if (wraps > 0) this.cycle += wraps;
            this.position = advanced - wraps * this.groupWidth;
            this.syncTransform(wraps > 0);
          }
          if (this.clockOwner) {
            for (const peer of peers) {
              if (peer === this) continue;
              peer.position = this.groupWidth ? this.position / this.groupWidth * peer.groupWidth : 0;
              peer.cycle = this.cycle;
              peer.syncTransform();
            }
            this.checkExposure(time);
          }
          this.retireReadItems();
          if (!this.raf) this.raf = window.requestAnimationFrame(frame);
        };
        this.raf = window.requestAnimationFrame(frame);
      }

      update(items, config) {
        const anchor = this.captureAnchor();
        const incomingKeys = new Set(items.map((item) => item.articleKey));
        for (const key of incomingKeys) {
          if (!this.events.readKeys.has(key) || items.some((item) => item.articleKey === key && item.replay === true)) this.retiring.delete(key);
        }
        for (const item of this.items) {
          const key = item.articleKey;
          if (validArticleKey(key) && !incomingKeys.has(key) && !this.retiring.has(key)) this.retiring.set(key, this.cycle);
        }
        const merged = [...items];
        const retained = new Set([...this.retiring.keys()].filter((key) => !this.canRetire(key)));
        this.items.forEach((item, index) => {
          const key = item.articleKey;
          if (retained.has(key) && !merged.some((candidate) => candidate.articleKey === key)) {
            merged.splice(Math.min(index, merged.length), 0, item);
          }
        });
        this.items = merged;
        this.config = config;
        if (!config.pauseOnHover) this.hover = false;
        this.syncPause();
        this.render(anchor);
      }

      dispose() {
        if (this.clockOwner) {
          this.playback.position = this.position;
          this.playback.cycle = this.cycle;
          this.playback.persist(true);
        }
        this.disposed = true;
        if (this.raf) window.cancelAnimationFrame(this.raf);
        this.resizeObserver?.disconnect();
        this.intersectionObserver?.disconnect();
        this.exposureCandidates.clear();
        this.root.removeEventListener('mouseenter', this.onEnter);
        this.root.removeEventListener('mouseleave', this.onLeave);
        this.root.removeEventListener('focusin', this.onFocus);
        this.root.removeEventListener('focusout', this.onBlur);
        this.root.remove();
        this.host.classList.remove('dsh-newscope-running');
        this.target?.classList.remove('dsh-newscope-running-content');
      }
    }

    function flattenLocaleDictionaries(dicts) {
      const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return item && typeof item === 'object' && !Array.isArray(item) ? flatten(item, path) : [[path, String(item)]];
      });
      return Object.fromEntries(Object.entries(dicts).map(([locale, value]) => [locale, Object.fromEntries(flatten(value))]));
    }

    function ManagementSection({ subject }, t) {
      if ((subject.kind !== 'bundle' && subject.kind !== 'row') || subject.pkg.name !== PACKAGE) return null;
      return h('section', { className: 'dsh-newscope-management' },
        h('a', { href: MANAGE_URL, target: '_blank', rel: 'noopener noreferrer' }, t('openManagement')));
    }

    function cloneJson(value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function settingsDraft(value = {}) {
      const draft = cloneJson(value) || {};
      draft.displayMode = draft.displayMode || 'running';
      for (const [key, , , fallback] of INVENTORY_FIELDS) {
        const path = key.split('.');
        if (atPath(draft, path) === undefined) setPath(draft, path, fallback);
      }
      for (const key of ['topicMap', 'sourceMap']) draft[key] = JSON.stringify(value[key] || {}, null, 2);
      return draft;
    }

    function boundedNumber(value, min, max) {
      const number = Number(value);
      if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(number) || number < min || number > max) {
        throw new Error('Invalid numeric setting');
      }
      return number;
    }

    function mappingValue(text) {
      let value;
      try { value = JSON.parse(text); } catch { throw new Error('Invalid mapping JSON'); }
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid mapping object');
      for (const category of CATEGORIES) {
        if (!Array.isArray(value[category]) || value[category].some((item) => typeof item !== 'string')) {
          throw new Error('Invalid mapping categories');
        }
      }
      return value;
    }

    function normalizeSettings(draft) {
      const result = cloneJson(draft);
      for (const [key, min, max, , integer] of INVENTORY_FIELDS) {
        const path = key.split('.');
        const number = boundedNumber(atPath(draft, path), min, max);
        if (integer && !Number.isInteger(number)) throw new Error('Expected an integer');
        setPath(result, path, number);
      }
      if (result.inventory.lowWatermark > result.inventory.targetInventory) throw new Error('Low watermark exceeds target inventory');
      for (const key of ['newscopeUrl', 'managementUrl', 'translationModel', 'semanticDedupModel']) {
        result[key] = String(result[key] || '').trim();
      }
      for (const [key, min, max] of [['minScore', 0, 10], ['maxAgeHours', 1, 720], ['refreshMinutes', 1, 1440]]) {
        result[key] = boundedNumber(result[key], min, max);
      }
      result.weights = {};
      for (const category of CATEGORIES) result.weights[category] = boundedNumber(draft.weights?.[category], 0, 1000);
      for (const key of ['topicMap', 'sourceMap']) result[key] = mappingValue(draft[key]);
      if (!['off', 'running', 'always'].includes(result.displayMode)) throw new Error('Invalid display mode');
      if (!['hide', 'delay', 'pause'].includes(result.runningIdleBehavior)) throw new Error('Invalid running idle behavior');
      result.runningIdleDelaySeconds = boundedNumber(result.runningIdleDelaySeconds, 1, 300);
      if (!Number.isInteger(result.runningIdleDelaySeconds)) throw new Error('Expected an integer delay');
      if (!['slow', 'medium', 'fast'].includes(result.scrollSpeed)) throw new Error('Invalid scroll speed');
      for (const key of ['newscopeUrl', 'managementUrl']) {
        if (!result[key]) continue;
        try {
          const url = new URL(result[key]);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid URL');
        } catch { throw new Error('Invalid Newscope URL'); }
      }
      if (!result.newscopeUrl) throw new Error('Missing Newscope URL');
      return result;
    }

    function settingsOperations(saved, draft) {
      const normalized = normalizeSettings(draft);
      const operations = [];
      for (const key of CONFIG_KEYS) {
        const value = normalized[key];
        if (JSON.stringify(saved?.[key]) === JSON.stringify(value)) continue;
        operations.push(value === undefined ? { op: 'unset', path: [key] } : { op: 'set', path: [key], value });
      }
      const baseline = settingsDraft(saved);
      for (const [key] of INVENTORY_FIELDS) {
        const path = key.split('.');
        const value = atPath(normalized, path);
        if (value !== atPath(baseline, path)) operations.push({ op: 'set', path, value });
      }
      return operations;
    }

    function modelCatalogDetails(value) {
      const options = [];
      const seen = new Set();
      for (const group of Array.isArray(value?.groups) ? value.groups : []) {
        const provider = String(group?.id || group?.provider || '').trim();
        if (!provider) continue;
        for (const model of Array.isArray(group?.models) ? group.models : []) {
          const id = String(model?.id || '').trim();
          if (!id) continue;
          const route = id.startsWith(`${provider}/`) ? id : `${provider}/${id}`;
          if (seen.has(route)) continue;
          seen.add(route);
          options.push({ value: route, label: `${model.name || id} · ${group.name || provider}` });
        }
      }
      const selection = value?.default;
      const defaultRoute = selection?.provider && selection?.model ? `${selection.provider}/${selection.model}` : '';
      return { options, defaultRoute };
    }

    async function readModelCatalog() {
      const response = await fetch(MODELS_URL, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(`DSH model catalog returned HTTP ${response.status}`);
      return modelCatalogDetails(await response.json());
    }

    function SettingsField({ label, hint, wide = false, children }) {
      return h('label', { className: 'dsh-newscope-settings-field', 'data-wide': wide || undefined },
        h('span', null, label), children, hint ? h('small', null, hint) : null);
    }

    function inventoryStatusValues(payload, t) {
      const unknown = t('inventoryStatus.unknown');
      const text = (value) => typeof value === 'string' && value.trim() ? value : unknown;
      const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : unknown;
      const boolean = (value) => typeof value === 'boolean' ? String(value) : unknown;
      const count = (value) => Number.isSafeInteger(value) && value >= 0 ? String(value) : unknown;
      const pool = payload?.pool;
      const capabilities = payload?.capabilities;
      const store = payload?.inventoryStore;
      const replayKnown = pool && Array.isArray(payload?.items) && payload.items.every((item) => typeof item?.replay === 'boolean');
      return {
        service: text(payload?.service), stale: boolean(payload?.stale), tier: text(pool?.tier),
        unreadCount: number(pool?.unreadCount),
        effective: 'minScore: ' + number(pool?.effective?.minScore) + ' / maxAgeHours: ' + number(pool?.effective?.maxAgeHours),
        replay: replayKnown ? String(payload.items.filter((item) => item.replay).length) : unknown,
        capabilities: 'history: ' + boolean(capabilities?.history) + ' / source: ' + text(capabilities?.source) + ' / truncated: ' + boolean(capabilities?.truncated),
        inventoryScope: text(capabilities?.inventoryScope), coverage: text(capabilities?.coverage),
        remoteWindowComplete: boolean(capabilities?.remoteWindowComplete), localInventory: boolean(capabilities?.localInventory),
        retainedCount: count(store?.retainedCount), firstCollectedAt: text(store?.firstCollectedAt),
        updatedAt: text(store?.updatedAt), pruned: count(store?.pruned),
        queriedAt: text(payload?.queriedAt),
      };
    }

    // This observer only queries Host inventory. It never posts read events or fetches sources.
    function InventoryStatus({ t }) {
      const [state, setState] = React.useState({ loading: true, payload: null, error: '' });
      const refreshRef = React.useRef(() => {});
      React.useEffect(() => {
        let active = true;
        let request = null;
        let nextTimer = null;
        let deadline = null;
        const refresh = () => {
          if (!active || request) return;
          window.clearTimeout(nextTimer);
          const controller = new AbortController();
          request = controller;
          setState((previous) => ({ ...previous, loading: true, error: '' }));
          const finish = (payload, error) => {
            if (!active || request !== controller) return;
            window.clearTimeout(deadline);
            request = null;
            setState({ loading: false, payload, error });
            nextTimer = window.setTimeout(() => {
              if (!document.hidden) refresh();
              else nextTimer = window.setTimeout(refreshWhenVisible, 30000);
            }, 30000);
          };
          const refreshWhenVisible = () => {
            if (!active) return;
            if (!document.hidden) refresh();
            else nextTimer = window.setTimeout(refreshWhenVisible, 30000);
          };
          deadline = window.setTimeout(() => {
            controller.abort();
            finish(null, 'timeout');
          }, 15000);
          (async () => {
            try {
              const response = await fetch(FEED_URL, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
              const payload = await response.json();
              if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid news payload');
              if (!response.ok && !['read-state-unavailable', 'candidate-state-unavailable'].includes(payload.service)) throw new Error('HTTP ' + response.status);
              finish(payload, '');
            } catch { finish(null, 'request'); }
          })();
        };
        refreshRef.current = refresh;
        refresh();
        return () => {
          active = false;
          request?.abort();
          request = null;
          window.clearTimeout(nextTimer);
          window.clearTimeout(deadline);
          refreshRef.current = () => {};
        };
      }, []);
      const values = inventoryStatusValues(state.payload, t);
      const capabilities = state.payload?.capabilities;
      const readError = state.payload?.service === 'read-state-unavailable';
      const candidateError = state.payload?.service === 'candidate-state-unavailable';
      const warnings = Array.isArray(state.payload?.warnings) ? state.payload.warnings.filter((warning) => typeof warning === 'string') : [];
      return h('section', { 'data-newscope-inventory-status': true, 'aria-label': t('inventoryStatus.heading') },
        h('h4', null, t('inventoryStatus.heading')),
        h('p', { className: 'dsh-newscope-settings-note' }, t('inventoryStatus.hint')),
        h('div', { className: 'dsh-newscope-settings-grid', 'aria-live': 'polite', 'aria-busy': state.loading },
          ...Object.entries(values).map(([key, value]) => h('div', { key, className: 'dsh-newscope-settings-field' },
            h('span', null, t('inventoryStatus.' + key)), h('span', { 'data-newscope-status': key }, value)))),
        capabilities?.history === false ? h('p', { className: 'dsh-newscope-settings-note', 'data-newscope-warning': 'history' }, t('inventoryStatus.historyWarning')) : null,
        typeof capabilities?.source === 'string' && capabilities.source.startsWith('rss') ? h('p', { className: 'dsh-newscope-settings-note', 'data-newscope-warning': 'rss' }, t('inventoryStatus.rssWarning')) : null,
        capabilities?.truncated === true ? h('p', { className: 'dsh-newscope-settings-note', 'data-newscope-warning': 'truncated' }, t('inventoryStatus.truncatedWarning')) : null,
        capabilities?.inventoryScope === 'known-local' ? h('p', { className: 'dsh-newscope-settings-note', 'data-newscope-warning': 'known-local' }, t('inventoryStatus.knownLocalWarning')) : null,
        capabilities?.inventoryScope === 'remote-window' || capabilities?.remoteWindowComplete === true ? h('p', { className: 'dsh-newscope-settings-note', 'data-newscope-warning': 'remote-window' }, t('inventoryStatus.remoteWindowWarning')) : null,
        capabilities?.coverage === 'best-effort' ? h('p', { className: 'dsh-newscope-settings-note', 'data-newscope-warning': 'best-effort' }, t('inventoryStatus.bestEffortWarning')) : null,
        capabilities?.coverage === 'partial' ? h('p', { className: 'dsh-newscope-settings-note', 'data-newscope-warning': 'partial' }, t('inventoryStatus.partialWarning')) : null,
        warnings.length ? h('ul', { className: 'dsh-newscope-settings-note', 'data-newscope-status': 'warnings' },
          ...warnings.map((warning, index) => h('li', { key: index }, warning))) : null,
        readError || candidateError || state.error ? h('p', { role: 'alert', className: 'dsh-newscope-settings-status', 'data-error': true, 'data-newscope-status': 'error' },
          t(readError ? 'inventoryStatus.readError' : candidateError ? 'inventoryStatus.candidateError' : state.error === 'timeout' ? 'inventoryStatus.timeout' : 'inventoryStatus.requestError')) : null,
        h('div', { className: 'dsh-newscope-settings-actions' }, h('button', {
          type: 'button', 'data-newscope-refresh-status': true, disabled: state.loading, onClick: () => refreshRef.current(),
        }, t(state.loading ? 'inventoryStatus.loading' : 'inventoryStatus.refresh'))));
    }

    function SettingsPanel({ configuration, t, view, loadModels }) {
      const subscribe = React.useCallback((listener) => configuration.subscribe(listener), [configuration]);
      const getSnapshot = React.useCallback(() => configuration.getSnapshot(), [configuration]);
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      const [draft, setDraft] = React.useState(() => settingsDraft(snapshot.value));
      const [dirty, setDirty] = React.useState(false);
      const [saveState, setSaveState] = React.useState('idle');
      const draftRef = React.useRef(draft);
      const dirtyRef = React.useRef(false);
      const editVersionRef = React.useRef(0);
      const saveQueueRef = React.useRef(Promise.resolve());
      const mountedRef = React.useRef(true);
      const replaceDraft = (value) => { draftRef.current = value; setDraft(value); };
      const updateDirty = (value) => { dirtyRef.current = value; setDirty(value); };
      const [catalog, setCatalog] = React.useState({ status: 'loading', options: [], defaultRoute: '' });
      React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
      }, []);
      React.useEffect(() => {
        let active = true;
        Promise.resolve(loadModels()).then((value) => {
          if (active) setCatalog({ status: 'ready', ...value });
        }, () => {
          if (active) setCatalog({ status: 'error', options: [], defaultRoute: '' });
        });
        return () => { active = false; };
      }, [loadModels]);
      React.useEffect(() => {
        if (!dirtyRef.current) replaceDraft(settingsDraft(snapshot.value));
      }, [snapshot, dirty]);

      if (view === 'summary') return t('settings.summary');
      if (snapshot.status === 'loading') return h('p', { className: 'dsh-newscope-settings-note' }, t('settings.loading'));
      if (snapshot.status === 'unavailable' || !snapshot.value) {
        return h('p', { className: 'dsh-newscope-settings-note' }, t('settings.unavailable'));
      }

      const disabled = !snapshot.writable;
      const persist = (nextDraft) => {
        const version = ++editVersionRef.current;
        saveQueueRef.current = saveQueueRef.current.catch(() => {}).then(async () => {
          if (version !== editVersionRef.current) return;
          const currentSnapshot = configuration.getSnapshot();
          let operations;
          try { operations = settingsOperations(currentSnapshot.value, nextDraft); }
          catch {
            if (version === editVersionRef.current && mountedRef.current) setSaveState('invalid');
            return;
          }
          if (!operations.length) {
            if (version === editVersionRef.current && mountedRef.current) {
              updateDirty(false);
              setSaveState('saved');
            }
            return;
          }
          if (mountedRef.current) setSaveState('saving');
          try {
            const accepted = await configuration.mutate(operations, currentSnapshot.revision);
            if (version !== editVersionRef.current || !mountedRef.current) return;
            setSaveState(accepted ? 'saved' : 'error');
            if (accepted) updateDirty(false);
          } catch {
            if (version === editVersionRef.current && mountedRef.current) setSaveState('error');
          }
        });
      };
      const edit = (path, value) => {
        const next = { ...draftRef.current };
        setPath(next, path, value);
        replaceDraft(next);
        updateDirty(true);
        setSaveState('idle');
        persist(next);
      };
      const input = (path, label, type = 'text', hint) => {
        const key = Array.isArray(path) ? path : [path];
        const value = key.reduce((current, part) => current?.[part], draft);
        const bounds = NUMERIC_FIELDS.find(([name]) => name === key.join('.'));
        return h(SettingsField, { label, hint }, h('input', {
          type, value: value ?? '', disabled, 'data-setting': key.join('.'),
          ...(bounds ? { min: bounds[1], max: key.join('.') === 'inventory.lowWatermark' ? draft.inventory.targetInventory : bounds[2], step: bounds[4] ? 1 : 'any' } : {}),
          onChange: (event) => edit(key, event.target.value),
        }));
      };
      const toggle = (key, label, hint) => h('label', { className: 'dsh-newscope-settings-toggle' },
        h('span', null, label, hint ? h('small', null, hint) : null),
        h('input', {
          type: 'checkbox', checked: draft[key] === true, disabled, 'data-setting': key,
          onChange: (event) => edit([key], event.target.checked),
        }));
      const mapping = (key, label, hint) => h(SettingsField, { label, hint, wide: true }, h('textarea', {
        rows: 7, value: draft[key] || '', disabled, 'data-setting': key, spellCheck: false,
        onChange: (event) => edit([key], event.target.value),
      }));
      const modelSelect = (key, label, hint, blankLabel) => {
        const current = String(draft[key] || '');
        const options = [...catalog.options];
        if (current && !options.some((option) => option.value === current)) {
          options.push({ value: current, label: `${current} (${t('settings.currentModel')})` });
        }
        const currentHint = catalog.status === 'loading' ? t('settings.modelsLoading')
          : catalog.status === 'error' ? t('settings.modelsError') : hint;
        return h(SettingsField, { label, hint: currentHint }, h('select', {
          value: current, disabled: disabled || catalog.status === 'loading', 'data-setting': key,
          onChange: (event) => edit([key], event.target.value),
        },
        h('option', { value: '' }, blankLabel),
        ...options.map((option) => h('option', { key: option.value, value: option.value }, option.label))));
      };
      const statusText = saveState === 'saving' ? t('settings.saving')
        : saveState === 'saved' ? t('settings.saved')
          : saveState === 'invalid' ? t('settings.invalid')
            : saveState === 'error' ? t('settings.error') : '';

      return h('div', { className: 'dsh-newscope-settings' },
        !snapshot.writable ? h('p', { className: 'dsh-newscope-settings-note' }, t('settings.readOnly')) : null,
        h('section', null, h('h4', null, t('settings.source')),
          h('div', { className: 'dsh-newscope-settings-grid' },
            input('newscopeUrl', t('settings.newscopeUrl'), 'text', t('settings.newscopeUrlHint')),
            input('managementUrl', t('settings.managementUrl'), 'text', t('settings.managementUrlHint')),
            input('minScore', t('settings.minScore'), 'number'),
            input('maxAgeHours', t('settings.maxAgeHours'), 'number'),
            input('refreshMinutes', t('settings.refreshMinutes'), 'number'))),
        h(InventoryStatus, { t }),
        h('section', { 'data-newscope-inventory-settings': true }, h('h4', null, t('settings.inventory')),
          h('p', { className: 'dsh-newscope-settings-note' }, t('settings.inventoryHint')),
          h('div', { className: 'dsh-newscope-settings-grid' },
            ...INVENTORY_FIELDS.map(([key]) => input(key.split('.'), t('settings.' + key), 'number',
              key === 'readAfterExposures' ? t('settings.readAfterExposuresHint') : undefined)))),
        h('section', null, h('h4', null, t('settings.display')),
          h('div', { className: 'dsh-newscope-settings-grid' },
            h(SettingsField, { label: t('settings.displayMode'), hint: t('settings.displayModeHint'), wide: true },
              h('select', {
                value: draft.displayMode || 'running', disabled, 'data-setting': 'displayMode',
                onChange: (event) => edit(['displayMode'], event.target.value),
              },
                ...['off', 'running', 'always'].map((mode) =>
                  h('option', { key: mode, value: mode }, t(`settings.mode.${mode}`))))),
            draft.displayMode === 'running' ? h(SettingsField, { label: t('settings.runningIdleBehavior'), hint: t('settings.runningIdleBehaviorHint'), wide: true },
              h('select', {
                value: draft.runningIdleBehavior || 'hide', disabled, 'data-setting': 'runningIdleBehavior',
                onChange: (event) => edit(['runningIdleBehavior'], event.target.value),
              }, ...['hide', 'delay', 'pause'].map((behavior) => h('option', { key: behavior, value: behavior }, t(`settings.idleBehavior.${behavior}`))))) : null,
            draft.displayMode === 'running' && draft.runningIdleBehavior === 'delay'
              ? input('runningIdleDelaySeconds', t('settings.runningIdleDelaySeconds'), 'number') : null,
            h(SettingsField, { label: t('settings.scrollSpeed') }, h('select', {
              value: draft.scrollSpeed || 'medium', disabled, 'data-setting': 'scrollSpeed',
              onChange: (event) => edit(['scrollSpeed'], event.target.value),
            }, ...['slow', 'medium', 'fast'].map((speed) => h('option', { key: speed, value: speed }, t(`settings.speed.${speed}`))))),
            toggle('pauseOnHover', t('settings.pauseOnHover')),
            toggle('openInNewTab', t('settings.openInNewTab')))),
        h('section', null, h('h4', null, t('settings.weights')),
          h('p', { className: 'dsh-newscope-settings-note' }, t('settings.weightsHint')),
          h('div', { className: 'dsh-newscope-settings-grid' },
            ...CATEGORIES.map((category) => input(['weights', category], t(`category.${category}`), 'number')))),
        h('section', null, h('h4', null, t('settings.ai')),
          h('div', { className: 'dsh-newscope-settings-grid' },
            toggle('translationEnabled', t('settings.translationEnabled')),
            modelSelect('translationModel', t('settings.translationModel'), t('settings.modelHint'),
              `${t('settings.followDefault')}${catalog.defaultRoute ? `（${catalog.defaultRoute}）` : ''}`),
            toggle('semanticDedupEnabled', t('settings.semanticDedupEnabled')),
            modelSelect('semanticDedupModel', t('settings.semanticDedupModel'), t('settings.semanticModelHint'), t('settings.followTranslation')))),
        h('details', null, h('summary', null, t('settings.advanced')),
          h('div', { className: 'dsh-newscope-settings-grid' },
            mapping('topicMap', t('settings.topicMap'), t('settings.mappingHint')),
            mapping('sourceMap', t('settings.sourceMap'), t('settings.mappingHint')))),
        h('div', { className: 'dsh-newscope-settings-actions' }, h('span', {
          className: 'dsh-newscope-settings-status', role: 'status',
          'data-error': ['invalid', 'error'].includes(saveState) || undefined,
        }, statusText || t('settings.autoSave'))));
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => {
          try {
            return ctx.locale.register(LOCALE_NS, flattenLocaleDictionaries({
              en: {
                ariaLabel: 'Newscope news ticker', openManagement: 'Open Newscope management ↗',
                category: { finance: 'Finance', technology: 'Technology', science: 'Science', general: 'News' },
                feedback: {
                  controls: 'Newscope feedback', like: 'Like this article in Newscope', dislike: 'Dislike this article in Newscope',
                  unavailable: 'Feedback is unavailable until this article has a resolved Newscope ID.',
                  pending: 'Submitting feedback to Newscope…', recorded: 'Feedback recorded in Newscope',
                  error: 'Feedback failed. Click to retry.',
                },
                inventoryStatus: {
                  heading: 'Live inventory status', unknown: 'Unknown', service: 'Service', stale: 'Stale snapshot',
                  tier: 'Current tier', unreadCount: 'Unread inventory', effective: 'Effective score / age (hours)', replay: 'Replay items in this response',
                  capabilities: 'Query capabilities', queriedAt: 'Last inventory query', refresh: 'Refresh status', loading: 'Refreshing status…',
                  inventoryScope: 'Inventory scope', coverage: 'Coverage', remoteWindowComplete: 'JSON query window complete',
                  localInventory: 'Local candidate inventory available', retainedCount: 'Retained candidates for this source',
                  firstCollectedAt: 'First collection time (not the start of complete history)', updatedAt: 'Candidate store updated', pruned: 'Candidates pruned globally in this operation',
                  hint: 'Queries existing inventory only; never fetches source feeds. Refreshes every 30 seconds while visible, with a 15-second timeout. history describes available known history, not remote completeness. Missing fields are unknown.',
                  historyWarning: 'The Host reports history unavailable (legacy response compatible); this does not mean RSS always supports only L0. Relaxation and replay depend on available known candidates.',
                  rssWarning: 'RSS has a limited source window. RSS plus a persistent candidate store can support L0/L1/L2 and replay over known inventory; HTML pagination can supplement history on demand. The new JSON API is optional.',
                  knownLocalWarning: 'Relaxation and replay apply only to candidates collected by this plugin; they cannot prove remote higher-tier unread items are exhausted.',
                  remoteWindowWarning: 'remoteWindowComplete=true applies only to a complete JSON pagination query window, not a fixed snapshot of the entire database.',
                  bestEffortWarning: 'HTML history is best-effort: concurrent changes during page-number pagination may cause missed items.',
                  partialWarning: 'Coverage is partial; missing or truncated results cannot prove remote higher-tier unread items are exhausted.',
                  truncatedWarning: 'Query was truncated; the returned window cannot prove remote higher-tier unread items are exhausted.',
                  candidateError: 'candidate-state-unavailable: persistent candidate storage is unavailable; this is not an empty inventory. This is separate from read-state-unavailable.',
                  readError: 'read-state-unavailable: persistent read state is unavailable. Inventory cannot be confirmed; this is not an empty pool.',
                  requestError: 'Could not load inventory status. Values are unknown; this is not an empty pool.',
                  timeout: 'Inventory status request timed out. Refresh to retry.',
                },
                settings: {
                  nav: 'News Ticker', summary: 'News source, scheduling, display, translation and semantic deduplication.',
                  loading: 'Loading Newscope settings…', unavailable: 'Newscope settings are unavailable.',
                  readOnly: 'This profile is read-only.', source: 'News source',
                  newscopeUrl: 'Newscope Host URL', newscopeUrlHint: 'The DSH Host queries existing articles at this address; it never triggers source fetching.',
                  managementUrl: 'Browser management URL', managementUrlHint: 'Optional browser-reachable address; blank uses the Host URL.',
                  minScore: 'Minimum score (0–10)', maxAgeHours: 'Maximum article age (hours)',
                  refreshMinutes: 'Refresh interval (minutes)',
                  inventory: 'Read state and inventory', readAfterExposures: 'Qualified exposures before read (1–100)',
                  readAfterExposuresHint: 'Default: 3. Counts qualified visible opportunities, not proof that the article was read.',
                  'inventory.targetInventory': 'Target inventory (1–100)', 'inventory.lowWatermark': 'Low watermark (0–target)',
                  'inventory.refillDebounceSeconds': 'Inventory query debounce (1–3600 seconds)',
                  'inventory.level1.minScore': 'L1 minimum score (0–10)', 'inventory.level1.maxAgeHours': 'L1 maximum age (1–720 hours)',
                  'inventory.level2.minScore': 'L2 minimum score (0–10)', 'inventory.level2.maxAgeHours': 'L2 maximum age (1–720 hours)',
                  inventoryHint: 'Only queries existing inventory; never fetches source feeds. Within the reported inventory scope, a tier must exhaust its unread items before relaxing to the next. Known-local inventory cannot prove remote exhaustion. These are configured thresholds, not the current effective filters, and never permanently change L0. Defaults: target 30, low watermark 10, debounce 30 seconds; L1 6 / 72 hours, L2 5 / 168 hours.',
                  display: 'Display', scrollSpeed: 'Scroll speed',
                  displayMode: 'Show news ticker', displayModeHint: 'Off hides it everywhere. While running uses the Agent status row. Always also shows it at the end of the scrolling chat flow while idle.',
                  mode: { off: 'Off', running: 'While Agent is running', always: 'Always' },
                  runningIdleBehavior: 'When the model stops', runningIdleBehaviorHint: 'Only for While Agent is running. Delay keeps scrolling in the chat flow before hiding; Keep paused leaves a static ticker there after a run.',
                  idleBehavior: { hide: 'Disappear immediately', delay: 'Disappear after a delay', pause: 'Stay visible but stop scrolling' },
                  runningIdleDelaySeconds: 'Delay before disappearing (seconds)',
                  speed: { slow: 'Slow', medium: 'Medium', fast: 'Fast' },
                  pauseOnHover: 'Pause on hover or keyboard focus', openInNewTab: 'Open articles in a new tab',
                  weights: 'Category exposure weights',
                  weightsHint: 'Relative weights; they do not need to total 100.', ai: 'AI features',
                  translationEnabled: 'Translate titles into Simplified Chinese', translationModel: 'Translation model',
                  modelHint: 'Choose from the DSH model catalog, or follow the DSH default model.',
                  followDefault: 'Follow DSH default model', followTranslation: 'Reuse the translation model',
                  modelsLoading: 'Loading the DSH model catalog…', modelsError: 'Could not load the DSH model catalog. You can keep the current setting or follow the default.',
                  currentModel: 'current setting',
                  semanticDedupEnabled: 'Remove cross-source duplicate reports', semanticDedupModel: 'Semantic dedup model',
                  semanticModelHint: 'Blank reuses the translation model; choose any model from the DSH catalog to override it.', advanced: 'Advanced topic and source mappings',
                  topicMap: 'Topic mapping (JSON)', sourceMap: 'Source mapping (JSON)',
                  mappingHint: 'Each category must contain an array of case-insensitive fragments.',
                  autoSave: 'Valid changes are saved automatically and take effect immediately; no Save button is needed.',
                  saving: 'Saving…', saved: 'Automatically saved',
                  invalid: 'This edit is not active yet. Check URLs, numeric ranges, integer counts, low watermark ≤ target, and mapping JSON.',
                  error: 'Automatic save failed. The configuration may have changed elsewhere; continue editing to retry.',
                },
              },
              zh: {
                ariaLabel: 'Newscope 新闻跑马灯', openManagement: '打开 Newscope 管理界面 ↗',
                category: { finance: '财经', technology: '科技', science: '科学', general: '新闻' },
                feedback: {
                  controls: 'Newscope 反馈', like: '在 Newscope 中点赞此文章', dislike: '在 Newscope 中点踩此文章',
                  unavailable: '尚未取得此文章的 Newscope 数字 ID，暂时无法反馈。',
                  pending: '正在向 Newscope 提交反馈…', recorded: '已向 Newscope 记录该反馈',
                  error: '反馈失败，点击可重试。',
                },
                inventoryStatus: {
                  heading: '实时库存状态', unknown: '未知', service: '服务状态', stale: '陈旧快照（stale）',
                  tier: '当前档位', unreadCount: '未读库存', effective: '实际生效评分 / 时效（小时）', replay: '本次返回的重播条数',
                  capabilities: '查询能力', queriedAt: '最近库存查询时间', refresh: '刷新状态', loading: '正在刷新状态…',
                  inventoryScope: '库存范围', coverage: '覆盖程度', remoteWindowComplete: 'JSON 查询窗口完整',
                  localInventory: '本地候选库存可用', retainedCount: '当前来源保留候选数',
                  firstCollectedAt: '首次采集时间（不是完整历史起点）', updatedAt: '候选库更新时间', pruned: '本次全局淘汰候选数',
                  hint: '仅查询已有库存，不抓取源站。可见时每 30 秒刷新一次，请求超时为 15 秒。history 表示可用已知历史，不代表远端完整性；缺失字段显示未知。',
                  historyWarning: 'Host 报告历史不可用（兼容旧响应），不代表 RSS 一律只有 L0；放宽与重播取决于可用已知候选。',
                  rssWarning: 'RSS 来源窗口有限；RSS 加持久候选库可在已知库存上执行 L0/L1/L2 与重播，HTML 分页可按需补历史，新 JSON API 可选。',
                  knownLocalWarning: '放宽与重播仅针对本插件已收集候选，无法证明远端高档未读耗尽。',
                  remoteWindowWarning: 'remoteWindowComplete=true 仅表示完整 JSON 分页查询窗口，不是整个数据库的恒定快照。',
                  bestEffortWarning: 'HTML 历史为尽力覆盖（best-effort）：页码分页期间的并发变化可能漏项。',
                  partialWarning: '覆盖不完整（partial）；缺项或截断不能证明远端高档未读耗尽。',
                  truncatedWarning: '查询已截断，不能据此断言远端高档未读耗尽。',
                  candidateError: 'candidate-state-unavailable：候选持久化不可用，这不是空库存；与 read-state-unavailable（已读状态不可用）不同。',
                  readError: 'read-state-unavailable：持久已读状态不可用，无法确认库存；这不是库存为空。',
                  requestError: '无法加载库存状态，当前数值未知；这不是库存为空。',
                  timeout: '库存状态请求超时，可刷新重试。',
                },
                settings: {
                  nav: '新闻跑马灯', summary: '配置新闻来源、调度、展示、标题翻译和跨源语义去重。',
                  loading: '正在加载 Newscope 设置…', unavailable: '当前无法读取 Newscope 设置。',
                  readOnly: '当前 profile 为只读。', source: '新闻来源',
                  newscopeUrl: 'Newscope Host 地址', newscopeUrlHint: 'DSH Host 从该地址查询已入库文章，不触发源站抓取。',
                  managementUrl: '浏览器管理地址', managementUrlHint: '可选的浏览器可访问地址；留空则使用 Host 地址。',
                  minScore: '最低评分（0–10）', maxAgeHours: '新闻最大年龄（小时）',
                  refreshMinutes: '刷新间隔（分钟）',
                  inventory: '已读与库存', readAfterExposures: '已读所需有效曝光次数（1–100）',
                  readAfterExposuresHint: '默认 3 次。统计真实可见机会，不代表用户已实际阅读。',
                  'inventory.targetInventory': '目标库存（1–100）', 'inventory.lowWatermark': '低水位（0–目标库存）',
                  'inventory.refillDebounceSeconds': '库存查询防抖（1–3600 秒）',
                  'inventory.level1.minScore': 'L1 最低评分（0–10）', 'inventory.level1.maxAgeHours': 'L1 最大时效（1–720 小时）',
                  'inventory.level2.minScore': 'L2 最低评分（0–10）', 'inventory.level2.maxAgeHours': 'L2 最大时效（1–720 小时）',
                  inventoryHint: '仅查询已有库存，不抓取源站。在所报告的库存范围内，当前档位未读耗尽才放宽到下一档；已知本地库存无法证明远端耗尽。这些值是配置阈值，不是当前实际生效条件，也不会永久修改 L0。默认目标 30、低水位 10、防抖 30 秒；L1 为 6 分 / 72 小时，L2 为 5 分 / 168 小时。',
                  display: '展示', scrollSpeed: '滚动速度',
                  displayMode: '讯息滚动显示', displayModeHint: '关闭时完全不显示；运行时显示仅使用 Agent 状态行；总是显示还会在空闲时显示于消息流末尾。所有形态随页面滚动，离开视口时暂停。',
                  mode: { off: '关闭', running: '运行时显示', always: '总是显示' },
                  runningIdleBehavior: '模型停止后的讯息表现', runningIdleBehaviorHint: '仅用于“运行时显示”。延迟期间在消息流末尾继续滚动；保留但停止滚动会在一次运行结束后留下静态讯息。',
                  idleBehavior: { hide: '立即消失', delay: '延迟后消失', pause: '不消失但停止滚动' },
                  runningIdleDelaySeconds: '延迟消失时间（秒）',
                  speed: { slow: '慢', medium: '中', fast: '快' },
                  pauseOnHover: '悬停或键盘聚焦时暂停', openInNewTab: '在新标签页打开原文',
                  weights: '分类曝光权重',
                  weightsHint: '使用相对权重，不要求总和为 100。', ai: 'AI 功能',
                  translationEnabled: '将标题翻译为简体中文', translationModel: '翻译模型',
                  modelHint: '从 DSH 已接入的模型目录中选择，或跟随 DSH 默认模型。',
                  followDefault: '跟随 DSH 默认模型', followTranslation: '沿用翻译模型',
                  modelsLoading: '正在加载 DSH 模型目录…', modelsError: '无法加载 DSH 模型目录，可保留当前设置或跟随默认模型。',
                  currentModel: '当前设置',
                  semanticDedupEnabled: '移除跨来源的重复报道', semanticDedupModel: '语义去重模型',
                  semanticModelHint: '留空时沿用翻译模型，也可从 DSH 模型目录中单独选择。', advanced: '高级主题与来源映射',
                  topicMap: '主题映射（JSON）', sourceMap: '来源映射（JSON）',
                  mappingHint: '每个分类都必须是不区分大小写的片段字符串数组。',
                  autoSave: '有效修改会自动保存并立即生效，无需点击保存。',
                  saving: '正在自动保存…', saved: '已自动保存',
                  invalid: '本次修改尚未生效。请检查 URL、数值范围、整数计数、低水位不大于目标库存，以及映射 JSON。',
                  error: '自动保存失败。配置可能已在别处变更，请继续编辑以重试。',
                },
              },
            }));
          } catch (error) {
            // An earlier development activation left this package-owned namespace
            // behind after removal. Reuse that identical dictionary; new activations
            // register through ctx.effect and are disposed normally.
            if (String(error).includes(`locale namespace "${LOCALE_NS}" already has locale`)) return undefined;
            throw error;
          }
        }, 'newscope-news-ticker: locale');
        const t = ctx.locale.bind(LOCALE_NS);
        const style = document.createElement('style');
        style.dataset.newscopeTickerStyle = '';
        style.textContent = CSS;
        document.head.appendChild(style);
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section', id: 'newscope-news-ticker-management', order: 20,
        }, (props) => ManagementSection(props, t)));
        const configuration = ctx.configForms.get(NS);
        let modelsPromise;
        const loadModels = () => {
          if (!modelsPromise) {
            modelsPromise = readModelCatalog().catch((error) => { modelsPromise = undefined; throw error; });
          }
          return modelsPromise;
        };
        const settingsComponent = (props) => h(SettingsPanel, { ...props, configuration, t, loadModels });
        ctx.effect(() => ctx.configForms.whileServed([NS], () => {
          const disposeRow = ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
            { name: 'plugins.row.config', key: ROW_CONFIG_KEY, locale: LOCALE_NS }, settingsComponent));
          const disposeBundle = ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
            { name: 'plugins.bundle.config', key: PACKAGE, locale: LOCALE_NS }, settingsComponent));
          const disposeSection = ctx.slots.inject('settings.section', () => ctx.slots.register(
            { name: 'settings.section', id: NS, order: 80, label: () => t('settings.nav'), locale: LOCALE_NS }, settingsComponent));
          return () => { disposeSection(); disposeBundle(); disposeRow(); };
        }), 'newscope-news-ticker: native settings surfaces');

        let latest = { items: [], config: { displayMode: 'running' } };
        const feedbackOverrides = new Map();
        const playback = createPlaybackState();
        playback.selectOwner = syncClockOwners;
        const readEvents = new ReadEventCoordinator(applyConfirmedRead);
        const onPageHide = () => {
          playback.persist(true);
          readEvents.flush(true);
        };
        let controllers = new Map();
        let disposed = false;
        let refreshing = null;
        let refillRequested = false;
        let refreshTimer = null;
        let currentRefreshMs = 300000;
        let hadRunning = false;
        let idleStartedAt = 0;
        let idleHideTimer = null;
        let idleTimerDeadline = 0;
        const observer = new MutationObserver(() => sync());

        function applyConfirmedRead(readKeys) {
          if (disposed) return;
          const items = latest.items.filter((article) => article.replay === true || !readKeys.has(article.articleKey));
          const consumed = items.length < latest.items.length;
          latest = { ...latest, items };
          for (const controller of controllers.values()) controller.retire(readKeys);
          if (consumed) {
            refillRequested = true;
            if (!refreshing) void refresh();
          }
        }

        function detachAll() {
          for (const controller of controllers.values()) controller.dispose();
          controllers = new Map();
        }

        function syncClockOwners() {
          const all = [...controllers.values()];
          const previous = all.find((controller) => controller.clockOwner);
          const usable = (controller) => controller && controller.inViewport && controller.groupWidth > 0 && rootIsVisible(controller.root);
          const owner = usable(previous) ? previous : all.find(usable) || previous || all[0];
          playback.controllers = all;
          for (const controller of all) {
            controller.clockOwner = controller === owner;
            controller.cycle = playback.cycle;
          }
          if (owner && owner !== previous) {
            if (previous) {
              owner.position = (playback.phase || 0) * owner.groupWidth;
              owner.exposureCandidates = previous.exposureCandidates;
              owner.exposureCounted = previous.exposureCounted;
              owner.exposureInside = previous.exposureInside;
              previous.hover = false;
              previous.focus = false;
              previous.syncPause();
            } else owner.exposureInside = new Set(playback.insideKeys);
            owner.lastFrame = 0;
          }
          if (owner) owner.syncTransform();
        }

        async function submitFeedback(article, action) {
          const response = await fetch(FEEDBACK_URL, {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ articleKey: article.articleKey, action }),
          });
          const result = await response.json().catch(() => null);
          if (!response.ok || result?.ok !== true || result.action !== action) throw new Error(result?.error || 'Feedback failed');
          if (!disposed) {
            const keys = new Set([article.articleKey, typeof result.articleKey === 'string' ? result.articleKey : article.articleKey]);
            for (const key of keys) feedbackOverrides.set(key, action);
            latest = { ...latest, items: latest.items.map((item) => keys.has(item.articleKey) ? { ...item, feedback: action } : item) };
            for (const controller of controllers.values()) {
              controller.items = controller.items.map((item) => keys.has(item.articleKey) ? { ...item, feedback: action } : item);
              controller.syncFeedback();
            }
            readEvents.confirmFeedback(article.articleKey, result);
          }
          return result;
        }
        function clearIdleHide() {
          if (idleHideTimer !== null) window.clearTimeout(idleHideTimer);
          idleHideTimer = null;
          idleTimerDeadline = 0;
        }
        function armIdleHide(deadline) {
          if (idleHideTimer !== null && idleTimerDeadline === deadline) return;
          clearIdleHide();
          idleTimerDeadline = deadline;
          idleHideTimer = window.setTimeout(() => { idleHideTimer = null; idleTimerDeadline = 0; sync(); }, Math.max(0, deadline - Date.now()));
        }
        function sync() {
          if (disposed) return;
          const config = latest.config;
          const hasPlaybackItems = latest.items.length || [...controllers.values()].some((controller) => controller.items.length);
          if (config.displayMode === 'off' || !hasPlaybackItems) {
            hadRunning = false;
            idleStartedAt = 0;
            clearIdleHide();
            detachAll();
            return;
          }
          const runningRows = [...document.querySelectorAll('[data-chat-running]')];
          const hasRunning = runningRows.length > 0;
          if (hasRunning) {
            hadRunning = true;
            idleStartedAt = 0;
            clearIdleHide();
          }
          const desired = new Map();
          for (const row of runningRows) desired.set(row, row.querySelector('[class*="runningContent"]') || row);
          const addFlowTickers = () => {
            for (const flow of document.querySelectorAll('[data-chat-flow]')) {
              // Use the same width-constrained, scrolling column as RunningStatus.
              // The sticky composer must not own an idle ticker or keep it on screen.
              desired.set(flow, null);
            }
          };
          if (config.displayMode !== 'running') {
            idleStartedAt = 0;
            clearIdleHide();
          }
          if (!hasRunning && config.displayMode === 'running' && hadRunning) {
            if (config.runningIdleBehavior === 'pause') {
              idleStartedAt = 0;
              clearIdleHide();
              addFlowTickers();
            } else if (config.runningIdleBehavior === 'delay') {
              if (!idleStartedAt) idleStartedAt = Date.now();
              const seconds = Math.max(1, Math.min(300, Number(config.runningIdleDelaySeconds) || 5));
              const deadline = idleStartedAt + seconds * 1000;
              if (Date.now() < deadline) {
                addFlowTickers();
                armIdleHide(deadline);
              } else {
                hadRunning = false;
                idleStartedAt = 0;
                clearIdleHide();
              }
            } else {
              hadRunning = false;
              idleStartedAt = 0;
              clearIdleHide();
            }
          }
          if (config.displayMode === 'always' && !hasRunning) addFlowTickers();
          for (const [host, controller] of controllers) {
            if (!desired.has(host) || !host.isConnected) { controller.dispose(); controllers.delete(host); }
          }
          for (const [host, target] of desired) {
            const existing = controllers.get(host);
            if (existing) existing.update(latest.items, config);
            else controllers.set(host, new TickerController(host, target, latest.items, config, t, playback, readEvents, submitFeedback));
            // Metadata only: no overlay in the clipping viewport or exposure geometry changes.
            const controller = controllers.get(host);
            const idlePaused = controller.root.hasAttribute('data-newscope-idle') && config.displayMode === 'running' && config.runningIdleBehavior === 'pause';
            if (controller.idlePaused !== idlePaused) {
              controller.idlePaused = idlePaused;
              controller.syncPause();
            }
            const root = controller.root;
            const label = latest.inventoryLabel || t('ariaLabel');
            if (root.title !== label) root.title = label;
            if (root.getAttribute('aria-label') !== label) root.setAttribute('aria-label', label);
          }
          syncClockOwners();
        }

        function armRefresh() {
          if (refreshTimer !== null) window.clearInterval(refreshTimer);
          refreshTimer = window.setInterval(refresh, currentRefreshMs);
        }

        async function refresh() {
          if (disposed || refreshing) return refreshing;
          refillRequested = false;
          refreshing = (async () => {
            try {
              const response = await fetch(FEED_URL, { credentials: 'same-origin', cache: 'no-store' });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const payload = await response.json();
              if (disposed) return;
              if (!payload || !payload.config || !Array.isArray(payload.items)) throw new Error('Invalid news payload');
              const projected = readEvents.applySnapshot(payload);
              if (!projected) return;
              const status = inventoryStatusValues(payload, t);
              const inventoryLabel = t('ariaLabel') + ' · ' + t('inventoryStatus.tier') + ': ' + status.tier
                + ' · ' + t('inventoryStatus.unreadCount') + ': ' + status.unreadCount + ' · ' + status.effective
                + ' · ' + t('inventoryStatus.inventoryScope') + ': ' + status.inventoryScope;
              const configured = configuration.getSnapshot().value;
              const config = configured && typeof configured === 'object' ? { ...payload.config, ...configured } : payload.config;
              const items = projected.items.map((item) => feedbackOverrides.has(item.articleKey)
                ? { ...item, feedback: feedbackOverrides.get(item.articleKey) } : item);
              latest = { items, config, inventoryLabel };
              const minutes = Math.max(1, Math.min(1440, Number(config.refreshMinutes) || 5));
              if (currentRefreshMs !== minutes * 60000) { currentRefreshMs = minutes * 60000; armRefresh(); }
            } catch (error) {
              // Keep the last good browser snapshot. An initial failure leaves no items,
              // so the native running row remains completely unchanged.
            } finally {
              refreshing = null;
              sync();
              if (refillRequested && !disposed) Promise.resolve().then(refresh);
            }
          })();
          return refreshing;
        }

        function visibility() {
          if (document.hidden) {
            for (const controller of controllers.values()) controller.resetExposure();
            readEvents.flush(true);
            return;
          }
          for (const controller of controllers.values()) controller.resetExposure();
          readEvents.resetRetry();
          refresh();
        }

        ctx.effect(() => {
          const unsubscribeConfiguration = configuration.subscribe(() => {
            if (disposed) return;
            const configured = configuration.getSnapshot().value;
            if (!configured || typeof configured !== 'object') return;
            latest = { ...latest, config: { ...latest.config, ...configured } };
            refillRequested = true;
            sync();
            if (!refreshing) void refresh();
          });
          observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
          document.addEventListener('visibilitychange', visibility);
          window.addEventListener('pagehide', onPageHide);
          refresh();
          armRefresh();
          return () => {
            disposed = true;
            unsubscribeConfiguration();
            observer.disconnect();
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('pagehide', onPageHide);
            playback.persist(true);
            if (refreshTimer !== null) window.clearInterval(refreshTimer);
            clearIdleHide();
            readEvents.shutdown();
            detachAll();
            style.remove();
          };
        }, 'newscope-news-ticker: running-row compatibility adapter');
      },
    };
  },
});
