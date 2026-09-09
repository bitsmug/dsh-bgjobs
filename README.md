# bgjobs (standalone background jobs) — DSH 独立后台任务插件

**中文** · [English](README.en.md)

[![npm version](https://img.shields.io/npm/v/bgjobs)](https://www.npmjs.com/package/bgjobs)
[![License](https://img.shields.io/npm/l/bgjobs)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

**让 DSH 提交的命令脱离 DSH 进程独立运行**：任务交给 Windows 任务计划程序服务托管，关掉 DSH、关掉网页都不影响执行；网页弹 Toast 提醒完成，随时看实时输出；DSH 离线时还能用独立 CLI/GUI 管理。

适合大文件下载、批量脚本、编译、数据同步/导出这类长任务——提交后不用守着 DSH，随时回来看结果。

## 特性一览

| 能力 | 说明 |
|---|---|
| 进程外独立运行 | 任务经 `schtasks` 托管，DSH 崩溃/关闭不影响 |
| 实时输出面板 | 网页右下角浮动面板每秒刷新输出：可拖拽、最小化为悬浮球、折叠为仅任务列表、随主题换肤；按工作区分组、可调大小；左栏底部入口可一键隐藏/唤出 |
| 清理已完成 | 🧹 点击右上角清理图标开启垃圾篓：拖拽单条已结束任务删除，或批量清理（仅超 24h / 全部，与视图过滤一致） |
| 完成通知 | 任务退出即弹 Toast（不打扰会话）；可选把通知发回创建它的 agent（`notify` 参数） |
| 断线续跟 | DSH 重启自动恢复跟踪；旧任务 id 也能从磁盘查询状态 |
| 离线管理 | 不依赖 DSH 的 CLI / GUI：list / status / log / submit / kill / cleanup |
| 可选沙箱 | `bgjob_submit_pwsh` 可选 `sandbox` 约束后台任务文件权限，权限不高于当前会话模式 |
| 零残留 | 任务跑完自删任务计划；done 任务默认保留展示，用户手动清理 |

## 安装 / 卸载

前置：已安装 DSH（`@deepseek-ai/dsh`）、PowerShell 7 与 Node.js（≥22），Windows 系统。

**方式 A（推荐，npm 发布版）**

```sh
$pf="web"; dsh plugin --profile $pf add bgjobs || dsh plugin --profile $pf approve-builds koffi; dsh plugin --profile $pf add bgjobs && Write-Host "✓ bgjobs安装成功！" -ForegroundColor Green
```

> 把 `web` 改成你自己的 profile 名，整行粘贴到 PowerShell（pwsh）即可。第一次 `add` 会报 `ERR_PNPM_IGNORED_BUILDS`（koffi 构建脚本未批准），`||` 会自动触发 `approve-builds` 批准并运行 koffi 构建，再 `add` 成功后打印「bgjobs 安装成功」。

**方式 B（从 GitHub 安装，始终最新）**

```sh
$pf="web"; dsh plugin --profile $pf add github:bitsmug/dsh-bgjobs || dsh plugin --profile $pf approve-builds koffi; dsh plugin --profile $pf add github:bitsmug/bgjobs && Write-Host "✓ bgjobs安装成功！" -ForegroundColor Green
```

> 直接从 GitHub 仓库默认分支拉取，**始终是最新代码**（含刚发布与未发布改动），不受 npm registry 同步延迟影响。两种方式装完包名都是 `bgjobs`，卸载命令相同。

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

重启 DSH 后生效：网页右下角出现「后台任务监控」面板，agent 获得 `bgjob_submit` / `bgjob_submit_pwsh` / `bgjob_status` / `bgjob_wait` 工具。

**方式 C（本地源码开发）**

1. 把仓库放到本地插件目录（路径不要含中文），如 `D:\dsh\plugins\bgjobs`；
2. 让 DSH 的模块解析器能找到它（把插件目录 junction 到 DSH 的 `node_modules\bgjobs`，或把目录加到 DSH 的插件扫描路径）；本地开发还需在插件目录执行一次 `pnpm install`（沙箱 runner 依赖，见下）；
3. 编辑 `<DSH_HOME>\profiles\<profile>\cordis.patch.yml` 追加挂载：

```yaml
- insert:
    - id: bgjobs
      name: bgjobs
```

**卸载：** `dsh plugin --profile <profile> remove bgjobs`

## 使用（agent 工具）

- `bgjob_submit(name, command, workdir, [wait], [notify], [notify_mode])` — 提交后台任务（command 为 **bat** 语法）；`wait`=提交后原地等待的秒数（0/缺省不等待；>0 语义同 bgjob_wait 全缺省——等本会话任一任务先结束，无会话信息时回退等刚提交任务）；
- `bgjob_submit_pwsh(name, command, workdir, [wait], [sandbox], [justification], [notify], [notify_mode])` — 提交后台任务（command 为 **PowerShell** 语法，UTF-8 日志、`exit <code>` 语义安全）；`wait` 同上；
- `bgjob_status(jobId)` — 查询状态 / 退出码 / 日志尾部；
- `bgjob_wait(jobId | jobIds, [timeoutSeconds])` — 等待后台任务结束并**立即返回**退出码与日志尾部（默认最多 120s）。三种用法：单个 `jobId` 等该任务；`jobIds` 数组 = **任一先结束即返回**（any 竞速，返回完成者 + 其余 pending）；两者都缺省 = 等**本会话**任务任一结束；
- `bgjob_wait_all(jobIds, [timeoutSeconds])` — 等一批任务**全部**结束，返回每个任务的退出码/日志尾 + `allDone`（超时返回部分状态可续等）；`jobIds` 缺省 = 本会话全部任务；
- `bgjob_list` — 列出当前 agent 会话提交的全部任务（id/状态/退出码），配合 wait 工具缺省使用。

直接对 AI 说一句即可：

> 把「下载 https://example.com/large.zip 到 D:\data」提交成后台任务，任务名叫「下载大文件」。

- 任务输出实时写入 `<workdir>\.dsh\bgjobs\<jobId>\stdout.log`；
- 退出后 `<workdir>\.dsh\bgjobs\<jobId>\exitcode.txt` 写入退出码，网页弹 Toast；
- 完成后**默认不打扰会话**；需要让 agent 主动得知并收尾时，传 `notify: on-exit`（或 `on-completion` 仅成功 / `on-fail` 仅失败），并可选 `notify_mode`（`wakeup` 空闲唤醒 / `quiet` 仅入收件箱 / `always`）；
- **交付标记（notify 视图）**：每个任务标注「结果是否已交付到会话上下文」——完成通知投递成功（`已通知·notify`）或某次 `bgjob_wait`/`bgjob_wait_all` 返回了它（`已通知·wait`）即交付；`bgjob_pending_list` 列出本会话**尚未交付**的任务（notify 视图），`bgjob_wait`/`bgjob_wait_all` 缺省只从这个视图等——已交付的结果不会重复返回。面板/离线 GUI 均有「已通知/待通知」标记。

## 网页面板

面板顶部依次是：清理（点击开启底部垃圾篓：拖拽删除单条已结束任务，或点「清理超 24h / 清理全部」批量清理）、折叠（收成仅任务列表）、最小化（悬浮球落在按钮位置）。工具栏两个开关：「仅当前会话」（只显示当前会话工作区任务）与「全权限」（预批准全权限任务，默认关）。点击任务行展开实时日志。面板文案跟随 DSH 界面语言（中文 DSH → 中文面板，其他 → 英文）。

**接入 DSH 侧边栏**：左侧栏（聊天列表列）底部有 bgjobs 入口（宽栏显示「后台任务」，收起成窄栏时仅图标）——点击可整体隐藏/唤出右侧浮动面板；面板隐藏期间任务照跑、完成照弹 Toast。该入口可在 **DSH 设置 → 后台任务**里开关（**默认隐藏**）。

**DSH 设置里的 bgjobs**：打开 DSH 设置（左下角齿轮），左侧出现「后台任务」页（顶部显示当前插件版本）：① 开关「左侧栏显隐按钮」（默认关，打开后左栏底部出现入口）；② 开关「监控面板」（直接显示/隐藏右下角监控面板与悬浮球，与入口开关相互独立）；③ 「打开离线 GUI」一键启动独立管理窗口，附 GUI 脚本路径；「打开所在文件夹」经 DSH 自身的文件资源管理器机制打开离线工具目录（找不到 GUI 就到这里找 dsh-bgjobs-gui.bat）。

## 离线管理 CLI（DSH 不运行也能用）

```powershell
# 在 tools/ 目录下执行
.\dsh-bgjobs.ps1 list
.\dsh-bgjobs.ps1 status -Id <id>
.\dsh-bgjobs.ps1 log -Id <id> [-Tail 100]
.\dsh-bgjobs.ps1 submit -Name <n> -Command <c> -Workdir <dir> [-Pwsh]
.\dsh-bgjobs.ps1 kill -Id <id> [-NoDeleteDir]
.\dsh-bgjobs.ps1 cleanup [-OlderThanHours 24]   # 0 = 清理全部
.\dsh-bgjobs.ps1 index -Workdir <dir>
```

## 图形面板（GUI）

双击 `tools\dsh-bgjobs-gui.bat` 即可启动独立窗口（不依赖 DSH）：任务列表/日志、提交（bat 或 pwsh）、终止、清理（超期小时数可调，或全部）、重建索引。工具栏**「📌 桌面快捷方式」**可一键在当前用户桌面创建指向本 GUI 的快捷方式（双击即开，不弹黑窗）。GUI 与 Toast 文案跟随系统 UI 语言（zh → 简体中文，其他 → 英文）；CLI 输出固定为英文。**找不到 GUI？** DSH 设置 → 后台任务 → 「打开离线 GUI / 打开所在文件夹」可直接启动或定位脚本位置。

## 数据与存储

- 任务数据：`<workdir>\.dsh\bgjobs\<jobId>\`（`job.json` 元数据、`stdout.log` 日志、`exitcode.txt` 退出码）；
- 全局状态：`$DSH_HOME\bgjobs\index.json`（任务"地图"）、`$DSH_HOME\bgjobs\fullaccess.json`（全权限开关）、`$DSH_HOME\bgjobs\ui-prefs.json`（网页 UI 偏好：左栏入口显隐）；
- `done` 任务默认持续保留，直到你手动清理（面板 🧹 / CLI cleanup / GUI）。

## 使用须知

- `workdir` 必须是 DSH 工作区内的绝对路径；
- 任务默认「仅用户登录时运行」：关 DSH/终端不影响，但**注销 Windows 会终止任务**；
- 命令不要自带 `> log` 类重定向（插件已整体重定向并保证 UTF-8）；
- **沙箱**：`sandbox` 只约束文件效果（写工作区/临时区外会被拒），网络不受限；它是"尽力而为"而非数学边界——工作目录若落在 Everyone 可写的位置会失效；沙箱任务的任务目录会授 Everyone 只读（脚本文本对本地用户可见）；bat 引擎任务恒为全权限，受限会话需开启「全权限」才能提交；
- 受限会话里请求超出会话模式的权限会弹窗审批，`justification` 说明理由即可。

## 维护与开发

架构设计、机制细节、测试与发布流程见 [docs/developer.md](docs/developer.md)。

## 近期更新（v0.1.62 → v0.1.72）

- **等待后台任务可被随时停止**：agent 在等任务时点「停止/打断」会立即释放，不再拖住对话；任务继续后台运行，可再等（v0.1.71）。
- **agent 间消息自动打断等待**：等待期间其它 agent 发来消息（send_message 等）会自动让路，先处理消息、稍后再回来等结果（v0.1.72）。
- **离线 GUI 稳定打开**：修复从后台任务设置面板「打开离线 GUI / 打开所在文件夹」没反应的问题；GUI 现由系统任务计划程序托管，**关闭或重启 DSH 也不会把它带走**。
- **兼容插件商店安装**：pnpm 深目录安装下也能正常打开离线 GUI（v0.1.70）。
- **DSH 设置页「后台任务」**：一键打开离线 GUI、定位其所在文件夹、开关左栏入口与右下角监控面板，并显示插件版本。
- **接入 DSH 左侧栏**：左栏底部入口一键隐藏/唤出监控面板（窄栏仅图标）。
- **任务完成后自动执行动作**：可选关机 / 休眠 / 运行自定义脚本（支持延迟与参数，离线 GUI 内配置）。
- **离线 GUI 体验优化**：列表自动刷新不再跳顶、列表与日志可拖动分界、修复列表列头与刷新闪烁；新增「创建桌面快捷方式」。
- 操作失败不再静默：设置页会直接显示失败原因。
