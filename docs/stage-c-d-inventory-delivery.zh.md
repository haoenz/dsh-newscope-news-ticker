# 阶段 C / D 交付：只读分页、库存分层与已读重播

日期：2026-11-05。**实现与自动化验证完成；未部署、未重启正式或 web-dev 服务，未执行阶段 E 真实 GUI 验收。**

依据：[已确认方案](<read-aware-inventory-plan.zh.md>)；前置：[阶段 A](<stage-a-read-state-delivery.zh.md>)、[阶段 B](<stage-b-browser-exposure-delivery.zh.md>)。

## 阶段 C：Newscope 元数据 API

在独立 Newscope 源码仓库新增 GET /api/v1/articles：

- min_score：0–10 有限数，默认 0；published_after：RFC3339，排他下界，规范化到 UTC；limit：1–100，默认 100；cursor：可选。
- 返回 items 和 nextCursor。文章含十进制字符串 id、guid、title、url、score、publishedAt、topics、feed.id/title，不查询或返回正文、摘要、抽取内容。
- 使用 (published, id) 严格倒序 keyset。首屏记录最大文章 ID，后续限定 id 不超过该值，避免正常插入及回填旧时间文章污染当前遍历。
- 游标使用进程内密钥 HMAC 认证，绑定标准化评分/时间过滤，最长 1024 字节；重启后旧游标无效，需要重新开始。limit 可以变，空游标重新开始，nextCursor=null 表示耗尽。
- limit+1 判断后续页，无 COUNT 全表统计。请求/SQL 上下文均有 5 秒限制；参数错误 400、超时 504；沿用已有同源边界，不新增跨域开放。
- 新增分类文章 (published DESC, id DESC) 局部索引定义；本轮仅修改 schema 源码，未对正在运行的数据库执行迁移。
- 插入高水位不是数据库历史快照，不冻结后续标题/评分/分类/删除修改。更新中的文章不承诺快照隔离；下一次从首屏查询会重新计算。

主要文件：[API](</home/haoen/newscope/src/server/articles_api.go>)、[只读查询](</home/haoen/newscope/src/pkg/repository/articles_page.go>)、[元数据类型](</home/haoen/newscope/src/pkg/domain/articles_page.go>)、[路由](</home/haoen/newscope/src/server/server.go>)、[适配器](</home/haoen/newscope/src/server/repository_adapter.go>)、[索引](</home/haoen/newscope/src/pkg/repository/schema.sql>)。API 使用说明补充在 [Newscope README](</home/haoen/newscope/src/README.md>)。

## 插件候选查询与身份兼容

- [查询适配器](<../lib/newscope-query.js>)一次取所有档位的最宽候选集，默认 score≥5、168 小时。逐页 100 条，最多 50 页/5000 条，总体查询 deadline 20 秒；每页最多 1 MiB、分页正文累计最多 10 MiB。
- 验证页结构、稳定 ID、顺序和游标前进。超时、500、畸形 JSON 等不伪装成“API 不支持”；只有首屏 404/405/501 才回退 RSS。
- RSS 标记 capabilities.history=false，只使用 L0，不声称完整时效放宽或历史重播。达到分页上限也标记 history=false、truncated=true，并保守只用 L0；不会把受限扫描当作高优先层已耗尽的证据。
- 缓存保留原始候选超集，显示库存再经过语义去重/翻译。单次快照准备候选总数不超过 100，避免历史查询把 LLM 成本放大到数千条。
- [已读存储](<../lib/read-state.js>)增加 includeRead 投影及 lastShownAt；保持原 schema v1，以 aliases 持久关联 RSS URL 键与 API ID 键。迁移、回退、重启不清已有已读记录。
- 优先复用已存在 canonical key；别名提交和合并经过同一文件锁、原子写入。合并旧重复记录时保留任一已读标记，曝光计数取最大值而非相加，避免重叠历史双计。事件 ID 冲突校验仍使用原始提交 key，不放宽幂等约束。
- 新别名的持久化可能推进 readVersion；写入失败返回 read-state-unavailable，不制造假确认。

## 阶段 D：库存策略

[策略模块](<../lib/inventory.js>)与[配置](<../lib/config.js>)提供以下默认值：

| 项目 | 默认值 |
| --- | --- |
| L0 | 用户 minScore/maxAgeHours，默认 7 / 48 小时 |
| L1 | 6 / 72 小时 |
| L2 | 5 / 168 小时 |
| targetInventory | 30 |
| lowWatermark | 10 |
| refillDebounceSeconds | 30 |

配置位置为 inventory.targetInventory、inventory.lowWatermark、inventory.refillDebounceSeconds、inventory.level1/level2（各含 minScore/maxAgeHours）。有效档位逐层使用更低评分、更长时效，永不比前一层收紧；不回写或永久改变用户 L0 配置。目标 1–100，低水位 0–目标，防抖 1–3600 秒。已有设置面板仅写变动字段，不覆盖这些新增配置；专用面板编辑控件留在阶段 E。

调度规则：

1. 每份快照都从 L0 重算。L0 有任何未读就不混 L1；L0 空才进入 L1；L1 空才进入 L2。
2. 当前最高层未读低于水位时绕过候选 TTL 查一次已有库存，单飞并短防抖；无新增恢复正常刷新节奏，不因不足目标提前降档。
3. L2 未读不足目标才以已读补位；重播优先较高质量档，同档 lastShownAt 最久未播放优先，缺失表示未记录过展示。
4. 重播带 replay:true。成功曝光只更新已读文章 lastShownAt，不累加曝光门槛、不清 readAt；重试不重复更新时间。
5. 新 L0/L1 未读在下一快照优先于更低层和重播。完全无候选返回空列表，浏览器隐藏跑马灯、保留原生状态行。
6. 全零分类权重保持既有“不展示”语义，包括重播也不绕过；pool 仍报告真实库存。

[Host](<../lib/index.js>)返回 pool.tier、unreadCount、targetInventory、lowWatermark、effective，及 capabilities、queriedAt、readVersion、exposureStates。unreadCount 是当前有效档的完整候选未读数，不是截断后的显示条数。翻译失败可能令可展示数更少，但不会因此判断高档耗尽。

[浏览器](<../client.js>)识别并标注“↻ 重播”，允许已确认文章以明确重播身份展示；重播仍遵循阶段 B 有效曝光及正常/克隆去重。已读消耗后立即向 Host 请求替换库存，保留安全移除和锚定。Host 防抖仍限制对 Newscope 的实际查询频率。

## 故障与竞态

- 查询失败使用旧候选超集，但重新应用最新已读状态；没有旧候选则 unavailable，不把故障当成耗尽。
- 翻译期间发生已读提交时，从完整原始超集重新选档，允许一次有界补准备新入选项；不会发布最新 readVersion 却配旧 pool。
- 翻译失败只从旧译文中匹配当前原始库存选中的文章；不能用旧显示子集判断耗尽、提前放宽或错误重播。
- 部分翻译结果不永久写入 prepared 缓存，后续刷新可以补译。
- 保留阶段 B 有界队列、Host 有限幂等窗口等限制，见其交付记录；本轮未扩展为无限期 exactly-once。

## 验证

插件：
- pnpm test：**143/143 通过**，较阶段 B 新增 52 项。
- pnpm run check、pnpm pack --dry-run、git diff --check：通过，新模块均进入打包清单。
- 新增：[库存单测](<../test/inventory.test.js>)、[分页/调度集成](<../test/host-inventory.test.js>)、[翻译竞态](<../test/host-inventory-races.test.js>)、[身份迁移](<../test/read-state-inventory.test.js>)；扩展[浏览器测试](<../test/client-read-events.test.js>)覆盖重播与即时补查。

Newscope：
- go test -mod=vendor ./pkg/repository ./server -count=1：通过。
- go test -mod=vendor -race ./pkg/repository ./server -count=1：通过。
- go test -mod=vendor -short ./... -count=1：全包通过。
- gofmt 及 git diff --check：通过。
- 新增 [SQL/游标测试](</home/haoen/newscope/src/pkg/repository/articles_page_test.go>)与[HTTP 测试](</home/haoen/newscope/src/server/articles_api_test.go>)，覆盖并列时间、插入高水位、分页耗尽、评分/时间/参数边界、超安全整数 ID、游标损坏/篡改/绑定/重启失效、超时和只读 total_changes 断言。
- 新测试使用独立内存数据库，不连接正式库。原机器没有 Go，临时工具链下载到已忽略的工作区缓存；使用 Go 1.26.0，与 go.mod 一致，归档已按[官方 Go 下载元数据](<https://go.dev/dl/?mode=json&include=all>)的 SHA-256 校验，不安装到系统路径。

## 边界与后续

- 插件未调用任何源站抓取接口，未改 Newscope scheduler、源列表、抽取或评分流程。
- 仅改两仓源码、测试、相关说明及本地验证缓存；未安装、发布、重启服务，未写正式已读/文章数据库。
- 旧运行 Newscope 在部署新版前仍只能走受限 RSS。阶段 E 的设置 UI、正式发布文档和真实浏览器验收尚未执行。
- [外仓操作提案](<newscope-stage-c-operations.json>)已用于审批并应用，保留作审阅记录；实际 Go 文件已 gofmt，此提案不是可重复执行的部署脚本。
- 插件工作树原有其它改动均保留；本轮未自动提交、回滚或清理用户文件。
