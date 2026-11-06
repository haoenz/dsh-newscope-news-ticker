// Opt-in acceptance for upstream 9c02bfa + test-only in-memory fixture.
// The parent owns service lifecycle. Only a new QA session uses a local fixed-response fixture; no external model or production data.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import nativeBrowserVisibility from './native-browser-visibility.cjs';

const origin = 'http://127.0.0.1:3081';
const fixture = 'http://127.0.0.1:8082';
const localLlm = 'http://127.0.0.1:8083';
let localSessionStarted = false;
const newsPath = '/plugins/dsh-newscope-news-ticker/news.json';
const eventPath = '/plugins/dsh-newscope-news-ticker/read-events';
const evidence = resolve('.dsh-dev/original-evidence');
const report = { startedAt: new Date().toISOString(), gui: origin, fixture,
  sourceRevision: '9c02bfa', passed: false, checks: [], events: [], errors: [], forbiddenRequests: [] };
let auth = '', browser, page, sessionId, qaTitle, fixtureVerified = false, originalMaxAge;
let restoreMaxAge = false;
const redact = value => {
  let text = String(value);
  if (auth) text = text.split(auth).join(origin + '/[authentication-redacted]');
  return text.replace(/([?&#](?:token|auth|key|secret|access_token)=)[^&#\s]+/gi, '$1[redacted]');
};
const check = (name, detail = {}) => { report.checks.push({ name, ...detail }); console.log('PASS', name); };
const field = name => page.locator('[data-setting="' + name + '"]');
const status = name => page.locator('[data-newscope-status="' + name + '"]');
const ticker = () => page.locator('[data-newscope-ticker][data-newscope-idle]');
async function fixtureJson(path, options = {}) {
  const response = await fetch(fixture + path, { ...options, signal: AbortSignal.timeout(10000) });
  assert.equal(response.ok, true, 'Fixture request failed: ' + path + ' HTTP ' + response.status);
  return response.json();
}
const audit = () => fixtureJson('/__test/requests');
async function scenario(name) {
  assert.ok(fixtureVerified, 'Never mutate an unverified fixture');
  return fixtureJson('/__test/scenario', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
}
async function rpc(method, request) {
  assert.ok(['session/create', 'session/rename', 'session/modelCatalog', 'session/selectModel', 'session/prompt', 'session/cancel'].includes(method));
  if (['session/rename', 'session/selectModel', 'session/prompt', 'session/cancel'].includes(method)) assert.equal(request.sessionId, sessionId, 'Only the new QA session may be changed');
  if (method === 'session/selectModel') { assert.equal(request.provider, 'stage-e-local'); assert.equal(request.model, 'stage-e-hold'); }
  const result = await page.evaluate(async ({ method, request }) => {
    const response = await fetch('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { request } } }) });
    return (await response.json()).result;
  }, { method, request });
  assert.equal(result?.ok, true, 'Dedicated QA session RPC failed: ' + method);
  return result.value;
}
async function snapshot() {
  const result = await page.evaluate(async path => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  }, newsPath);
  assert.equal(result.status, 200, 'Inventory HTTP status');
  return result.body;
}
async function settings() {
  if (await page.locator('[data-newscope-save]').count()) return;
  await page.getByRole('button', { name: /^(Plugins|插件)$/ }).click();
  const view = page.getByRole('button', { name: /^(View|查看).*Newscope/ });
  await view.or(page.locator('[data-newscope-save]')).first().waitFor();
  if (!await page.locator('[data-newscope-save]').count()) await view.click();
  await page.locator('[data-newscope-inventory-status]').waitFor();
}
async function save() {
  const response = page.waitForResponse(r => r.url().endsWith('/api/settings/mutate'));
  await page.locator('[data-newscope-save]').click();
  const result = (await (await response).json()).result;
  assert.equal(result?.ok, true, 'QA settings save failed');
}
async function dismissOnboarding() {
  const close = page.getByRole('dialog').getByRole('button', { name: /^(Close|关闭)$/ });
  if (await close.isVisible()) await close.click();
}
async function openSession() {
  assert.ok(sessionId && qaTitle, 'Only the newly created QA session can be opened');
  await page.getByRole('button', { name: /^(Plugins|插件)$/ }).waitFor();
  await dismissOnboarding();
  const expand = page.getByRole('button', { name: /^(Expand sidebar|展开侧边栏)$/ });
  if (await expand.isVisible()) await expand.click();
  // Native workspace UI hides non-current blanks and labels the current blank
  // New Session even after rename. Verify the exact native selected row, not title.
  const row = page.locator('[data-row-key="session:' + sessionId + '"]');
  await row.waitFor();
  await page.waitForFunction(id => document.querySelector('[data-row-key="session:' + id + '"]')?.getAttribute('aria-selected') === 'true', sessionId);
  await ticker().waitFor();
}
async function refreshView() {
  await page.reload();
  await openSession();
  return snapshot();
}
async function mark(items) {
  assert.ok(items.length, 'Manual read batch must not be empty');
  const result = await page.evaluate(async ({ items, eventPath }) => {
    const response = await fetch(eventPath, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: items.map(item => ({ eventId: crypto.randomUUID(), articleKey: item.articleKey, type: 'manual' })) }) });
    return { status: response.status, body: await response.json() };
  }, { items, eventPath });
  assert.equal(result.status, 200, 'Manual read acknowledgement HTTP status');
  for (const item of items) assert.equal(result.body.exposureStates?.[item.articleKey]?.read, true, 'Host must confirm persisted manual read');
}
async function refreshStatus() {
  await settings();
  const button = page.locator('[data-newscope-refresh-status]');
  await page.waitForFunction(() => !document.querySelector('[data-newscope-refresh-status]')?.disabled);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === newsPath);
  await button.click();
  await response;
  await page.waitForFunction(() => !document.querySelector('[data-newscope-refresh-status]')?.disabled);
}
async function screenshot(name) {
  await page.screenshot({ path: resolve(evidence, name + '.png') });
}
function knownLocal(state) {
  assert.equal(state.capabilities.inventoryScope, 'known-local');
  assert.equal(state.capabilities.remoteWindowComplete, false);
  assert.equal(state.capabilities.history, true);
}
async function tierView(expected, name) {
  const state = await refreshView();
  knownLocal(state);
  assert.equal(state.pool.tier, expected);
  await page.waitForFunction(expected => {
    const root = document.querySelector('[data-newscope-ticker][data-newscope-idle]');
    return root?.title.includes(expected) && root.title.includes('known-local') && root.getAttribute('aria-label') === root.title;
  }, expected);
  if (state.items.some(item => item.replay)) await page.locator('[data-newscope-replay="true"]').first().waitFor();
  await screenshot(name);
  return state;
}

try {
  await mkdir(evidence, { recursive: true });
  assert.equal(process.env.QA_HEADFUL, '1', 'Run explicitly with QA_HEADFUL=1 in isolated web-dev');
  auth = (await readFile(process.env.QA_URL_FILE || '.dsh-dev/stage-e-url.txt', 'utf8')).trim();
  assert.equal(new URL(auth).origin, origin, 'Only dedicated GUI port 3081 is allowed');
  const version = await fixtureJson('/api/v1/status');
  assert.equal(version.version, 'ticker-original-acceptance', 'Refuse a real Newscope database');
  fixtureVerified = true;
  assert.equal((await fetch(fixture + '/api/v1/articles', { signal: AbortSignal.timeout(10000) })).status, 404);
  // Parent seeds once before starting the Host. Reseeding here would create new IDs
  // and invalidate the exact five-candidate assertion without clearing real history.
  const before = await audit();
  assert.equal(before.scenario.name, 'initial', 'Parent must prepare initial scenario and isolated clean stores');
  assert.equal(before.scenario.articles.length, 5);
  check('verified-original-fixture-without-new-JSON-API');

  const { chromium } = nativeBrowserVisibility();
  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(redact(error.message)));
  context.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === eventPath) report.events.push({ at: new Date().toISOString(), body: request.postDataJSON() });
    if (/^\/api\/session\/(?:prompt|selectModel|cancel)$/.test(path)) {
      const body = request.postDataJSON()?.payload?.args?.request;
      if (!sessionId || body?.sessionId !== sessionId || (path.endsWith('/selectModel') && (body?.provider !== 'stage-e-local' || body?.model !== 'stage-e-hold'))) report.forbiddenRequests.push(path);
    }
  });
  await page.goto(auth);
  await page.getByRole('button', { name: /^(Plugins|插件)$/ }).waitFor();
  await dismissOnboarding();
  const created = await rpc('session/create', { cwd: resolve('.') });
  sessionId = created.sessionId;
  assert.ok(sessionId);
  qaTitle = 'Original Compatibility QA ' + Date.now();
  await rpc('session/rename', { sessionId, title: qaTitle });
  report.sessionId = sessionId;
  report.sessionTitle = qaTitle;
  const modelCatalog = await rpc('session/modelCatalog');
  assert.ok(modelCatalog.groups.some(group => group.id === 'stage-e-local'));
  const models = await fetch(localLlm + '/v1/models').then(r => r.json());
  assert.equal(models.data[0].id, 'stage-e-hold');
  assert.deepEqual((await fetch(localLlm + '/__test/state').then(r => r.json())).active, []);
  await rpc('session/selectModel', { sessionId, provider: 'stage-e-local', model: 'stage-e-hold' });
  localSessionStarted = true;
  await rpc('session/prompt', { sessionId, requestId: crypto.randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: 'Original compatibility UI fixture only. No tools.' }], clientTimeZone: 'Asia/Shanghai' });
  const startedDeadline = Date.now() + 10000;
  while (!(await fetch(localLlm + '/__test/state').then(r => r.json())).active.length) {
    assert.ok(Date.now() < startedDeadline, 'Dedicated local fixture stream must start');
    await page.waitForTimeout(100);
  }
  await fetch(localLlm + '/__test/finish', { method: 'POST' });
  await rpc('session/rename', { sessionId, title: qaTitle });
  check('dedicated-local-fixed-response-session-without-external-model');
  // Verified DSH 0.2.1-rc.3 native persistence: ui-workspace selection uses
  // dsh.sessions.current = {sessionId}; restoreSelection restores blank sessions.
  // This changes navigation only, not read state, DOM, visibility or clocks.
  await page.evaluate(id => localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })), sessionId);
  await page.reload();
  await openSession();

  let state = await snapshot();
  assert.equal(state.version, 'ticker-original-acceptance');
  assert.equal(state.config.newscopeUrl, fixture);
  assert.equal(state.config.onlyWhenRunning, false);
  assert.equal(state.config.translationEnabled, false);
  assert.equal(state.config.semanticDedupEnabled, false);
  assert.equal(state.config.readAfterExposures, 100);
  assert.equal(state.config.inventory.targetInventory, 4);
  assert.equal(state.config.inventory.lowWatermark, 2);
  assert.equal(state.config.inventory.refillDebounceSeconds, 1);
  assert.equal(state.pool.tier, 'L0');
  assert.equal(state.pool.unreadCount, 3);
  assert.equal(state.items.length, 3);
  assert.equal(state.inventoryStore.retainedCount, 5);
  knownLocal(state);
  assert.equal(state.capabilities.source, 'rss+html');
  assert.equal(state.capabilities.coverage, 'best-effort');
  const initialKeys = state.items.map(item => item.articleKey);
  assert.ok(state.items.every(item => !item.replay && state.exposureStates[item.articleKey]?.read === false));
  assert.match(await ticker().getAttribute('title'), /known-local/);
  assert.equal(await ticker().getAttribute('aria-label'), await ticker().getAttribute('title'));
  assert.equal(await ticker().locator(':scope > *').count(), 1, 'No scope geometry badge');
  await screenshot('initial-idle');
  check('new-empty-QA-session-idle-ticker-with-known-local-accessible-scope');

  await refreshStatus();
  for (const [key, value] of Object.entries({ inventoryScope: 'known-local', coverage: 'best-effort', remoteWindowComplete: 'false', retainedCount: '5' })) {
    assert.equal(await status(key).textContent(), value);
  }
  const rssWarning = await page.locator('[data-newscope-warning="rss"]').innerText();
  assert.match(rssWarning, /L0\/L1\/L2/);
  assert.match(rssWarning, /重播|replay/i);
  assert.doesNotMatch(rssWarning, /仅.*L0|L0.only|disable.*replay|禁用.*重播/i);
  assert.match(await page.locator('[data-newscope-warning="known-local"]').innerText(), /无法证明远端|cannot prove remote/i);
  assert.match(await page.locator('[data-newscope-warning="best-effort"]').innerText(), /并发.*漏项|concurrent.*missed/i);
  await page.locator('[data-newscope-inventory-status]').scrollIntoViewIfNeeded();
  await screenshot('settings-known-local');
  check('bilingual-scope-coverage-count-and-RSS-HTML-limits-not-L0-only');

  await mark(state.items);
  state = await tierView('L1', 'tier-l1');
  assert.equal(state.items.length, 1);
  assert.ok(state.items.every(item => !item.replay));
  check('manual-L0-exhaustion-selects-L1-in-known-inventory');
  await mark(state.items);
  state = await tierView('L2+replay', 'tier-l2-replay');
  assert.equal(state.items.length, 4);
  assert.equal(state.items.filter(item => !item.replay).length, 1);
  assert.equal(state.items[0].replay, false);
  check('manual-L1-exhaustion-selects-L2-before-read-replay');
  await mark(state.items.filter(item => !item.replay));
  state = await tierView('replay', 'tier-replay');
  assert.ok(state.items.every(item => item.replay && state.exposureStates[item.articleKey]?.read));
  const readVersion = state.readVersion;
  state = await tierView('replay', 'reload-replay');
  assert.ok(state.readVersion >= readVersion);
  assert.ok(state.items.every(item => item.replay && state.exposureStates[item.articleKey]?.read));
  check('reload-preserves-persisted-read-and-explicit-replay');

  await scenario('new-high-only');
  await page.waitForTimeout(1200); // Real configured debounce; no clock/visibility/DOM overrides.
  state = await tierView('L0', 'new-high-preempts');
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].score, 10);
  assert.equal(state.items[0].replay, false);
  assert.equal(state.inventoryStore.retainedCount, 6);
  const highKey = state.items[0].articleKey;
  assert.ok((await audit()).requests.some(r => r.scenario === 'new-high-only' && r.path === '/rss'));
  check('low-water-query-discovers-new-high-and-preempts-replay-without-cache-key-change');

  await scenario('outage');
  await page.waitForTimeout(1200);
  await refreshStatus();
  assert.equal(await status('service').textContent(), 'cache');
  assert.equal(await status('stale').textContent(), 'true');
  state = await snapshot();
  knownLocal(state);
  assert.equal(state.service, 'cache');
  assert.equal(state.stale, true);
  assert.ok(state.items.some(item => item.articleKey === highKey));
  await page.locator('[data-newscope-inventory-status]').scrollIntoViewIfNeeded();
  await screenshot('stale-outage');
  check('original-remote-outage-keeps-stale-known-candidates');

  await scenario('empty');
  await page.waitForTimeout(1200);
  await settings();
  originalMaxAge = await field('maxAgeHours').inputValue();
  const age = Number(originalMaxAge);
  assert.ok(age >= 1 && age < 59, 'Keep QA baseline below the 60-hour L1 fixture');
  restoreMaxAge = true;
  await field('maxAgeHours').fill(String(age + 1));
  await save();
  state = await tierView('L0', 'remote-empty-retains-history');
  assert.equal(state.service, 'ok');
  assert.equal(state.stale, false);
  assert.equal(state.inventoryStore.retainedCount, 6);
  assert.ok(state.items.some(item => item.articleKey === highKey));
  await mark(state.items.filter(item => !item.replay));
  state = await tierView('replay', 'remote-empty-known-replay');
  assert.ok(state.items.some(item => initialKeys.includes(item.articleKey)), 'Previously collected L0 candidates remain available for replay');
  check('remote-empty-does-not-delete-collected-history-or-disable-replay');

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.forbiddenRequests, []);
  check('no-page-exceptions-or-other-session-operations');
  report.passed = true;
} catch (error) {
  report.failure = redact(error?.stack || error);
  try { if (page) await screenshot('failure'); } catch { /* Preserve original failure. */ }
} finally {
  report.cleanupErrors = [];
  if (localSessionStarted) {
    try { await fetch(localLlm + '/__test/finish', { method: 'POST' }); report.localLlm = await fetch(localLlm + '/__test/state').then(r => r.json()); assert.deepEqual(report.localLlm.active, []); }
    catch (error) { report.cleanupErrors.push('Local fixture cleanup: ' + redact(error)); }
    if (!report.passed && page && sessionId) { try { await rpc('session/cancel', { sessionId }); } catch (error) { report.cleanupErrors.push('Cancel dedicated QA session: ' + redact(error)); } }
  }
  if (restoreMaxAge && page) {
    try {
      await settings();
      await field('maxAgeHours').fill(originalMaxAge);
      await save();
    } catch (error) { report.cleanupErrors.push('Restore QA maxAgeHours: ' + redact(error)); }
  }
  if (fixtureVerified) {
    try { await scenario('initial'); } catch (error) { report.cleanupErrors.push('Restore fixture initial: ' + redact(error)); }
    try {
      report.fixtureRequests = await audit();
      assert.equal(report.fixtureRequests.noFeedFetch, true);
      assert.equal(report.fixtureRequests.feedFetchRequests, 0);
      check('fixture-restored-and-no-feed-fetch');
    } catch (error) { report.cleanupErrors.push('Fixture request audit: ' + redact(error)); }
  }
  try { await browser?.close(); } catch (error) { report.cleanupErrors.push('Close QA browser: ' + redact(error)); }
  if (report.cleanupErrors.length || report.errors.length || report.forbiddenRequests.length) report.passed = false;
  report.finishedAt = new Date().toISOString();
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'browser-report.json'), redact(JSON.stringify(report, null, 2)));
}
if (!report.passed) {
  console.error('Original compatibility browser acceptance failed; inspect .dsh-dev/original-evidence/browser-report.json');
  process.exitCode = 1;
}
