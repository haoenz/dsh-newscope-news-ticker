# 实际验证记录

## Newscope 点赞点踩反馈（2026-11-06）

- 新增悬停/聚焦 👍/👎、同源 Host 反馈代理、稳定 `articleKey` → 数字 ID 反查、同操作防重和候选元数据持久化。原版 HTML active 反馈可解析，纯 RSS 无 ID 时明确禁用。
- `pnpm test`：**313/313 通过**（无跳过）；`pnpm run check`、`git diff --check` 与打包 dry-run 通过。覆盖同源/Origin/JSON/大小限制、并发共享、上游失败/超时、本地保存失败不重复写远端、跨重启/别名/RSS 刷新，以及客户端切换和失败重试。
- 上游 HTML 仅取消响应体，不解析或注入页面。本轮使用模拟上游和原版 HTML 夹具，**未对正式 Newscope 写入真实反馈，未做真实 GUI 验收、安装或服务重启**。

## 三级显示与设置即时生效（2026-11-06）

- 讯息滚动显示破坏性迁移为单一 `displayMode: off | running | always`，删除 `enabled` / `onlyWhenRunning` 及所有兼容映射；Host、Client、默认配置和验收脚本均只使用该字段。
- 设置页有效修改自动保存，无“保存修改”按钮；连续写入串行使用最新修订号。客户端订阅配置快照，立即同步显示位置与展示行为，并请求最新 Host 新闻快照。
- `pnpm test`：**303/303 通过**（无跳过）；`pnpm run check` 与 `git diff --check` 通过。新增三级单字段写入、运行/空闲即时挂载与移除、连续编辑和缺失库存字段默认值回归。
- 本轮仅完成自动化与源码审查，**未重新执行真实 GUI 验收、安装或重启正式服务**；下述原版兼容验收保留其当时范围和测试数量。

## 原版 Newscope 兼容验收（2026-11-06）

- **实现与隔离验收完成，未部署、未发布。** 默认 RSS＋持久候选库＋按需原版 HTML 分页；新增 JSON API 仅为可选增强。已知库存支持 L0/L1/L2/重播，但不宣称远端高档库存全量耗尽。
- `pnpm test`：**302/302 通过**（无跳过）；语法检查、打包 dry-run 与 diff 检查通过。覆盖候选上限/锁/损坏/失败原子性、跨重启 URL/ID 别名、RSS 根/DTD、状态读取限额、原版 text/plain HX、降级状态码、15 分钟跨界重探、完整 API 权威与部分覆盖。
- **真实原版 HTTP 8/8 通过**：使用新增接口之前的 `9c02bfa` 源码副本，仅加入测试夹具；新 API 实际返回 404，不是修改版模拟。真实 RSS＋3 页 HTML 收集 **130 条**，找回最新 100 条外的高档文章；验证分层/重播、抢占、重建 Host 缓存后的磁盘恢复、真实 503 stale、远端空 RSS 不删历史，以及无历史时真正空库存。时间 00:14:18（Asia/Shanghai）。
- **真实 GUI 12/12 通过**：00:36:26—00:36:41（Asia/Shanghai），Chromium＋Xvfb，真实 DSH web-dev 3081 和上述原版 8082。覆盖 known-local/best-effort/候选数/限制提示、原生 idle ticker、L0→L1→L2＋重播、刷新保留已读、低水位发现新高分抢占、stale、远端 empty 后仍保留候选。没有页面异常、越权会话操作或清理错误。
- 浏览器只使用新 QA 会话；本地 8083 固定响应夹具正常完成 **1 条协议流**，结束时 active=0，不调用真实外部模型或工具。空草稿 hero 不挂 composer dock，因此先完成本地首轮再验收真实 idle 对话；没有伪造 DOM、visibility、时钟或几何。
- 原版 Go `server -race` 通过。8082 夹具收到 SIGTERM 后正常完成测试，退出码 0；审计 `noFeedFetch=true`、`feedFetchRequests=0`。
- 收尾：3081/8082/8083 已关闭，专用 Xvfb 停止，web-dev 原始配置逐字恢复并 cmp 验证，失效认证文件已删除。正式 DSH/Newscope 进程 PID 90721/18443 不变；未读生产数据库，未推送、创建 tag/release 或重启正式服务。本轮调整尚未追加本地提交。
- 边界：本轮是原版兼容专题 GUI 验收，**未重新执行历史阶段 E 的整套 17 项曝光浏览器流程**；曝光相关自动化回归仍在 302 项内。本轮关闭翻译/语义去重，不冒充外部模型或生产压力验收。HTML 页码并发漂移、尚未采集历史、远端删除/改分滞后仍是已接受限制。

实现与复现：[原版兼容说明](<docs/original-newscope-compatibility.zh.md>)；本机私有证据：[HTTP 报告](<.dsh-dev/original-evidence/http-report.json>)、[GUI 报告](<.dsh-dev/original-evidence/browser-report.json>)、[范围提示](<.dsh-dev/original-evidence/settings-known-local.png>)、[远端空库后重播](<.dsh-dev/original-evidence/remote-empty-known-replay.png>)。证据含 GUI 信息，不随包公开发布。

以下阶段 E 及更早记录仅代表当时版本；原“RSS 仅 L0/禁止重播”的限制已由本轮经用户确认的 known-local 方案替代。

## 阶段 E：设置、状态与隔离真实浏览器（2026-11-05）

- **代码与验收完成，正式部署未执行。** 未重启正式 DSH 3080 / Newscope 8080；原进程 PID 90721 / 18443 保持不变。
- `pnpm test`：**150/150 通过**；`pnpm run check`、`pnpm pack --dry-run` 与 `git diff --check` 通过。新增曝光次数、库存策略的 8 个设置控件，以及可见时每 30 秒刷新、15 秒超时的库存状态区；保存采用 revision 检查和叶字段 patch。
- **真实 GUI 17/17 检查通过**：2026-11-05 22:52:14—22:53:15（Asia/Shanghai），Chromium 156.0.8078.4 + Xvfb，退出码 0；无跳过、页面异常或清理错误。使用真实 web-dev 3081、真实 Go 内存数据库服务 8082、本地无外网 LLM 8083 和新建专用会话；不是 jsdom/Vite/替代 GUI。
- 覆盖设置校验/保存/刷新保留、原生 running 行、hover/键盘暂停、真实 hidden 标签不累计、三次独立可见机会与丢 ACK 同 ID 重试、刷新保留已读/重播、点击安全退场、多标签共享已读、L0→L1→L2+replay、低水位查询发现新高分抢占、503 stale/恢复、旧 API 的 RSS 限制提示、空库存保留原生计时。
- 单篇文章连续可见时，跨克隆/循环不重复累计；通过真实标签切换制造独立机会。仅关闭 Playwright 自动化强制可见性，未改应用 DOM、visibility getter、时钟或几何。
- Newscope repository/server `-race` 通过；独立 Go 夹具收到 SIGTERM 后完成禁抓源审计，退出码 0。所有测试均为已有库存查询，审计 `noFeedFetch=true`、`feedFetchRequests=0`。
- 本地模型 9 次测试流均取消、活动流为零；验收服务停止、web-dev 原始配置恢复。专用测试会话保留作审计，不运行或取消其他会话。
- 范围边界：不代表生产数据压力测试；本轮关闭了翻译/语义去重，不冒充真实外部模型验收。扫描上限、损坏存储等故障组合仍由自动化覆盖。

复现及安全边界：[阶段 E 验收说明](<docs/stage-e-browser-acceptance.zh.md>)；本机私有证据：[报告](<.dsh-dev/stage-e-evidence/report.json>)、[设置](<.dsh-dev/stage-e-evidence/settings.png>)、[重播](<.dsh-dev/stage-e-evidence/replay.png>)、[RSS 限制](<.dsh-dev/stage-e-evidence/rss-limited.png>)、[空库存](<.dsh-dev/stage-e-evidence/native-empty.png>)。截图含 GUI 信息，不公开发布。

---

以下为历史验证记录，只代表当时的版本和环境；旧测试数量、部署描述与未验收项不覆盖上述最新结论。

## 1.2.0 跨源语义去重（2026-11-05）

- `pnpm test`：32/32 通过；`pnpm run check`、`pnpm pack --dry-run` 与 `git diff --check` 通过。
- 覆盖禁用零模型调用、跨源同事件分组合并、排序代表保留、非法/空值/布尔/越界 ID 整组拒绝、候选集缓存、模型回退与覆盖、故障/畸形响应放行、100 条与 300 字符分析上限。
- Host 联动测试确认先语义去重、后标题翻译，重复文章不进入翻译请求。
- 真实 DSH 模型去重与页面效果待 Host 重启后验收；本次不重启运行中的 Host。

## 1.1.0 标题翻译（2026-11-05）

- `pnpm test`：25/25 通过（含浏览器 DOM 仅显示中文标题）；`pnpm run check`、`pnpm pack --dry-run` 与 `git diff --check` 通过。
- 使用模拟 DSH LLM 流验证 provider/model 路由、中英混合与日语假名识别、自然中文输出、持久缓存跨实例复用与并发合并、失败不显示英文、新模型配置不复用旧快照，以及不同配置在请求阻塞或同批完成时均返回各自结果。
- 验证禁用翻译零模型/缓存副作用、单轮 100 条/10 批次上限、流式文本按块组装，以及无 finish、max-tokens 和 tool-call 等异常终止拒绝入库。
- 标题翻译通过 Host 的 `ctx.llm` 调用，不新增 endpoint 或 API Key 设置；浏览器仍只读取同源新闻接口。
- 真实模型翻译和真实 RSS 展示需在 NewScope 分类模型配置完成、RSS 有文章后验收。

## 环境

- DSH 0.2.1-rc.3，web profile；GUI `http://127.0.0.1:3080`。
- 当前没有专用 RunningStatus Slot；使用官方 bundle/Client/Config/管理 Slot，加一处 `[data-chat-running]` 兼容适配器。未修改 DSH 或 Newscope 上游源码。
- `dsh-status-rotator` 已安装但未启用；`dsh-turn-status-text` 未安装。本插件不隐藏或恢复其他插件的文案节点，降低冲突面。
- Newscope 使用可用的 `master` 镜像，宿主机只绑定 `127.0.0.1:8080`。

## 自动化

`pnpm test`：15/15 通过；`pnpm run check` 与 `pnpm pack --dry-run` 通过。

覆盖：Newscope RSS 真实字段、评分和 48 小时过滤、URL/GUID/近似标题去重、可配置映射、55/25/15/5 调度、缺类配额让出、Host 新鲜缓存和故障缓存、无缓存故障回退、禁用无请求、连续位移、hover/focus 暂停与恢复、刷新不重建、原文安全链接、session DOM 替换、卸载清理、reduced-motion、locale 重激活回归。

## 已连接的真实 DSH 页面

使用独立模拟 Newscope RSS 和一次性浏览器探针，在当前运行 session 的 Edge/Chrome 页面验证后已卸载探针：

- 跑马灯只挂载一次，四条文章各有独立元素和循环副本；原文 URL 指向模拟源文章。
- 原生「深度求索中」与实时计时保持并继续更新。
- 实际轨道出现过非零 `translate3d` 位移；无页面级横向溢出（当时 viewport 宽 1270）。
- 点击捕获验证命中用户所见链接，目标为原文，`_blank` + `noopener noreferrer`；测试阻止了实际导航，避免干扰当前页面。
- 新闻刷新保留同一跑马灯节点；内容正确。
- 浏览器真实 `prefers-reduced-motion: reduce` 已命中并显示静态分支。
- hover 暂停、focus 暂停、mouseleave/focusout 恢复以及普通动画时序由上述 DOM 自动化回归完整验证。真实标签后来进入后台，`document.hidden=true` 时插件按设计暂停，未把后台暂停误报为动画故障。

## 真实 Newscope 故障与恢复

- `GET /api/v1/status`、`GET /rss?min_score=7`、`GET /rss/Technology?min_score=7` 已验证。
- 实际停止 Newscope 后，插件返回 `service=unavailable`、`items=[]`，原生状态行回退；启动后自动恢复 `service=ok`。
- Bloomberg Markets、Techmeme、Hacker News、Quanta Magazine 与兴趣摘要经容器重建后仍存在。
- 旧 `master` 镜像在禁用 extraction 时曾因待提取文章触发 panic；部署已保持 `extraction.enabled: true`，重启后无新增 panic。

## 边界

- 当前没有独立模型凭证，真实 Newscope RSS 尚为空；这是唯一阻止真实新闻展示的配置项。模拟数据未写入真实 Newscope 数据库。
- 没有浏览器远程缩放控制，未做真实窄窗口/完整页面刷新后的目视截图验收；窄屏 CSS、session 替换和刷新清理由自动化覆盖。普通刷新无需构建步骤。
- Newscope RSS 不含 FeedName，来源名称优先按原文 hostname 的别名表显示，未知来源显示 hostname。
