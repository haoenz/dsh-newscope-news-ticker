# 原版 Newscope 兼容：实现说明与边界

## 状态与约束

本文记录当前 Unreleased 源码实现，不是部署记录或验收结论。最终自动化测试总数与真实浏览器验收仍在进行，不在此提前声明通过。历史证据保留在[验收记录](<../VERIFICATION.zh.md>)，不能自动延伸为本次兼容路径的通过证明。

**默认支持未修改的原版 Newscope，不要求部署 fork 或新增 JSON API。** 原版通过 RSS + 插件持久候选库工作，必要时只读补查 HTML 历史。新 JSON API 是可选增强。所有远端请求只查询 Newscope 已有库存；不触发源站抓取，不修改 scheduler、feed、抽取或评分流程。实现不直接打开 Newscope 数据库；本次工作不得读取生产数据库，不进行正式服务重启/部署，不创建 tag/release。

源码依据：[Host 协调](<../lib/index.js>)、[查询适配](<../lib/newscope-query.js>)、[HTML 解析与分页](<../lib/newscope-html.js>)、[候选持久化](<../lib/candidate-store.js>)、[库存选择](<../lib/inventory.js>)、[客户端状态](<../client.js>)。

## 1. 查询路径与能力探测

1. 新进程或探测缓存过期时，先尝试只读 JSON 元数据 API：`GET /api/v1/articles`。
2. 仅其**首屏 404/405/501** 判定本次不支持，选择 RSS 兼容路径。该结果按 Newscope 来源在 Host 内存缓存 **15 分钟**；缓存期内不重复探测，到期后的实际查询可以重新探测并升级到 JSON API。不是每 15 分钟强制发一个请求，也不是永久降级。
3. 401/403/503、超时、网络错误、格式错误不能伪装成“不支持”；中途分页错误也不重新解释成首屏能力缺失。故障由 stale/错误路径呈现，绝非空库存或远端高档耗尽证据。
4. 原版路径读取 `GET /rss?min_score=...`：评分使用最宽有效 L2 的下限，默认 5；年龄过滤使用最宽有效窗口，默认 168 小时。原版 RSS 最新 100 条仅是本次来源窗口。
5. RSS 元数据先合并进候选库，再根据已知库存与最新已读状态判断是否需要 HTML 补查。候选库中更早采集的文章不因跌出 RSS 最新窗口就立即消失。
6. `GET /api/v1/status` 是可选版本信息，失败不影响已获得的候选，不触发源站抓取。

所有 HTTP URL 均由配置来源和固定只读路径生成；HTML 不跟随页面中的任意动作链接，不调用反馈/抓取操作。HTML 上的反馈按钮只参与结构/身份校验，绝不执行 POST。

## 2. HTML 仅按需补历史

### 触发与限流

在原版路径，RSS 合并后的已知库存满足任一条件时可补查：

- 读取前该来源尚无保留候选（首次/空本地库存）；
- 当前选择档位未读数小于配置低水位；
- 当前档位不为 L0，涉及降档、重播或空库存。

同一来源与最宽筛选窗口的尝试至少相隔 **60 秒**，失败同样计入。该节流在 Host 进程内保存，重启会重建；改变最宽筛选窗口属于不同键。它与普通缓存刷新（默认 5 分钟）及低水位查询防抖（默认 30 秒）是不同机制。不是每次 UI 状态轮询都重扫 HTML。

### 请求及预算

`GET /articles?score=<最宽有效评分>&sort=published&page=N`，页码从 1 开始，并发送 `HX-Request: true` 和 `Accept: text/html`。

**HTML 使用 `score`，不是 RSS/JSON 的 `min_score`。** 本地仍再核对评分与时效，不因上游忽略筛选参数而放宽配置。

| 约束 | 默认实现上限 |
| --- | --- |
| HTML 页数 | 20 页 |
| 扫描身份 | 2000 个唯一文章 ID；不是只计最后通过评分的文章 |
| 单页响应 | 1 MiB |
| HTML 累计响应 | 8 MiB |
| HTML 扫描总时间 | 8 秒 |
| API/RSS/HTML 库存网络遍历 | 共用 20 秒 deadline |
| JSON 分页 | 每页 100 条，最多 50 页/5000 条，1 MiB/页、10 MiB 总量 |

20 秒不是整条插件请求的完成承诺：独立可选状态读取、持久化锁/写盘、语义去重和翻译有各自边界。RSS 文本读取也有 5 MiB 响应上限。达到页数/扫描身份/响应预算、重复页、无进展或中途异常，均不能宣称远端已耗尽。

### 解析与失败

解析针对原版已知模板，不是通用网页抓取器。需要匹配文章容器、列表、分页、计数和明确空状态；文章卡需有一致的字符串 ID、评分、原文 HTTP(S) URL、标题、合法时间和 feed。拒绝登录页、未知布局、不完整/矛盾结构、非法 URL/日期、不受支持的响应类型和跳转。原版 Go 的 HX 片段实测可能标为 `text/plain`，因此允许 `text/html` 或 `text/plain`，二者都必须通过同一严格 HTML 结构验证，不能把普通文本/登录页当库存。只提取受限元数据，忽略脚本/样式/template 内容，不持久化正文、摘要、评分解释。

- 首个页面无效：补查失败，保留 RSS + 已知候选，增加 warning，不将未知页面当作零条文章。
- 已验证页面后失败：可保留已验证元数据，返回 partial/截断与 warning。
- 扫到列表结尾或时间边界：Host 标为 `best-effort`，**不是**远端完整证明。
- 页码/offset 分页期间并发插入或删除会移动页面，可能重叠或漏项。去重能消除已见重复，不能发现所有未见遗漏；即使没有检测到重叠，也不能证明无漏项。

## 3. 独立持久候选库

默认文件为 `${XDG_DATA_HOME:-~/.local/share}/dsh-newscope-news-ticker/candidate-inventory.json`，与持久已读文件 `read-state.json` 同目录，独立锁与原子替换。Host 使用独立已读目录时，候选库也跟随该目录；开发隔离必须设置独立 `XDG_DATA_HOME`，不能只换 profile。

- **整文件跨来源合计**最多 5000 条、20 MiB，不是每个来源各有此额度。
- 保留窗口为 `min(31 天, max(8 天, 最宽有效窗口 + 24 小时))`，按文章发布时间淘汰；容量紧张还可提前淘汰最旧条目，故不保证完整保留整个时间窗。
- 目录权限 0700、文件及临时/锁文件 0600；独立文件锁串行合并，临时文件写入同步后原子替换，失败不发布未提交的内存状态。
- 保存文章元数据、来源命名空间与 URL/API-ID 身份别名，不复制正文、API凭证或已读计数。再次观察文章时更新元数据，RSS 不覆盖已经获得的 API 身份。
- 文件不存在可以初始化新库；损坏 JSON、非法 schema、不可读/写等候选持久化问题返回 `candidate-state-unavailable`，**不是空库存，也不是 `read-state-unavailable`**。
- 损坏文件不能自动覆盖或静默清空；应保留并由维护者明确恢复备份，或在理解会失去已知候选后显式隔离故障文件。不要用删除已读历史修复候选故障。
- 崩溃残留锁不按年龄自动抢占；确认无活跃写入者后才由维护者处理。本文不执行任何清理或恢复操作。

保留候选是“最近曾观察到的元数据”，不是远端镜像。来源删除文章或改分后，旧元数据可能滞后直到再次观察或本地过期；缺失于某次 RSS 窗口不等同于删除。

## 4. 库存范围、完整窗口与重启故障

### known-local：原版、部分分页与故障恢复

RSS + 持久库、RSS + HTML、部分 JSON 分页都能在**已知候选范围**执行 L0/L1/L2 和已读重播。先耗尽较高档已知未读再放宽；未读少于目标不是提前降档的许可。重播仍保留已读身份，不重新变未读。

这里“L0 耗尽”只指本插件当前可用候选，无法证明远端还有没有未采集高档未读。HTML 的尽力补齐能增加已知候选，但不能把局部视图变成完整远端历史。

Host 重启后即使远端故障，也可读取合法持久候选作为 `source=local`、`inventoryScope=known-local`、`coverage=partial` 的 stale 响应，重新应用最新已读状态并说明故障。没有可用候选时返回 unavailable，而不是声称远端确实为空。

### remote-window：可选完整 JSON 查询

完整 JSON 分页遍历所查询的评分/时间窗口时，该次响应以远端查询结果为准，**不与旧本地候选求并集**，避免把远端已删除或不再匹配的文章带回当次展示。采集到的元数据仍可留作以后故障/兼容路径使用，不意味着本地档案是删除同步镜像。

`remoteWindowComplete=true` 仅描述该 JSON 分页查询窗口；不是整个 Newscope 数据库的恒定快照，也不保证并发修改/删除下的快照隔离。新增 JSON API 完全可选；部署它是后续独立授权操作，不能作为原版兼容的前置条件。

## 5. 响应字段与 UI 语义

| 字段 | 含义 |
| --- | --- |
| `capabilities.inventoryScope` | `remote-window` 或 `known-local` |
| `capabilities.remoteWindowComplete` | 仅完整 JSON 查询窗口为 true |
| `capabilities.coverage` | `queried-window`、`best-effort`、`partial`、`rss-window` |
| `capabilities.localInventory` | 是否具备本地候选库存能力 |
| `capabilities.source` | 正常候选来源为 `articles`、`rss`、`rss+html`、`local`；故障响应可另有 unavailable 状态 |
| `capabilities.history` | 可用已知历史，不代表远端完整性；兼容旧响应 |
| `inventoryStore.retainedCount` | 当前来源保留候选数，不是远端总量或页面展示数 |
| `inventoryStore.firstCollectedAt` | 本插件开始采集该来源时间，不是完整历史起点 |
| `inventoryStore.updatedAt` | 候选库中该来源更新时间 |
| `inventoryStore.pruned` | 本次操作全局淘汰候选数，非负整数，不是 boolean |
| `warnings` | 可选字符串数组，客户端以 React 文本转义显示 |

旧 payload 缺失新增字段时显示未知，不能猜测 complete。旧 `history:false` 保留兼容提示，但不推广成“RSS 一律只有 L0”。`source` 以 rss 开头时（含 rss+html）统一显示 RSS/已知库存说明。partial、截断、HTML best-effort 和 known-local 的限制均明确呈现。

UI 显示库存范围、覆盖程度、候选数与首次采集时间。ticker 只在 title/aria-label 附加 scope，不加遮挡几何 badge；本次兼容工作不改变曝光资格、共享 clock 或 readEvents 投递语义。

## 6. 原版隔离验收复现

测试基线为本次新增 JSON API 之前的原版源码 `9c02bfa`，不是通过在修改版上模拟 404 来证明兼容。将该版本 `git archive` 解包到**新建的临时目录**（含其受版本管理的 vendor），只复制[测试专用夹具](<../test/fixtures/original-newscope-server_test.go>)到临时副本的 `server/ticker_acceptance_test.go`；不改原版任何生产源码，不引用真实数据库。Go 1.26+ 执行：

```sh
DSH_TICKER_QA_PORT=8082 GOTOOLCHAIN=local GOPROXY=off \
  go -C "$QA_SRC" test -mod=vendor ./server \
  -run "^TestTickerBrowserAcceptanceServer$" -count=1 -v -timeout=0
```

`QA_SRC` 必须是已确认的独立临时副本。夹具只允许 8082，使用 SQLite `:memory:`、禁用 feed、mock scheduler；版本固定为 `ticker-original-acceptance`，原版不存在新 JSON API。测试控制端点只改变该内存数据库，严禁把夹具加入正式构建。

先运行[真实 HTTP 验收](<../test/original-server-acceptance.mjs>)：

```sh
QA_ORIGINAL_SERVER=1 pnpm run test:original:http
```

它验证 130 条真实文章的 RSS＋3 页 HTML 补齐、分层/重播、新高分抢占、重新创建 Host 缓存后从磁盘恢复、远端 empty 不清本地、真正初始空库和禁抓源审计；所有磁盘状态在新建系统临时目录，最后恢复夹具 initial。

再启动隔离 web-dev 3081：备份其可写 profile，关闭 HMR/自动标题模型，使用**新的独立 `XDG_DATA_HOME`**，设置 Newscope/管理地址为 8082、关闭翻译/语义去重、`onlyWhenRunning:false`、`readAfterExposures:100`、L0=7/48h、L1=6/72h、L2=5/168h、target=4、low=2、debounce=1秒。配置 `stage-e-local/stage-e-hold` 指向本地 8083，并启动[固定响应夹具](<../test/fixtures/stage-e-llm.mjs>)（`node test/fixtures/stage-e-llm.mjs`，无上游请求或工具调用）。它仅模拟模型协议返回固定文本，不调用真实模型；用于新 QA 会话完成首轮，让原生真实对话 composer 出现。把该 GUI 私有 auth URL 保存到权限 0600 的文件，用 `QA_URL_FILE` 传入，不打印或提交。

```sh
QA_HEADFUL=1 QA_URL_FILE="$PRIVATE_AUTH_FILE" pnpm run test:original:browser
```

[浏览器脚本](<../test/browser-original-acceptance.mjs>)要求原生有头 Chromium 与显示服务（无显示器可用独立 Xvfb），只创建本轮 QA 会话，在指定本地固定响应夹具完成首轮后测试 idle 状态，不调用外部模型、不运行已有会话。原生空草稿的 hero 输入框没有 composer dock，因此不能把空草稿当成真实 idle 对话；会话导航仅使用 DSH 原生持久选择恢复，不伪造 DOM。它检查真实 UI 的范围/覆盖警告、分层/重播、刷新保留、新高分抢占、stale 和远端 empty 后保留。浏览器本身不伪造 visibility/时钟/几何。Playwright 的原生可见性设置及本机依赖方式见[阶段 E 说明](<stage-e-browser-acceptance.zh.md>)。

HTTP 与浏览器验收不要并行运行：控制端点会重新播种新 ID，已知候选库应保留旧 ID，所以每次完整浏览器重试须使用新的隔离数据目录，不能把“清空生产库”当修复。结果写入本机私有证据目录；运行失败也应检查报告中的清理错误。

验收后只停止所记录的测试 PID/job，Go 使用 SIGTERM/SIGINT 正常退出以完成最终审计；恢复 web-dev 备份（先核对无其他并发修改），删除过期认证文件，保留或私有清理证据。正式 3080/8080 不动；不创建 tag/release，不自动部署。最终通过结果见[验收记录](<../VERIFICATION.zh.md>)。
