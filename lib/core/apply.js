// bgjobs core —— 插件装配（v0.1.61 结构重构）。
// apply(ctx) 只做编排：建 store → 依依赖序建各域 → 收拢 disposers → 返回清理。
// 域对象 = { api, dispose }：api 供其它域经 deps 注入调用；dispose 为本域注册的清理函数。

import { createStore } from './store.js'
import { createEnginesService } from './engines.js'
import { batEngine, pwshEngine } from '../engines/shell/index.js'
import { createNotify } from './notify.js'
import { createRegistry } from './registry.js'
import { createWatch } from './watch.js'
import { createWait } from './wait.js'
import { createJobs } from './jobs.js'
import { createWeb } from './web.js'
import { createTools } from './tools.js'
import { buildBgjobsGuidance } from '../guidance.js'
import { mergeGlobalConfig } from './config-file.js'
import { reconcileOrphanTasks } from '../exec/reconcile.mjs'

export function apply(ctx, config = {}) {
  // 依赖方向（无环）：store ← engines ← notify ← registry ← watch ← wait/jobs ← web/tools。
  const store = createStore()
  // Engine registry（能力缝 Service Definition）：注册内置 shell engines（bat + pwsh）；
  // 独立插件可在 apply() 里自行 ctx.bgjobEngines.registerEngine() 接入。mcp engine 由
  // dsh-mcp-control 独立包注册；未安装时 MCP 提交报 "engine \"mcp\" not registered"。
  // ★ 必须走 ctx.provide：cordis 4 的 plugin fiber 里直接给 ctx 赋值会抛
  //   "cannot set property ... without provide"，导致整个 apply 失败（插件完全不可用）。
  const engines = createEnginesService()
  ctx.provide('bgjobEngines', engines)
  const engineDisposers = [
    engines.registerEngine(batEngine),
    engines.registerEngine(pwshEngine),
  ]
  const notify = createNotify(ctx)
  const registry = createRegistry(ctx, store)
  const watch = createWatch(ctx, store, { notify: notify.api, registry: registry.api })
  const wait = createWait(ctx, store, { watch: watch.api, registry: registry.api })
  const jobs = createJobs(ctx, store, { watch: watch.api, registry: registry.api, engines })
  // 提交能力供外部 engine 插件（dsh-mcp-control）使用：MCP 工具经此提交 mcp 任务。
  // 同样必须 provide（外部插件以 inject: ['bgjobs'] 消费）。
  ctx.provide('bgjobs', {
    submitJob: jobs.api.submitJob,
    decideJobSandbox: jobs.api.decideJobSandbox,
    waitSubmittedAny: wait.api.waitSubmittedAny,
  })
  const web = createWeb(ctx, store, { watch: watch.api, registry: registry.api, notify: notify.api })
  // web 域先于 tools 建域：它的 api 里已外露 killJob / removeJob（见 core/web.js 的 return
  // { api: { killJob, removeJob, cleanupDone } }）——工具层只接线转达，**不再复写一份实现**。
  const tools = createTools(ctx, store, {
    jobs: jobs.api, wait: wait.api, registry: registry.api,
    web: { killJob: web.api.killJob, removeJob: web.api.removeJob },
    // D1：插件 config 作种子，$DSH_HOME/bgjobs/config.json 覆盖它（文件是唯一全局值）。
    config: mergeGlobalConfig(config),
  })

  // 模型可见的使用指引（system prompt section；镜像 dsh-ai4scholar 的 guidance）。
  const disposeGuidance = ctx.systemPrompt.section({
    name: 'tool:bgjobs',
    order: 150,
    text: buildBgjobsGuidance(),
  })

  const run = (fn) => { try { fn() } catch (e) { /* noop */ } }
  // 启动期对账（spec v7 §4.5）：延迟启动，避免和 registry 恢复抢任务查询；失败静默。
  // 只清「不在索引 + 非 Running + 超过 90s」的 dsh-bgj-* 任务，绝不碰运行中的实例。
  // 测试进程（node --test 设置 NODE_TEST_CONTEXT）不启动，避免单测真的去查/删系统任务。
  let reconcileTimer = null
  if (!process.env.NODE_TEST_CONTEXT) {
    reconcileTimer = setTimeout(() => {
      reconcileOrphanTasks().catch(() => {})
    }, 3000)
    if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref()
  }
  return () => {
    if (reconcileTimer !== null) clearTimeout(reconcileTimer)
    // 顺序沿用原单文件实现：停 tick → 关监视 → 注销工具 → 事件监听 → 路由 → guidance。
    for (const d of watch.dispose) run(d)
    for (const job of store.registry.values()) run(() => watch.api.closeWatch(job))
    for (const d of tools.dispose) run(d)
    for (const d of notify.dispose) run(d)
    for (const d of web.dispose) run(d)
    for (const d of engineDisposers) run(d)
    run(disposeGuidance)
  }
}
