// Opt-in real-browser acceptance. Requires isolated web-dev + Newscope/LLM fixtures.
// Never run against the stable GUI or a real article database.
import assert from 'node:assert/strict';
import nativeBrowserVisibility from './native-browser-visibility.cjs';
const { chromium } = nativeBrowserVisibility();
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const origin = 'http://127.0.0.1:3081';
const fixture = 'http://127.0.0.1:8082';
const model = 'http://127.0.0.1:8083';
const newsPath = '/plugins/dsh-newscope-news-ticker/news.json';
const eventPath = '/plugins/dsh-newscope-news-ticker/read-events';
const evidence = resolve(process.env.QA_EVIDENCE || '.dsh-dev/stage-e-evidence');
await mkdir(evidence, { recursive: true });
const auth = (await readFile(process.env.QA_URL_FILE || '.dsh-dev/stage-e-url.txt', 'utf8')).trim();
assert.equal(new URL(auth).origin, origin, 'Only the dedicated 3081 GUI is allowed');
const initial = await fetch(origin + newsPath).then(r => r.json());
assert.equal(initial.version, 'ticker-browser-acceptance', 'Refuse a real Newscope database');
assert.equal(initial.config.newscopeUrl, fixture);
const report = { startedAt: new Date().toISOString(), gui: origin, fixture, checks: [], events: [], errors: [] };
const browser = await chromium.launch({ headless: process.env.QA_HEADFUL !== '1' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
const page = await context.newPage();
page.setDefaultTimeout(15000);
let sessionId, qaTitle;
const check = (name, detail = {}) => { report.checks.push({ name, ...detail }); console.log('PASS', name); };
page.on('pageerror', error => report.errors.push(error.message));
context.on('request', req => {
  if (new URL(req.url()).pathname === eventPath) report.events.push({ at: Date.now(), tab: req.frame().page() === page ? 'A' : 'B', body: req.postDataJSON() });
});
async function rpc(method, request) {
  const result = await page.evaluate(async ({method, request}) => {
    const args = request === undefined ? {} : { request };
    const response = await fetch('/api/' + method, {method:'POST',headers:{'content-type':'application/json'},
      body: JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args}})});
    return (await response.json()).result;
  }, {method, request});
  assert.equal(result?.ok, true, JSON.stringify(result)); return result.value;
}
async function settings() {
  if(await page.locator('[data-newscope-save]').count()) return;
  await page.getByRole('button', {name:/^(Plugins|插件)$/}).click();
  const view=page.getByRole('button', {name:/^(View|查看).*Newscope/});
  await view.or(page.locator('[data-newscope-save]')).first().waitFor();
  if(!await page.locator('[data-newscope-save]').count()) await view.click();
  await page.locator('[data-newscope-inventory-status]').waitFor();
}
async function save() {
  const response = page.waitForResponse(r => r.url().endsWith('/api/settings/mutate'));
  await page.locator('[data-newscope-save]').click();
  const result = (await (await response).json()).result;
  assert.equal(result.ok, true, JSON.stringify(result));
}
const field = name => page.locator('[data-setting="' + name + '"]');
const snapshot = () => fetch(origin + newsPath).then(r => r.json());
async function scenario(name) {
  const response = await fetch(fixture+'/__test/scenario',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})});
  assert.equal(response.ok,true); return response.json();
}
async function openSession(p = page) {
  await p.setViewportSize({width:1440,height:1000});
  await p.getByRole('button',{name:/^(Plugins|插件)$/}).waitFor();
  const link=p.getByText(qaTitle,{exact:true}).filter({visible:true}).first();
  if(await p.locator('[data-chat-running]').isVisible() && await link.isVisible()) return;
  if(!await link.isVisible()) {
    const expand=p.getByRole('button',{name:/^(Expand sidebar|展开侧边栏)$/});
    if(await expand.isVisible()) await expand.click();
    await p.getByText(/^(Ungrouped|未分组)$/).click();
  }
  await link.click(); await p.locator('[data-chat-running]').waitFor();
}
async function forceFreshScenario(name) {
  await scenario(name); await page.setViewportSize({width:1440,height:1000});
  await settings(); await field('maxAgeHours').fill(String(Number(await field('maxAgeHours').inputValue())+1));
  await save(); await page.reload(); await openSession();
}
async function mark(items) {
  const result=await page.evaluate(async({items,eventPath}) => {
    const response=await fetch(eventPath,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({events:items.map(item=>({eventId:crypto.randomUUID(),articleKey:item.articleKey,type:'manual'}))})});
    return {status:response.status,body:await response.json()};
  },{items,eventPath}); assert.equal(result.status,200,JSON.stringify(result));
}
async function refreshView() { await page.reload(); await openSession(); return snapshot(); }

try {
  await page.goto(auth);
  await page.getByRole('button', {name:/^(Plugins|插件)$/}).waitFor();
  const modal = page.getByRole('dialog');
  if (await modal.count()) await modal.getByRole('button', {name:/^(Close|关闭)$/}).click();
  await fetch(fixture + '/__test/scenario', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'initial'})});
  await settings();
  await field('maxAgeHours').fill(String(Number(await field('maxAgeHours').inputValue())+1));
  const target = (await field('inventory.targetInventory').inputValue()) === '4' ? '3' : '4';
  await field('inventory.targetInventory').fill(target);
  await field('inventory.lowWatermark').fill(String(Number(target) + 1));
  await page.locator('[data-newscope-save]').click();
  assert.match(await page.locator('.dsh-newscope-settings-actions').last().innerText(), /Check URLs|请检查/);
  await field('inventory.lowWatermark').fill('2');
  await save();
  await page.reload(); await settings();
  assert.equal(await field('inventory.targetInventory').inputValue(), target);
  assert.equal(await field('inventory.lowWatermark').inputValue(), '2');
  assert.equal(await field('readAfterExposures').inputValue(), '3');
  await page.locator('[data-newscope-inventory-status]').scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(evidence,'settings.png')});
  check('native-settings-validation-save-reload');
  const catalog = await rpc('session/modelCatalog');
  assert.ok(catalog.groups.some(group => group.id === 'stage-e-local'));
  const created = await rpc('session/create', {cwd:resolve('.')}); sessionId = created.sessionId;
  assert.ok(sessionId);
  const title = qaTitle = 'Stage E Local Running QA ' + Date.now();
  await rpc('session/rename', {sessionId,title});
  await rpc('session/selectModel', {sessionId,provider:'stage-e-local',model:'stage-e-hold'});
  await rpc('session/prompt', {sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:'Stage E local UI running-state fixture only'}],clientTimeZone:'Asia/Shanghai'});
  report.sessionId=sessionId;
  await rpc('session/rename', {sessionId,title});
  await page.reload();
  const sessionLink = page.getByText(title,{exact:true});
  if (!await sessionLink.isVisible()) await page.getByText(/^(Ungrouped|未分组)$/).click();
  await sessionLink.click();
  await page.locator('[data-chat-running]').waitFor();
  await page.locator('[data-newscope-ticker]').waitFor();
  await page.screenshot({path:resolve(evidence,'running.png')});
  check('dedicated-session-native-running-row',{sessionId});
  // All timing/visibility/rectangles below are the real browser's, never mocked.
  const ticker=page.locator('[data-newscope-ticker]');
  if(process.env.QA_SKIP_EXPOSURE !== '1') {
  await forceFreshScenario('one');
  await page.setViewportSize({width:360,height:900});
  await ticker.waitFor();
  const one=await snapshot(); const key=one.items[0].articleKey;
  await page.waitForSelector('[data-newscope-key="'+key+'"]');
  await page.bringToFront(); await page.waitForFunction(()=>!document.hidden); await ticker.hover();
  const dwellDeadline=Date.now()+6000;
  while((await snapshot()).exposureStates[key]?.exposureCount===0 && Date.now()<dwellDeadline) await page.waitForTimeout(250);
  const first=(await snapshot()).exposureStates[key].exposureCount;
  assert.equal(first,1,'one continuous visible opportunity');
  const frozen=await page.locator('[data-newscope-track]').evaluate(el=>el.style.transform);
  await page.waitForTimeout(1700);
  assert.equal((await snapshot()).exposureStates[key].exposureCount,first);
  assert.equal(await page.locator('[data-newscope-track]').evaluate(el=>el.style.transform),frozen);
  check('hover-pause-counts-dwell-once');
  await ticker.focus(); await page.mouse.move(0,0); await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-newscope-track]').evaluate(el=>el.style.transform),frozen);
  check('keyboard-focus-pauses-motion');
  const blank=await context.newPage(); await blank.goto('about:blank'); await blank.bringToFront();
  await page.waitForFunction(()=>document.visibilityState==='hidden',null,{polling:100});
  const hiddenAt=Date.now(); await blank.waitForTimeout(2200);
  assert.equal((await snapshot()).exposureStates[key].exposureCount,first);
  assert.equal(report.events.filter(e=>e.tab==='A'&&e.at>hiddenAt).length,0);
  await page.screenshot({path:resolve(evidence,'background.png')});
  await blank.close(); await page.bringToFront();
  await page.waitForFunction(()=>document.visibilityState==='visible');
  check('native-background-tab-does-not-accrue-exposure');
  // Commit once but lose the ACK; the browser must retry the exact event id.
  let lostId=null;
  await page.route('**'+eventPath,async route=>{
    const events=route.request().postDataJSON().events;
    if(!lostId){lostId=events[0].eventId;await route.fetch();await route.abort('failed');}
    else await route.continue();
  });
  await page.locator('[contenteditable="true"],textarea').first().focus();
  await page.mouse.move(0,0);
  const waitCount=async(count)=>{
    const deadline=Date.now()+45000;
    while(Date.now()<deadline){
      if((await snapshot()).exposureStates[key]?.exposureCount>=count)return;
      await page.waitForTimeout(300);
    }
    assert.fail('Timed out waiting for genuine visible opportunity '+count);
  };
  await waitCount(2);
  await page.waitForTimeout(1500); // allow the same-ID retry to settle
  // A single article's adjacent clones can stay continuously visible forever.
  // That must NOT generate extra exposures just for wrapping. Leave the actual
  // tab again to create a third distinct foreground opportunity in a later cycle.
  const away=await context.newPage(); await away.goto('about:blank'); await away.bringToFront();
  await page.waitForFunction(()=>document.hidden); await away.waitForTimeout(1800);
  assert.equal((await snapshot()).exposureStates[key].exposureCount,2);
  await away.close(); await page.bringToFront(); await waitCount(3);
  await page.unroute('**'+eventPath);
  assert.ok(lostId,'a real exposure request was fault-injected');
  assert.ok(report.events.flatMap(e=>e.body.events).filter(e=>e.eventId===lostId).length>=2,'same event id retried');
  const replay=await snapshot();
  assert.equal(replay.exposureStates[key].exposureCount,3);
  assert.equal(replay.pool.tier,'replay'); assert.ok(replay.items.every(i=>i.replay));
  await page.waitForSelector('[data-newscope-replay="true"]');
  await page.screenshot({path:resolve(evidence,'replay.png')});
  check('three-real-opportunities-confirm-read-with-idempotent-lost-ack-retry');
  await page.reload(); await openSession();
  assert.equal((await snapshot()).exposureStates[key].exposureCount,3);
  assert.ok(await page.locator('[data-newscope-replay="true"]').count());
  check('reload-retains-confirmed-read-and-explicit-replay');
  } else report.skipped=['exposure-detail'];
  // Return to a fresh L0 pool; clicking one item must not instantly remove it in view.
  await forceFreshScenario('initial'); await ticker.hover();
  const hit=await ticker.evaluate(root=>{
    const r=root.getBoundingClientRect();
    return [...root.querySelectorAll('a')].map(a=>{const b=a.getBoundingClientRect();const left=Math.max(r.left,b.left),right=Math.min(r.right,b.right);return {key:a.closest('[data-newscope-key]').dataset.newscopeKey,x:(left+right)/2,y:(b.top+b.bottom)/2,width:right-left};}).find(x=>x.width>=160);
  }); assert.ok(hit);
  await context.route('https://ticker-qa.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Local QA article</title><p>Local fixture only.</p>'}));
  const clickAck=page.waitForResponse(r=>new URL(r.url()).pathname===eventPath && r.request().postDataJSON()?.events?.some(e=>e.type==='open')) ;
  const popupPromise=context.waitForEvent('page'); await page.mouse.click(hit.x,hit.y);
  const popup=await popupPromise; await popup.waitForLoadState(); await popup.close(); await page.bringToFront();
  await ticker.hover(); await page.waitForTimeout(650);
  const clicked=await (await clickAck).json();
  assert.equal(clicked.exposureStates[hit.key]?.read,true,JSON.stringify(clicked));
  assert.ok(!(await snapshot()).items.some(i=>i.articleKey===hit.key),'confirmed item is excluded from fresh unread projection');
  assert.ok(await page.locator('[data-newscope-key="'+hit.key+'"]').count(),'visible read item stays until safe exit');
  await page.locator('[contenteditable="true"],textarea').first().focus(); await page.mouse.move(0,0);
  await page.waitForFunction(key=>!document.querySelector('[data-newscope-key="'+key+'"]'),hit.key,{timeout:25000,polling:100});
  check('click-confirmation-retires-only-after-safe-exit');
  // A second real GUI tab shares Host truth, but the hidden first tab accrues nothing.
  const other=await context.newPage(); await other.goto(origin); await openSession(other);
  await other.locator('[data-newscope-ticker]').waitFor(); await other.bringToFront();
  await page.waitForFunction(()=>document.hidden); const multiAt=Date.now();
  await other.waitForTimeout(1800);
  assert.equal(report.events.filter(e=>e.tab==='A'&&e.at>multiAt).length,0);
  const version=(await snapshot()).readVersion;
  await other.close(); await page.bringToFront();
  assert.ok((await snapshot()).readVersion>=version);
  check('two-real-gui-tabs-share-read-state-without-hidden-exposures');
  // Manual test events drive exhaustion; production inventory and rendering stay real.
  await mark((await snapshot()).items.filter(i=>!i.replay));
  let state=await refreshView(); assert.equal(state.pool.tier,'L1'); assert.ok(state.items.every(i=>!i.replay));
  check('L0-exhaustion-selects-only-L1');
  await mark(state.items); state=await refreshView();
  assert.equal(state.pool.tier,'L2+replay'); assert.equal(state.items[0].replay,false); assert.ok(state.items.slice(1).every(i=>i.replay));
  await page.screenshot({path:resolve(evidence,'l2-replay.png')});
  check('L1-exhaustion-selects-L2-before-read-replay');
  await mark(state.items.filter(i=>!i.replay)); state=await refreshView(); assert.equal(state.pool.tier,'replay');
  await scenario('new-high-only'); await page.waitForTimeout(1200); state=await refreshView();
  assert.equal(state.pool.tier,'L0'); assert.equal(state.items.length,1); assert.equal(state.items[0].replay,false);
  check('low-water-requery-discovers-new-L0-and-preempts-replay');
  await scenario('outage'); await page.waitForTimeout(1200); await settings();
  await page.locator('[data-newscope-refresh-status]').click();
  await page.waitForFunction(()=>document.querySelector('[data-newscope-status="stale"]')?.textContent==='true');
  state=await snapshot(); assert.equal(state.service,'cache'); assert.equal(state.capabilities.source,'articles');
  await page.locator('[data-newscope-inventory-status]').scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(evidence,'stale.png')}); check('query-failure-keeps-stale-inventory-not-fake-RSS');
  await scenario('recovery'); await page.waitForTimeout(1200); await page.reload(); await settings();
  await page.waitForFunction(()=>document.querySelector('[data-newscope-status="service"]')?.textContent==='ok');
  check('query-recovery-restores-live-inventory');
  await forceFreshScenario('rss-only'); await settings();
  await page.locator('[data-newscope-warning="rss"]').waitFor();
  state=await snapshot(); assert.equal(state.capabilities.history,false); assert.equal(state.pool.tier,'L0');
  await page.locator('[data-newscope-inventory-status]').scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(evidence,'rss-limited.png')}); check('old-server-RSS-limitation-is-explicit');
  await forceFreshScenario('empty');
  await page.waitForFunction(()=>!document.querySelector('[data-newscope-ticker]'));
  assert.ok(await page.locator('[data-chat-running]').isVisible());
  assert.match(await page.locator('[data-chat-running]').innerText(),/用时|elapsed|Running/);
  await page.screenshot({path:resolve(evidence,'native-empty.png')}); check('empty-inventory-preserves-native-running-status');
  const audit=await fetch(fixture+'/__test/requests').then(r=>r.json());
  assert.equal(audit.noFeedFetch,true); assert.equal(audit.feedFetchRequests,0);
  assert.deepEqual(report.errors,[]); check('no-source-fetch-and-no-page-exceptions');
  report.passed=true;
} catch (error) {report.passed=false;report.failure=String(error);try{await page.screenshot({path:resolve(evidence,'failure.png')});}catch{}throw error;}
finally {
  if(sessionId) try {await rpc('session/cancel',{sessionId});} catch(error){report.cleanupError=String(error);}
  await fetch(model+'/__test/finish',{method:'POST'}).catch(()=>{});
  report.fixtureRequests=await fetch(fixture+'/__test/requests').then(r=>r.json()).catch(()=>null);
  report.finishedAt=new Date().toISOString();
  await writeFile(resolve(evidence,'report.json'),JSON.stringify(report,null,2));
  await browser.close();
}
