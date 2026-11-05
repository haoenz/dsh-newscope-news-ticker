# Changelog

## Unreleased

These source changes passed isolated web-dev validation (17 real-browser checks, 150 automated tests) and still require explicit user approval for production deployment. No production service was restarted and no version bump is included. See the [verification record](<VERIFICATION.zh.md>).

- Add Host-persisted exposure/read history with stable instance-scoped article identity and RSS URL/API-ID aliases. Default to read after three qualified visible exposures; opening can mark read immediately without being required.
- Detect foreground clipped-viewport dwell, coalesce normal/cloned copies and running rows, batch same-origin read events, and preserve pending IDs/playback across same-tab refreshes. Confirm only persisted Host state; safely retire visible articles and reject stale read-version snapshots.
- Prefer the new Newscope read-only metadata pagination API with stable keysets and bounded scans, instead of treating the latest 100 RSS items as complete inventory. Only first-page 404/405/501 falls back to RSS; RSS or capped scans report limited history and use L0 only, without history relaxation/replay. Query failures remain distinct from empty inventory.
- Add dynamic L0/L1/L2 unread priority (default 7/48h, 6/72h, 5/168h), with read replay only when L2 unread is below target. Replay is explicitly labeled, updates last-shown time without resetting read history, and yields to new higher-tier unread.
- Add `readAfterExposures` and nested `inventory` policy fields: target 30, low watermark 10, query debounce 30 seconds, and configurable L1/L2 filters. Effective tiers only widen the previous tier; saved L0 is unchanged. Expose tier/filter/count/capability/query-time metadata; candidate unread counts are not rendered counts.
- Low-water refill only queries articles already stored by Newscope, single-flight and debounced. It never triggers source fetching or changes the scheduler, feed configuration, extraction or scoring pipeline.
- Retain translation, conservative semantic deduplication, category weighting and presentation behavior. Bound model preparation separately from pagination; translation failure must not masquerade as higher-tier exhaustion.
- Document failure handling and finite guarantees: latest 10000 Host event IDs, browser pending 1000 events/24 hours and 5000 recent IDs, best-effort unload delivery, and no permanent exactly-once claim. Corrupt read storage is an explicit failure, never a silent empty-history reset.
- Document safe upgrades: back up configuration, read state and current program; build/deploy/restart Newscope for its new API, update the DSH Host/plugin and affected Web artifacts before refreshing, validate isolated web-dev first, then obtain user confirmation for production. Documentation changes do not perform service operations.

## 1.2.0 - 2026-11-05

- Place the ticker above the native Agent running line and above the composer while idle, and show only article titles without category or source metadata.
- Preserve ticker playback position across Agent running-row replacements and same-tab page refreshes, with throttled `sessionStorage` persistence and no cross-tab interference.
- Decode numeric, hexadecimal and named HTML entities in RSS titles before scoring, deduplication and translation, preventing raw `&#39;`/`&#34;` text in the ticker.
- Scrolling now always ignores the OS/browser reduced-motion preference instead of disabling the plugin's main feature.
- Flatten locale dictionaries for DSH's dot-key lookup and serve the native DSH model catalog through a same-origin Host `models.json` endpoint.
- Offer translation and semantic-dedup model pickers populated from the DSH model catalog, with legacy routes preserved and blank settings dynamically resolved through `agentDefaultModel`.
- Isolate client translations from plugin metadata so settings render localized natural-language labels instead of raw `settings.*` keys.
- Expose the same native settings form in DSH Settings, on the package detail page and on the plugin-row page, wired to DSH `configForms` with staged saves, validation and revision-checked writes.
- Optional conservative cross-source semantic deduplication through the DSH LLM service.
- Native `semanticDedupEnabled` and `semanticDedupModel` settings, with optional reuse of `translationModel`.
- Existing local dedup runs first; semantic grouping keeps the highest-ranked existing representative and runs before translation.
- Candidate-set caching, bounded model input and fail-open fallback to local dedup results.
- Shared provider-neutral DSH JSON stream assembly for translation and semantic tasks.

## 1.1.0 - 2026-11-05

- Optional Simplified Chinese title translation through the DSH LLM service.
- A native `translationModel` setting accepts a DSH `provider/model` route without separate endpoint or credential configuration.
- Persistent title translations with file locking and write-time merging across concurrent instances.
- Chinese-dominant output validation, bounded translation work and strict DSH stream termination checks.
- No English fallback on failure; in-flight and stale Host snapshots are scoped to the exact translation configuration.

## 1.0.0 - 2026-11-05

- Newscope Host-side RSS/status integration with a same-origin browser route.
- Fresh cache, stale-cache fallback and native-status fallback without news.
- Score/age filtering, URL/GUID/near-title deduplication and configurable category maps.
- Weighted finance/technology/science/general scheduling with shortage redistribution.
- Continuous accessible ticker, hover/focus pause, original-article links and reduced-motion mode.
- Native DSH Config settings and Newscope management entry.
