# DSH Newscope 新闻跑马灯

在 Agent 运行状态提示的上一行追加真正从右向左连续滚动的新闻，保留原有运行提示和计时。每条新闻保留独立 DOM 和原文链接；悬停或键盘焦点会暂停，移出后从原位置继续。多次模型运行之间也保留播放位置，不会每次从第一条重新开始；同一标签页刷新后也会通过 `sessionStorage` 从原位置继续。支持明暗主题和窄屏。始终忽略系统 `prefers-reduced-motion` 设置，保持核心滚动功能。

下述持久已读和分层库存属于 **Unreleased 源码变更**；不表示正在运行的 Newscope/Host 已升级，也不表示真实浏览器验收通过。

## 数据与边界

- Host 优先读取 `GET /api/v1/articles` 分页元数据和 `GET /api/v1/status`，候选缓存默认 5 分钟。插件**只查询 Newscope 已入库、已评分的文章，不抓源**；不调用 `/api/v1/feeds/{id}/fetch` 或任何批量抓取接口。
- Newscope 仍负责源管理、定时抓取、正文抽取、AI 评分、主题、反馈学习和持久化。本轮新增了 Newscope 只读查询 API 源码，不等于“不改 Newscope”，但不改其 scheduler、源列表、抽取和评分流程。插件不直接读取 Newscope SQLite，也不解析管理页面。
- 插件负责候选查询、评分/时效过滤、去重、持久曝光/已读、库存分层和四类曝光权重调度及 UI。
- 不向会话写事件，不注册工具，不创建 Session。标题翻译默认关闭；启用后通过 DSH 的 LLM 服务调用所选模型。
- 浏览器只访问同源插件路由：`GET /plugins/dsh-newscope-news-ticker/news.json`、`POST /plugins/dsh-newscope-news-ticker/read-events` 和模型目录接口；Newscope 凭证和模型 Key 不会进入浏览器或会话。

### 分页与受限 RSS 回退

`GET /api/v1/articles` 接受 `min_score`（0–10）、`published_after`（RFC3339 排他时间下界）、`limit`（1–100）和 `cursor`；返回 `items` 与 `nextCursor`（null 表示耗尽）。元数据含字符串文章 ID、标题、URL、评分、时间、主题和 feed，不含正文或摘要。按发布时间、ID 严格倒序 keyset 分页，以首屏最大 ID 限制后续插入；签名游标绑定筛选条件，Newscope 重启后旧游标失效，需重新从首屏查询。插入高水位不是数据库快照，不冻结后续修改和删除。

Host 一次查询所有有效层所需的最宽超集，默认评分 ≥ 5、168 小时；每页 100 条，最多 50 页/5000 条，总 deadline 20 秒，每页最多 1 MiB、累计最多 10 MiB。**不再把 RSS 最新 100 条当作完整库存**；单份快照的语义去重/翻译准备仍最多处理 100 个候选，避免扩大 LLM 成本。

仅 API **首屏 404/405/501** 才回退 `/rss?min_score=...`。RSS 仍受最新 100 条窗口限制，并标记 `capabilities.history=false`：只用 L0，不支持完整历史放宽或已读重播。分页达到上限同样标记 `history=false`、`truncated=true`，保守只用 L0。超时、500、畸形响应属于查询失败，不能伪装成“不支持 API”或“高优先层已耗尽”。

## 设置

安装后可在 DSH 左侧 **设置 → Newscope 新闻跑马灯** 中配置，也可进入 **插件 → 已安装 → Newscope 新闻跑马灯**，在插件包详情页或 `newscope-news-ticker` 行配置页修改。所有常用项均通过 DSH `configForms` 读写：启用、Newscope Host 地址、最低评分、最大年龄、刷新间隔、四类权重、滚动速度、悬停暂停、新标签打开、仅运行时显示。关闭“仅在 Agent 运行时显示”后，空闲时也会在输入框上方滚动。标题区只显示新闻标题，不显示分类和来源；已读重播另有明确标记。修改后点击“保存修改”生效。

`topicMap` 和 `sourceMap` 是可配置的主题/来源片段映射。Newscope 的 topic 由模型自由生成，匹配采用不区分大小写的包含匹配；未识别条目暂归入大众新闻。某类库存不足时，调度自动让出配额。

插件详情页另有“打开 Newscope 管理界面”。本机访问时会跳转 `newscopeUrl`；远程浏览器遇到 loopback 地址会明确提示，而不会错误打开浏览器自己的 localhost。此时请将 `managementUrl` 设置为浏览器实际可访问的地址。

## 持久已读与有效曝光

默认 `readAfterExposures=3`：同一文章获得 **3 次有效可见曝光，并由 Host 成功持久化后**才形成已读，不要求点击。点击或中键打开可以直接已读；协议也支持 `manual` 事件，不代表另有手动标记按钮。

- 约 100ms 采样：页面前台、DOM 已连接且可见、非零尺寸，与浏览器视口及 overflow 裁剪区域相交。单个副本可见宽度至少 `min(文章宽度, 跑马灯宽度×50%, 160px)`，连续保持至少 1000ms 才形成一次机会。
- 正常组、克隆组和同页面多个运行行合并计数，不拼接两个不合格副本的宽度。同文每轮至多一次；跨轮一直可见也不会重复，必须所有副本不再满足资格后重新完成停留。后台、隐藏和真正 DOM 重建中断未完成停留。
- 悬停/焦点暂停滚动，但真实可见内容仍可计一次；长时间暂停不会反复计数。这是“提供可见机会”的几何近似，不证明用户注视或读完，不检测其它窗口和任意覆盖层遮挡。
- Host 权威状态位于 `${XDG_DATA_HOME:-~/.local/share}/dsh-newscope-news-ticker/read-state.json`，不在可清理缓存目录。曝光次数、已读原因/时间、`lastShownAt` 和身份别名跨刷新/重启保留；按 Newscope 实例隔离，RSS URL 与 API ID 持久别名迁移不清历史，翻译/评分/档位变化不重置身份。
- 浏览器 `sessionStorage` 只保存播放位置、轮次及 pending 投递 ID 等恢复信息，不另建权威已读库。同标签刷新以原 ID 补交；多标签独立有效曝光可以分别计数，通过 Host 后续快照收敛，不保证实时锁步。
- 只有校验通过的 Host ACK 才确认已读，本地计数或 HTTP 200 本身不够。可见项等所有副本离开或真实循环边界再安全移除，保留文章锚点；旧 `readVersion` 快照不能覆盖新确认。

## 库存设置与有效层

| 设置字段 | 默认值 | 含义 / 范围 |
| --- | --- | --- |
| `readAfterExposures` | 3 | 形成已读所需有效曝光数，整数 1–100 |
| `minScore` / `maxAgeHours` | 7 / 48 | 用户 L0 基线；评分 0–10，时效 1–720 小时 |
| `inventory.level1.minScore` / `inventory.level1.maxAgeHours` | 6 / 72 | L1 请求值；评分和时效范围同上 |
| `inventory.level2.minScore` / `inventory.level2.maxAgeHours` | 5 / 168 | L2 请求值；评分和时效范围同上 |
| `inventory.targetInventory` | 30 | 目标展示库存，不保证凑满；整数 1–100 |
| `inventory.lowWatermark` | 10 | 未读低于此值时补查；整数 0–100，有效值不超过目标库存 |
| `inventory.refillDebounceSeconds` | 30 | 低水位查询单飞防抖秒数；整数 1–3600 |
| `refreshMinutes` | 5 | 普通 Host 候选缓存刷新间隔；1–1440 分钟 |

**有效层不等于设置原值**：L1 相对有效 L0、L2 相对有效 L1，取两者更低评分和更长时效（分别 min/max）。放宽只能变宽或相等，永不收紧，也不回写、永久修改用户 L0。有效策略和当前快照状态不应与尚未保存的表单编辑混淆。

1. 每份快照从 L0 重算：L0 有任何未读就不混 L1，L0 为零才进 L1，L1 也为零才进 L2。不能为了凑满 30 条提前降档。
2. 当前最高层未读低于 **10** 时可绕过候选 TTL 查询一次已有库存，单飞并默认 **30 秒**防抖；没有新增则恢复普通刷新节奏。已读消耗会请求替换快照，不会抓源。
3. 仅到 L2 且未读不足目标 **30** 时，以已读补位；重播先选较高质量层，同层按 `lastShownAt` 最久未播放优先。显示 **↻ 重播** 和 `replay:true`；曝光只更新最近展示时间，不累计已读门槛、不清已读时间。
4. 新 L0/L1 未读在下一快照优先于低层和重播。完全无候选时隐藏跑马灯，保留原生运行状态。四类权重全零仍不展示，重播也不能绕过。

快照包含 `pool.tier`（L0/L1/L2/L2+replay/replay/empty）、`pool.effective`（当前评分/时效条件；空时为最宽已尝试条件）、`pool.unreadCount`（当前有效档完整候选未读数，**不是页面显示条数**）、目标/低水位、`capabilities`、`queriedAt`、`readVersion` 和 `exposureStates`。语义去重或翻译失败可能减少可展示条数，不能据此判定高档耗尽。

## 故障与有界幂等

- 查询失败时使用旧原始候选超集，但重新应用**最新已读状态**；无旧候选则 unavailable。失败不是空库存，不可作为提前放宽或重播的依据。
- 已读文件仅在缺失时初始化空历史；JSON/schema 损坏或权限错误返回 `read-state-unavailable`，绝不静默清空。文件锁串行化、原子写入成功后才确认；写入失败不形成假计数/假已读。异常退出遗留锁时明确超时，需维护者确认没有持有进程后人工处理，不自动抢锁。
- 事件约每秒合批、单飞，每批最多 100 个、请求最多 64 KiB。网络/15 秒超时/429/5xx/无效 ACK 等可重试故障用原 eventId 退避，间隔上限 30 秒；同 ID 改 type/articleKey 整批 409。
- 浏览器 pending 最多 1000 条，补交期限 24 小时，近期已发 ID 最多 5000 个。队列满、超期、终止性 4xx、关闭标签页或 Storage 不可用可能少计，但不能凭此制造已读。Storage 不可用只做内存重试；卸载 keepalive 不保证送达。
- Host 仅保留最近 **10000 个事件 ID**：在保留窗口内同 ID 重试幂等，包括提交后响应丢失；超出窗口不保证去重。客户端 24 小时期限不等于永久幂等，不能声称无限期 exactly-once。

## 可选：中文标题翻译

标题翻译默认关闭。启用 `translationEnabled` 后，可直接从 DSH 已接入的模型目录中选择 `translationModel`，或留空跟随 DSH 默认模型。插件通过 Host 的 `ctx.llm` 服务复用 DSH 的供应商、凭证和模型适配器，**不需要手动输入 provider/model，也不需要另行配置接口地址或 API Key**。

- 仅翻译通过评分、时效和去重过滤的非中文标题；分类与调度逻辑不变。明显中英混排标题也会进入翻译。
- 每轮最多翻译 100 条，每条原文最多 1000 字符，每批 10 条，整体翻译 deadline 为 60 秒。
- 标题按目标语言和模型持久缓存到 `~/.cache/dsh-newscope-news-ticker/title-translations.json`，刷新和重启不会重复翻译相同标题；并发写入通过文件锁和写前合并保护。
- 为保证展示语言一致，翻译失败或模型返回非中文标题时，该条暂不显示，不回退英文；已有中文缓存仍可正常使用。
- 更改 `translationModel` 会使用独立翻译缓存，且故障时不会误用旧模型或翻译关闭时的快照。
- Newscope 的分类模型仍需独立配置；翻译功能本身不会让未评分文章进入分页候选或 RSS。

## 可选：跨源语义去重

启用 `semanticDedupEnabled` 后，插件会在现有 URL/GUID/标题去重之后、标题翻译之前，通过 DSH LLM 识别不同来源对同一具体事件的重复报道。

- `semanticDedupModel` 同样从 DSH 模型目录中选择；留空时沿用 `translationModel`，不需要手动输入路由、独立接口或 Key。
- 判定保持保守：同主题、不同公司、不同日期、不同数据、观点分析或包含实质新增信息的跟进报道不应合并。
- 模型只给出重复组，插件始终保留组内按既有评分和时效排序最靠前的文章，并保持其余文章顺序。
- 相同候选集和模型使用 Host 内存缓存；候选集变化时才重新判定。每轮最多分析 100 条，单条用于分析的标题最多 300 字符，模型请求限时 60 秒。
- 模型或响应失败时回退到现有本地去重结果，不让新闻服务整体不可用。
- 去重先于翻译，因此重复文章不会产生额外翻译调用。

## 从 GitHub 安装

在 DSH **Plugins** 的安装入口填写一个固定版本：

```text
git+https://github.com/<OWNER>/dsh-newscope-news-ticker.git#v1.2.0
```

也可以使用 CLI：

```bash
dsh plugin --profile web add 'git+https://github.com/<OWNER>/dsh-newscope-news-ticker.git#v1.2.0'
```

安装或迁移前请先遵循下方安全升级步骤。从早期本地目录安装迁移时，备份后在 Plugins 页面卸载旧 bundle，再安装 Git 版本，避免重复注册插件行和 HTTP 路由。不要手改 DSH 核心或 profile 的生成文件。

## 升级和卸载

1. **任何替换之前先备份**当前 DSH/插件配置、持久已读文件、正在使用的程序/插件产物；Newscope schema 初始化前还应备份数据库。记录路径、版本和权限，确保可回退。源码目录不是运行数据备份，不要通过删除已读历史修复升级。
2. **先 web-dev 隔离验证**：独立 profile/专用 Session、已读数据目录和 Newscope 实例/数据库。仅换 profile 不会隔离默认已读路径，web-dev Host 应使用独立 `XDG_DATA_HOME`；不要将测试指向正式可写数据，也不要重复注册同名插件行和路由。
3. Newscope 新 API 当前是**源码能力**：维护者必须 build 对应修订、替换目标程序并重启目标 Newscope 实例后才生效。先在数据库副本验证 schema/索引初始化。旧运行程序在升级前仍只提供受限 RSS，改源码不等于线上已有 API。
4. 插件升级必须更新目标 **Host/插件安装及受影响的 Web 构建**，再刷新对应 GUI。只刷新浏览器不更新 Host，只更新 Host 也不能证明新客户端和设置已生效；未确认匹配的开发构建 watcher 运行时，不承诺热更新。
5. 在 web-dev 实测真实滚动、三次独立曝光、刷新/重启持久性、后台/前台切换、安全移除、层级耗尽/恢复、重播标识、无新增、故障恢复及多标签页；检查请求，确认从未调用抓源接口。自动化 DOM/API 模拟不等于真实浏览器验收。
6. **隔离验证后，再经用户明确确认正式发布**，才由维护者发布/安装新固定版本并操作正式服务。上面的 `v1.2.0` 只是安装 tag 示例，安装前需确认所选 tag 存在，不是本次 Unreleased 功能的发布声明；移除旧 bundle 前先完成备份。保留旧配置、程序和状态备份以便回退。

本次文档工作不启动/重启任何服务，不表示已部署或真实浏览器验收通过。卸载或关闭 bundle 后，兼容适配器、动画、样式和设置入口移除，原生状态行恢复；卸载流程不要求清除持久已读历史。

## 开发验证

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run check
pnpm pack --dry-run
```

证据边界见[阶段 A](<docs/stage-a-read-state-delivery.zh.md>)、[阶段 B](<docs/stage-b-browser-exposure-delivery.zh.md>)、[阶段 C/D](<docs/stage-c-d-inventory-delivery.zh.md>)和[验收记录](<VERIFICATION.zh.md>)。阶段交付中的自动化结果不是部署或本轮真实浏览器通过证明；最终验收由主 agent 完成后另行写入，本次不修改该验收记录。
