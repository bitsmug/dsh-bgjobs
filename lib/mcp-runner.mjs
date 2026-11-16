// bgjobs —— 历史 MCP 任务执行体（v0.4.2 起降级为失败占位）。
// 旧版在此动态 import `dsh-mcp-control/runner`（含同级目录回退）以转发历史 MCP 任务；
// 宿主不应知道、也不应解析外部插件包名/位置，因此本文件不再 import 任何包：
// 只打印双语说明并以退出码 2 失败关闭（2 = MCP 任务语义里的「配置/调用失败」）。
// 宁可明显失败，也不静默成功；补救方式是用当前 bgjobs + MCP 引擎插件重新提交任务。

const message = [
  'This MCP background job was created by an older bgjobs release and is no longer supported.',
  'Re-submit the job with the current bgjobs + MCP engine plugin.',
  '',
  '历史 MCP 任务已不再支持，请重新提交。',
].join('\n')

try { process.stderr.write(message + '\n') } catch { /* stderr 不可写也不影响退出码 */ }
process.exit(2)
