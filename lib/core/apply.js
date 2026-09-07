// bgjobs core —— 插件装配（v0.1.61 结构重构）。
// apply(ctx) 只做编排：建 store → 依依赖序建各域 → 收拢 disposers → 返回清理。
// 域对象 = { api, dispose }：api 供其它域经 deps 注入调用；dispose 为本域注册的清理函数。

import { createStore } from './store.js'
import { createNotify } from './notify.js'
import { createRegistry } from './registry.js'
import { createWatch } from './watch.js'
import { createWait } from './wait.js'
import { createJobs } from './jobs.js'
import { createWeb } from './web.js'
import { createTools } from './tools.js'
import { buildBgjobsGuidance } from '../guidance.js'

export function apply(ctx) {
  // 依赖方向（无环）：store ← notify ← registry ← watch ← wait/jobs ← web/tools。
  const store = createStore()
  const notify = createNotify(ctx)
  const registry = createRegistry(ctx, store)
  const watch = createWatch(ctx, store, { notify: notify.api, registry: registry.api })
  const wait = createWait(ctx, store, { watch: watch.api, registry: registry.api })
  const jobs = createJobs(ctx, store, { watch: watch.api, registry: registry.api })
  const web = createWeb(ctx, store, { watch: watch.api, registry: registry.api })
  const tools = createTools(ctx, store, { jobs: jobs.api, wait: wait.api, registry: registry.api })

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
    for (const d of web.dispose) run(d)
    run(disposeGuidance)
  }
}
