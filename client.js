window.__ModuleLoader__.load({
  id: 'dsh-newscope-news-ticker',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PACKAGE = 'dsh-newscope-news-ticker';
    const FEED_URL = '/plugins/dsh-newscope-news-ticker/news.json';
    const MANAGE_URL = '/plugins/dsh-newscope-news-ticker/manage';
    const NS = 'newscope-news-ticker';
    const SPEEDS = { slow: 25, medium: 45, fast: 75 };

    const CSS = `
      [data-chat-running].dsh-newscope-running { display:flex; width:100%; min-width:0; max-width:100%; overflow:hidden; }
      .dsh-newscope-running-content { display:flex !important; align-items:center; flex:1 1 auto; min-width:0; max-width:100%; overflow:hidden; }
      .dsh-newscope-running-content > [class*="runningText"] { flex:none; min-width:0; }
      .dsh-newscope-ticker { box-sizing:border-box; position:relative; flex:1 1 auto; min-width:0; max-width:100%; height:26px; margin-left:12px; padding-left:12px; overflow:hidden; border-left:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); font-size:var(--dsh-content-font-size-secondary,12px); line-height:24px; white-space:nowrap; contain:layout paint; }
      .dsh-newscope-ticker[data-newscope-idle] { width:100%; margin:2px 0 0; padding-left:0; border-left:0; }
      .dsh-newscope-ticker:focus-visible { outline:1px solid var(--dsw-alias-brand-primary); outline-offset:1px; border-radius:2px; }
      .dsh-newscope-track { display:inline-flex; align-items:center; min-width:max-content; will-change:transform; transform:translate3d(0,0,0); }
      .dsh-newscope-group { display:inline-flex; align-items:center; flex:none; }
      .dsh-newscope-item { display:inline-flex; align-items:center; flex:none; }
      .dsh-newscope-separator { flex:none; margin:0 16px; color:var(--dsw-alias-label-secondary); opacity:.55; }
      .dsh-newscope-link { display:inline-flex; align-items:center; max-width:none; color:var(--dsw-alias-label-secondary); text-decoration:none; cursor:pointer; }
      .dsh-newscope-link:hover { color:var(--dsw-alias-brand-primary); text-decoration:underline; text-underline-offset:3px; }
      .dsh-newscope-category { flex:none; margin-right:6px; color:var(--dsw-alias-brand-primary); }
      .dsh-newscope-source { flex:none; margin-right:6px; color:var(--dsw-alias-label-secondary); }
      .dsh-newscope-title { flex:none; }
      .dsh-newscope-ticker[data-reduced-motion="true"] { overflow-x:auto; overscroll-behavior-x:contain; }
      .dsh-newscope-ticker[data-reduced-motion="true"] .dsh-newscope-track { transform:none !important; will-change:auto; }
      .dsh-newscope-ticker[data-reduced-motion="true"] [data-newscope-clone] { display:none; }
      .dsh-newscope-management { margin-top:16px; padding-top:16px; border-top:1px solid var(--dsw-alias-border-l1); }
      .dsh-newscope-management a { color:var(--dsw-alias-brand-primary); text-decoration:none; }
      .dsh-newscope-management a:hover { text-decoration:underline; }
      @media (max-width:600px) {
        .dsh-newscope-ticker { margin-left:8px; padding-left:8px; }
        .dsh-newscope-category { display:none; }
        .dsh-newscope-separator { margin:0 10px; }
      }
      @media (prefers-reduced-motion:reduce) { .dsh-newscope-track { will-change:auto; } }
    `;

    function articleElement(article, config, t, clone) {
      const target = config.openInNewTab ? '_blank' : undefined;
      const children = [];
      if (config.showCategory) children.push(h('span', { className: 'dsh-newscope-category' }, t(`category.${article.category}`)));
      children.push(
        h('span', { className: 'dsh-newscope-source' }, article.source),
        h('span', { className: 'dsh-newscope-title' }, article.title),
      );
      const anchor = h('a', {
        className: 'dsh-newscope-link', href: article.url, target,
        rel: 'noopener noreferrer', referrerPolicy: 'no-referrer',
        title: `${article.source} — ${article.title}`,
        tabIndex: clone ? -1 : undefined,
      }, ...children);
      return h('span', { className: 'dsh-newscope-item', 'data-newscope-item': article.id },
        anchor, h('span', { className: 'dsh-newscope-separator', 'aria-hidden': 'true' }, '◆'));
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
        if (key === 'children' || value === undefined) continue;
        if (key === 'className') element.className = value;
        else if (key === 'tabIndex') element.tabIndex = value;
        else if (key === 'referrerPolicy') element.referrerPolicy = value;
        else element.setAttribute(key, String(value));
      }
      const children = descriptor.props?.children;
      for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
        if (child !== null && child !== undefined && child !== false) mountDescriptor(element, child);
      }
      parent.appendChild(element);
    }

    class TickerController {
      constructor(host, target, items, config, t) {
        this.host = host;
        this.target = target;
        this.items = items;
        this.config = config;
        this.t = t;
        this.position = 0;
        this.groupWidth = 0;
        this.lastFrame = 0;
        this.hover = false;
        this.focus = false;
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
        if (host.hasAttribute('data-slot')) this.root.dataset.newscopeIdle = '';
        this.track = document.createElement('div');
        this.track.className = 'dsh-newscope-track';
        this.track.dataset.newscopeTrack = '';
        this.root.appendChild(this.track);
        target.appendChild(this.root);
        host.classList.add('dsh-newscope-running');
        if (target !== host) target.classList.add('dsh-newscope-running-content');
        this.media = typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-reduced-motion: reduce)')
          : { matches: false, addEventListener() {}, removeEventListener() {} };
        this.onMotion = () => { this.signature = ''; this.render(); };
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
        this.media.addEventListener?.('change', this.onMotion);
        this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.measure()) : null;
        this.resizeObserver?.observe(this.root);
        this.render();
      }

      syncPause() {
        const paused = this.hover || this.focus;
        if (this.root.dataset.paused !== String(paused)) {
          this.root.dataset.paused = String(paused);
          this.lastFrame = 0;
        }
      }

      measure() {
        const group = this.track.querySelector('[data-newscope-group]');
        const width = group ? group.getBoundingClientRect().width || group.scrollWidth : 0;
        this.groupWidth = Math.max(0, width);
        if (this.groupWidth > 0) this.position %= this.groupWidth;
      }

      render() {
        const signature = JSON.stringify(this.items.map((item) => [item.id, item.title, item.url, item.source]))
          + JSON.stringify([this.config.showCategory, this.config.openInNewTab, this.media.matches]);
        if (signature === this.signature) { this.measure(); return; }
        this.signature = signature;
        this.root.dataset.reducedMotion = String(this.media.matches);
        this.track.replaceChildren();
        const groups = this.media.matches ? [false] : [false, true];
        for (const clone of groups) {
          const group = document.createElement('span');
          group.className = 'dsh-newscope-group';
          group.dataset.newscopeGroup = '';
          if (clone) {
            group.dataset.newscopeClone = '';
            group.setAttribute('aria-hidden', 'true');
          }
          for (const item of this.items) mountDescriptor(group, articleElement(item, this.config, this.t, clone));
          this.track.appendChild(group);
        }
        this.measure();
        this.start();
      }

      start() {
        if (this.disposed || this.media.matches || this.raf) return;
        const frame = (time) => {
          this.raf = 0;
          if (this.disposed || this.media.matches) return;
          const elapsed = this.lastFrame ? Math.min(100, Math.max(0, time - this.lastFrame)) : 0;
          this.lastFrame = time;
          if (!this.hover && !this.focus && !document.hidden && this.groupWidth > 0) {
            const speed = SPEEDS[this.config.scrollSpeed] || SPEEDS.medium;
            this.position = (this.position + elapsed * speed / 1000) % this.groupWidth;
            this.track.style.transform = `translate3d(${-this.position.toFixed(2)}px,0,0)`;
          }
          this.raf = window.requestAnimationFrame(frame);
        };
        this.raf = window.requestAnimationFrame(frame);
      }

      update(items, config) {
        this.items = items;
        this.config = config;
        if (!config.pauseOnHover) this.hover = false;
        this.syncPause();
        this.render();
      }

      dispose() {
        this.disposed = true;
        if (this.raf) window.cancelAnimationFrame(this.raf);
        this.resizeObserver?.disconnect();
        this.media.removeEventListener?.('change', this.onMotion);
        this.root.removeEventListener('mouseenter', this.onEnter);
        this.root.removeEventListener('mouseleave', this.onLeave);
        this.root.removeEventListener('focusin', this.onFocus);
        this.root.removeEventListener('focusout', this.onBlur);
        this.root.remove();
        this.host.classList.remove('dsh-newscope-running');
        this.target.classList.remove('dsh-newscope-running-content');
      }
    }

    function ManagementSection({ subject }, t) {
      if ((subject.kind !== 'bundle' && subject.kind !== 'row') || subject.pkg.name !== PACKAGE) return null;
      return h('section', { className: 'dsh-newscope-management' },
        h('a', { href: MANAGE_URL, target: '_blank', rel: 'noopener noreferrer' }, t('openManagement')));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, {
              en: {
                ariaLabel: 'Newscope news ticker', openManagement: 'Open Newscope management ↗',
                category: { finance: 'Finance', technology: 'Technology', science: 'Science', general: 'News' },
              },
              zh: {
                ariaLabel: 'Newscope 新闻跑马灯', openManagement: '打开 Newscope 管理界面 ↗',
                category: { finance: '财经', technology: '科技', science: '科学', general: '新闻' },
              },
            });
          } catch (error) {
            // An earlier development activation left this package-owned namespace
            // behind after removal. Reuse that identical dictionary; new activations
            // register through ctx.effect and are disposed normally.
            if (String(error).includes(`locale namespace "${NS}" already has locale`)) return undefined;
            throw error;
          }
        }, 'newscope-news-ticker: locale');
        const t = ctx.locale.bind(NS);
        const style = document.createElement('style');
        style.dataset.newscopeTickerStyle = '';
        style.textContent = CSS;
        document.head.appendChild(style);
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section', id: 'newscope-news-ticker-management', order: 20,
        }, (props) => ManagementSection(props, t)));

        let latest = { items: [], config: { enabled: true, onlyWhenRunning: true } };
        let controllers = new Map();
        let disposed = false;
        let refreshing = null;
        let refreshTimer = null;
        let currentRefreshMs = 300000;
        const observer = new MutationObserver(() => sync());

        function detachAll() {
          for (const controller of controllers.values()) controller.dispose();
          controllers = new Map();
        }

        function sync() {
          if (disposed) return;
          const config = latest.config;
          if (!config.enabled || !latest.items.length) { detachAll(); return; }
          const desired = new Map();
          for (const row of document.querySelectorAll('[data-chat-running]')) {
            desired.set(row, row.querySelector('[class*="runningContent"]') || row);
          }
          if (!config.onlyWhenRunning && !document.querySelector('[data-chat-running]')) {
            for (const dock of document.querySelectorAll('[data-slot="conversation.composer.dock"]')) desired.set(dock, dock);
          }
          for (const [host, controller] of controllers) {
            if (!desired.has(host) || !host.isConnected) { controller.dispose(); controllers.delete(host); }
          }
          for (const [host, target] of desired) {
            const existing = controllers.get(host);
            if (existing) existing.update(latest.items, config);
            else controllers.set(host, new TickerController(host, target, latest.items, config, t));
          }
        }

        function armRefresh() {
          if (refreshTimer !== null) window.clearInterval(refreshTimer);
          refreshTimer = window.setInterval(refresh, currentRefreshMs);
        }

        async function refresh() {
          if (disposed || refreshing) return refreshing;
          refreshing = (async () => {
            try {
              const response = await fetch(FEED_URL, { credentials: 'same-origin', cache: 'no-store' });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const payload = await response.json();
              if (!payload || !payload.config || !Array.isArray(payload.items)) throw new Error('Invalid news payload');
              latest = { items: payload.items, config: payload.config };
              const minutes = Math.max(1, Math.min(1440, Number(payload.config.refreshMinutes) || 5));
              if (currentRefreshMs !== minutes * 60000) { currentRefreshMs = minutes * 60000; armRefresh(); }
            } catch (error) {
              // Keep the last good browser snapshot. An initial failure leaves no items,
              // so the native running row remains completely unchanged.
            } finally {
              refreshing = null;
              sync();
            }
          })();
          return refreshing;
        }

        function visibility() { if (!document.hidden) refresh(); }

        ctx.effect(() => {
          observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
          document.addEventListener('visibilitychange', visibility);
          refresh();
          armRefresh();
          return () => {
            disposed = true;
            observer.disconnect();
            document.removeEventListener('visibilitychange', visibility);
            if (refreshTimer !== null) window.clearInterval(refreshTimer);
            detachAll();
            style.remove();
          };
        }, 'newscope-news-ticker: running-row compatibility adapter');
      },
    };
  },
});
