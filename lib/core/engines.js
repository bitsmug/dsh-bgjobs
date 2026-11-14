// bgjobs —— Engine Registry Service.
// 能力缝 Service Definition：bgjobs 只持有 registry，不知道 engine 的内部实现。
// shell engine（bat/pwsh）内置在 bgjobs 包里注册；其它 engine（如 mcp）由独立插件在 apply()
// 里调 ctx.bgjobEngines.registerEngine() 接入。

/** 一个后台任务执行后端。每个 engine 注册一个稳定 id，submitJob 按 engine 参数路由。 */
export class BgjobEngine {
  /** 稳定 id；submitJob 的 engine 参数精确匹配。冲突（同名 id）抛错。 */
  id = ''
  /** 引擎展示名；缺省 id。 */
  label = ''
  /** 可选：声明是否支持 sandbox。默认 false。 */
  supportsSandbox = false

  constructor(overrides) {
    Object.assign(this, overrides)
    if (!this.id || typeof this.id !== 'string') throw new Error('BgjobEngine.id must be a non-empty string')
    this.label ||= this.id
    this.resolve ||= async () => ({})
    this.buildMeta ||= () => ({})
    this.writeFiles ||= async () => ({})
    // 两种 engine 形态：
    //   - 描述符引擎（新链路）：提供 buildDescriptor，任务定义由 host.mjs 承载；
    //   - 旧链路引擎（外部 mcp / bat）：提供 buildTr 返回 schtasks /TR 字符串。
    if (typeof this.buildTr !== 'function' && typeof this.buildDescriptor !== 'function') {
      throw new Error('BgjobEngine needs buildDescriptor (new chain) or buildTr (legacy /TR)')
    }
  }
}

/**
 * bgjobs 暴露给 engine 插件的注册表。apply() 初始化并通过 ctx.provide('bgjobEngines', …)
 * 挂到上下文（cordis 4 不允许直接给 ctx 赋值；消费方以 inject: ['bgjobEngines'] 取得）。
 * - registerEngine(engine)：原子验证（id 不冲突 + 钩子齐全）后注册；返回 disposer。
 * - get(id)：按 id 取；未注册返回 null。
 * - list()：全部已注册引擎（工具 schema 枚举用）。
 */
export function createEnginesService() {
  /** @type {Map<string, BgjobEngine>} */
  const byId = new Map()

  const service = {
    registerEngine(engine) {
      const e = engine instanceof BgjobEngine ? engine : new BgjobEngine(engine)
      if (byId.has(e.id)) {
        throw new Error('bgjobs: engine id "' + e.id + '" already registered; conflict in registerEngine')
      }
      byId.set(e.id, e)
      return () => {
        // 卸载即注销：外部插件（dsh-mcp-control）重载时会再次 registerEngine，不去重就会
        // 报 "already registered" 且留下指向已销毁闭包的僵尸 engine。只删自己注册的那一份，
        // 防止重复调用误删后来重新注册的实例。
        if (byId.get(e.id) === e) byId.delete(e.id)
      }
    },

    get(id) {
      return byId.get(String(id)) || null
    },

    list() {
      return Array.from(byId.values())
    },
  }

  return service
}
