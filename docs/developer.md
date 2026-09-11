# bgjobs — 开发者文档

> 面向用户的说明见 [README.md](../README.md)。本文档给开发者：架构机制、设计取舍、测试与发布。

## 目录

- [目录结构](#目录结构)
- [架构与关键机制](#架构与关键机制)
- [可选沙箱（bgjob_submit_pwsh）](#可选沙箱bgjob_submit_pwsh复用-dsh-windows-acl-runner)
- [MCP 引擎（bgjob_submit_mcp / bgjob_mcp_tools）](#mcp-引擎bgjob_submit_mcp--bgjob_mcp_tools)
- [完成通知创建者 Agent（可选 notify）](#完成通知创建者agentv0131可选-notify)
- [Web 面板（client-src / 构建产物）](#web-面板libclient-src--构建产物-libclientjs可维护要点)
- [测试与发布](#测试与发布)

## 目录结构

```
lib/
  index.js            入口聚合（插件元信息 + 公共导出；apply 来自 core/apply.js）
  util.js / index-store.js / sandbox.js / scripts.js / notify-policy.js / guidance.js
                      纯函数叶子模块（按功能拆分）
  runners.js          schtasks / PowerShell / 沙箱 runner 执行层（测试替身 seam）
  gui-launch.js       网页侧启动离线 GUI / 打开所在文件夹（schtasks 一次性任务拉起 GUI——脱离宿主
                      job，Ctrl+C/宿主退出不杀；目录用 powershell Invoke-Item；resolveShell +
                      execFile，可注入替身）
  mcp-connect.js      MCP 连接构造（环境清洗 / SDK transport / tools.list / 结果投影）——runner 与预热共用一个实现点
  mcp-runner.mjs      任务内 MCP 调用执行体（node lib/mcp-runner.mjs <jobDir>\mcp.json；预热通道优先 + 回退冷启动）
  mcp-prewarm.js      host 侧预热域：常驻连接 supervisor + 127.0.0.1 回环代理（onclose 重连 / 有界退避 / 空闲 TTL）
  dsh-profiles.js     DSH profile 判定 + cordis.patch.yml 的 MCP 条目解析/导入（不 eval !!js）
  meta.js             包版本读取（设置页显示）
  core/               host 域模块（store/notify/registry/watch/wait/jobs/mcp/web/tools + apply 装配）
  client.js           Web 面板 bundle（产物，提交入库；由 lib/client-src 构建而来）
  client-src/         网页面板源码（index/i18n/ui/panel/apply/monitor/sidebar-action/
                      gui-prefs/settings-section/mcp-section；改后需 pnpm build:client）
                      设置页注册**两页**（settings.section 是 list seat）：settings-section.js=「后台任务」、
                      mcp-section.js=「MCP 任务」（总开关 / server 登记含编辑 / 导入导出 / 从 DSH 导入）
scripts/
  build-client.mjs    esbuild：lib/client-src → lib/client.js（产物提交，防漂移由 CI 把关）
  fix-bom.mjs         清理「多余（重复）的 UTF-8 BOM」（只去重、绝不新增 BOM；--write/--check）
tests/
  helpers/common.js   共享测试工具与套件隔离（installSuiteHooks）
  fixtures/demo-mcp-server.mjs
                      本地 demo MCP server（零依赖纯 stdio；echo/sleep/fail；测试与手工自测用，不触网）
  unit/tools/submit/watch/routes/sandbox/notify/wait/mcp/mcp-web.test.js
                      node:test（零依赖，按功能分文件）：纯函数/提交/完成/恢复/路由/沙箱/通知/MCP
tools/
  dsh-bgjobs.ps1 / dsh-bgjobs-lib.ps1   离线 CLI（DSH 不运行时管理任务；暂单文件，决策保留）
  dsh-bgjobs-gui.ps1 / dsh-bgjobs-gui.bat   WinForms GUI
  dsh-bgjobs-toast.ps1                   系统 Toast（WinRT，pwsh 7 自切 5.1）
  smoke-test.ps1                          离线 CLI 冒烟（pwsh 7 + 5.1）
docs/developer.md   本文档
package.json  版本即发布号；依赖 @deepseek-ai/dsh-sandbox-windows-acl + @modelcontextprotocol/sdk + yaml + react；devDep esbuild
pnpm-workspace.yaml  pnpm ≥10 构建白名单（allowBuilds/onlyBuiltDependencies: koffi + esbuild）
```

### host 域模型（v0.1.61 起，依赖无环）

- 入口只做聚合；`apply(ctx)`（`lib/core/apply.js`）按依赖序创建各域：`store`（per-apply 状态：registry 注册表 + full access + **ui-prefs**（v0.1.65，左栏入口显隐偏好）+ **MCP 开关/server 登记**）与 `prewarm`（MCP 常驻连接域，先于其它域创建）← `mcp` ← `notify` ← `registry` ← `watch` ← `wait`/`jobs` ← `web`/`tools`。
- 每个域 = `createX(ctx, store, deps)` 工厂，返回 `{ api, dispose }`；跨域调用经 `deps` 注入的 `api` 解析（纯函数直接 import 叶子模块）。
- 规则：凡「每插件实例一份」的可变状态必须在 `store` 或域工厂闭包内，**严禁模块级**（多 apply/测试隔离）。

## 架构与关键机制

### 托管（schtasks 双引擎）

- 插件在 DSH 进程内直接 `spawn schtasks`（不经 pwsh 沙箱，免提权）。任务 = ONCE 计划，`/Create /ST=now+60s` 后立即 `/Run`，成功即 `/Change /DISABLE` 防 `/ST` 整分双跑（**不能**紧接 `/Delete`：/Run 实例异步排队，会被连注册一起丢弃 → 进程从未启动 → 永远 running）。
- 任务目录 `<workdir>/.dsh/bgjobs/<id>/`；`.dsh` 由 `resolveDshHome()` 同规则。运行目录在 `~/.dsh`（DSH_HOME）之外、`<workdir>` 之内。
- **bat 引擎**（`bgjob_submit`）：用户命令原样写入 `cmd.bat`；`run.bat` 用 `call cmd.bat >> log 2>&1` **整体重定向**（逐行重定向会破坏 `for/if` 块）；开头 `chcp 65001` 保 UTF-8；末尾写 exitcode、自删任务；`/TR` 经 `wscript.exe` + 纯 ASCII `launch.vbs`（SW_HIDE）隐藏窗口、零 PowerShell 依赖。
- **pwsh 引擎**（`bgjob_submit_pwsh`）：`/TR` 直接调解释器（pwsh 7 优先，5.1 兜底；提交时解析烘焙绝对路径）执行 `run.ps1`，由它完成 `& job.ps1 *> stdout.log`、5.1 UTF-16LE 日志转 UTF-8、写 exitcode、自删任务。命令写入 `job.ps1`（UTF-8 with BOM + 编码 preamble）。沙箱任务另见下文。
- 退出码 = `exitcode.txt` 首数字（`parseExitCode`），负值允许；done 后再 `fire-and-forget /Delete` 兜底（bat 已自删，幂等）。
- **任务计划残留与手工清理**（O-3）：正常路径由任务自删 + done 兜底 `/Delete` 清理，但进程被强杀、`/Create` 成功却未 `/Run`、或 `watch` 未及兜底时会留下 `dsh-bgj-*` 计划。host **刻意不做**「启动时枚举清扫」：清扫窗口会和「已 `/Create` + `/Run` 但尚未 `indexUpsert`」的提交竞争，误删会让该任务**永不启动**（比残留更难查）。手工清理：
  ```powershell
  schtasks /Query  /FO LIST /TN "dsh-bgj-*"      # 列出残留
  schtasks /Delete /TN "<上一步的名字>" /F       # 逐个删除
  ```
  也可在「任务计划程序」GUI 里按名字筛 `dsh-bgj-`。

### 完成检测 / 读日志 / 恢复

- **事件驱动 + 兜底**：fs.watch 监视任务目录，`exitcode.txt` 出现即触发（200ms 节流）迁移 done；tick 每 5s 补查防 watch 丢事件/合并。`checkCompletion` 是唯一 running→done 迁移点。
- **增量读**：按字节位置只读增量，TextDecoder 流式避免截断多字节；完成前补读一次捕获 marker 行。
- **恢复（中央索引优先）**：索引只存 `jobDir` 当"地图"，状态实时读 `job.json`——索引过期/缺失不影响正确性。recover 挂 done 直接显示终态、running 继续跟踪；重启不重复通知（见 notify 幂等）。

### bgjob_wait（v0.1.51）

- 目的：agent 需要「等结果继续」时不再用前台 `pwsh sleep` 反复轮询；`bgjob_wait(jobId, timeoutSeconds?)` 等到任务 done 立即返回退出码/日志尾。
- **硬约定（v0.1.82，与 `buildBgjobsGuidance` 一致）**：等结果只用 `bgjob_wait` / `bgjob_wait_all`（或 submit* 的 `wait` 参数），**禁止**用 `sleep` / `Start-Sleep` / `timeout` 或「循环 + `bgjob_status`」代替——阻塞式等待占住回合、收不到新消息、还可能被超时打断。并行提交多个任务后默认用 `bgjob_wait` 的 any 竞速：先拿到先处理，其余用 `pending` 继续等，不必等齐。
- 实现：轮询 `waitSnapshot(jobId)`——注册表命中时对 running 任务复用既有 `checkCompletion(job)`（幂等收尾：置 done/写盘/通知），未命中回退 `statusFromDisk`；间隔与**任务自身已运行时长**成正比（`clamp(250ms, taskAge×10%, 1s)`，上限 1s 保证检测延迟 ≤~1s；v0.1.51 起，废弃按等待时长的档位退避），默认 120s、clamp 1–600s。
- 语义：未知 id 立即返回 `not found` 不空等；等待期间任务被清理 → `status:'removed'`；超时返回 `timedOut:true` 的当前快照供 agent 再次调用；不替代 `notify`（异步收结果仍用 submit 的 notify）。
- **`bgjob_wait_all` = 合取语义 + 失败短路（v0.1.82）**：`allDone:true` 只在**全部成功**时为真。失败判定 `e.ok === false`（not found）|| `e.status === 'removed'`（被清理，无法确认成功）|| `e.exitCode !== 0`（含 `exitCode` 为 `null`——done 但读不到退出码，同样无法确认成功）；MCP 引擎的非 0 码（1/2/3）自然覆盖。
  - **一旦有失败立刻返回**：`{ allDone:false, failed:true, failedJobId, timedOut:false, results, pending }`——合取已确定为假，不必再等剩余任务。判定序固定：**全部成功结束 > 让路 > 失败短路 > 超时**（让路优先于失败：有人在等，先把回合交还，失败信息随时可再查）。
  - 短路返回里**已终态者仍置交付**（`finishWaitResult` → `delivered·wait`；否则缺省 wait 会把它们再返回一次），未结束者给 running 占位并列入 `pending`；**不调 `concludeTurn`**——失败是"有活要干"，回合应继续，agent 可立即处置。
  - `waitAnyOf`（any 竞速）与 submit 的 `wait` 参数**不受影响**：失败也是"结束"，本来就立即返回。
- **停止路径 = 抛工具自有错误，不是返回快照**（v0.1.74）：用户点停止/打断 → `exec.signal` abort → 本次等待**抛** `Error`（`err.code = 'BGJOB_WAIT_STOPPED'`，文案含最多 3 条 `id=status(exit n)` 摘要 + `…(+N more)` + 续等指引）。
  - **为什么不能返回快照**：DSH 的取消不变式会把「caller 取消后 settle 的**成功**结果」替换成合成错误 `Error: tool call aborted`——`packages/core/tools/src/index.ts:1539-1543` 的 `isAborted(signal) ? toolAbortedResult(result) : result`，以及 `:1580-1585` / `:1599-1607` 两处也是同样处理（`callerCancelled(exec) && !result.isError`）。所以「停止时返回 stopped 快照」在结构上**送达不了模型**；反之**抛出的错误不会被替换**（复核条件都带 `!isError`），first-party 工具（`tool-bash` / `tool-pwsh` / `jobs-local`）也是这个范式。
  - 结构化信息写在 message 文本里（`errorInfo()` 只对 harness 的 `HarnessError` 实例产出 `{name, code}`，见 `:635-641`；本插件不引 harness 依赖，`err.code` 仅供插件侧测试/日志）。语义不变：任务继续后台跑、不置 delivered（抛错路径**不得**调 `finishWaitResult`/`markDeliveredId`）、可再次 `bgjob_wait` 续等。
  - **不采用 `deferContext` 注入消息**：那会把工具结果改成"稍后注入"，破坏 wait 的本义（同步拿结果），且注入时机/顺序不受调用方控制；错误形态已能携带全部可操作信息。
- **新入站消息让路 = 正常返回 + 声明回合终结**（`stoppedBy:'message'`，v0.1.72；`concludeTurn` 自 v0.1.82）：不涉及 abort，值能正常送达，保持 `stopped:true` 快照（`stoppedSingle` 只服务这条路径）。`stoppedBy:'signal'` 不再出现在返回值里（输出 schema 保留该字段给 message 用）。
  - 返回**不含消息正文**：`buildInboxWatch` 只对 `inbox.nextStep` / `inbox.nextTurn` 的消息 id 序列做「wait 起点基准 + 差分」，不读消息内容。
  - 让路时另调 `concludeTurnOf(exec)` → `exec.concludeTurn()`，把本次**成功**结果标记为「终结当前 agent 回合」（dsh-tools 契约 `ToolRunContext.concludeTurn` → `ToolExecutionSuccess.concludesTurn`；一方先例：`dsh-subagent-in-process-driver` 的 `structured_output` 工具）。DSH 侧链路：`concluded` → 该 step 判 `completed` → `nextStep` 非空则**同回合立即开下一步**并领取投递；否则回合结束、`inbox.hasPending` 为真 → **自动开新回合**领取投递（见 `dsh-agent-loop/lib/index.js` 的 `turn()` 尾段与 `preStep` 的 `claim`、`dsh-agent/lib/types/inbox.js` 的 `claim`）。
  - **为什么必须声明**：`bgjob_wait` 是步内长工具、没有步边界。agent 若在让路后继续等待或跑耗时操作，回合不结束，`inbox` 里**排在本轮之后的用户消息（next-turn）永远不会被领取**——这就是"让路后读不到消息"的根因。机制保证优于文案约定，故不再靠指引要求 agent 自觉收敛回合。
  - **降级**：`exec.concludeTurn` 不存在（老版本 DSH / 测试替身）→ 静默跳过，退回"仅返回 stopped 快照"（try/catch 兜住冻结或异常实现）。
  - **已评估但未采用**：① 读 `inbox.nextStep`/`nextTurn` 正文放进返回——用户明确选择不读，且 DSH 之后仍会正式投递一次，模型会看到两遍；② `inbox.remove(id)` 做 exactly-once——其语义是"取消待投递消息"（写 `outcome:'canceled'` splice），用户自己的消息将不再作为正式用户消息出现，且插件去改 agent loop 的收件箱属越界；③ `exec.deferContext` 主动注入（理由同上文停止路径：破坏 wait 的同步语义）。
- submit 糖（v0.1.52）：`bgjob_submit` / `bgjob_submit_pwsh` 传 `wait: <秒>`（1–600）会在提交成功后自动等待任务结束（内部同一 `waitJobDone`，超时返回 timedOut 快照）；提交失败不进入等待。

### 保留策略（v0.1.32 起）

- **done 任务不按时间剪枝**：内存注册表、中央索引、面板、CLI/GUI 都持续保留，直到用户删除/清理。去掉了 `DONE_RETENTION_MS` 自动剪枝。
- 清理入口三处，语义一致但各有形态：
  - Web 面板 🧹 → 菜单二选一：仅 >24h / 全部（范围 = 当前视图过滤后的任务，逐条 `/bgjobs/delete`）；
  - GUI → 自定义弹窗：输入小时数（默认 24、会话内记忆），按钮「清理超期 N 小时 / 清理全部已完成 / 取消」；
  - CLI → `cleanup [-OlderThanHours 24]`（`0`=全部）。
- 面板「仅 >24h」依赖 `/bgjobs/state` 视图的 `finishedAt`（done=时间戳、running=null；缺失按不算超期）。
- 离线 CLI/GUI 的「仅 >N 小时」只删能确定完成时间且已超期的 done：finishedAt 缺失（DSH 离线完成未回写）以 exitcode.txt 落盘时间近似完成时间；两者皆无才保留，仅「全部」（0）无条件删除。

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

## MCP 引擎（bgjob_submit_mcp / bgjob_mcp_tools）

把「MCP server + tool + 参数」当成第三种后台任务：仍由 schtasks 托管（关 DSH 继续跑）、面板可见、可 `wait`/`notify`，收尾仍靠 `exitcode.txt`。**MCP 任务独立开关控制，默认关闭**，且**不受会话访问模式限制**。

### 三引擎对照

| | bat（bgjob_submit） | pwsh（bgjob_submit_pwsh） | mcp（bgjob_submit_mcp） |
|---|---|---|---|
| 执行载体 | `cmd.bat` + `run.bat` + `launch.vbs`（wscript 隐藏窗口） | `run.ps1` 直接 `/TR` 调解释器 | **同 bat 管线**：`cmd.bat` 一行调 Node runner |
| 权限/沙箱 | 恒全权限、不可沙箱化 | 可 `read-only`/`workspace-write`/`off` | 恒 `off`（无文件系统沙箱概念） |
| 会话模式约束 | 受限会话仅 full access 开启时可提交 | 权限不高于会话模式（更宽需审批） | **不受限**（`jobSandboxDecision` 对 mcp 早退，见下） |
| 依赖 | 无 | PowerShell | 插件自带 Node 依赖（SDK + yaml，随包发布） |

**为什么 mcp 不受会话模式限制**（与 DSH 一致）：DSH 的 sandbox policy 只被**实施隔离的执行通道**消费——shell 沙箱执行器 `ctx.sandbox.confine`、`fs-sandbox`、`terminal-bash`；MCP server 由官方 SDK 的 `StdioClientTransport` 直接 spawn，**不经** `ctx.subprocess`/`ctx.sandbox`，MCP 工具注册与执行路径上也没有策略/审批门控。故 `jobSandboxDecision` 在 state 校验与 full access 判定**之前**对 `engine === 'mcp'` 直接返回 `{ mode:'off', escalate:false }`（`lib/sandbox.js`），`requested` 被忽略。

### 提交与任务产物

- `submitJob(..., engine='mcp', ..., extra)`：`extra = { mcpSpec, serverName }`。提交时解析 Node 解释器（优先 `process.execPath`，否则 `where.exe node`）、烘焙 `meta.mcpRunnerPath`（`lib/mcp-runner.mjs` 绝对路径）/`meta.nodeExe`/`meta.mcpSpecPath`，写 `jobDir\mcp.json`（任务自包含，不依赖设置文件），`meta.engine='mcp'`、`meta.mcp={server,tool,transport,prewarm}`、展示用 `meta.command = 'mcp: <server> → <tool>'`。
- **双层开关校验**：① 工具 `execute` 入口（开关即时生效、无需重启，工具常驻注册以避免动态注册时序问题）；② `submitJob` 内 `engine==='mcp'` 时再校验（防程序直调绕过）——关闭时连 jobDir 都不创建。开关文案统一为 `store.js` 的 `MCP_DISABLED_ERROR`。
- **runner 契约**（`lib/mcp-runner.mjs`，`node lib/mcp-runner.mjs <jobDir>\mcp.json`）：
  - `mcp.json` = `{ server, transport:'stdio'|'streamable-http', command/args/env/cwd 或 url/headers, tool, arguments, timeoutMs, prewarm? }`；
  - 先试预热通道（`prewarm.url` + `x-bgjobs-token`，3s 短超时），任何失败写 `[BGJOB] prewarm unavailable: …; falling back to cold start` 并**回退冷启动**；
  - 退出码：`0` 成功 / `1` 工具 `isError` / `2` 配置·连接·调用失败 / `3` 超时；日志首行 `[BGJOB] mcp call: …`、末行 `[BGJOB] channel: prewarm|cold`；
  - 产物：stdout 投影文本（→ `stdout.log`）、`result.json`（`{ ok, exitCode?, isError, channel, content, structuredContent?, server, tool, durationMs, timeoutMs, error? }`）、冷启动时 `mcp-server.pid`（供删除时 `taskkill /PID /T /F` 回收）。
- **超时收尾宽限（O-1）**：超时/失败路径会 `client.close()` 回收 server 子进程（SDK 的 close = stdin end → 等 2s → SIGTERM → 再等 2s），所以 `result.json` 的 `durationMs` 可能比 `timeoutMs` 多 1–2 秒（故同文件记录 `timeoutMs` 供对照）。这是「保证不残留 server 子进程」的代价，**不加 `process.exit` 抢跑**。
- done 收尾时（`watch.js` 的 `checkCompletion`）对 mcp 任务补读 `result.json` 的 `channel` 落进 `meta.mcpChannel`，面板详情显示「执行通道：预热/冷启动」。

### 预热（`lib/mcp-prewarm.js`，只做加速）

- 形态对齐第一方 mcp-client：`onclose` 触发重连 + 有界指数退避（500ms 起、上限 30s、最多 10 次）、**不做 ping**；空闲 TTL 10 分钟回收（每 60s 扫一次，定时器 `unref`）。连接尝试**按 server 去重（单飞）**——否则并发 `warm` 会重复 spawn 同一 stdio server，未记录的那些成为孤儿进程（实测会把测试进程卡住）；连接期间被 `unwarm`/dispose 则立即关闭。
- 回环代理：`http.createServer` 自绑 `127.0.0.1:0`（**不依赖 DSH webServer 端口 API**），`POST /call`（调用）与 `POST /tools`（列工具），鉴权 = 每次 apply 随机 `randomUUID()` token（`x-bgjobs-token`）；同一 server 的调用经一条串行队列。
- token 与端口**只写进该任务的 `mcp.json`**（`prewarm:{url,token}`），不写设置文件、不进日志。代理生命周期挂在插件 dispose 链上。
- 开关联动：MCP 总开关开启 → 对**启用且 `prewarm:true`** 的 server 预连；关闭 → `unwarmAll()`。被设为「禁用」（`enabled:false`）的 server **不预连**，且切到禁用时立即 `unwarm`。host 不在/代理不可达/坏 token → runner 回退冷启动，**任务照常成功**（"任务脱离 DSH 也能跑"的保证不变）。
- runner 与 supervisor 共用 `lib/mcp-connect.js`（env 清洗 `/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*`、transport 构造、`tools/list` 分页、结果投影），避免两套实现漂移。

### 工具列表与缓存（`lib/core/mcp.js`）

- 来源优先级：live 工具注册表 `ctx.tools.schemas()` 的 `mcp__<server>__*`（**零启动开销**，DSH 已连接就免 spawn）→ `mcp-tools-cache.json`（TTL 10 分钟）→ 实际连接探测。探测**优先复用预热常驻连接**（该 server 已在预热表且 `warm` 时走 `prewarm.listTools`，`channel:'prewarm'`；失败才回退冷启动 `channel:'cold'`）——stateful MCP server 只允许一个会话，另开第二个会让第一会话的请求挂死（实测 Template-Nodejs-MCP-Server 复现）。返回 `source: 'registry'|'cache'|'probe'` 与 `channel`。
- 只回传工具名/描述（截断 200 字符）/必填字段名摘要，避免上下文膨胀。
- 口径差异（有意为之）：agent 侧 `bgjob_mcp_tools` **受 MCP 开关限制**（防模型在未开启时反复 spawn）；设置页「列出工具」（`POST /bgjobs/mcpservers?probe=1`）是用户显式操作，**不受限制**——总开关关闭、乃至该 server 被设为「禁用」时仍可手动探测（`resolveServer` 传 `allowDisabled:true` 放行）。
- `bgjob_submit_mcp` 提交前会先取一次工具清单做**工具名纠错**：清单拿到了但没有该 tool 名 → 直接拒绝并附可用清单（截断 30 个）；探测失败不阻断提交（任务里会重新连接并报真实原因）。

### DSH 配置导入（`lib/dsh-profiles.js`）

- **活动 profile 三级判定**（`detectActiveProfile`，返回 `detectedBy` 供设置页显示依据）：① `process.argv` 的 `--profile <name>`；② **realpath 比对**——本插件包根（`<root>/lib/<file>` 上溯两级）的 realpath == `profiles/<n>/node_modules/bgjobs` 的 realpath（兼容 `link:` 与 pnpm 软链安装）；③ 只有一个 profile 目录。都不成立 → `{ name: null, reason }` 并给出 `candidates`，**绝不兜底 web**（参考插件 `@xxxyz/dsh-mcp-manager` 2.2.7 的「先 web 再 headless 再任意」在 r4 下会展示错 profile，本模块不复制该缺陷）。
- `readMcpConfigs(scope)`：`active` / `global`（`$DSH_HOME/cordis.patch.yml`）/ 具体 profile 名；抽出 `name: '@deepseek-ai/dsh-mcp-client'` 的条目（支持 `- insert: [...]` 与顶层直挂两种写法），映射成 `{ id, serverName, transport, enabled, needsAttention, config }`。
- **不 eval 任何表达式**：解析前把 `!!js` 表达式整体替换为占位符再交给 `yaml`（未知 tag 不抛错）；含占位符的条目标 `needsAttention: true` + `attentionReason`；`disabled: true` 映射为 `enabled:false`。
  - **两种写法都要吃掉**：带引号（`Authorization: !!js '"Bearer " + process.env.X'`）与**无引号**（`METASO_API_KEY: !!js process.env.X`，r3/res 的真实写法）。占位替换用 `/!!js\b[^\n]*/g` 全吃整行——只匹配带引号形式时，无引号写法会落到 yaml 的未知 tag 分支，值退化成**普通字符串字面量**（静默错导 + 控制台刷 `TAG_RESOLVE_FAILED`）。
  - **scope 级安全网**：文件里确有 `!!js` 却没有任何一条被逐条命中时，**整批**标 `needsAttention`（宁可让用户手工核对，也不静默导入）。`readMcpConfigs` 与 `parseServerImport` 各有一份。
  - **已知限制**：flow 风格（`{ a: !!js x, b: 1 }`）会把同行后续内容一并吃掉，`YAML.parse` 通常直接失败并返回 `parseError`（UI 可见的显式错误，不是静默错导）。
- 导入**只读** DSH 配置、一次性拷贝（同名不覆盖 → `skipped`；`needsAttention` 默认拒导，`force=1` 才导），不回写 DSH 的 patch，也不接管其 MCP 生命周期。

### 端点与持久化

- `GET/POST /bgjobs/mcpprefs`（`mcp-prefs.json`，默认 `{enabled:false}`，联动预热）。
- `GET/POST /bgjobs/mcpservers`（`mcp-servers.json` = `{ servers: { <name>: <config + prewarm + enabled> } }`，`enabled` 缺省 `true`、`prewarm` 缺省 `false`）：GET 列表**不回传 env/headers 的值**（只回键名）；POST 新增/覆盖（`?config=<urlencoded JSON>` 或 JSON body）、`?delete=1`、`?enabled=0|1` 与/或 `?prewarm=0|1`（状态补丁，只改请求里出现的键；两者可一次带上，如 `?enabled=1&prewarm=0`）、`?probe=1`。写入经 `normalizeConfig` 校验（fail loud），未显式给 `prewarm` / `enabled` 时保留原值。
  - 状态口径（设置页三态按钮）：`预热` = `enabled:1&prewarm:1`；`冷启动` = `enabled:1&prewarm:0`；`禁用` = `enabled:0`（只写 `enabled`，保留 `prewarm` 原值以便一键切回）。被禁用的 server：`bgjob_submit_mcp` / `bgjob_mcp_tools` **硬拒绝**（错误文案由 `mcpServerDisabledError` 生成，与总开关的 `MCP_DISABLED_ERROR` 区分），并断开其常驻连接、不再预连；`?probe=1` 仍可用。老文件缺 `enabled` 视为启用（`raw.enabled !== false`，不改写磁盘直到下次写入）。
- **编辑用单条明细**：`GET /bgjobs/mcpservers?name=<n>` → `{ ok, name, config }`，**含 env/headers 值**（设置页「编辑」用，回填表单后再 `POST` 覆盖）。口径：列表不回值（防翻看面板时泄漏），单条明细按需回值（本机回环网页、用户显式点击）——两处都要写进文档，改前端别误用列表做编辑回填。
- **导出**：`GET /bgjobs/mcpservers?export=yaml|json[&name=<n|*>]` → `{ ok, format, names, text }`。实现在 `lib/dsh-profiles.js#serializeServers`：
  - `yaml` = **DSH 兼容片段**（`- insert: [{ id: 'mcp-<name>', name: '@deepseek-ai/dsh-mcp-client', config: { serverName, transport, … } }]`，每条一个 `insert`，与 DSH 侧实际写法一致；`timeoutMs` → `toolCallTimeoutMs`；文件头注明明文密钥与用法）；
  - `json` = bgjobs 原生 `{ "servers": { … } }`（含 `prewarm` / `enabled`），可被导入原样吃回。
- **导入**：`POST /bgjobs/mcpservers?import=1`，body `{ text, mode:'skip'|'overwrite', force }` → `{ ok, source, hasJsTag, imported[], skipped[], rejected[] }`。解析在 `lib/dsh-profiles.js#parseServerImport`，自动识别四种形态（DSH patch 片段 / `{servers:{…}}` / 单个配置对象 / 配置数组），并**不 eval 任何表达式**：`!!js` 先替换为占位符；若整份文本含 `!!js` 却没有任何一条被逐条命中，则**整批**标 `needsAttention`（安全网，避免表达式被当普通字符串静默导入）；`needsAttention` 条目默认进 `rejected`，`force` 才写。逐条写入仍走 `setMcpServer`（校验失败进 `rejected` 并透出原因）。
- `GET /bgjobs/dsh-mcp`（活动 profile + 各 scope 条目 + 已登记名）、`POST /bgjobs/dsh-mcp?action=import&scope=…&name=…&force=…`。
- store 的 MCP 懒读是**单飞 + 读回填不覆盖期间写入**：并发读共享同一次文件读，且若读回填时缓存已被 `setMcp*` 写入，保留写入值（否则用户点开关/登记的那几毫秒里会被在读的旧值覆盖——实测过的竞态）。
- 离线 CLI/GUI **不做 MCP 提交**（`Submit-BgjobsJob` 的 `-Engine` 仍是 `bat|pwsh`），只要求只读查看/删除对未知 `engine` 不报错（`engine` 只是展示字段，不参与分支）。

### 设置页结构与凭据口径（client / 安全）

- **两页**：`settings.section` 是 list seat，本插件注册两项 —— `bgjobs`（「后台任务」：入口/面板/离线 GUI/字段显示）与 `bgjobs-mcp`（「MCP 任务」：总开关 / server 登记（含编辑）/ 导出导入 / 从 DSH 导入）。拆页是为了避免单页过长；导航 label 走 i18n `settings.nav` / `settings.mcp.nav`。
- **「编辑」**：`GET /bgjobs/mcpservers?name=<n>` 取单条明细（含值）回填表单 → 保存仍走同一个 `POST /bgjobs/mcpservers`（同名覆盖）。列表用列表端点（不含值），**不要**用列表数据做编辑回填，否则会把 env/headers 清空。
- 提示文案：预热说明与明文密钥提示写在各区块的说明行（i18n `settings.mcp.prewarmHint` / `settings.mcp.secretHint`）；每行的三态说明走 `settings.mcp.modeHint`（另有 `modeCold` / `modeDisabled` / `modeTitlePrewarm|Cold|Disabled`）。
- **每行三态按钮**：不用 `Switch`（右侧的 36×20 开关易被误认成总开关），改为带文字的互斥按钮 `预热` / `冷启动` / `禁用`，以「文字 + 语义色」双重区分（预热=琥珀 `--dsw-alias-state-warn-label`、冷启动=绿 `--dsw-alias-state-success-primary`、禁用=灰 `--dsw-alias-label-secondary`，激活态另加 `--dsw-specific-selector` 底色与描边）；点击分别发 `?enabled=1&prewarm=1` / `?enabled=1&prewarm=0` / `?enabled=0`。总开关仍用 `Switch`。
- **面板标题栏两个快捷入口**：⚙（`IconSettingsOutline16`）→ `openBgjobsSettings({ label: t('settings.nav') })` 定位 `bgjobs` 页；数据齿轮（`IconDataOutline16`，即带齿轮的数据库图标）→ `openBgjobsSettings({ label: t('settings.mcp.nav'), rowId: 'bgjobs-mcp' })` 定位 MCP 页。两者各受独立元素键控制（`settingsButton` / `mcpSettingsButton`，缺省均显示）；定位失败/无设置入口时各自弹 toast（复用 `settings.open.failed`）。新增元素键须同时改 5 处：host `store.js` 的 `ELEMENT_KEYS`+`DEFAULT_ELEMENTS`、client `gui-prefs.js` 的 `DEFAULT_ELEMENTS`、client `settings-section.js` 的 `ELEMENT_KEYS`、client `panel.js` 的读取点、i18n `element.<key>`（zh+en）——漏一处即表现为「设置页无该项」或「改不动」。
- **凭据落盘面（明文，三处）**：`$DSH_HOME/bgjobs/mcp-servers.json`（登记表）、任务目录 `<jobDir>/mcp.json`（任务自包含，随任务一起存在）、导出的 YAML/JSON 文本。README「已知限制」已提示分享/归档前脱敏（任务目录最容易被连带打包）。
- **回归**：`tests/mcp-web.test.js` 用桩 React 加载 `lib/client.js`，断言注册了 `bgjobs` + `bgjobs-mcp` 两页且两页都能渲染；改过 `lib/client-src/` 必须先 `pnpm build:client`，否则该用例读到的仍是旧产物（同时 CI 的产物漂移检查会拦）。

### 本地 demo server（测试/自测）
`tests/fixtures/demo-mcp-server.mjs` 是零依赖纯 stdio NDJSON 的最小 MCP server，提供 `echo {text}` / `sleep {seconds}`（上限 300s，够跨 agent 回合做停止/让路回归）/ `fail {message?}`；环境开关 `DEMO_MCP_STALL_MS`（每请求前延迟）、`DEMO_MCP_BROKEN=1`（不响应 `initialize`）。自动化测试与手工验证**一律用它**（不触网、不依赖付费 MCP）。手工自测可登记为：

```json
{ "transport": "stdio", "command": "<node 绝对路径>", "args": ["<repo>/tests/fixtures/demo-mcp-server.mjs"] }
```

## 完成通知创建者Agent（v0.1.31，可选 notify）

- 参数：`notify` = `off`（缺省，仅 toast）/ `on-completion`（仅 exit 0）/ `on-fail`（仅非零）/ `on-exit`（任何退出）；`notify_mode` = `wakeup`（缺省）/ `quiet` / `always`。
- 送达路由（`deliverCompletionNotice`，参照 harness `tool-jobs` 的 onJobDone）：
  - `ctx.get('agents')` 可选服务；`agents.get(createdBySession)` 拿 live handle；缺位/会话已关/跨作用域 → 静默跳过（toast 兜底，不重试）。
  - 忙碌（`status !== 'idle'`）→ `inject`（排下一步收件箱，turn 关不掉未领消息）；空闲 + wakeup（预算内）或 always → `followup` 唤醒一轮；quiet → 恒 `inject`。
  - wakeup 预算：同 session 连续 2 次由 bgjob 通知触发的唤醒后降级 inject；`agent/inbox/claimed` 且 `message.source.kind === 'user'` 时重置（防「完成→提交新任务→再唤醒」自激链）。
  - 消息：纯文本 UserMessage（`randomUUID` id + `role: user` + source `{kind:'plugin', plugin:'bgjobs'}`），一行「后台任务『name』已完成/已结束（exit code N）」。
- **幂等**：`deliverCompletionNotice` 成功（inject/followup 未抛）后由 `markDelivered(job,'notify')` 把 `notifiedAt/notifiedBy` 并入 job.json——恢复判重依据「notifiedAt 已落盘」，漏送窗口极小且 toast 兜底，可接受。

### 结果交付标记与 notify 视图（v0.1.60，全任务）

每个任务的「结果是否已交付到 agent 上下文」由 `notifiedAt`（首次交付时间）+ `notifiedBy`（`notify` | `wait`）标记：**缺省即 pending（待交付）**。两条交付通道，先到者生效、不覆盖：

```
submit ─► [pending-running] ──done──► [pending-done]
             │                          ├─ notify≠off 且完成通知投递成功 → [delivered · by=notify]
             │                          ├─ wait 返回了它的结果        → [delivered · by=wait]
             │                          └─ (仍 running / 投递失败)    → 保持 pending
             └──────────── removed / 清理后不再参与 notify 视图
```

| 标记 | 含义 | 进入方式 | notify 视图是否包含 |
|---|---|---|---|
| pending-running | 未交付，运行中 | submit | ✔ |
| pending-done | 已完成但结果未入上下文 | done（notify 未投递/失败/尚未被 wait） | ✔ |
| delivered·notify | 完成通知注入成功 | `deliverCompletionNotice` 成功 → `markDelivered(job,'notify')` | ✘ |
| delivered·wait | wait 返回了该结果 | 任一 wait（jobId/any/all/submit wait）命中返回前 `markDeliveredId(id,'wait')` | ✘ |
| removed | 已删除 | cleanup / 拖删 | ✘ |

- **notify 视图** = 本会话（`createdBySession`）中 pending 的任务；`sessionPendingIds` 单一实现，供 `bgjob_wait`/`bgjob_wait_all` 缺省与 `bgjob_pending_list` 同源。
- wait 返回某任务结果即视为一次「上下文注入」——done 结果在返回前被置 delivered·wait 并落盘；已交付任务不会被缺省 wait 重复返回。
- 面板 `/bgjobs/state` 的 `view()`、`bgjob_list`/GUI 均输出 `notified/notifiedAt/notifiedBy`；GUI 列表加「通知」列。

## Web 面板（lib/client-src → 构建产物 lib/client.js）可维护要点

- 源码在 `lib/client-src/`（多文件：i18n / ui 原子 / panel 主组件 / apply 装配 / index 入口），由 `pnpm build:client`（esbuild，见 `scripts/build-client.mjs`）打进**单文件** `lib/client.js`（产物提交入库）。**不再免 build**：改面板源码后需先 `pnpm build:client` 再刷新/重启。
- 运行时铁定单文件（harness client-modules 约束：factory 的 `require` 只认模块表词，无相对路径通道）——相对 import 必须在构建期内联；`react` / `react-dom` / `@deepseek-ai/dsh-client-ui-primitives` 是模块表 seed，保持 external（try/catch require 语义不变）。
- 主题：只用 `--dsw-*` token；组件来自 `@deepseek-ai/dsh-client-ui-primitives`（PLATFORM_MODULES 共享表直接 `require`：Toast、Icon 组件），每个都 try/catch 回退文本符号。
- 层叠：面板 z-index 接近上限仍会被 `shell.overlay`（z-index 20 层叠上下文）困住 → `react-dom` **createPortal 到 document.body**（v0.1.27 实测）；`PANEL_Z = 2147483000`、`TOAST_Z = +1`。
- 交互：拖拽用 pointer 事件 + `draggedRef` 位移阈值区分拖/点（悬浮球/折叠条/行区同款）；`data-bgjobs-ctrl` 让拖拽守卫忽略控件（防 setPointerCapture 吞 click）。
- 状态：`open`（展开）/ 折叠（仅任务列表，fit-content 自适应宽、按行高、锚定到折叠按钮位置）；`minimized`（悬浮球，落在最小化按钮位置）。清理菜单 = 🧹 下拉二选一。
- 宿主集成（v0.1.64）：面板 occupant 在 `shell.overlay`（root/list，id `bgjobs-monitor`，order 50）；**新增左侧栏脚部入口** occupant（`sidebar.footer.action` root/list，id `bgjobs-monitor-toggle`，order 60），ui-cordis 同款 best-effort——宿主组合无 ui-sidebar 时该 inject 静默等待、不注册，面板照常、boot 不失败；入口无需 import 任何 harness 包（slot 名 = 字符串契约），不新增 external。
- 显隐共享 store（v0.1.64）：`lib/client-src/monitor.js` 的 apply 级 `createMonitorStore`（`getVisible`/`toggle`/`subscribe` 对齐 `useSyncExternalStore`）+ `useMonitorVisible` hook（monitor 缺位恒 true）。面板「隐藏」用 **display:none 保持挂载**（几何/折叠/悬浮球/jobs 状态保留，轮询照常）；toast 独立不受影响。入口组件 `lib/client-src/sidebar-action.js`：宽栏 = 图标 + 「后台任务」行，rail（56px）= 仅图标；`aria-expanded`/键盘可用。
- DSH 设置 section（v0.1.65）：新增 occupant 注册进 `settings.section`（root/list，id `bgjobs`、order 30、label thunk `settings.nav`），组件 `lib/client-src/settings-section.js` 自绘：① `Switch`（primitives，缺位自绘退化）控制**左栏入口显隐**（偏好持久化 `$DSH_HOME/bgjobs/ui-prefs.json`，缺省 false → 入口默认隐藏）；② 「打开离线 GUI / 打开所在文件夹」走 host `/bgjobs/gui` POST（`gui-launch.js`：`resolveShell()` 解析解释器 + `spawn -WindowStyle Hidden -File tools/dsh-bgjobs-gui.ps1`，或 `explorer /select,` 定位）；③ 展示 GUI 脚本路径（GET 回显）。偏好共享 store `lib/client-src/gui-prefs.js`（`createGuiPrefsStore`/`loadGuiPrefs`/`useGuiPrefsEnabled`），sidebar-action 空渲染门控、设置开关即时生效。
- 路由扩展（v0.1.65）：`/bgjobs/uiprefs`（GET/POST `?sidebarEntry=0|1`）与 `/bgjobs/gui`（GET 信息 / POST `?action=open|reveal`）；spawn 经 `gui-launch.setGuiSpawn` 注入（测试替身同 runners 模式）。
- 设置页修复与增强（v0.1.66）：`/bgjobs/gui` GET 附 `version`（`lib/meta.js` 读包版本，模块级缓存）；「打开所在文件夹」客户端**优先第一方 `POST /open-in-app/open`**（`{app:'explorer', path:<tools 目录>}`，DSH 已验证的 explorer 打开机制；官方端点只收现存目录），不可用回退宿主 reveal；spawn 等 `'spawn'` 事件确认真实拉起（`'error'` → `{ok:false,error}`），失败一律透出到设置页结果行；监控面板显隐开关复用 monitor store 的 `setVisible`。附带修复：tools 三个 ps1 曾被反复写入**双 BOM**（运行时首行解析噪音，pwsh 报 `'works' 不是命令`），已规范为单一 UTF-8 BOM（字节级 EF BB BF + `#`）。
- 启动/打开机制收敛（v0.1.67→v0.1.68）：真根因 **DETACHED_PROCESS 让 pwsh 秒退不执行**（§56），且 Start-Process 载体下 GUI 仍与宿主共享控制台（Ctrl+C 会杀 GUI）→ **打开离线 GUI = 写临时 UTF-8 .cmd（`chcp 65001` + `start "" <pwsh> -WindowStyle Hidden -File <gui.ps1>`，引号语义在文件内规避 Node 对 argv 内嵌引号的 `\"` 转义）+ spawn cmd.exe `/d /c` 判活**；**打开所在文件夹 = `explorer.exe <目录>` 直开**（Invoke-Item 实证对本机目录静默 exit 0 不弹窗；explorer 单实例握手后 exit 1，判活忽略退出码、只看 spawn 是否成功），客户端 reveal 不再走第一方 open-in-app 端点。
- 机制最终形态（v0.1.69）：用户实证 **宿主在 Job Object 内——Ctrl+C 连第一方 open-in-app 拉起的 VS Code/资源管理器都一并消失**，独立控制台/进程组均逃不掉；且 explorer.exe 直开在其 Win10 **堆积 explorer 进程不弹窗** → **打开离线 GUI = schtasks 一次性任务**（`/Create /TN dsh-bgj-gui /F /SC ONCE /ST now+60s /TR "<pwsh> ... -WindowStyle Hidden -File gui.ps1"` → `/Run` → `/Change /DISABLE` 防整分双跑；Task Scheduler 服务起进程，不在宿主 job 内，Ctrl+C/宿主退出不杀；固定任务名 /F 覆盖不堆积）；reveal 回退为**第一方原语 powershell Invoke-Item + 客户端优先官方 open-in-app 端点**（不再 spawn explorer.exe）。
- schtasks /TR 长度上限补丁（v0.1.70）：商店(pnpm)深路径安装（`node_modules\.pnpm\bgjobs@…`）使 `/TR "<pwsh> … -File <深路径>"` 达 258 字符即越界（任务 Last Result 64、静默不跑）→ `/TR` 改为 `"cmd.exe" /c "%TEMP%\bgjobs-gui-launch.cmd"`，长命令（`start "" "<pwsh>" … -File "<gui>"`）写入该短路径批处理；进程父链仍 = 任务，脱离宿主 job 性质不变。
- Toggle：轨道/滑块组件，`onColor` 自定义开启色——「全权限」用 `--dsw-alias-state-warn-primary`（与 dsh 审批提升面板同色）；「仅当前会话」默认 `--dsw-alias-state-business-primary`。

## 测试与发布

### 测试

- `pnpm test`（=`node --test "tests/**/*.test.js"`，不依赖 DSH）。用例按功能分布在 `tests/*.test.js`（unit / tools / submit / watch / routes / sandbox / notify / wait / mcp / mcp-web），共享工具与套件隔离在 `tests/helpers/common.js`。覆盖：纯函数、工具注册契约、提交/完成/恢复/保留、webServer 路由、沙箱决策矩阵与审批、notify 矩阵与送达路由、wait/交付标记、MCP（开关双层拦截 / 提交与 mcp.json 落盘 / server 登记解析 / runner 端到端 / 工具列表与缓存 / 预热通道与回退 / profile 判定与 DSH 导入 / 端点）。MCP 用例一律用 `tests/fixtures/demo-mcp-server.mjs`（本地、离线）。
- 测试替身 seam（模块级，测试内成对恢复）：`setSchtasksRunner`（schtasks/icacls/taskkill 都走它）、`setShellResolver`、`setSandboxRunnerResolver`、`setPrewarmFactory`（捕获本 apply 的预热域以驱动 warm/endpoint 断言）。
- 回归注意：
  - `/bgjobs/state` 路由含 `await readFullAccess()` → 测试调 `handler` 必须 `await`；
  - makeCtx mock 需提供 `ctx.on`（apply 注册了 `agent/inbox/claimed`）；触发事件 = `onCallbacks.find(...)?.fn(payload)`；
  - 视图是**附加字段宽容**的（`finishedAt` 等），但新增依赖字段的 UI 要显式断言其存在；
  - MCP 预热相关用例会真起 `127.0.0.1` 回环代理与子进程：代理监听已 `unref`、定时器已 `unref`，用例结束务必 `dispose()`/恢复 `setPrewarmFactory`，否则残留子进程会拖住测试进程退出。
- `tools/smoke-test.ps1`：离线 CLI 冒烟，**pwsh 7 与 powershell 5.1 各跑一遍**。

> 测试脚本中不得出现个人用户名或本机路径。

### 文本文件 BOM 规约与清理工具

- **坑**：PowerShell 用 `[System.IO.File]::WriteAllText($p, $text, [System.Text.UTF8Encoding]::new($true))` 写一个**已带 BOM** 的文件时，BOM 会**叠加**（实测累积到 8 个）。PowerShell 只剥第一个，其余变成首行内容里的 U+FEFF → 首行注释被当命令执行（报 `'works' 不是命令` 之类），而 `Parser::ParseFile` 语法检查正常，极难定位。
- **规约**：含中文的 `.ps1/.bat` 保持 **UTF-8 with BOM**；改写时**只去掉多余 BOM，不要无条件补写 BOM**（无 BOM 的文件保持无 BOM，避免污染 diff）。
- **工具**：`pnpm fix:bom`（=`node scripts/fix-bom.mjs --write`，实测归一 ×N → ×1）、`pnpm check:bom`（只检查，发现多余 BOM 时退出码 1，可用于提交前/CI 把关）；支持 `node scripts/fix-bom.mjs <目录|文件>` 指定范围、`--all` 关闭扩展名白名单。纯字节级操作（UTF-8 BOM = `EF BB BF`），不解码文本。
- 改完 `.ps1` 后建议核对首字节恰为一组 `EF BB BF`（`[System.IO.File]::ReadAllBytes($p)[0..2]`）。

### 依赖与本地安装

- 沙箱 runner 依赖 + koffi（原生）需在**插件目录内** `pnpm install`（Node 从插件真实路径向上解析 require；宿主 `link:` 装不进插件目录）。
- pnpm ≥10 不再读 package.json 的 `pnpm` 字段；构建白名单在 `pnpm-workspace.yaml`（`allowBuilds: { esbuild: true, koffi: true }` + `onlyBuiltDependencies: [esbuild, koffi]`）；alpha 依赖在 `minimumReleaseAgeExclude`。`pnpm-lock.yaml`/`node_modules` 均被 .gitignore 排除（esbuild 属 devDep，仅插件仓库开发时需要；profile 经 link 安装不需装它）。

### 固定发布流程（每次改动）

1. 递增 `package.json` 版本（默认只升末位）；
2. 若改过 `lib/client-src/`：先 `pnpm build:client` 再确认 `git diff --exit-code -- lib/client.js`（产物已提交、无漂移；CI 发布前也会重建并比对）；
3. 更新 `README.md`（包括「近期更新」） / `docs/developer.md` 如有用户/开发者可读变化；
4. `pnpm test` 全绿 + `pnpm check:bom` 无「多余 BOM」→ `git add`（按文件）→ commit。

> 发布前抽查发布面：`npm pack --dry-run 2>&1 | Select-String "tools/dsh-bgjobs|client-src"`——应含 `tools/`（离线 CLI/GUI/toast 随包）、**不含** `lib/client-src`（构建源）。

安装到 profile（在 harness 仓库目录执行，插件目录下会 fallback 到残缺全局 CLI）：

```powershell
pnpm dsh plugin --profile <profile> add link:<插件绝对路径>
```

`package.json`（版本号等）变更需重新执行 add；`lib/core|lib/*.js` 改动即时生效；`lib/client-src/` 改动需先 `pnpm build:client` 再刷新（必要时重启）。
