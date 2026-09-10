// bgjobs — DSH 持久插件（host 半）—— 入口聚合文件（v0.1.61 结构重构）。
// 机制（2026-09-01 实测；v0.1.8 修复三个实测 bug）：
//   - 任务由 Windows 任务计划程序服务托管，与 DSH 进程/终端无关；
//   - 插件在 DSH 进程内直接 spawn schtasks（不经过 pwsh 沙箱，免提权审批）；
//   - 用户命令原样写入子 bat（cmd.bat），run.bat 用 `call cmd.bat >> log 2>&1`
//     整体重定向。不能逐行追加重定向：会把 `for ... do (`、`)` 等块行破坏成
//     cmd 语法错误（实测 exit=255 秒死、不写 exitcode → 任务永远 running + 任务
//     计划残留）；bat 开头 chcp 65001 使日志以 UTF-8 写入（cmd 默认 GBK 会乱码）；
//     末尾写 exitcode 并自删任务；
//   - /Create /ST=now+60s 后立即 /Run 会双跑（/Run 立即一次 + /ST 整分再触发一次，
//     实测 17:54:30 与 17:55:00 两次日志），故 /Run 成功后立即 /Change /DISABLE 任务计划
//     （不能用 /Delete：/Run 实例异步排队启动，紧随的 /Delete 会把排队运行连同注册一起
//     丢弃→进程从未启动→永远 running 且无日志）；bat 末尾与 done 兜底的 /Delete 变成无害
//     no-op；
//   - 日志尾部：每秒按字节位置增量读（TextDecoder 流式解码，避免截断多字节
//     UTF-8）；任务完成检测事件驱动：fs.watch 监视任务目录，exitcode.txt
//     出现即触发 → 状态迁移 done → agents.followup 通知创建任务的 agent 会话，
//     tick 每 5s 兜底补查防 watch 丢事件；done 后 DSH 侧再 fire-and-forget
//     一次 schtasks /Delete 兜底（bat 正常已自删，防中途退出残留任务计划）；
//   - webServer 前缀路由 /bgjobs/* 供客户端面板轮询；
//   - done 任务在内存注册表持续保留（不按时间剪枝），面板与中央索引一致保留，
//     直到用户手动删除或“一键清理”；job.json 已落盘终态，清理不丢历史。
//
// cmd 陷阱备忘：`echo %var%>file` 当 var 为数字时被解析成句柄重定向
// （0 字节文件、输出丢失），必须写成 `> file echo %var%`。
//
// 代码组织（自 lib/index.js 拆分为多文件 + 目录分层）：
//   lib/index.js          本入口：插件元信息 + 公共导出聚合（测试按名字 import）
//   lib/util.js           字符串/退出码/常量工具
//   lib/index-store.js    中央任务索引（DSH_HOME/bgjobs/index.json）
//   lib/sandbox.js        沙箱模式纯判定
//   lib/scripts.js        任务脚本/启动器生成（run.bat/run.ps1/job.ps1/launch.vbs…）
//   lib/notify-policy.js  notify 触发纯判定
//   lib/guidance.js       system prompt 指引文本
//   lib/runners.js        schtasks/PowerShell/沙箱 runner 执行层（测试替身 seam）
//   lib/core/store.js     per-apply 可变状态（registry/full access）
//   lib/core/apply.js     apply(ctx) 装配（各域按依赖序创建、收拢 disposers）
//   lib/core/*.js         域：notify/registry/watch/wait/jobs/web/tools

export const name = 'bgjobs'
export const inject = ['tools', 'timer', 'systemPrompt']

export { apply } from './core/apply.js'

// —— 公共导出（与拆分前逐名一致；纯函数/执行层见各自模块）——
export { strip, errorMsg, parseExitCode } from './util.js'
export {
  resolveBgjobsHome, bgjobsIndexPath, readBgjobsIndex, writeBgjobsIndex,
  updateBgjobsIndex, rebuildBgjobsIndex,
} from './index-store.js'
export { jobSandboxDecision } from './sandbox.js'
export { buildBat, buildCmdBat, buildPwshRunner, buildLaunchVbs, buildPs1, buildMcpCmdBat } from './scripts.js'
export { shouldNotifyForExit } from './notify-policy.js'
export { buildBgjobsGuidance } from './guidance.js'
export {
  setSchtasksRunner, setShellResolver, resolveShell,
  setSandboxRunnerResolver, resolveSandboxRunner,
} from './runners.js'
// MCP 引擎：连接构造（runner 与预热 supervisor 共用）、预热域、DSH profile 定位与导入。
export { normalizeConfig, scrubbedParentEnv, openClient, listTools, projectResult, callTool } from './mcp-connect.js'
export { createMcpPrewarm, setPrewarmFactory } from './mcp-prewarm.js'
export {
  MCP_CLIENT_PLUGIN, profileFromArgv, listProfiles, detectActiveProfile,
  extractMcpServers, readMcpConfigs, describeDshMcp,
} from './dsh-profiles.js'
