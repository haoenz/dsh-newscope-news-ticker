// Opt-in only: real unmodified upstream handlers + test-only in-memory fixture on 8082.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NewsCache } from '../lib/index.js';
import { CandidateStore } from '../lib/candidate-store.js';
import { ReadStateStore } from '../lib/read-state.js';
assert.equal(process.env.QA_ORIGINAL_SERVER, '1', 'Explicit isolated acceptance opt-in required');
const source = 'http://127.0.0.1:8082';
const version = await fetch(source + '/api/v1/status').then(r => r.json());
assert.equal(version.version, 'ticker-original-acceptance', 'Refuse a real database');
const tmp = await mkdtemp(join(tmpdir(), 'ticker-original-http-'));
const evidence = resolve('.dsh-dev/original-evidence');
await mkdir(evidence, { recursive: true });
const report = { source, sourceRevision: '9c02bfa', startedAt: new Date().toISOString(), checks: [] };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const scenario = async name => {
  const response = await fetch(source + '/__test/scenario', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  assert.equal(response.ok, true); return response.json();
};
let now = Date.now() + 500;
const config = { newscopeUrl: source, translationEnabled: false, semanticDedupEnabled: false,
  inventory: { targetInventory: 4, lowWatermark: 2, refillDebounceSeconds: 1 } };
const make = (suffix = '') => {
  const candidates = new CandidateStore({ file: join(tmp, 'candidates' + suffix + '.json'), now: () => now });
  const reads = new ReadStateStore({ file: join(tmp, 'reads' + suffix + '.json'), now: () => now });
  const cache = new NewsCache(fetch, { candidateStore: candidates, readState: reads, now: () => now });
  return { candidates, reads, cache };
};
const mark = async (reads, items) => {
  for (let i = 0; i < items.length; i += 100) await reads.recordEvents(items.slice(i, i + 100).map(item => ({
    type: 'manual', eventId: crypto.randomUUID(), articleKey: item.articleKey,
  })));
};
try {
  assert.equal((await fetch(source + '/api/v1/articles')).status, 404);
  check('upstream-has-no-new-JSON-API');
  await scenario('history'); now = Date.now() + 500;
  let h = make();
  let state = await h.cache.snapshot(config);
  assert.equal(state.service, 'ok', state.error);
  assert.equal(state.capabilities.source, 'rss+html', JSON.stringify(state.warnings));
  assert.equal(state.capabilities.inventoryScope, 'known-local');
  assert.equal(state.capabilities.remoteWindowComplete, false);
  assert.equal(state.inventoryStore.retainedCount, 130);
  assert.equal(state.supplement.pages, 3);
  assert.equal(state.pool.tier, 'L0'); assert.equal(state.items.length, 3);
  check('real-RSS-plus-three-HTML-pages-recover-130-candidates-beyond-latest-100');
  await mark(h.reads, state.items); state = await h.cache.snapshot(config);
  assert.equal(state.pool.tier, 'L1'); await mark(h.reads, state.items);
  state = await h.cache.snapshot(config); assert.equal(state.pool.tier, 'L2');
  const all = await h.candidates.snapshot(source, { now });
  const known = await h.reads.present(all.articles, { source, includeRead: true, trustedAliases: all.aliasesByKey });
  await mark(h.reads, known.items.filter(item => !known.exposureStates[item.articleKey].read));
  state = await h.cache.snapshot(config); assert.equal(state.pool.tier, 'replay'); assert.ok(state.items.every(item => item.replay));
  check('real-original-data-support-L0-L1-L2-and-explicit-read-replay');
  await scenario('new-high-only'); now += 61_000;
  state = await h.cache.snapshot(config); assert.equal(state.pool.tier, 'L0'); assert.equal(state.items.length, 1); assert.equal(state.items[0].score, 10);
  check('new-high-priority-RSS-item-preempts-local-replay');
  await scenario('outage'); now += 31_000;
  state = await h.cache.snapshot(config); assert.equal(state.stale, true); assert.equal(state.service, 'cache');
  h = make(); state = await h.cache.snapshot(config);
  assert.equal(state.capabilities.source, 'local'); assert.equal(state.stale, true); assert.equal(state.items.length, 1);
  assert.equal(state.inventoryStore.retainedCount, 131);
  check('restarted-Host-cache-restores-durable-known-inventory-during-real-HTTP-outage');
  await scenario('empty'); now += 31_000;
  state = await h.cache.snapshot(config); assert.equal(state.service, 'ok'); assert.equal(state.items.length, 1);
  check('empty-remote-RSS-does-not-erase-collected-history');
  const fresh = make('-empty'); state = await fresh.cache.snapshot(config);
  assert.equal(state.service, 'ok', state.error); assert.equal(state.items.length, 0); assert.equal(state.pool.tier, 'empty');
  assert.equal(state.capabilities.source, 'rss+html', JSON.stringify(state.warnings));
  check('genuine-empty-original-HTML-is-recognized-with-no-candidate-history');
  const audit = await fetch(source + '/__test/requests').then(r => r.json());
  assert.equal(audit.noFeedFetch, true); assert.equal(audit.feedFetchRequests, 0);
  report.audit = audit; check('no-feed-fetch-or-extraction'); report.passed = true;
} catch (error) { report.passed = false; report.failure = String(error); throw error; }
finally {
  await scenario('initial');
  report.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, 'http-report.json'), JSON.stringify(report, null, 2));
  assert.ok(tmp.startsWith(join(tmpdir(), 'ticker-original-http-')));
  await rm(tmp, { recursive: true, force: true });
}
