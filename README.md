# Newscope News Ticker for DSH

A DSH bundle that reads Newscope on the Host, schedules four
categories by exposure weights, and adds a continuously scrolling, clickable
ticker to the native Agent running row. It never appends Session events, sends
Agent messages, registers model tools, or invokes an LLM.

See `README.zh.md` for configuration and operations.

## Install from GitHub

Install a fixed release through the DSH Plugins page or CLI:

```bash
dsh plugin --profile web add 'git+https://github.com/<OWNER>/dsh-newscope-news-ticker.git#v1.0.0'
```

When migrating a directory-linked development copy, remove that old bundle first;
do not run two copies with the same plugin row and HTTP routes.

## Development

```bash
pnpm install
pnpm test
pnpm run check
```

The Host uses Newscope's `/rss?min_score=...` and `/api/v1/status`; the browser
uses only the same-origin plugin route. Newscope credentials never enter the
browser or DSH Session.
