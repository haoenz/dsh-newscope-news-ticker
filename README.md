# Newscope News Ticker for DSH

A DSH bundle that reads Newscope on the Host, schedules four
categories by exposure weights, and adds a continuously scrolling, clickable
ticker to the native Agent running row. It never appends Session events, sends
Agent messages or registers model tools. Optional title translation uses the DSH LLM
service and is disabled by default; provider credentials never enter the browser.
Optional cross-source semantic deduplication also uses the DSH LLM service and runs
before title translation.

See the [Chinese guide](<README.zh.md>) for configuration and operations. Settings are available under **Settings → News Ticker** and **Plugins → Installed → Newscope News Ticker → package detail or the `newscope-news-ticker` row**, using DSH `configForms` and explicit saves.

The source and tagged releases below do not imply that the running Host/Newscope has been upgraded or that real-browser acceptance has passed.

## Install from GitHub

Install a fixed release through the DSH Plugins page or CLI:

```bash
dsh plugin --profile web add 'git+https://github.com/<OWNER>/dsh-newscope-news-ticker.git#v1.2.1'
```

Before installation or migration, follow the safe-upgrade procedure below. After backing up a directory-linked development copy, remove that old bundle before installing its replacement; do not run two copies with the same plugin row and HTTP routes.

## Development

```bash
pnpm install
pnpm test
pnpm run check
```

## Settings

Open **Settings → News Ticker**, or use the package/row configuration on the installed Plugins page. Valid changes are saved automatically and applied immediately; there is no Save button. **Show news ticker** has three levels: **Off**, **While Agent is running**, and **Always**. Always additionally mounts the ticker at the end of the chat flow while idle. Every mode uses the same content column, scrolls away with the page, pauses outside the viewport, and resumes at the saved offset. The setting is stored as the single `displayMode` field; the former two boolean fields are intentionally removed during development.

### When a running-only ticker becomes idle

For `displayMode=running`, `runningIdleBehavior` selects **hide immediately (`hide`, default)**, **hide after a delay (`delay`)**, or **stay visible but stop scrolling (`pause`)**. `runningIdleDelaySeconds` accepts 1–300 seconds and defaults to 5. Delay mode moves the ticker to the end of the chat flow and keeps scrolling until the deadline. Pause mode leaves a static ticker only after an actual run and resumes on the next run; initial idle alone does not create one.

### Newscope feedback

Hover or keyboard-focus an article to reveal 👍 / 👎; controls remain visible on touch devices. A same-origin Host route resolves `articleKey` to the candidate's numeric `newscopeId` and calls the original `POST /api/v1/feedback/{id}/like|dislike` endpoint. RSS-only articles without a resolved ID expose disabled controls with an explanation. Newscope's native feedback updates score and preferences. Successful feedback also persists a `manual` read on the Host with zero required exposures; the client retires it only after validating the read acknowledgement. Failed feedback or read-state persistence never fabricates a read. Current/pending actions are disabled, concurrent identical operations share one upstream write, and successful state is retained in candidate metadata or read from original HTML active states. No source feed fetch is triggered.

## Data, pagination and boundaries

- **Original Newscope is supported without deploying a fork or the new JSON API.** The compatibility path uses RSS plus a persistent candidate inventory, with on-demand read-only HTML pagination. Inventory paths query articles already stored/scored by Newscope and never trigger source fetching or open its SQLite database. Explicit user feedback is the only write path and delegates to Newscope's native score/preference pipeline; it does not change scheduler or feed configuration.
- The Host probes the optional `GET /api/v1/articles` API first. Only **first-page 404/405/501** selects RSS compatibility; that unsupported result is cached in memory for 15 minutes, then a later query can probe again and upgrade. Authentication failures (401/403), 503s, timeouts and malformed JSON are failures, not proof of API absence or exhausted inventory. `GET /api/v1/status` is optional health/version information.
- RSS uses `/rss?min_score=...` with the widest effective L2 score (default 5), filters by the widest age window (default 168 hours), and merges metadata into the persistent inventory. A feed's latest-100 window is **not** the whole known inventory. Known candidates support L0/L1/L2 and read replay; RSS does not imply L0-only operation.
- On first collection, low unread inventory or a tier below L0, the Host may supplement from `GET /articles?score=...&sort=published&page=N`. **HTML uses `score`, not RSS/API's `min_score`.** Attempts for the same source/window are at least 60 seconds apart, including failures. HTML is bounded to 20 pages, 2000 scanned unique IDs, 1 MiB/page, 8 MiB total and 8 seconds, within the inventory network traversal's 20-second deadline. Unknown/login/broken HTML is not an empty result: failed supplementation retains RSS plus collected candidates with warnings; a failure after validated pages can retain those pages as partial coverage.
- The optional metadata API accepts `min_score`, exclusive RFC3339 `published_after`, `limit` (1–100) and `cursor`, returning `items` and `nextCursor`. It uses descending time/ID keysets with an insertion high-water mark, not snapshot isolation for edits/deletions; signed cursors expire on Newscope restart. Scans are bounded to 50 pages/5000 articles, 1 MiB/page, 10 MiB total and 20 seconds. A complete query window is authoritative for that response: old local candidates are not unioned back to resurrect remotely removed articles. A capped, partial traversal may use known-local inventory for relaxation/replay, but cannot prove remote exhaustion. Model preparation remains bounded to 100 candidates.
- HTML page-number pagination is **best effort**: concurrent inserts/deletions may cause missed items even when the observed list ends. Known inventory can also retain a deleted or re-scored remote article until it is observed again or expires locally. Neither mode proves all remote high-tier unread articles are exhausted.
- The browser uses same-origin plugin routes: `GET /plugins/dsh-newscope-news-ticker/news.json`, `POST /plugins/dsh-newscope-news-ticker/read-events` and the model catalog. Credentials remain on the Host; no Session events, Agent messages or model tools are added.

### Persistent candidate inventory

The candidate store is separate from read history, in `candidate-inventory.json` beside `read-state.json` (normally under `${XDG_DATA_HOME:-~/.local/share}/dsh-newscope-news-ticker/`). It retains sanitized article metadata and URL/API identity aliases, not bodies or a second set of read counts. Limits are **5000 articles and 20 MiB for the entire file across all source namespaces**. Retention is `min(31 days, max(8 days, widest effective window + 24 hours))`, based on article publication time; capacity pressure evicts older entries sooner. Directory permissions are 0700 and file permissions 0600, with independent locking and atomic replacement.

Corrupt/schema-invalid/unreadable candidate storage reports `candidate-state-unavailable`; it is not silently cleared or treated as empty, and is distinct from `read-state-unavailable`. Preserve the damaged file and use explicit operator recovery, not automatic deletion. On restart during a remote outage, valid retained candidates can serve a **stale known-local** response with current read state reapplied. `firstCollectedAt` is when this plugin began collecting for the source, **not the beginning of complete history**. See the [original-Newscope compatibility implementation notes](<docs/original-newscope-compatibility.zh.md>) for precise scope and recovery boundaries.

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

1. Every snapshot starts at L0 within its reported inventory scope. In known-local mode, exhaustion refers only to collected candidates, not all remote articles. Any L0 unread excludes L1; only zero L0 unread permits L1, and only zero L1 unread permits L2. Fewer than 30 items is not permission to lower quality.
2. Below 10 unread, the Host may bypass candidate TTL to query existing inventory, single-flight and debounced by 30 seconds. Without additions, normal refresh cadence resumes. Read consumption requests a replacement snapshot, not source fetching.
3. Only at L2, unread below target can be supplemented with read replay. Higher-quality tiers replay first; within a tier the least recently shown wins. A replay exposure updates `lastShownAt`, not the read threshold or read timestamp. New L0/L1 unread takes priority at the next snapshot.
4. No candidates means an empty ticker while the native running row remains. All-zero category weights suppress all display, including replay.

Snapshot status includes `pool.tier` (L0/L1/L2/L2+replay/replay/empty), `pool.effective` (the selected score/age filter, or widest attempted filter when empty), `pool.unreadCount` (the full selected candidate-tier count, **not** rendered item count), target/low-water values, `capabilities`, `queriedAt`, `readVersion` and `exposureStates`. Semantic deduplication or translation failures may reduce visible items without exhausting a higher tier. Effective policy and live inventory status are distinct from unsaved form edits. Status also exposes `inventoryScope` (`remote-window`/`known-local`), `remoteWindowComplete`, `coverage` (`queried-window`/`best-effort`/`partial`/`rss-window`), `localInventory`, source (`articles`/`rss`/`rss+html`/`local`) and text-escaped warnings. `history` means usable known history, not remote completeness. `remoteWindowComplete=true` means only a completed JSON query window, never a fixed whole-database snapshot. Optional `inventoryStore` reports source-specific `retainedCount`, `firstCollectedAt`, `updatedAt`, and numeric `pruned` (global evictions in that operation). Missing legacy fields display Unknown; the UI does not infer completeness.

## Failures and bounded delivery

- Query failure can reuse stale in-memory or durable known candidates with the **latest read state** reapplied; without usable candidates, the service is unavailable. Any relaxation/replay remains scoped to the available inventory. Failure itself never proves remote emptiness or high-tier exhaustion.
- Missing read storage can initialize empty history; corrupt/schema-invalid/unreadable storage reports `read-state-unavailable`, never silently resets it. File-lock serialization and atomic replacement precede acknowledgement; failed writes do not fabricate read counts. A leftover lock requires an operator to confirm no owner is running before cleanup; it is not automatically stolen.
- Events are batched about once a second, at most 100 per request (64 KiB). Retryable network/15-second timeout/429/5xx/invalid-ACK failures reuse IDs with backoff capped at 30 seconds. Conflicting reuse of an ID for another type/key returns 409.
- Browser pending is bounded to 1000 events, 24 hours of retry eligibility and 5000 recent issued IDs. Queue overflow, expiry, terminal 4xx, closing a tab or unavailable storage can undercount. Memory-only retry and unload keepalive are best effort, not durable delivery guarantees.
- Host deduplication retains only the latest **10000 event IDs**. Reusing IDs within that retained window is idempotent, including response loss after commit; beyond it, duplicate suppression is not guaranteed. The 24-hour client window does not imply permanent or exactly-once delivery.

## Existing presentation and optional LLM features

Continuous title-only scrolling, original links, hover/keyboard-focus pause, light/dark and narrow layouts, and playback anchoring across running-row replacement and same-tab refresh remain available. The three-level display setting controls off/running-only/always visibility; the ticker deliberately keeps scrolling regardless of the OS reduced-motion preference. Four-category exposure weights and configurable `topicMap`/`sourceMap` remain supported; a category shortage redistributes its allocation. `managementUrl` can provide a browser-reachable Newscope management address when the Host URL is loopback.

Optional `semanticDedupEnabled`/`semanticDedupModel` conservatively remove cross-source reports of the same specific event after local URL/GUID/title deduplication and before translation. Distinct events, opinions and material follow-ups should remain separate. The model returns groups; the existing highest-ranked representative is retained. Candidate/model caching, 100 candidates, 300 title characters and a 60-second request bound limit work; model failure falls back to local deduplication.

Optional `translationEnabled`/`translationModel` translate non-Chinese and mixed-language titles to Simplified Chinese through DSH’s model catalog and Host LLM service, without separate credentials. Blank translation model follows the DSH default; blank semantic model follows translation. Translation is bounded to 100 titles, 1000 source characters each, batches of 10 and a 60-second deadline. Persistent model/language-scoped title caching avoids redundant translation across restarts. Failed/non-Chinese output is withheld rather than falling back to English; changing models does not reuse the wrong model’s stale snapshot. Newscope classification remains independently configured.

## Safe upgrade and acceptance gate

1. **Before replacing anything**, back up the active DSH/plugin configuration, persistent read-state and candidate-inventory files and currently installed program/plugin artifacts (and the Newscope database before its schema initialization). Preserve their paths, versions and ownership for rollback. A Git checkout is not a backup of live state. Never delete read history to fix an upgrade.
2. Use an isolated **web-dev** profile/session, separate read-state data directory, and an isolated Newscope instance/database for validation. A different profile alone does not isolate the default read-state path: set an independent `XDG_DATA_HOME` for its Host process. Do not aim development tests at production writable state or run duplicate bundles with identical rows/routes.
3. **No Newscope fork/build/deployment is required for original-version RSS + candidate inventory + HTML compatibility.** The new JSON API is optional; choosing it later is a separate, explicitly approved build/deployment/restart operation, with schema/index review against an isolated database copy. Editing source does not change the running program. Development verification must not read the production database.
4. Update the intended DSH **Host/plugin installation and the affected Web build**, then refresh that GUI. A browser refresh alone does not update Host code; a Host update alone does not prove that new client/settings assets are served. Do not assume plugin hot reload unless the matching development build watcher is actually running.
5. In web-dev, verify real scrolling, three separate exposures, refresh/restart persistence, background/foreground changes, safe removal, tier exhaustion/recovery, replay labels, no-new-inventory behavior, failure recovery and multiple tabs. Inspect requests to confirm that no source-fetch endpoint is called. Automated DOM/API tests are not real-browser acceptance.
6. **Only after isolated validation and explicit user confirmation** may a maintainer publish/install a new fixed release and perform production service operations. The `v1.2.1` tag above is an installation example; verify the chosen tag exists before installing. Keep backups for rollback; disabling/uninstalling removes ticker UI, styles and settings without making read-history deletion part of the procedure.

This documentation update does not start/restart services, deploy changes or record successful real-browser acceptance. See the [A delivery](<docs/stage-a-read-state-delivery.zh.md>), [B delivery](<docs/stage-b-browser-exposure-delivery.zh.md>), [C/D delivery](<docs/stage-c-d-inventory-delivery.zh.md>) and [verification record](<VERIFICATION.zh.md>) for scoped evidence; final acceptance must be recorded separately by the main agent.
