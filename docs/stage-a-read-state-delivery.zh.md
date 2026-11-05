# 阶段 A 交付记录：Host 持久已读与事件协议

- 日期：2026-11-05
- 状态：**代码与自动化验证完成，尚未部署或做真实浏览器验收**
- 方案：`docs/read-aware-inventory-plan.zh.md`

## 已完成范围

- 新增文章稳定身份：规范化 URL 的 SHA-256，并包含 Newscope 实例命名空间；保留未来 Newscope 文章 ID 与 URL 别名兼容。
- 文章键在 RSS 解析后、语义去重和标题翻译前生成，不随标题、翻译、评分或分类变化。
- 新增 Host 持久已读存储，保存曝光次数、首次/最近已读时间、已读原因、最近曝光时间及有界事件日志。
- 默认数据文件为 `${XDG_DATA_HOME:-~/.local/share}/dsh-newscope-news-ticker/read-state.json`，不是缓存目录。
- 新增 `POST /plugins/dsh-newscope-news-ticker/read-events`，支持 `exposure`、`open`、`manual` 批量事件。
- 默认第 3 次曝光形成已读；`open/manual` 可直接形成已读，但均不是浏览器自动曝光的前置实现。
- 同一事件重试为幂等 no-op；同一 eventId 携带不同 type/articleKey 时整批拒绝并返回 409。
- 事件日志与文章状态在同一原子文件中提交；最多保留最近 10000 个事件，超过该窗口的旧事件不再保证幂等去重。
- 正常、stale cache 和空库存快照统一经过已读投影；已读文章不再进入 `items`，未读文章附带 `articleKey` 和 `exposureStates`，响应附带 `readVersion`。
- 已读文件缺失才创建空历史；损坏 JSON、错误 schema 或权限错误返回 `read-state-unavailable`，不静默重建为空历史。

## 并发与故障语义

- 同一 store 内事件串行提交；不同 store/进程通过同一 lock 文件串行化，并在锁内重新读取最新文件。
- 锁文件包含随机 owner token，释放时校验所有者；不按 mtime 自动删除锁，避免 stale-check/unlink 竞态误删新锁。
- 事件先在候选副本上应用，write + atomic rename 成功后才替换权威内存并确认。
- write 或 rename 失败不增加内存计数、不形成假已读；旧 JSON 保持可读。
- rename 已提交但响应丢失时，客户端使用相同 eventId 重试可安全恢复为幂等成功。
- 异常退出若遗留 lock 文件，后续写入会明确超时而不是冒险抢锁；确认没有持有进程后方可人工清理该 lock 文件。

## HTTP 边界

- 仅 POST + `application/json`。
- 校验 `sec-fetch-site` 与可选 Origin/Host；直接 API 客户端没有浏览器头时仍可使用。
- 按流实际字节限制 64 KiB，不信任 Content-Length。
- 每批 1–100 个事件；校验事件类型、eventId 和 articleKey 格式。
- 错误 JSON/字段返回 400，事件冲突 409，错误 Content-Type 415，过大请求 413，跨站写入 403。

## 明确未做

- 未修改 `client.js`，没有浏览器可见曝光检测、pending 队列或安全移除动画；这些属于阶段 B。
- 未新增 Newscope 分页文章 API；属于阶段 C。
- 未实现 L0/L1/L2、低水位查询或已读重播；属于阶段 D。
- 未调用 `/api/v1/feeds/{id}/fetch` 或任何其他源站抓取接口，未修改 Newscope 调度与源配置。
- 未重启/安装到正式或 web-dev Host，未写正式已读数据文件，未做浏览器目视验收。

## 验证

- `pnpm test`：**48/48 通过**，其中新增阶段 A 专项测试 9 项。
- `pnpm run check`：通过。
- `pnpm pack --dry-run`：通过，新增 `lib/article-identity.js` 与 `lib/read-state.js` 均进入包清单。
- `git diff --check`：通过。
- 测试覆盖：稳定键与实例隔离、跨实例重启、批内/跨批/跨实例幂等、事件冲突、20 路并发、write/rename 故障、提交后丢响应、损坏文件、fresh/stale 过滤，以及 HTTP 方法、Origin、类型、JSON、批量和字节上限。
- 所有状态测试均使用独立临时文件，没有读取或污染用户正式已读数据。

下一阶段是阶段 B：浏览器有效曝光检测、事件批量上报与已读后的安全移除。
