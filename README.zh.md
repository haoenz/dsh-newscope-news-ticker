# DSH Newscope 新闻跑马灯

在 Agent 运行状态行保留原有运行提示和计时，追加真正从右向左连续滚动的新闻。每条新闻保留独立 DOM 和原文链接；悬停或键盘焦点会暂停，移出后从原位置继续。支持明暗主题、窄屏和 `prefers-reduced-motion`。

## 数据与边界

- Host 读取 `GET /rss?min_score=...` 和 `GET /api/v1/status`，默认 5 分钟缓存。
- Newscope 负责源管理、抓取、AI 评分、主题、反馈学习和持久化。
- 本插件只做 XML 解析、评分/时效过滤、去重、四类曝光权重调度和 UI。
- 不向会话写事件，不注册工具，不调用当前 DSH 模型，不创建 Session。
- 浏览器只访问同源 `/plugins/dsh-newscope-news-ticker/news.json`；模型 Key 不会进入浏览器。

## 设置

安装后进入 DSH 插件设置中的 `newscope-news-ticker` 行。所有常用项均为原生 Config：启用、Newscope Host 地址、最低评分、最大年龄、刷新间隔、四类权重、滚动速度、悬停暂停、新标签打开、仅运行时显示、分类标签。

`topicMap` 和 `sourceMap` 是可配置的主题/来源片段映射。Newscope 的 topic 由模型自由生成，匹配采用不区分大小写的包含匹配；未识别条目暂归入大众新闻。某类库存不足时，调度自动让出配额。

插件详情页另有“打开 Newscope 管理界面”。本机访问时会跳转 `newscopeUrl`；远程浏览器遇到 loopback 地址会明确提示，而不会错误打开浏览器自己的 localhost。此时请将 `managementUrl` 设置为浏览器实际可访问的地址。

## 从 GitHub 安装

在 DSH **Plugins** 的安装入口填写一个固定版本：

```text
git+https://github.com/<OWNER>/dsh-newscope-news-ticker.git#v1.0.0
```

也可以使用 CLI：

```bash
dsh plugin --profile web add 'git+https://github.com/<OWNER>/dsh-newscope-news-ticker.git#v1.0.0'
```

从早期本地目录安装迁移时，请先在 Plugins 页面卸载旧 bundle，再安装 Git 版本，避免重复注册插件行和 HTTP 路由。不要手改 DSH 核心或 profile 的生成文件。

## 升级和卸载

升级时移除旧版本，再安装新的 tag，例如 `#v1.1.0`；按插件管理器提示重启 Host 或刷新页面。卸载或关闭 bundle 后，兼容适配器、动画、样式和设置入口都会被移除，原生状态行恢复。

## 开发验证

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run check
pnpm pack --dry-run
```

本机实际浏览器、故障恢复及未覆盖边界见 `VERIFICATION.zh.md`。
