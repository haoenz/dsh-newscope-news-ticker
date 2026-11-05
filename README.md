# Newscope News Ticker for DSH

A DSH bundle that reads Newscope on the Host, schedules four
categories by exposure weights, and adds a continuously scrolling, clickable
ticker to the native Agent running row. It never appends Session events, sends
Agent messages or registers model tools. Optional title translation uses the DSH LLM
service and is disabled by default; provider credentials never enter the browser.
Optional cross-source semantic deduplication also uses the DSH LLM service and runs
before title translation.

See the [Chinese guide](<README.zh.md>) for configuration and operations. Settings are available under **Settings → Newscope News Ticker** and **Plugins → Installed → Newscope News Ticker → package detail or the `newscope-news-ticker` row**, using DSH `configForms` and explicit saves.

The read-aware inventory changes below are **Unreleased source changes**, not a claim that the running Host/Newscope has been upgraded or that real-browser acceptance has passed.

## Install from GitHub

Install a fixed release through the DSH Plugins page or CLI:

```bash
dsh plugin --profile web add 'git+https://github.com/<OWNER>/dsh-newscope-news-ticker.git#v1.2.0'
```

Before installation or migration, follow the safe-upgrade procedure below. After backing up a directory-linked development copy, remove that old bundle before installing its replacement; do not run two copies with the same plugin row and HTTP routes.

## Development

```bash
pnpm install
pnpm test
pnpm run check
```

## Data, pagination and boundaries

- The Host prefers `GET /api/v1/articles` and reads `GET /api/v1/status`. It queries **articles already stored and scored by Newscope**, never a source-fetch endpoint. Newscope still owns feeds, scheduled fetching, extraction, scoring, topics and feedback learning. The new read-only API changes Newscope source code, not that pipeline.
- The metadata API accepts `min_score` (0–10), `published_after` (exclusive RFC3339 lower bound), `limit` (1–100) and `cursor`; it returns `items` and `nextCursor` (null when exhausted), with string article IDs, title, URL, score, time, topics and feed metadata, not bodies or summaries.
- Pages use descending (published time, ID) keysets and an insertion high-water mark. Signed cursors bind the filters and become invalid after a Newscope restart; start a new traversal then. This is not snapshot isolation for concurrent edits/deletions.
- One scan retrieves the widest effective tier (default score ≥ 5, age ≤ 168 hours), in pages of 100, bounded by 50 pages/5000 articles, a 20-second deadline, 1 MiB/page and 10 MiB total. The former latest-100 RSS window is **not** the normal pagination limit. Preparing a snapshot for semantic deduplication/translation is still bounded to 100 candidates.
- **Only first-page 404/405/501** enables `/rss?min_score=...` fallback. RSS retains its latest-100 window: `capabilities.history=false`, L0 only, no full history relaxation or read replay. A pagination cap also sets `history=false` and `truncated=true` and conservatively uses L0 only. Timeouts, 500s and malformed pages are failures, not evidence of API absence or exhausted inventory.
- The browser uses same-origin plugin routes: `GET /plugins/dsh-newscope-news-ticker/news.json`, `POST /plugins/dsh-newscope-news-ticker/read-events` and the model catalog route. Newscope/provider credentials remain on the Host. No Session events, Agent messages or model tools are added.

## Persistent read state and visible exposure

An article becomes read after **3 qualified exposures by default**, once the Host persists the event. Clicking or middle-clicking can mark it read immediately; clicking is not required. The protocol also supports `manual` events; this does not imply a separate manual-marking UI.

A qualified exposure requires a foreground page, connected and visible DOM, viewport/overflow intersection, and a single copy’s visible width of at least `min(article width, 50% of ticker width, 160px)` continuously for at least 1000ms (sampled roughly every 100ms). Normal/cloned copies and multiple running rows share counting. At most one exposure per article per cycle; continuous visibility across cycles does not count again until all copies cease to qualify and a new full dwell completes. Hover/focus pauses scrolling but can still yield one real visible exposure. Hidden/background time does not count. This is a geometric opportunity to read, not proof of attention or detection of every overlay/window occlusion.

The Host stores authoritative counts, read reasons/times, aliases and `lastShownAt` in `${XDG_DATA_HOME:-~/.local/share}/dsh-newscope-news-ticker/read-state.json`, outside the disposable cache. Identity is namespaced to the Newscope instance; persistent URL/API-ID aliases preserve history across RSS/API transitions. Titles, translations, scoring and tier changes do not reset it. The browser’s `sessionStorage` holds only playback/delivery state, including pending event IDs across same-tab refreshes, not a second read database. Independent tabs can contribute independent exposures; they converge through Host snapshots, not real-time tab locking.

Only a validated Host acknowledgement confirms read state. Visible items are retired after all copies leave or at a real cycle boundary, preserving the article anchor. Older `readVersion` snapshots cannot undo newer confirmation. Replay items remain explicitly marked **↻ 重播** (Replay) and do not become unread again.

## Inventory settings and effective tiers

| Field | Default | Meaning / bounds |
| --- | --- | --- |
| `readAfterExposures` | 3 | Qualified exposures required; integer 1–100 |
| `minScore` / `maxAgeHours` | 7 / 48 | User’s L0 baseline; score 0–10, age 1–720 hours |
| `inventory.level1.minScore` / `inventory.level1.maxAgeHours` | 6 / 72 | L1 requested score/age; same score/age bounds |
| `inventory.level2.minScore` / `inventory.level2.maxAgeHours` | 5 / 168 | L2 requested score/age; same score/age bounds |
| `inventory.targetInventory` | 30 | Target display inventory, not a guarantee; integer 1–100 |
| `inventory.lowWatermark` | 10 | Query below this unread count; integer 0–100, effectively capped at target |
| `inventory.refillDebounceSeconds` | 30 | Single-flight low-water query debounce; integer 1–3600 seconds |
| `refreshMinutes` | 5 | Normal Host candidate-cache refresh; 1–1440 minutes |

Effective L1/L2 filters use the **minimum score and maximum age** of the preceding effective tier and that tier’s requested values. They can widen or equal, never tighten, and do not rewrite the saved L0 baseline.

1. Every snapshot starts at L0. Any L0 unread excludes L1; only zero L0 unread permits L1, and only zero L1 unread permits L2. Fewer than 30 items is not permission to lower quality.
2. Below 10 unread, the Host may bypass candidate TTL to query existing inventory, single-flight and debounced by 30 seconds. Without additions, normal refresh cadence resumes. Read consumption requests a replacement snapshot, not source fetching.
3. Only at L2, unread below target can be supplemented with read replay. Higher-quality tiers replay first; within a tier the least recently shown wins. A replay exposure updates `lastShownAt`, not the read threshold or read timestamp. New L0/L1 unread takes priority at the next snapshot.
4. No candidates means an empty ticker while the native running row remains. All-zero category weights suppress all display, including replay.

Snapshot status includes `pool.tier` (L0/L1/L2/L2+replay/replay/empty), `pool.effective` (the selected score/age filter, or widest attempted filter when empty), `pool.unreadCount` (the full selected candidate-tier count, **not** rendered item count), target/low-water values, `capabilities`, `queriedAt`, `readVersion` and `exposureStates`. Semantic deduplication or translation failures may reduce visible items without exhausting a higher tier. Effective policy and live inventory status are distinct from unsaved form edits.

## Failures and bounded delivery

- Query failure reuses a stale raw candidate superset with the **latest read state** reapplied; without one, the service is unavailable. Failure is not an empty pool and must not trigger speculative relaxation/replay.
- Missing read storage can initialize empty history; corrupt/schema-invalid/unreadable storage reports `read-state-unavailable`, never silently resets it. File-lock serialization and atomic replacement precede acknowledgement; failed writes do not fabricate read counts. A leftover lock requires an operator to confirm no owner is running before cleanup; it is not automatically stolen.
- Events are batched about once a second, at most 100 per request (64 KiB). Retryable network/15-second timeout/429/5xx/invalid-ACK failures reuse IDs with backoff capped at 30 seconds. Conflicting reuse of an ID for another type/key returns 409.
- Browser pending is bounded to 1000 events, 24 hours of retry eligibility and 5000 recent issued IDs. Queue overflow, expiry, terminal 4xx, closing a tab or unavailable storage can undercount. Memory-only retry and unload keepalive are best effort, not durable delivery guarantees.
- Host deduplication retains only the latest **10000 event IDs**. Reusing IDs within that retained window is idempotent, including response loss after commit; beyond it, duplicate suppression is not guaranteed. The 24-hour client window does not imply permanent or exactly-once delivery.

## Existing presentation and optional LLM features

Continuous title-only scrolling, original links, hover/keyboard-focus pause, light/dark and narrow layouts, and playback anchoring across running-row replacement and same-tab refresh remain available. `onlyWhenRunning=false` enables an idle composer dock; the ticker deliberately keeps scrolling regardless of the OS reduced-motion preference. Four-category exposure weights and configurable `topicMap`/`sourceMap` remain supported; a category shortage redistributes its allocation. `managementUrl` can provide a browser-reachable Newscope management address when the Host URL is loopback.

Optional `semanticDedupEnabled`/`semanticDedupModel` conservatively remove cross-source reports of the same specific event after local URL/GUID/title deduplication and before translation. Distinct events, opinions and material follow-ups should remain separate. The model returns groups; the existing highest-ranked representative is retained. Candidate/model caching, 100 candidates, 300 title characters and a 60-second request bound limit work; model failure falls back to local deduplication.

Optional `translationEnabled`/`translationModel` translate non-Chinese and mixed-language titles to Simplified Chinese through DSH’s model catalog and Host LLM service, without separate credentials. Blank translation model follows the DSH default; blank semantic model follows translation. Translation is bounded to 100 titles, 1000 source characters each, batches of 10 and a 60-second deadline. Persistent model/language-scoped title caching avoids redundant translation across restarts. Failed/non-Chinese output is withheld rather than falling back to English; changing models does not reuse the wrong model’s stale snapshot. Newscope classification remains independently configured.

## Safe upgrade and acceptance gate

1. **Before replacing anything**, back up the active DSH/plugin configuration, persistent read-state file and currently installed program/plugin artifacts (and the Newscope database before its schema initialization). Preserve their paths, versions and ownership for rollback. A Git checkout is not a backup of live state. Never delete read history to fix an upgrade.
2. Use an isolated **web-dev** profile/session, separate read-state data directory, and an isolated Newscope instance/database for validation. A different profile alone does not isolate the default read-state path: set an independent `XDG_DATA_HOME` for its Host process. Do not aim development tests at production writable state or run duplicate bundles with identical rows/routes.
3. The new Newscope API exists in **source** until a maintainer builds that revision, deploys the resulting program and restarts the intended Newscope instance. Review schema/index initialization against a database copy first. The old running binary can only provide restricted RSS fallback; editing source does not change it.
4. Update the intended DSH **Host/plugin installation and the affected Web build**, then refresh that GUI. A browser refresh alone does not update Host code; a Host update alone does not prove that new client/settings assets are served. Do not assume plugin hot reload unless the matching development build watcher is actually running.
5. In web-dev, verify real scrolling, three separate exposures, refresh/restart persistence, background/foreground changes, safe removal, tier exhaustion/recovery, replay labels, no-new-inventory behavior, failure recovery and multiple tabs. Inspect requests to confirm that no source-fetch endpoint is called. Automated DOM/API tests are not real-browser acceptance.
6. **Only after isolated validation and explicit user confirmation** may a maintainer publish/install a new fixed release and perform production service operations. The `v1.2.0` tag above is an installation example, not a release of these Unreleased changes; verify the chosen tag exists before installing. Keep backups for rollback; disabling/uninstalling removes ticker UI, styles and settings without making read-history deletion part of the procedure.

This documentation update does not start/restart services, deploy changes or record successful real-browser acceptance. See the [A delivery](<docs/stage-a-read-state-delivery.zh.md>), [B delivery](<docs/stage-b-browser-exposure-delivery.zh.md>), [C/D delivery](<docs/stage-c-d-inventory-delivery.zh.md>) and [verification record](<VERIFICATION.zh.md>) for scoped evidence; final acceptance must be recorded separately by the main agent.
