// bgjobs —— 历史 MCP 任务的启动转发。
// 旧任务目录的 cmd.bat 里烘焙的是本文件的绝对路径；实现已迁移到 dsh-mcp-control 包。
// 未安装该包时任务以 ERR_MODULE_NOT_FOUND 失败（fail-closed：不降级、不重跑）。

// 两个插件通常并列安装在同一 plugins 目录，此时包名未必能从 bgjobs 解析到，
// 故先按包名解析，解析不到再按同级目录取；两者都不存在时由 import 抛 ERR_MODULE_NOT_FOUND。
const specifier = (() => {
  try {
    return import.meta.resolve('dsh-mcp-control/runner')
  } catch {
    return new URL('../../dsh-mcp-control/lib/runner.mjs', import.meta.url).href
  }
})()

await import(specifier)
