# bgjobs (standalone background jobs) — DSH 独立后台任务插件

**中文** · [English](README.en.md)

[![npm version](https://img.shields.io/npm/v/bgjobs)](https://www.npmjs.com/package/bgjobs)
[![GitHub tag](https://img.shields.io/github/v/tag/bitsmug/dsh-bgjobs)](https://github.com/bitsmug/dsh-bgjobs/tags)
[![publish](https://github.com/bitsmug/dsh-bgjobs/actions/workflows/publish.yml/badge.svg)](https://github.com/bitsmug/dsh-bgjobs/actions/workflows/publish.yml)
[![License](https://img.shields.io/npm/l/bgjobs)](LICENSE)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/bitsmug/dsh-bgjobs)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

让 DSH 提交的命令脱离 DSH 进程独立运行：任务交给 Windows 任务计划程序服务托管，关掉 DSH 进程、关掉网页都不影响执行；网页悬浮面板实时展示输出；DSH 离线时还能用独立 CLI/GUI 管理。

适合大文件下载、批量脚本、编译、数据同步/导出这类长任务—— **DSH 崩溃（通常因内存不足OOM）亦不影响任务运行**。

## 快速安装

1. 打开 DSH 官方桌面客户端或网页，点击左侧导航栏的“插件”入口，转至插件页，点击右上角的“添加插件”；
2. 在插件安装输入框中输入 `bgjobs` （或 GitHub 最新版：`github:bitsmug/dsh-bgjobs`）并确认安装；首次安装时会提示要求允许 `pnpm approve build`，点击允许后再次安装即可。

## 目录

- [快速安装](#快速安装)
- [特性一览](#特性一览)
- [前置依赖与兼容性](#前置依赖与兼容性)
- [安装 / 卸载](#安装--卸载)
- [使用（agent 工具）](#使用agent-工具)
- [网页面板](#网页面板)
- [离线管理 CLI（DSH 不运行也能用）](#离线管理-clidsd-不运行也能用)
- [图形面板（GUI）](#图形面板gui)
- [配置与数据](#配置与数据)
- [使用须知](#使用须知)
- [维护与开发](#维护与开发)
- [贡献](#贡献)
- [近期更新](#近期更新)
- [许可证](#许可证)

## 特性一览

| 能力 | 说明 |
|---|---|
| 进程外独立运行 | 任务经 `schtasks` 托管，DSH 崩溃/关闭不影响 |
| 实时输出面板 | 网页右下角浮动面板每秒刷新输出：可拖拽、最小化为悬浮球、折叠为仅任务列表、随主题换肤；按工作区分组、可调大小；左栏底部入口可一键隐藏/唤出。任务行显示运行时长（运行中实时增长、完成后为总耗时），字段显示位置可按「列表 / 详情 / 隐藏」逐项配置 |
| 清理已完成 | 🧹 点击右上角清理图标开启垃圾篓：拖拽单条已结束任务删除，或批量清理（仅超 24h / 全部，与视图过滤一致）；判定不出进程状态的任务（探针/反查本身跑不起来）会先弹**警告确认框**（说清"继续可能留下看不见的孤儿进程"并原样展示原因），点「确认清理」才带 `force` 动手 —— 取消则一个记录都不删 |
| 完成通知 | 任务退出即弹 Toast（不打扰会话）；可选把通知发回创建它的 agent（`notify` 参数） |
| 会话内等待 | `bgjob_wait` 让 agent 等结果而**不阻塞对话**：缺省不限时（可在设置页配「默认等待超时」），期间被新入站消息让路或被用户停止会立即释放；支持 any 竞速（先完成先返回）与 all 合取（任一失败即刻返回） |
| 断线续跟 | DSH 重启自动恢复跟踪；旧任务 id 也能从磁盘查询状态 |
| 离线管理 | 不依赖 DSH 的 CLI / GUI：list / status / log / submit / kill（终止进程）/ delete（删记录）/ cleanup |
| 可选沙箱 | `bgjob_submit_pwsh` 可选 `sandbox` 约束后台任务文件权限，权限不高于当前会话模式 。沙箱后端选择开关（默认关）：开启后可传 `sandbox_backend: 'dsh'`，改为复用当前会话的 dsh 沙箱 provider（`ctx.sandbox.confine`），支持 [dsh-sandbox-mxc](https://github.com/bitsmug/dsh-sandbox-mxc) 沙箱后端（约束文件权限和网络权限） 。沙箱后端选择开关 = 面板「沙箱选择」 |
| MCP 调用托管 | `bgjob_submit_mcp` 把一次 MCP 工具调用提交为后台任务（设置页开关，默认关闭）（暂不支持沙箱）；可登记 server 或从 DSH 配置一键导入；每个 server 可选「预热 / 冷启动 / 禁用」三态（禁用后 agent 调用被拒） |
| 零残留 | 任务跑完自删任务计划；done 任务默认保留展示，用户手动清理 |

## 前置依赖与兼容性

| 前置 | 兼容 | 推荐 |
|---|---|---|
| Windows | `10`-`11` | `11` (build `>=26300`) |
| PowerShell 7+ | `>=7.6.5`（沙箱功能需[ zip 解压版 PowerShell](https://learn.microsoft.com/zh-cn/powershell/scripting/install/install-powershell-on-windows?view=powershell-7.6#install-the-zip-package)） | [`>=7.7.0`](https://github.com/PowerShell/PowerShell/releases#release-v7.7.0-preview.5) |
| DSH |`0.1.2-rc.1` ~ `0.2.1-rc.3`（rc版）  （[官方桌面版](https://www.deepseek.com/harness/)/以`win`+`R` 运行 [npx @deepseek-ai/dsh web](https://github.com/deepseek-ai/deepseek-harness#run-from-npm)） |  `0.2.1-rc.3` |
| Node.js | `^22.19.0 \|\| >=24.0.0`（或自动使用官方桌面版自带Node） | [`>=24.22.1`](https://nodejs.org/zh-cn/download) |

| 插件（可选） | 兼容 |
|---|---|
| [dsh-sandbox-mxc](https://github.com/bitsmug/dsh-sandbox-mxc) | `0.1.2` (最新版)|
| [dsh-multi-folder](https://github.com/AngelosZou/dsh-multi-folder) | `0.3.4` |


## 安装 / 卸载


**方式 A（最省事，插件管理器（GUI 插件入口）；DSH `>=0.2.0-rc.2`）**

1. 打开 DSH 官方桌面客户端或网页，点击左侧导航栏的“插件”入口，转至插件页，点击右上角的“添加插件”；
2. 在插件安装输入框中输入 `bgjobs` （或 GitHub 最新版：`github:bitsmug/dsh-bgjobs`）并确认安装；首次安装时会提示要求允许 `pnpm approve build`，点击允许后再次安装即可。

**方式 B（快速，npm 发布版）**

```sh
$pf="web"; dsh plugin --profile $pf add bgjobs || dsh plugin --profile $pf approve-builds koffi; dsh plugin --profile $pf add bgjobs && Write-Host "✓ bgjobs安装成功！" -ForegroundColor Green
```

> 把 `web` 改成你自己的 profile 名，整行粘贴到 PowerShell（pwsh）即可。第一次 `add` 会报 `ERR_PNPM_IGNORED_BUILDS`（koffi 构建脚本未批准），`||` 会自动触发 `approve-builds` 批准并运行 koffi 构建，再 `add` 成功后打印「bgjobs 安装成功」。

**方式 C（从 GitHub 安装，始终最新）**

```sh
$pf="web"; dsh plugin --profile $pf add github:bitsmug/dsh-bgjobs || dsh plugin --profile $pf approve-builds koffi; dsh plugin --profile $pf add github:bitsmug/dsh-bgjobs && Write-Host "✓ bgjobs安装成功！" -ForegroundColor Green
```

> 直接从 GitHub 仓库默认分支拉取，**始终是最新代码**（含刚发布与未发布改动），不受 npm registry 同步延迟影响。以上方式装完包名都是 `bgjobs`，卸载命令相同。

**从插件市场(dsh-market)安装报 `ERR_PNPM_IGNORED_BUILDS`？**

插件依赖原生库 `koffi`，安装会触发它的构建脚本，而 pnpm ≥10 默认阻止依赖运行构建脚本（GitHub 安装还会跑 `prepare`）。报错形如：

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: koffi@3.2.1
dsh: pnpm failed in profile directory <你的 DSH home>\profiles\<profile>
```

处理（把 `web` 改成你自己的 `<profile>` 名，整行粘贴到 PowerShell（pwsh）即可）：

```sh
$pf="web"; dsh plugin --profile $pf approve-builds koffi; dsh plugin --profile $pf add bgjobs
```

第一条命令批准并运行 koffi 的构建脚本，随后重新 `add` 即可装上。

若你的 DSH 版本没有 `approve-builds` 子命令，改为手动处理：打开报错里打印完整路径的 `pnpm-workspace.yaml`，会发现首次失败的 `add` 已写入一行占位 `set this to true or false`，把它改成 `true` 后重新 `add`：

```yaml
allowBuilds:
  koffi: true
```

仅首次安装需要，装好后 koffi 已编译完毕，升级/重装无需重复。

重启 DSH 后生效（**完全退出并重新启动**——桌面客户端与网页版都是）：网页右下角出现「后台任务监控」面板，agent 获得 `bgjob_submit` / `bgjob_submit_pwsh` / `bgjob_submit_mcp` / `bgjob_mcp_tools` / `bgjob_status` / `bgjob_wait` / `bgjob_kill` / `bgjob_delete` 工具（MCP 两个工具需先在设置页打开「MCP 任务」开关）。

**方式 D（本地源码开发）**

1. 把仓库放到本地插件目录（路径不要含中文），如 `D:\dsh\plugins\bgjobs`；
2. 让 DSH 的模块解析器能找到它（把插件目录 junction 到 DSH 的 `node_modules\bgjobs`，或把目录加到 DSH 的插件扫描路径）；本地开发还需在插件目录执行一次 `pnpm install`（沙箱 runner 依赖，见下）；
3. 编辑 `<DSH_HOME>\profiles\<profile>\cordis.patch.yml` 追加挂载：

```yaml
- insert:
    - id: bgjobs
      name: bgjobs
```

**卸载：** `dsh plugin --profile <profile> remove bgjobs`

> 方式  B / C / D 装完都要**重启 DSH**（完全退出并重新启动）才生效。

## 使用（agent 工具）

**工具总览**（完整参数、取值与边界见 [docs/developer.md](docs/developer.md)；逐项语义随后并入该文档）

| 工具 | 一句话 |
|---|---|
| `bgjob_submit` | 提交后台任务（`command` 为 **bat** 语法） |
| `bgjob_submit_pwsh` | 提交后台任务（**PowerShell** 语法；UTF-8 日志、`exit <code>` 语义安全；可选 `sandbox` / `sandbox_backend` / `output_encoding`） |
| `bgjob_submit_mcp` | 把一次 **MCP 工具调用**提交为后台任务（默认关闭，需「MCP 任务」开关；退出码 0/1/2/3） |
| `bgjob_mcp_tools` | 列出某 MCP server 的工具名 / 描述 / 必填字段（有缓存，`refresh: true` 强制刷新） |
| `bgjob_status` | 查询状态 / 退出码 / 日志尾部（**别拿它轮询**；终态权威与 `wrapper-gone` 三态见 developer.md） |
| `bgjob_wait` | 等任务结束并立即返回；`logic: 'any'`（缺省，竞速）/ `'all'`（合取）；`timeoutSeconds` 缺省 = 设置页「默认等待超时」 |
| `bgjob_list` | 列出当前 agent 会话提交的全部任务（id/状态/退出码） |
| `bgjob_kill` | **只终止进程树、不删记录**（补写非 0 退出码 1 + `exitCodeSource: 'killed'`；`mode` 三态，`unknown` 需显式 `force`） |
| `bgjob_delete` | **只删记录、不杀进程**（有活进程时拒绝并提示先 `kill`；`mode` 三态） |

直接对 AI 说一句即可（说清工作目录、任务名，以及要不要等结果 / 通知）：

> 把「clone Linux 内核源码到 `D:\work\linux`，再 `make -j16` 编译」这条长链路放后台跑，跑完通知我（`notify: on-exit`）——别让编译占着对话。

> 并行起两个后台任务：一边下载数据集、一边重新编译；**谁先完成就先给我看结果**，另一个继续跑（any 竞速，不必等齐）。

> 用 pwsh 引擎把 `D:\data` 下 30 个 CSV 批量转成 UTF-8；我要**全部成功才继续**，任何一个失败就立刻停下来（`logic: 'all'`）。

> 把一次 MCP 调用提交成后台任务：server `glm` 的 `web_search`，query=「大模型最新进展」，跑完把结果发回本会话。

- 任务输出实时写入 `<workdir>\.dsh\bgjobs\<jobId>\stdout.log`；
- 退出后 `<workdir>\.dsh\bgjobs\<jobId>\exitcode.txt` 写入退出码，网页弹 Toast；
- 完成后**默认不打扰会话**；需要让 agent 主动得知并收尾时，传 `notify: on-exit`（或 `on-completion` 仅成功 / `on-fail` 仅失败），并可选 `notify_mode`（`wakeup` 空闲唤醒 / `quiet` 仅入收件箱 / `always`）；
- **交付标记（notify 视图）**：每个任务标注「结果是否已交付到会话上下文」——完成通知投递成功（`已通知·notify`）或某次 `bgjob_wait` 返回了它（`已通知·wait`）即交付；`bgjob_pending_list` 列出本会话**尚未交付**的任务（notify 视图），`bgjob_wait` 缺省（含 `logic: 'all'`）只从这个视图等——已交付的结果不会重复返回。面板/离线 GUI 均有「已通知/待通知」标记。

## 网页面板

面板顶部依次是：清理（点击开启底部垃圾篓：拖拽删除单条已结束任务，或点「清理超 24h / 清理全部」批量清理）、折叠（收成仅任务列表）、最小化（悬浮球落在按钮位置）。**判定不出进程状态**的任务（探针/反查跑不起来，既不能确认还在跑、也不能确认已停）默认**一个记录都不删**：面板弹警告确认框并原样列出 host 给的原因，点「确认清理」才带 `force` 执行（取消 = 不发请求）；普通已结束任务与"有活进程被拒"的提示**不受影响**（失败原因现在也会弹 Toast，不再静默）。工具栏两个开关：「仅当前会话」（只显示当前会话工作区任务）与「全权限」（预批准全权限任务，默认关）。点击任务行展开实时日志。任务行默认显示「运行时长」（运行中随面板每秒刷新增长，完成后为总耗时），可在设置 → 后台任务 → 字段显示里改到详情或隐藏。面板文案跟随 DSH 界面语言（中文 DSH → 中文面板，其他 → 英文）。

**接入 DSH 侧边栏**：左侧栏（聊天列表列）底部有 bgjobs 入口（宽栏显示「后台任务」，收起成窄栏时仅图标）——点击可整体隐藏/唤出右侧浮动面板；面板隐藏期间任务照跑、完成照弹 Toast。该入口可在 **DSH 设置 → 后台任务**里开关（**默认隐藏**）。

**DSH 设置里的 bgjobs（两个页面）**：打开 DSH 设置（左下角齿轮），左侧出现「后台任务」与「MCP 任务」两页。监控面板标题栏也有两个快捷入口：⚙ 直达「后台任务」页，数据齿轮图标直达「MCP 任务」页（两者可在设置 → 后台任务 → 界面元素里分别隐藏）。

- 「后台任务」（顶部显示当前插件版本）：① 开关「左侧栏显隐按钮」（默认关，打开后左栏底部出现入口）；② 开关「监控面板」（直接显示/隐藏右下角监控面板与悬浮球，与入口开关相互独立）；③ 「默认等待超时」（数字输入 + 保存）：agent 调用 `bgjob_wait` 未指定 `timeoutSeconds` 时使用的缺省秒数，`0` 或留空 = 不限时；④ 「打开离线 GUI」一键启动独立管理窗口，附 GUI 脚本路径；⑤「打开所在文件夹」经 DSH 自身的文件资源管理器机制打开离线工具目录（找不到 GUI 就到这里找 dsh-bgjobs-gui.bat）；⑥「字段显示」可配置每个任务字段（含「运行时长」）显示在列表/详情/隐藏。
- 「MCP 任务」（默认关闭）：见下。

**MCP 任务（独立设置页，默认关闭）**：

- **MCP 任务开关**：控制 agent 能否用 `bgjob_submit_mcp` / `bgjob_mcp_tools` 提交（关闭时一律拒绝并提示来开启）；开启后即时生效，无需重启 DSH。与 DSH 一致，会话访问模式（read-only 等）不限制 MCP 任务；
- **MCP 服务器**：登记 agent 可按名引用的 server（名字 + JSON 配置）。每行可开「预热」、**编辑**（把该 server 的完整配置载入下方表单，含 env/headers 明文）、点「列出工具」看工具名（点击复制）、删除；列表只回传 env/headers 的键名，不回传值。**预热**＝在 DSH 进程内为该 server 保持一条常驻连接（任务复用它、省去每次冷启动），仅 DSH 存活期有效，连接失败/host 不在时任务自动回退冷启动，**不影响正确性**；只有"确定没执行"的失败才回退——**已发出的调用失败或超时不会重跑**（避免重复副作用），此时任务按退出码 `2`/`3` 结束，可自行重提（v0.1.84）；
- **导出 / 导入**：导出格式二选一 —— **DSH YAML**（`@deepseek-ai/dsh-mcp-client` 条目，可直接并入 `cordis.patch.yml`）或 **bgjobs JSON**（备份/迁移，可被导入原样吃回）；导入支持粘贴或选文件，自动识别 DSH patch 片段 / bgjobs JSON / 单个或多个 server 配置对象（需带 `serverName`），可选「同名跳过 / 同名覆盖」，含 `!!js` 的条目默认拒导（勾选后强制导入，且不会求值——需手工补全 env/headers）。**导出文本与 `mcp.json` 都含明文密钥，分享前请脱敏**；
- **DSH 已有 MCP（导入）**：读取**当前 profile** 或全局 `cordis.patch.yml` 里已配好的 `@deepseek-ai/dsh-mcp-client` 条目，一键导入成 bgjobs 登记（只读 DSH 配置、不改它）。顶部显示「当前 profile」；含 `!!js` 表达式的条目**不会求值**，默认不导入（需手动补全 env/headers）。凡无法逐条确认的表达式，整批条目都会被标红提示核对，不会把 JS 表达式当普通字符串静默导入。

## 离线管理 CLI（DSH 不运行也能用）

```powershell
# 在 tools/ 目录下执行
.\dsh-bgjobs.ps1 list
.\dsh-bgjobs.ps1 status -Id <id>
.\dsh-bgjobs.ps1 log -Id <id> [-Tail 100]
.\dsh-bgjobs.ps1 submit -Name <n> -Command <c> -Workdir <dir> [-Pwsh]
.\dsh-bgjobs.ps1 kill -Id <id> [-Force]                    # 只终止进程（记录保留；补写非 0 退出码 1 = taskkill 记录的真值）
.\dsh-bgjobs.ps1 delete -Id <id> [-NoDeleteDir] [-Force]   # 只删记录（有活进程时会被拒绝，先 kill）
.\dsh-bgjobs.ps1 cleanup [-OlderThanHours 24]   # 0 = 清理全部
.\dsh-bgjobs.ps1 index -Workdir <dir>
```

无法判定进程状态的任务（探针/反查本身跑不起来）**默认什么都不做**：只打印警告并以退出码 `3` 结束，确认要动手请加
`-Force`（GUI 的同口径入口是那条「无法判定进程状态」的确认框）。

## 图形面板（GUI）

双击 `tools\dsh-bgjobs-gui.bat` 即可启动独立窗口（不依赖 DSH）：任务列表/日志、提交（bat 或 pwsh）、终止进程（kill，记录保留）、删除记录（delete，只对已结束/无进程的任务）、清理（超期小时数可调，或全部）、重建索引。工具栏**「📌 桌面快捷方式」**可一键在当前用户桌面创建指向本 GUI 的快捷方式（双击即开，不弹黑窗）。GUI 与 Toast 文案跟随系统 UI 语言（zh → 简体中文，其他 → 英文）；CLI 输出固定为英文。**找不到 GUI？** DSH 设置 → 后台任务 → 「打开离线 GUI / 打开所在文件夹」可直接启动或定位脚本位置。

## 配置与数据

### 环境变量

以下变量都是**可选**的（通常无需设置）：

- `BGJOBS_SANDBOX_RUNNER` — 显式指定沙箱 runner 的路径（缺省自动探测；找不到时提交沙箱任务会明确报错）。
- `BGJOBS_DSH_HOME` — 离线 GUI / CLI 的「便携优先」home；需要钉死时显式指定。
- `DSH_HOME` — 全局状态目录的来源（状态落在 `$DSH_HOME\bgjobs\`）；通常由 DSH 提供。
- `DSH_DESKTOP_NODE_EXECUTABLE` — 桌面版 runtime 的 node 来源（沙箱任务所需的「真 node」优先取自它）。
- `BGJOBS_PWSH` 显式指定 PowerShell 解释器路径。

### 数据与存储

- 任务数据：`<workdir>\.dsh\bgjobs\<jobId>\`（`job.json` 元数据、`stdout.log` 日志、`exitcode.txt` 退出码；MCP 任务另有 `mcp.json` 调用说明与 `result.json` 结果）；
- 全局状态：`$DSH_HOME\bgjobs\`（`index.json` 任务"地图"、`fullaccess.json` 全权限开关、`ui-prefs.json` 网页 UI 偏好、`mcp-*.json` MCP 开关/登记/缓存；逐项含义见 [docs/developer.md](docs/developer.md)）；
- `done` 任务默认持续保留，直到你手动清理（面板 🧹 / CLI cleanup / GUI）。

## 使用须知

- `workdir` 必须是 DSH 工作区内的绝对路径；
- 任务默认「仅用户登录时运行」：关 DSH/终端不影响，但**注销 Windows 会终止任务**；
- 命令不要自带 `> log` 类重定向（插件已整体重定向并保证 UTF-8）；
- **沙箱**：`sandbox` 只约束文件效果（写工作区/临时区外会被拒），网络不受限；它是"尽力而为"而非数学边界——工作目录若落在 Everyone 可写的位置会失效；沙箱任务的任务目录对本地用户可读（脚本文本可见）；bat 引擎任务恒为全权限，受限会话需开启「全权限」才能提交；
- 受限会话里请求超出会话模式的权限会弹窗审批，`justification` 说明理由即可；面板的**「全权限」开关不改变会话访问模式**（不改 DSH 的 mode）——它只决定这种「更宽请求」是弹窗审批（关）还是直接放行（开），任务仍按 resolved 模式落盘。
- **MCP 任务**：默认关闭（设置页开启）；任务**被 kill 时**会按记录的 pid 回收其 stdio MCP server 子进程（`delete` 只删记录、不杀进程；若 server 子进程仍活着，delete 会拒绝并提示先 kill）；每个 server 在设置页可切「预热 / 冷启动 / 禁用」三态——**禁用**会让 `bgjob_submit_mcp` / `bgjob_mcp_tools` 拒绝该 server 并断开其常驻连接（「列出工具」仍可用）；「预热」连接只在 DSH 存活期有效，不改变"任务脱离 DSH 也能跑"；离线 CLI/GUI 只读查看、终止进程与删除记录 MCP 任务，不在离线侧提交 MCP；`mcp-servers.json`、导出文本与任务目录的 `mcp.json` 都含**明文密钥**，分享/归档前请脱敏。
- **等待被停止 ≠ 任务失败**：agent 等待任务时你点「停止/打断」，本次等待会**以错误结束**（错误文案写明各任务当前状态并提示可续等）。这是 DSH 的取消语义——调用方取消后，成功返回的东西送不到模型，只能以错误形态呈现；任务本身继续后台运行、不标记已交付，agent 可再次 `bgjob_wait` 续等。等待期间收到其它 agent 的消息则正常返回让路（`stoppedBy: 'message'`）：该返回**不含消息正文**，但这次调用会**声明终结当前回合**——DSH 随即把你/它发来的消息作为正式用户消息投递给 agent（排在本轮之后的排队消息亦然）；agent 不应再用等待或阻塞操作顶替它。
- **MCP 超时收尾有 1–2 秒宽限**：MCP 任务超时/失败后 host 会关闭连接并回收 server 子进程（关连接本身要等约 2 秒），所以 `result.json` 里的 `durationMs` 可能比 `timeoutMs` 多 1–2 秒（同文件也记了 `timeoutMs` 便于对照）。

## 维护与开发

架构设计、机制细节、测试与发布流程见 [docs/developer.md](docs/developer.md)。

## 贡献

欢迎 issue 与 PR：Bug 报告、面板 / CLI 体验、文档与翻译（中英镜像需同步更新）都可以提。

- 仓库：<https://github.com/bitsmug/dsh-bgjobs>
- 问题与建议：<https://github.com/bitsmug/dsh-bgjobs/issues>
- 架构、机制、测试与发布流程：[docs/developer.md](docs/developer.md)

## 近期更新

v0.1.71 → v0.2.6

- **修复沙箱 pwsh 任务日志的中文乱码**：新增 `output_encoding`：逐任务选择任务日志的解码编码**（v0.2.6）
。
- **修复沙箱任务误选 MSIX 版 pwsh 导致容器内任务启动失败**： PowerShell 解析**跳过 WindowsApps 别名**、取第一个非 MSIX 命中，并新增 **`BGJOBS_PWSH`** 环境变量显式覆盖解释器（最高优先）（v0.2.6）。

- **新增「沙箱选择」（实验，默认关）：后台任务可选用 dsh 沙箱后端**（v0.2.5）

- **修复同一任务被收尾两次（完成通知偶发收到 2 次）的并发缺陷**（v0.2.4）

- **修复「死任务显示运行中」**（v0.2.3）

- **修复 `node` 安装路径含空格时 MCP 预热被误拦**（v0.2.1）。

- **设置页「完成横幅」两个开关独立成组**（v0.2.1）。

- **新增 bgjob_kill 和 bgjob_delete 工具**（v0.2.0-alpha）。

- **沙箱 pwsh 任务的启动更快了**：去掉了一处每次进程启动都要现做的开销（它在日志编码上其实没起作用），启动等待更短，**任务行为、日志与退出码完全不变**（v0.1.92）。

- **修复沙箱 pwsh 任务「日志空白 + 假成功」**：桌面版（Electron）DSH 的 `process.execPath` 是 GUI 子系统 exe，stdout 被重定向到文件后会静默秒退——于是任务 `exit 0` 但日志空白。现在沙箱 runner 改用**真 node**（优先 DSH 自带的那份），连 PATH 上都没有 ⇒ **提交时明确报错**（`a real node executable not found`）而非假成功。已完成的任务若呈「秒退 + exit 0 + 日志只含 `[BGJOB]` marker」，会在 `job.json` / 面板带一条 `suspect` 提示（**仅提示**，不改状态/退出码/通知语义）（v0.1.90）。

- 支持 DSH 0.2.0-rc.2 版本（v0.1.87）

- **修复完成通知在 DSH 0.1.7 上导致会话报错**：`notify` 通知消息的来源标记改用新版写法（旧写法 `{ kind: 'plugin', … }` 被 DSH 0.1.7 的会话准入拒绝，表现为「本轮运行失败 `format v4 message requires a producer-owned source 
- **修复预热通道导致 MCP 工具被执行两次**：预热代理调用原先客户端只等 3 秒，超时即"回退冷启动"，于是耗时 >3 秒的工具会被执行两遍；现在客户端中止预算与调用超时对齐（仅兜底 host 无响应），且代理会标记"调用是否已发出"——已发出的失败/超时**不再重跑**，直接按退出码 `2`/`3` 收尾（v0.1.84）。
- **`bgjob_wait_all` 合并进 `bgjob_wait`**：新增 `logic` 参数（`any` 缺省 / `all` 合取），原 `bgjob_wait_all` 的全部行为（全部成功才 `allDone`、任一失败即刻返回 `failed` + `failedJobId` + 其余 `pending`）改由 `bgjob_wait({ ..., logic: 'all' })` 提供；工具数 9 → 8（v0.1.83）。
- **等待被新消息让路后自动交还回合**：`bgjob_wait` / `bgjob_wait_all` 因新入站消息返回（`stoppedBy: 'message'`）时会**声明终结当前回合**（DSH 工具执行契约 `exec.concludeTurn`），DSH 随即把该消息作为正式用户消息投递给 agent——不再出现"agent 继续等待、消息递不进来"（v0.1.82）。
- **`bgjob_wait_all` 改为合取语义**：`allDone` 只在**全部成功**时为真；任一任务失败（非 0 退出码 / 被清理 / 找不到）即刻返回 `failed:true` + `failedJobId` + 已结束者 `results` + 其余 `pending`，不再空等。并行提交后的默认姿势改为 `bgjob_wait` 的 any 竞速（先拿到先推进）（v0.1.82）。
`bgjob_mcp_tools`（v0.1.82）。
- **新增 MCP 后台任务引擎**（v0.1.80）。
- **等待后台任务可被随时停止**：agent 在等任务时点「停止/打断」会立即释放，不再拖住对话；任务继续后台运行，可再等（v0.1.71）。
- 操作失败不再静默：设置页会直接显示失败原因。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
