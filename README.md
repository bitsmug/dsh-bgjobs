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
| MCP 调用托管（可选插件） | 已拆到独立插件 [dsh-mcp-control](https://github.com/bitsmug/dsh-mcp-control)：它注册 `mcp` 引擎并提供 `bgjob_submit_mcp` / `mcp_list_tools` 与「MCP 任务」设置页。本包只提供引擎注册点（`ctx.bgjobEngines`）；未安装该插件时 `engine: 'mcp'` 直接报 `engine "mcp" not registered`（不降级） |
| 零残留 | 任务跑完自删任务计划；done 任务默认保留展示，用户手动清理 |

## 前置依赖与兼容性

| 前置 | 兼容 | 推荐 |
|---|---|---|
| Windows | `10`-`11` | `11` (build `>=26300`) |
| PowerShell 7+ | `>=7.6.5`（沙箱功能需[ zip 解压版 PowerShell](https://learn.microsoft.com/zh-cn/powershell/scripting/install/install-powershell-on-windows?view=powershell-7.6#install-the-zip-package)） | [`>=7.7.0`](https://github.com/PowerShell/PowerShell/releases#release-v7.7.0-preview.5) |
| DSH |`0.1.2-rc.1` ~ `0.2.1-rc.5`（rc版）  （[官方桌面版](https://www.deepseek.com/harness/)/以`win`+`R` 运行 [npx @deepseek-ai/dsh web](https://github.com/deepseek-ai/deepseek-harness#run-from-npm)） |  `>=0.2.1-rc.5` |
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

重启 DSH 后生效（**完全退出并重新启动**——桌面客户端与网页版都是）：网页右下角出现「后台任务监控」面板，agent 获得 `bgjob_submit` / `bgjob_config` / `bgjob_status` / `bgjob_wait` / `bgjob_list` / `bgjob_pending_list` / `bgjob_kill` / `bgjob_delete` 工具（MCP 相关工具与设置页在可选插件 dsh-mcp-control 里）。

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

## 网页面板

面板顶部依次是：清理（点击开启底部垃圾篓：拖拽删除单条已结束任务，或点「清理超 24h / 清理全部」批量清理）、折叠（收成仅任务列表）、最小化（悬浮球落在按钮位置）。**判定不出进程状态**的任务（探针/反查跑不起来，既不能确认还在跑、也不能确认已停）默认**一个记录都不删**：面板弹警告确认框并原样列出 host 给的原因，点「确认清理」才带 `force` 执行（取消 = 不发请求）；普通已结束任务与"有活进程被拒"的提示**不受影响**（失败原因现在也会弹 Toast，不再静默）。工具栏的**作用域**是三段式开关（随宿主持久化，刷新/多标签一致）：「会话」（只看当前会话提交的任务，老记录无创建者时保留）、「工作区」（当前会话工作区，含子目录）、「全」（不过滤）。取不到活动会话时自动降级（会话 → 工作区 → 全），回显位置随之显示实际生效的目标；在设置里隐藏本控件即不过滤。另有「全权限」开关（预批准全权限任务，默认关）。点击任务行展开实时日志。任务行默认显示「运行时长」（运行中随面板每秒刷新增长，完成后为总耗时），可在设置 → 后台任务 → 字段显示里改到详情或隐藏。面板文案跟随 DSH 界面语言（中文 DSH → 中文面板，其他 → 英文）。

**接入 DSH 侧边栏**：左侧栏（聊天列表列）底部有 bgjobs 入口（宽栏显示「后台任务」，收起成窄栏时仅图标）——点击可整体隐藏/唤出右侧浮动面板；面板隐藏期间任务照跑、完成照弹 Toast。该入口可在 **DSH 设置 → 后台任务**里开关（**默认隐藏**）。

**DSH 设置里的 bgjobs（一个页面）**：打开 DSH 设置（左下角齿轮），左侧出现「后台任务」页；监控面板标题栏的 ⚙ 可直达该页（可在设置 → 后台任务 → 界面元素里隐藏）。装可选插件 dsh-mcp-control 后，它会在设置里额外提供「MCP 任务」页，并在标题栏加一个数据齿轮快捷入口。

- 「后台任务」（顶部显示当前插件版本）：① 开关「左侧栏显隐按钮」（默认关，打开后左栏底部出现入口）；② 开关「监控面板」（直接显示/隐藏右下角监控面板与悬浮球，与入口开关相互独立）；③ 「默认等待超时」（数字输入 + 保存）：agent 调用 `bgjob_wait` 未指定 `timeoutSeconds` 时使用的缺省秒数，`0` 或留空 = 不限时；④ 「打开离线 GUI」一键启动独立管理窗口，附 GUI 脚本路径；⑤「打开所在文件夹」经 DSH 自身的文件资源管理器机制打开离线工具目录（找不到 GUI 就到这里找 dsh-bgjobs-gui.bat）；⑥「字段显示」可配置每个任务字段（含「运行时长」）显示在列表/详情/隐藏；⑦ 开关「隐藏任务窗口（实验）」（默认关）。

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
- 全局状态：`$DSH_HOME\bgjobs\`（`index.json` 任务"地图"、`fullaccess.json` 全权限开关、`ui-prefs.json` 网页 UI 偏好、`mcp-*.json` MCP 开关/登记/缓存；
- `done` 任务默认持续保留，直到你手动清理（面板 🧹 / CLI cleanup / GUI）。

## 使用须知

- `workdir` 必须是 DSH 工作区内的绝对路径；
- 任务默认「仅用户登录时运行」：关 DSH/终端不影响，但**注销 Windows 会终止任务**；
- 命令不要自带 `> log` 类重定向（插件已整体重定向并保证 UTF-8）；
- **沙箱**：`sandbox` 只约束文件效果（写工作区/临时区外会被拒），网络不受限；它是"尽力而为"而非数学边界——工作目录若落在 Everyone 可写的位置会失效；沙箱任务的任务目录对本地用户可读（脚本文本可见）；bat 引擎任务恒为全权限，受限会话需开启「全权限」才能提交；

## 维护与开发

架构设计、机制细节、测试与发布流程见 [docs/developer.md](docs/developer.md)。

## 贡献

欢迎 issue 与 PR：Bug 报告、面板 / CLI 体验、文档与翻译（中英镜像需同步更新）都可以提。

- 仓库：<https://github.com/bitsmug/dsh-bgjobs>
- 问题与建议：<https://github.com/bitsmug/dsh-bgjobs/issues>

## 近期更新

**v0.4.1-beta**

- **新增：面板作用域三态（当前会话 / 当前工作区 / 全）**：把此前"仅当前会话"布尔开关升级为三段式，选择**持久化到宿主** `ui-prefs.json`（`scope` 键，多面板/多标签同源）。同时修掉它在 DSH 0.2.x 上不生效的老 bug —— 旧实现读 `SessionListState.current`（该字段早已不存在，恒为 `undefined`），现在改用会话的 `retainedBy.mainView > 0` 判定活动会话（0.1.x 没有 `retainedBy`，自动回退到 `current`）；「会话」按任务的创建者会话过滤（老记录无创建者时保留，不会凭空消失），「工作区」沿用路径前缀语义。取不到活动会话时自动降级，设置页隐藏控件即不过滤。**注意**：因老 bug 此前实际是"不过滤"，升级后默认「会话」会真正开始过滤，首帧可能看到任务变少，属预期。
- **新增面板开关「隐藏任务窗口（实验）」**：Win11 把控制台委派给 Windows Terminal 时，计划任务拉起的 `pwsh`/`node` 会弹可见终端；开关打开后改经包内静态资产 `launch.vbs`（`wscript.exe`，GUI 子系统）启动，隐藏窗口且不影响退出码、进程树与沙箱链路。**默认关**（关掉即与旧行为逐字相同）；WSH 被策略禁用时自动降级为原路径并给提示；只影响开关打开后新提交的任务。
- **新增 engine 注册表**：内置 `bat` / `pwsh`；第三方插件可注册自己的 engine（`supportsSandbox` 决定能否沙箱），未注册的 engine 一律 fail-closed（报错，不降级到其它 engine）。
- **升级提示**：只升级本包不装 `dsh-mcp-control` ⇒ MCP 任务能力消失（历史 MCP 任务仍可查看/清理；新提交会被拒绝）。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
