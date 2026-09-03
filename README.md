# bgjobs — DSH 独立后台任务插件

**让 DSH 提交的命令脱离 DSH 进程独立运行**：任务交给 Windows 任务计划程序服务托管，关掉 DSH、关掉网页、甚至关掉终端窗口都不影响执行；网页弹 Toast 提醒完成，随时看实时输出；DSH 离线时还能用独立 CLI/GUI 管理。

适合大文件下载、批量脚本、编译、数据同步/导出这类长任务——提交后不用守着 DSH，随时回来看结果。

## 特性一览

| 能力 | 说明 |
|---|---|
| 进程外独立运行 | 任务经 `schtasks` 托管，DSH 崩溃/关闭不影响 |
| 实时输出面板 | 网页右下角浮动面板每秒刷新输出：可拖拽、最小化为悬浮球、折叠为仅任务列表、随主题换肤；按工作区分组、可调大小 |
| 清理已完成 | 🧹 手动选择清理范围：仅超过 24h（默认保留 24h 内）或全部；单条任务可拖到垃圾篓删除 |
| 完成通知 | 任务退出即弹 Toast（不打扰会话）；可选把通知发回创建它的 agent（`notify` 参数） |
| 断线续跟 | DSH 重启自动恢复跟踪；旧任务 id 也能从磁盘查询状态 |
| 离线管理 | 不依赖 DSH 的 CLI / GUI：list / status / log / submit / kill / cleanup |
| 可选沙箱 | `bgjob_submit_pwsh` 可选 `sandbox` 约束后台任务文件权限，权限不高于当前会话模式 |
| 零残留 | 任务跑完自删任务计划；done 任务默认保留展示，用户手动清理 |

## 安装 / 卸载

前置：已安装 DSH（`@deepseek-ai/dsh`）与 Node.js（≥18），Windows 系统。

**方式 A（推荐，从 GitHub 安装，免 npm 发布）**

```bat
dsh plugin --profile <profile> add github:bitsmug/dsh-bgjobs
```

> 从 GitHub 仓库默认分支安装（免 npm 发布）。仓库含 `dsh.bundle` 声明，装完自动加入 profile 层栈并启用工具。
>
> 若首次 `add` 报 pnpm 的 `allowBuilds` 提示（git 安装会跑 `prepare` 构建脚本，pnpm ≥10 默认阻止），把提示里的键复制进该 profile 的 `pnpm-workspace.yaml` 后重跑即可。

重启 DSH 后生效：网页右下角出现「后台任务监控」面板，agent 获得 `bgjob_submit` / `bgjob_submit_pwsh` / `bgjob_status` 工具。

**方式 B（本地源码）**

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

- `bgjob_submit(name, command, workdir, [notify], [notify_mode])` — 提交后台任务（command 为 **bat** 语法）；
- `bgjob_submit_pwsh(name, command, workdir, [sandbox], [justification], [notify], [notify_mode])` — 提交后台任务（command 为 **PowerShell** 语法，UTF-8 日志、`exit <code>` 语义安全）；
- `bgjob_status(jobId)` — 查询状态 / 退出码 / 日志尾部。

直接对 AI 说一句即可：

> 把「下载 https://example.com/large.zip 到 D:\data」提交成后台任务，任务名叫「下载大文件」。

- 任务输出实时写入 `<workdir>\.dsh\bgjobs\<jobId>\stdout.log`；
- 退出后 `<workdir>\.dsh\bgjobs\<jobId>\exitcode.txt` 写入退出码，网页弹 Toast；
- 完成后**默认不打扰会话**；需要让 agent 主动得知并收尾时，传 `notify: on-exit`（或 `on-completion` 仅成功 / `on-fail` 仅失败），并可选 `notify_mode`（`wakeup` 空闲唤醒 / `quiet` 仅入收件箱 / `always`）。

## 网页面板

面板顶部依次是：清理（选 24h 前/全部）、折叠（收成仅任务列表）、最小化（悬浮球落在按钮位置）。工具栏两个开关：「仅当前会话」（只显示当前会话工作区任务）与「全权限」（预批准全权限任务，默认关）。点击任务行展开实时日志。

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

双击 `tools\dsh-bgjobs-gui.bat` 即可启动独立窗口（不依赖 DSH）：任务列表/日志、提交（bat 或 pwsh）、终止、清理（可选 24h 前或全部）、重建索引。

## 数据与存储

- 任务数据：`<workdir>\.dsh\bgjobs\<jobId>\`（`job.json` 元数据、`stdout.log` 日志、`exitcode.txt` 退出码）；
- 全局状态：`$DSH_HOME\bgjobs\index.json`（任务"地图"）、`$DSH_HOME\bgjobs\fullaccess.json`（全权限开关）；
- `done` 任务默认持续保留，直到你手动清理（面板 🧹 / CLI cleanup / GUI）。

## 使用须知

- `workdir` 必须是 DSH 工作区内的绝对路径；
- 任务默认「仅用户登录时运行」：关 DSH/终端不影响，但**注销 Windows 会终止任务**；
- 命令不要自带 `> log` 类重定向（插件已整体重定向并保证 UTF-8）；
- **沙箱**：`sandbox` 只约束文件效果（写工作区/临时区外会被拒），网络不受限；它是"尽力而为"而非数学边界——工作目录若落在 Everyone 可写的位置会失效；沙箱任务的任务目录会授 Everyone 只读（脚本文本对本地用户可见）；bat 引擎任务恒为全权限，受限会话需开启「全权限」才能提交；
- 受限会话里请求超出会话模式的权限会弹窗审批，`justification` 说明理由即可。

## 维护与开发

架构设计、机制细节、测试与发布流程见 [docs/developer.md](docs/developer.md)。
