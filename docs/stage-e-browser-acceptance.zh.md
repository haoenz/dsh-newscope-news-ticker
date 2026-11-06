# Stage E：隔离真实浏览器验收复现

> **2026-11-05 22:52:14—22:53:15（Asia/Shanghai）完整验收通过，尚未正式部署。** Chromium 156.0.8078.4 + 隔离 Xvfb 中真实 GUI 检查 **17/17 通过**，退出码 `0`，无跳过、页面异常或清理错误。Node 测试 **150/150**、Go repository/server **`-race` 通过**。证据见本机私有 [report](<../.dsh-dev/stage-e-evidence/report.json>)；今后重跑需按新报告重新判断，不能复用本次结论。

本轮还核对了实际设置、RSS 限制及空库存截图。整个夹具运行期间 `noFeedFetch=true`、`feedFetchRequests=0`；Go 夹具收到 SIGTERM 后完成退出审计并以 `PASS` / 退出码 `0` 结束。测试会话已取消，本地模型活动流为零；测试服务已停止，开发 profile 已按原始备份恢复（包括测试默认模型），正式 3080/8080 实例未重启。测试使用独立文章和本地假模型，不代表生产数据负载测试或真实翻译/语义模型验收。

## 1. 隔离边界与准备

| 服务 | 地址 | 实际运行内容 |
| --- | --- | --- |
| DSH GUI | `http://127.0.0.1:3081` | 真实 Host、原生设置页、Session running 行与 ticker，专用 `web-dev` profile |
| Newscope API | `http://127.0.0.1:8082` | 真实 Go server/router/repository，SQLite `:memory:`；不是替代 API 的 JS mock |
| LLM | `http://127.0.0.1:8083/v1` | 本地 OpenAI streaming fixture，保持真实 Session running，不访问上游、不调用工具 |

- **禁止改正式 profile、连接正式文章数据库或在正式 GUI 3080 上执行验收。** 不运行、续跑、改模型或取消任何已有 Session；脚本会创建并命名新的专用 QA Session，仅向它发送本地 fixture prompt。
- 先确认 3081/8082/8083 的占用者；已有验收在执行时不要并行重启或重复运行。以下命令均以本插件仓库为工作目录；不同服务用独立终端/受管理后台任务，记录各自 PID/job ID。
- 依赖见 [package.json](<../package.json>)：Node `>=22.19`、pnpm、Playwright `^1.64.1` 与对应 Chromium；另需 Go、可用 DSH `web-dev` 环境。提前准备依赖，验收阶段的 LLM 不需要外网：

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
# Linux 缺系统库时，按环境权限预先安装：
pnpm exec playwright install-deps chromium
```

完整可见性验收使用 **headful**：`QA_HEADFUL=1`，需要正常桌面 `DISPLAY`，或 Xvfb（例如 `xvfb-run -a`）。无显示服务不要冒充 headful 结果；脚本未设置该变量时默认 headless。运行期间不要人工抢焦点或切换测试窗口。

## 2. 可写 profile 与 read-state 隔离

[启动器](<../.dsh-dev/start.sh>)固定使用 `web-dev`，加载 [开发 overlay](<../.dsh-dev/web-dev.patch.yml>)，并通过 `DSH_DEV_PATCH` 加载 [Stage E overlay](<../.dsh-dev/stage-e.patch.yml>)。后者禁用 HMR/自动标题 LLM，注册本地 `stage-e-local/stage-e-hold` 并设为测试默认模型。

**命令行 overlay 中的 ticker 配置会禁止对应的 `settings/mutate` 写入**，不能把待测试的 ticker 配置放进去，否则原生设置保存场景无法成立。应先停止专用 GUI，确认 [web-dev profile](<../../../.dsh/profiles/web-dev/cordis.patch.yml>)的原始内容已备份至 [原始备份](<../.dsh-dev/web-dev.patch.before-e.yml>)，再只在该可写 profile 的 ticker 插件节点配置下列值。保留其他节点，不覆盖已有原始备份；**正式 profile 绝不能改**。

```yaml
displayMode: always
newscopeUrl: http://127.0.0.1:8082
managementUrl: http://127.0.0.1:8082
minScore: 7
maxAgeHours: 48
refreshMinutes: 1
readAfterExposures: 3
scrollSpeed: fast
pauseOnHover: true
openInNewTab: true
translationEnabled: false
semanticDedupEnabled: false
inventory:
  targetInventory: 3
  lowWatermark: 2
  refillDebounceSeconds: 1
  level1: { minScore: 6, maxAgeHours: 72 }
  level2: { minScore: 5, maxAgeHours: 168 }
```

启动 GUI 时必须用进程环境 `env XDG_DATA_HOME="$PWD/.dsh-dev/stage-e-data"` 隔离 ticker read-state；不是把这个变量写入 overlay。每轮干净重跑前，仅在专用 GUI 已停止、路径核实后归档/重建该隔离目录，勿触碰正式 read-state。此隔离不意味着 Session 历史自动隔离，仍必须只使用新建专用 Session。

## 3. 启动三个测试服务

**Go 内存 API**：实现见 [ticker_acceptance_test.go](<../../../newscope/src/server/ticker_acceptance_test.go>)。默认未设置 `DSH_TICKER_QA_PORT` 时该测试 **跳过**；显式启用后只允许 8082，持续运行至 SIGINT/SIGTERM：

```bash
(cd /home/haoen/newscope/src && env DSH_TICKER_QA_PORT=8082 go test -count=1 -v -timeout=0 ./server -run '^TestTickerBrowserAcceptanceServer$')
```

它使用真实只读文章/RSS 路由；仅 `/__test/scenario` 允许切换夹具，`/__test/requests` 提供请求审计。feed 禁用，抓取、正文提取与偏好任务均禁止；不能调用真实 feed fetch。

**本地 LLM**：运行 [stage-e-llm.mjs](<../test/fixtures/stage-e-llm.mjs>)：

```bash
node test/fixtures/stage-e-llm.mjs
```

默认 `STAGE_E_LLM_AUTO_FINISH_MS=0`，等待取消或 `POST /__test/finish`；不要设置短时自动结束导致 running 行提前消失。

**专用 GUI**：使用上述已备份且可写的测试 profile。启动器不需要额外 `web` 参数。使用 [启动脱敏器](<../.dsh-dev/redact-boot.mjs>)保存私有 auth URL 并脱敏标准输出；日志仍按私有材料处理，不要贴入对话、提交或公开：

```bash
set -o pipefail
umask 077
mkdir -p .dsh-dev/stage-e-data
env XDG_DATA_HOME="$PWD/.dsh-dev/stage-e-data" STAGE_E_LLM_KEY=stage-e-local-only DSH_DEV_PORT=3081 DSH_DEV_PATCH="$PWD/.dsh-dev/stage-e.patch.yml" bash .dsh-dev/start.sh 2>&1 | node .dsh-dev/redact-boot.mjs
```

`STAGE_E_LLM_KEY` 只是本地 fixture 占位值，不使用真实 API key。通过本地脱敏启动流程将该 **3081** 实例产生的 auth URL 保存到 [私有 auth URL 文件](<../.dsh-dev/stage-e-url.txt>)（权限 `0600`），供脚本直接读取；**不要读取/回显/泄露其内容或 token**。也可用 `QA_URL_FILE` 指向另一个私有文件。不要使用 3080 的认证地址。

## 4. 执行与结果判读

入口为 [browser-acceptance.mjs](<../test/browser-acceptance.mjs>)。它先断言 auth origin 是 3081、后端版本为 `ticker-browser-acceptance`、ticker 数据源为 8082；拒绝正式数据库。

```bash
# 使用桌面 DISPLAY：
env -u QA_SKIP_EXPOSURE QA_HEADFUL=1 node test/browser-acceptance.mjs
# 或无桌面 Linux 上使用虚拟显示（二选一，不要并行）：
xvfb-run -a env -u QA_SKIP_EXPOSURE QA_HEADFUL=1 node test/browser-acceptance.mjs
```

检查点包括原生设置校验/保存/重载、新专用 Session running、hover/键盘暂停、后台不累计、真实曝光与丢 ACK 同 ID 重试、重载保留已读、点击安全退场、双标签共享状态、L0→L1→L2/replay、低水位发现新 L0、故障 stale/恢复、RSS 能力限制、空库存保留原生 running，以及无抓源/无页面异常。

- **一篇文章连续可见，即使跨 clone/loop，也只能算一次连续机会**，不能为了达到三次而重复累计。脚本通过真实切到空白标签、等待后台、再切回，制造新的前台机会；不是仅等待循环次数。
- [native-browser-visibility.cjs](<../test/native-browser-visibility.cjs>)只在当前 Node 进程加载 Playwright 时关闭其默认强制 visible 的焦点模拟（`Emulation.setFocusEmulationEnabled: false`）。它不修改 app DOM、`document.visibilityState`/`document.hidden`、计时器或页面几何，也不改磁盘依赖。加载后恢复编译钩子；需新 Node 进程运行，Playwright 内部匹配变化时会明确失败，必须重新审查，不能绕过断言。
- 切换夹具场景时，脚本递增 `maxAgeHours` 并保存/重载以建立新候选缓存，这是 **test arrangement**，不代表修改生产缓存策略；“新高分抢占”场景不这样重置，实际验证低水位查询。重复复现前恢复初始配置，避免时间窗持续增长。
- `QA_SKIP_EXPOSURE=1` 只用于调试后半组，会记录 `skipped: ["exposure-detail"]`；**即使 `passed: true` 也不能当完整验收**。

默认输出为私有 [report.json](<../.dsh-dev/stage-e-evidence/report.json>) 与 [截图目录](<../.dsh-dev/stage-e-evidence/>)中的 PNG（设置、running、后台、replay、stale、RSS、空库存或失败截图）；`QA_EVIDENCE` 可指定另一目录。截图可能包含 GUI/Session 信息，全部按私有证据处理，不提交仓库或直接公开。不要把旧截图或旧报告混作本轮证据。

核对本轮开始/结束时间、退出码、`checks`、`events`、`errors`、`failure`、`skipped`、`cleanupError` 和 `fixtureRequests`；尤其核对 `noFeedFetch=true`、`feedFetchRequests=0`。启动前置断言或浏览器启动失败时可能尚未写出本轮报告，文件存在不等于本轮完成。**执行结果以最新 [report](<../.dsh-dev/stage-e-evidence/report.json>) 为准，当前未正式部署。**

## 5. 收尾（失败同样执行）

1. 脚本 `finally` 尝试只取消本轮新建 Session、调用 LLM finish、写报告并关闭浏览器；检查清理错误。若中途被强制终止，人工仅取消本轮专用 Session，勿操作已有 Session。
2. 结束本地 LLM 活跃流：`curl -fsS -X POST http://127.0.0.1:8083/__test/finish`。这只结束流，**不会停止服务**。
3. 按已记录 PID/job ID 停止专用 GUI、Go fixture、LLM fixture，确认 3081/8082/8083 已释放；Go 用 SIGINT/SIGTERM 正常退出以执行清理审计，不要使用广域 `pkill`。
4. GUI 停止后，将 [原始备份](<../.dsh-dev/web-dev.patch.before-e.yml>)恢复到 [web-dev profile](<../../../.dsh/profiles/web-dev/cordis.patch.yml>)并逐字核对；取消本轮环境设置。不要将 Stage E 配置推广到正式 profile，也不要顺手部署。
5. 核实绝对路径后删除本轮 [私有 auth URL 文件](<../.dsh-dev/stage-e-url.txt>)及其他含 auth URL/token 的临时材料；隔离 read-state、报告和截图按需私有留存/清理，不删除正式数据。
