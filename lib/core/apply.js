// bgjobs core —— 插件装配（v0.1.61 结构重构）。
// apply(ctx) 只做编排：建 store → 依依赖序建各域 → 收拢 disposers → 返回清理。
// 域对象 = { api, dispose }：api 供其它域经 deps 注入调用；dispose 为本域注册的清理函数。

import { createStore } from './store.js'
import { createMcp } from './mcp.js'
import { createNotify } from './notify.js'
import { createRegistry } from './registry.js'
import { createWatch } from './watch.js'
import { createWait } from './wait.js'
import { createJobs } from './jobs.js'
import { createWeb } from './web.js'
import { createTools } from './tools.js'
import { buildBgjobsGuidance } from '../guidance.js'
import { newPrewarm } from '../mcp-prewarm.js'
import { readBgjobsVersion } from '../meta.js'

export function apply(ctx) {
  // 依赖方向（无环）：store ← notify ← registry ← watch ← wait/jobs ← web/tools。
  const store = createStore()
  // MCP 预热域：常驻连接 + 127.0.0.1 回环代理（§7）。版本号异步读一次进缓存（clientInfo 用）。
  let versionCache = '0.0.0'
  readBgjobsVersion().then((v) => { versionCache = v === null || v === undefined ? '0.0.0' : String(v) }).catch(() => {})
  const prewarm = newPrewarm({
    resolveConfig: async (n) => (await store.readMcpServers()).servers[String(n)] || null,
    version: () => versionCache,
  })
  const mcp = createMcp(ctx, store, { prewarm: prewarm.api, version: () => versionCache })
  const notify = createNotify(ctx)
  const registry = createRegistry(ctx, store)
  const watch = createWatch(ctx, store, { notify: notify.api, registry: registry.api })
  const wait = createWait(ctx, store, { watch: watch.api, registry: registry.api })
  const jobs = createJobs(ctx, store, { watch: watch.api, registry: registry.api, prewarm: prewarm.api })
  const web = createWeb(ctx, store, { watch: watch.api, registry: registry.api, mcp: mcp.api, prewarm: prewarm.api })
  const tools = createTools(ctx, store, {
    jobs: jobs.api, wait: wait.api, registry: registry.api, mcp: mcp.api,
  })

  // 预热常驻连接：MCP 总开关开启时才连（§6 联动）；对「已登记、启用且 prewarm: true」的 server 预连。
  // 纯加速：初始化失败/总开关关闭都不影响任何任务（runner 一律可冷启动）。
  const startPrewarm = async () => {
    const init = await prewarm.api.init()
    if (init && init.ok === false) return
    if ((await store.readMcpPrefs()).enabled !== true) return
    const { servers } = await store.readMcpServers()
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg && cfg.prewarm === true && cfg.enabled !== false) prewarm.api.warm(name).catch(() => {})
    }
  }
  startPrewarm().catch(() => {})

  // 模型可见的使用指引（system prompt section；镜像 dsh-ai4scholar 的 guidance）。
  const disposeGuidance = ctx.systemPrompt.section({
    name: 'tool:bgjobs',
    order: 150,
    text: buildBgjobsGuidance(),
  })

  const run = (fn) => { try { fn() } catch (e) { /* noop */ } }
  return () => {
    // 顺序沿用原单文件实现：停 tick → 关监视 → 注销工具 → 事件监听 → 路由 → guidance。
    for (const d of watch.dispose) run(d)
    for (const job of store.registry.values()) run(() => watch.api.closeWatch(job))
    for (const d of tools.dispose) run(d)
    for (const d of notify.dispose) run(d)
    for (const d of prewarm.dispose) run(d)
    for (const d of web.dispose) run(d)
    run(disposeGuidance)
  }
}
