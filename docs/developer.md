# bgjobs — 开发者文档

> 面向用户的说明见 [README.md](../README.md)。本文档给开发者：架构机制、设计取舍、测试与发布。

## 目录结构

```
lib/
  index.js   宿主半（手写 ESM）：工具、schtasks 托管、监视、路由、沙箱/通知决策
  client.js  Web 面板 bundle（client-modules 加载，免 build，改后刷新/重启生效）
tests/
  index.test.js    node:test（零依赖）：纯函数/提交/完成/恢复/保留/路由/沙箱/通知
tools/
  dsh-bgjobs.ps1 / dsh-bgjobs-lib.ps1   离线 CLI（DSH 不运行时管理任务）
  dsh-bgjobs-gui.ps1 / dsh-bgjobs-gui.bat   WinForms GUI
  dsh-bgjobs-toast.ps1                   系统 Toast（WinRT，pwsh 7 自切 5.1）
  smoke-test.ps1                          离线 CLI 冒烟（pwsh 7 + 5.1）
docs/developer.md   本文档
package.json  版本即发布号；依赖 @deepseek-ai/dsh-sandbox-windows-acl + react
pnpm-workspace.yaml  pnpm ≥10 构建白名单（allowBuilds/onlyBuiltDependencies: koffi）
```

## 架构与关键机制

### 托管（schtasks 双引擎）

- 插件在 DSH 进程内直接 `spawn schtasks`（不经 pwsh 沙箱，免提权）。任务 = ONCE 计划，`/Create /ST=now+60s` 后立即 `/Run`，成功即 `/Change /DISABLE` 防 `/ST` 整分双跑（**不能**紧接 `/Delete`：/Run 实例异步排队，会被连注册一起丢弃 → 进程从未启动 → 永远 running）。
- 任务目录 `<workdir>/.dsh/bgjobs/<id>/`；`.dsh` 由 `resolveDshHome()` 同规则。运行目录在 `~/.dsh`（DSH_HOME）之外、`<workdir>` 之内。
- **bat 引擎**（`bgjob_submit`）：用户命令原样写入 `cmd.bat`；`run.bat` 用 `call cmd.bat >> log 2>&1` **整体重定向**（逐行重定向会破坏 `for/if` 块）；开头 `chcp 65001` 保 UTF-8；末尾写 exitcode、自删任务；`/TR` 经 `wscript.exe` + 纯 ASCII `launch.vbs`（SW_HIDE）隐藏窗口、零 PowerShell 依赖。
- **pwsh 引擎**（`bgjob_submit_pwsh`）：`/TR` 直接调解释器（pwsh 7 优先，5.1 兜底；提交时解析烘焙绝对路径）执行 `run.ps1`，由它完成 `& job.ps1 *> stdout.log`、5.1 UTF-16LE 日志转 UTF-8、写 exitcode、自删任务。命令写入 `job.ps1`（UTF-8 with BOM + 编码 preamble）。沙箱任务另见下文。
- 退出码 = `exitcode.txt` 首数字（`parseExitCode`），负值允许；done 后再 `fire-and-forget /Delete` 兜底（bat 已自删，幂等）。

### 完成检测 / 读日志 / 恢复

- **事件驱动 + 兜底**：fs.watch 监视任务目录，`exitcode.txt` 出现即触发（200ms 节流）迁移 done；tick 每 5s 补查防 watch 丢事件/合并。`checkCompletion` 是唯一 running→done 迁移点。
- **增量读**：按字节位置只读增量，TextDecoder 流式避免截断多字节；完成前补读一次捕获 marker 行。
- **恢复（中央索引优先）**：索引只存 `jobDir` 当"地图"，状态实时读 `job.json`——索引过期/缺失不影响正确性。recover 挂 done 直接显示终态、running 继续跟踪；重启不重复通知（见 notify 幂等）。

### 保留策略（v0.1.32 起）

- **done 任务不按时间剪枝**：内存注册表、中央索引、面板、CLI/GUI 都持续保留，直到用户删除/清理。去掉了 `DONE_RETENTION_MS` 自动剪枝。
- 清理入口三处，语义一致但各有形态：
  - Web 面板 🧹 → 菜单二选一：仅 >24h / 全部（范围 = 当前视图过滤后的任务，逐条 `/bgjobs/delete`）；
  - GUI → YesNoCancel（是=24h、否=0=全部、取消）；
  - CLI → `cleanup [-OlderThanHours 24]`（`0`=全部）。
- 面板「仅 >24h」依赖 `/bgjobs/state` 视图的 `finishedAt`（done=时间戳、running=null；缺失按不算超期）。

## 可选沙箱（bgjob_submit_pwsh，复用 dsh Windows ACL runner）

目标约束：**后台任务权限不得高于会话访问模式**。

### 决策（纯函数 `jobSandboxDecision(state, requested, engine, fullAccess)`）

- 会话三态（`sessionModeOf`）：`none`（无 `sandboxPolicy` 服务）/ `full`（服务在但 resolve 得 `danger-full-access`）/ `read-only`/`workspace-write`（受限）。resolve 抛错/意外 mode → **fail-closed 抛错**，绝不把受限会话静默当全权限。
- `none`：full access 关 → **拒绝提交**（用户决策：无服务不能默认放行）；开 → 原模式放行。
- `full`：任意请求放行，无审批。
- 受限：pwsh 缺省继承会话模式（自动沙箱化，不弹审批）；显式更宽（含 off）且 full access 关 → escalate（`ctx.approval.request`，`allowed-once` 才放行，reason 带 `justification`）；bat 引擎无法沙箱化、恒全权限 → 受限会话**仅 full access 模式支持**（关则直接拒绝）。
- escalate 依赖 `approval` 服务与 agent 会话；缺任一 → fail-closed 抛错。

### full access 开关

- Web 面板 toggle，**默认关**，持久化 `$DSH_HOME/bgjobs/fullaccess.json`；`/bgjobs/state` 带 `fullAccess`，`GET/POST /bgjobs/fullaccess`。开 = 用户预批准全权限（原模式出口）。

### runner 获取与任务 wiring

- `resolveSandboxRunner()`：插件依赖 `@deepseek-ai/dsh-sandbox-windows-acl`（exports `./runner` → `lib/runner.js`）→ 环境变量 `BGJOBS_SANDBOX_RUNNER` 兜底；都不可得且请求沙箱 → fail loud + 清理。
- `job.json` 恒记 resolved `sandbox`（含 off）；沙箱任务另记 `sandboxRunnerPath` / `sandboxTempPath`（`$DSH_HOME/bgjobs/sandbox/<id>`，工作区外）/ `nodeExe`（DSH 进程同款 Node，koffi ABI 匹配）。
- 沙箱任务对 `jobDir` 授 `Everyone:(OI)(CI)RX`（受限子进程去 Authenticated Users 读不了 job.ps1/解释器）。副作用：job.ps1（用户命令文本）对本地用户可读——README 已言明。
- run.ps1 沙箱段：`node <runner> --workspace <workdir> --temp <sandboxTemp> --mode <mode> -- <解释器> -File job.ps1`；外层仍管重定向/exitcode/自删；done 清理时删 sandboxTemp。

### 边界与已知限制

- Windows ACL 沙箱是"尽力而为"非数学边界：workdir 落在 Everyone 可写树（如系统临时目录）会失效。
- cmd 对被拒重定向不置 errorlevel（exit=0 但实际被拒，denial 只体现在输出文本 `Access is denied.`/「拒绝访问。」）——v1 不特判，日志可见即可。

## 完成通知创建者Agent（v0.1.31，可选 notify）

- 参数：`notify` = `off`（缺省，仅 toast）/ `on-completion`（仅 exit 0）/ `on-fail`（仅非零）/ `on-exit`（任何退出）；`notify_mode` = `wakeup`（缺省）/ `quiet` / `always`。
- 送达路由（`deliverCompletionNotice`，参照 harness `tool-jobs` 的 onJobDone）：
  - `ctx.get('agents')` 可选服务；`agents.get(createdBySession)` 拿 live handle；缺位/会话已关/跨作用域 → 静默跳过（toast 兜底，不重试）。
  - 忙碌（`status !== 'idle'`）→ `inject`（排下一步收件箱，turn 关不掉未领消息）；空闲 + wakeup（预算内）或 always → `followup` 唤醒一轮；quiet → 恒 `inject`。
  - wakeup 预算：同 session 连续 2 次由 bgjob 通知触发的唤醒后降级 inject；`agent/inbox/claimed` 且 `message.source.kind === 'user'` 时重置（防「完成→提交新任务→再唤醒」自激链）。
  - 消息：纯文本 UserMessage（`randomUUID` id + `role: user` + source `{kind:'plugin', plugin:'bgjobs'}`），一行「后台任务『name』已完成/已结束（exit code N）」。
- **幂等**：`checkCompletion` 里命中后**先**把 `notifiedAt` 并入终态写入 job.json **再**送达——防「done 已写未送 → 重启重挂 running → 重迁移重复通知」；漏送窗口极小且 toast 兜底，可接受。

## Web 面板（lib/client.js）可维护要点

- 加载：`dsh.client` 声明 → client-modules 提供 bundle（手写 CJS factory，**免 build**，改后刷新/重启生效）。
- 主题：只用 `--dsw-*` token；组件来自 `@deepseek-ai/dsh-client-ui-primitives`（PLATFORM_MODULES 共享表直接 `require`：Toast、Icon 组件），每个都 try/catch 回退文本符号。
- 层叠：面板 z-index 接近上限仍会被 `shell.overlay`（z-index 20 层叠上下文）困住 → `react-dom` **createPortal 到 document.body**（v0.1.27 实测）；`PANEL_Z = 2147483000`、`TOAST_Z = +1`。
- 交互：拖拽用 pointer 事件 + `draggedRef` 位移阈值区分拖/点（悬浮球/折叠条/行区同款）；`data-bgjobs-ctrl` 让拖拽守卫忽略控件（防 setPointerCapture 吞 click）。
- 状态：`open`（展开）/ 折叠（仅任务列表，fit-content 自适应宽、按行高、锚定到折叠按钮位置）；`minimized`（悬浮球，落在最小化按钮位置）。清理菜单 = 🧹 下拉二选一。
- Toggle：轨道/滑块组件，`onColor` 自定义开启色——「全权限」用 `--dsw-alias-state-warn-primary`（与 dsh 审批提升面板同色）；「仅当前会话」默认 `--dsw-alias-state-business-primary`。

## 测试与发布

### 测试

- `pnpm test` / `node --test tests/index.test.js`（不依赖 DSH）。覆盖：纯函数、工具注册契约、提交/完成/恢复/保留、webServer 路由、沙箱决策矩阵与审批、notify 矩阵与送达路由。
- 回归注意：
  - `/bgjobs/state` 路由含 `await readFullAccess()` → 测试调 `handler` 必须 `await`；
  - makeCtx mock 需提供 `ctx.on`（apply 注册了 `agent/inbox/claimed`）；触发事件 = `onCallbacks.find(...)?.fn(payload)`；
  - 视图是**附加字段宽容**的（`finishedAt` 等），但新增依赖字段的 UI 要显式断言其存在。
- `tools/smoke-test.ps1`：离线 CLI 冒烟，**pwsh 7 与 powershell 5.1 各跑一遍**。

> 测试脚本中不得出现个人用户名或本机路径。

### 依赖与本地安装

- 沙箱 runner 依赖 + koffi（原生）需在**插件目录内** `pnpm install`（Node 从插件真实路径向上解析 require；宿主 `link:` 装不进插件目录）。
- pnpm ≥10 不再读 package.json 的 `pnpm` 字段；构建白名单在 `pnpm-workspace.yaml`（`allowBuilds: { koffi: true }` + `onlyBuiltDependencies`）；alpha 依赖在 `minimumReleaseAgeExclude`。`pnpm-lock.yaml`/`node_modules` 均被 .gitignore 排除。

### 固定发布流程（每次改动）

1. 递增 `package.json` 版本（默认只升末位）；
2. 更新 `README.md` / `docs/developer.md` 如有用户/开发者可读变化；
3. `pnpm test` 全绿 → `git add`（按文件）→ commit。

安装到 profile（在 harness 仓库目录执行，插件目录下会 fallback 到残缺全局 CLI）：

```powershell
pnpm dsh plugin --profile <profile> add link:<插件绝对路径>
```

`package.json`（版本号等）变更需重新执行 add；`lib/*` 改动手写 bundle 即时生效（client 需刷新，必要时重启）。
