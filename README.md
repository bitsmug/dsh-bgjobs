# bgjobs — DSH 独立后台任务插件

**让 DSH 提交的命令脱离 DSH 进程独立运行：任务由 Windows 任务计划程序服务托管，关掉 DSH、关掉网页、甚至关掉终端窗口都不影响任务执行。任务退出时网页弹出 Toast 提示，随时看实时输出，DSH 离线也能用独立 CLI/GUI 管理。**

还在为大文件下载、批量脚本、数据同步、编译这类长任务守着 DSH 会话？DSH 自带的后台任务会随 DSH 结束一起终止；而用本插件提交的任务交由 Windows 任务计划程序服务托管，关掉 DSH、甚至 DSH 崩溃，任务照常跑完，随时回来查结果就行。

## 特性一览

| 能力 | 说明 |
|---|---|
| **进程外独立运行** | 任务经 `schtasks` 交给 Windows 任务计划程序服务托管，关掉 DSH、关掉网页，甚至 DSH 崩溃，都不影响已提交任务的运行 |
| **实时输出面板** | 网页右下角「后台任务监控」浮动面板每秒刷新打印输出，可拖拽移动（自动吸附在窗口内）、`—` 最小化为悬浮球、▾/▸ 折叠、随主题换肤 |
| **清理已完成** | 一键清理所有已完成任务（🧹 按钮）；单条已完成/异常退出任务可拖到面板底部"垃圾篓"快速删除 |
| **完成通知** | 任务退出瞬间网页顶部弹出 Toast 提示（退出码 + 任务名，UI toast 不污染会话消息；fs.watch 事件驱动，亚秒级） |
| **agent 可识别** | 工具自动进 system prompt + 注入使用指引（何时用 bgjob_submit、bat 语法注意事项），新会话 agent 开箱即用 |
| **断线续跟** | DSH 重启后自动扫描工作区恢复跟踪之前留下的任务（含运行中任务，done 不重复通知） |
| **离线管理** | DSH 不运行时，`tools/` 下的 CLI 与 GUI 直接读写任务磁盘文件，照常 list / status / log / submit / kill |
| **零残留** | 任务跑完 bat 自动删除 schtasks 定义（插件侧另有兜底删除）；done 任务保留 24h 后清理，job.json 落盘不丢历史 |

## 适用场景

- **长耗时任务**：大文件下载、批量脚本、数据同步、编译、数据导出；
- **提交后不想守着 DSH 会话**：关掉网页/终端，任务照常跑完；
- **随时回来看结果**：网页面板、离线 CLI、GUI 三处都能查状态与日志。

## 安装 / 卸载

前置：已安装 DSH（`@deepseek-ai/dsh`）与 Node.js（≥18），Windows 系统。

**方式 A（推荐，bundle 发布版）** — 一条命令安装，`cordis.patch.yml` 自动挂载：

```bat
dsh plugin --profile web add bgjobs
```

安装完成后重启 DSH 即生效（网页右下角出现「后台任务监控」面板，agent 获得 `bgjob_submit` / `bgjob_status` 工具）。

**方式 B（本地源码/免发布）** — 尚未发布或想直接用本地代码时：

1. 把仓库放到本地插件目录（无中文路径更稳妥），例如 `D:\dsh\plugins\bgjobs`；
2. 建立 junction，让 DSH 的模块解析器通过包名 `bgjobs` 找到本地源码：

```bat
mklink /J "<你的DSH安装>\node_modules\bgjobs" "D:\dsh\plugins\bgjobs"
```

> 说明：DSH 从它自己的 `node_modules` 向上解析包名。默认安装位置是 `C:\Users\<用户名>\node_modules`（npm 安装在用户目录时）；若用 npx 缓存运行，则对 npx 缓存目录下的 `node_modules` 建 junction。执行 `npm root -g` 或查看 DSH 启动报错路径即可确认。

3. 挂载到 profile 补丁层：编辑 `<DSH_HOME>\profiles\web\cordis.patch.yml`，追加：

```yaml
- insert:
    - id: bgjobs
      name: bgjobs
```

4. 生效：保存即热加载（host 部分），刷新页面出现监控面板。

**卸载：**

```bat
dsh plugin --profile web remove bgjobs
```

## 使用（agent 工具）

agent 通过两个工具使用 bgjobs：

- `bgjob_submit(name, command, workdir)` — 提交后台任务；
- `bgjob_status(jobId)` — 查询状态 / 退出码 / 日志尾部。

直接对 AI 说一句话即可，例如：

> 把「下载 https://example.com/large.zip 到 D:\data」提交成后台任务，任务名叫「下载大文件」。

agent 会调用 `bgjob_submit` 提交，随后：

- 输出实时写入 `<workdir>\.dsh\bgjobs\<jobId>\stdout.log`；
- 任务退出后 `<workdir>\.dsh\bgjobs\<jobId>\exitcode.txt` 写入退出码，网页顶部弹出 Toast 提示（任务名 + 退出码）；
- 网页右下角「后台任务监控」面板实时显示全部任务与输出：点任务行展开日志尾部，标题栏可拖拽（拖出窗口范围会自动拉回），`—` 最小化为悬浮球（点击恢复），`▾` / `▸` 折叠面板。

## 离线管理 CLI（DSH 不运行时也可用）

任务由系统服务托管，DSH 离线期间照常运行。`tools/` 下提供独立 CLI，直接读写任务磁盘文件，不依赖 DSH 进程：

```powershell
# 在 tools/ 目录下执行
.\dsh-bgjobs.ps1 list                                  # 全部任务
.\dsh-bgjobs.ps1 status -Id <id>                       # 单任务详情 + 日志尾部
.\dsh-bgjobs.ps1 log -Id <id> [-Tail 100]              # 查看日志末尾 N 行
.\dsh-bgjobs.ps1 submit -Name <n> -Command <c> -Workdir <dir>   # 离线提交新任务
.\dsh-bgjobs.ps1 kill -Id <id> [-NoDeleteDir]          # 终止任务（默认删除任务目录）
.\dsh-bgjobs.ps1 cleanup [-OlderThanHours 24]          # 清理过期任务目录
.\dsh-bgjobs.ps1 index -Workdir <dir>                  # 重建任务索引（可传多个目录）
```

> 离线提交的任务，DSH 恢复后会自动接管跟踪；任务完成时网页顶部弹出 Toast 提示。

## 图形面板（GUI）

双击 `tools\dsh-bgjobs-gui.bat`（或为其建桌面快捷方式）即可启动独立窗口，不依赖 DSH：任务列表 + 详情/日志、提交、终止、清理、重建索引，每 2s 自动刷新。

## 数据与存储

| 项目 | 位置 |
|---|---|
| 任务目录 | `<workdir>\.dsh\bgjobs\<jobId>\` |
| 任务元数据 | `job.json`（id / name / command / status / exitCode / finishedAt） |
| 输出日志 | `stdout.log`（命令输出实时追加，末尾 `[BGJOB] exit code: N`） |
| 退出码 | `exitcode.txt`（bat 最后写入，出现即触发完成检测） |
| 任务计划 | `dsh-bgj-<jobId>`（schtasks ONCE 任务，跑完自删） |
| 中央索引 | `$DSH_HOME\bgjobs\index.json`（仅存 jobDir 当"地图"，状态实时读 job.json） |

生命周期：`done` 任务在插件内存注册表保留 24h 后剪枝（同时从中央索引移除）；job.json 已落盘终态，剪枝不丢历史。

## 语义与边界

- `workdir` 必须是 DSH 工作区内的绝对路径（任务文件与日志写在 `<workdir>/.dsh/bgjobs/<id>/`）；
- 任务默认「仅用户登录时运行」：关 DSH/关终端不影响，但**注销 Windows 会终止任务**；
- 命令使用 **bat 语法**，支持多行与 `for` / `if` 块结构；`for` 循环变量写成 `%%i`；
- 命令原样写入子 bat（`cmd.bat`），输出整体重定向到日志（UTF-8，中文不乱码），**命令里不要自带 `> log` 类重定向**；
- 任务由 DSH 插件自动跟踪，`done` 任务保留 24h 后清理。

## 设计要点

- **托管机制**：插件在 DSH 进程内直接 `spawn schtasks`（不经过 pwsh 沙箱）；用户命令原样写入子 bat（`cmd.bat`），run.bat 用 `call cmd.bat >> log 2>&1` 整体重定向（逐行重定向会破坏 `for ... do (` 等块结构导致 cmd 语法错误）、开头 `chcp 65001` 保证日志 UTF-8、`/Run` 成功后立即删任务计划防 `/ST` 整分双跑、末尾写 exitcode 并自删任务；
- **亚秒级完成检测**：fs.watch 监视任务目录，`exitcode.txt` 出现即触发状态迁移 → 通知创建者；tick 每 5s 兜底补查，防 Windows watch 丢事件；
- **增量日志读取**：按字节位置只读新增部分，TextDecoder 流式解码，避免块边界截断多字节 UTF-8；
- **断线续跟**：启动后扫描工作区 `.dsh/bgjobs/*/job.json` 重新挂接：running 继续跟踪，done 直接显示终态（不重复通知）；
- **索引即地图**：中央索引只存 jobDir，状态永远实时读 job.json，索引过期/缺失不影响正确性。

## 开发

- 测试（不需要 DSH 运行，在仓库目录执行）：

```bat
npm test
```
