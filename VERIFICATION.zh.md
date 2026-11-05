# 实际验证记录（2026-11-04）

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
