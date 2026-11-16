// bgjobs —— Engine Registry Service.
// 能力缝 Service Definition：bgjobs 只持有 registry，不知道 engine 的内部实现。
// shell engine（bat/pwsh）内置在 bgjobs 包里注册；其它 engine 由独立插件在 apply() 里调
// ctx.bgjobEngines.registerEngine() 接入。宿主不认识任何具体插件/包名。

import { BGJOB_SANDBOX_POLICIES } from '../sandbox.js'
import { isSafeJobFileName } from '../util.js'

/** 一个后台任务执行后端。每个 engine 注册一个稳定 id，submitJob 按 engine 参数路由。 */
export class BgjobEngine {
  /** 稳定 id；submitJob 的 engine 参数精确匹配。冲突（同名 id）抛错。 */
  id = ''
  /** 引擎展示名；缺省 id。 */
  label = ''
  /** 可选：声明是否支持 sandbox。默认 false。 */
  supportsSandbox = false
  /**
   * 可选契约：沙箱策略（见 sandbox.js 的 BGJOB_SANDBOX_POLICIES）。缺省 'inherit'。
   * 宿主只读这个声明，不按引擎 id 特判。
   */
  sandboxPolicy = 'inherit'
  /**
   * 可选契约：任务目录里可能落盘的 pid 文件（按优先级）。
   *   [{ name: 'xxx.pid', owned: true }] —— owned=true 表示该 pid 的命令行应含本任务
   *   jobDir/taskName（kill/判定时做归属核验）；owned=false 表示只判存活、不做归属核验。
   * 缺省（不声明）回落 [{ name: 'run.pid', owned: true }]。
   *   [] 表示显式声明"本引擎不落 pid 文件" ⇒ kill/判定走 jobDir 反查（不回落 run.pid）。
   * 名字必须是任务目录内的单段文件名（见 util.js 的 isSafeJobFileName）。
   */
  pidFiles = undefined
  /** 可选契约：任务目录里的结果文件名（相对 jobDir）。缺省 = 不读结果文件。 */
  resultFile = undefined

  constructor(overrides) {
    Object.assign(this, overrides)
    if (!this.id || typeof this.id !== 'string') throw new Error('BgjobEngine.id must be a non-empty string')
    this.label ||= this.id
    // 类字段初始值只在"未传这个 key"时生效；Object.assign 会把显式 undefined / null 覆盖进来，
    // 这里把"未设置"语义恢复成缺省值（空串等非法值仍走下面的白名单校验，不被静默吞掉）。
    if (this.sandboxPolicy === undefined || this.sandboxPolicy === null) this.sandboxPolicy = 'inherit'
    if (!BGJOB_SANDBOX_POLICIES.includes(this.sandboxPolicy)) {
      throw new Error('BgjobEngine.sandboxPolicy must be one of ' + BGJOB_SANDBOX_POLICIES.join(' | '))
    }
    if (this.pidFiles !== undefined) {
      if (!Array.isArray(this.pidFiles)) throw new Error('BgjobEngine.pidFiles must be an array')
      for (const entry of this.pidFiles) {
        if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.name.length === 0) {
          throw new Error('BgjobEngine.pidFiles entries must be { name: string, owned?: boolean }')
        }
        if (entry.owned !== undefined && typeof entry.owned !== 'boolean') {
          throw new Error('BgjobEngine.pidFiles entry "owned" must be a boolean')
        }
        if (!isSafeJobFileName(entry.name)) {
          throw new Error('BgjobEngine.pidFiles entry name must be a plain file name inside the job dir '
            + '(no path separators, no ".."): ' + entry.name)
        }
      }
    }
    if (this.resultFile !== undefined && !isSafeJobFileName(this.resultFile)) {
      throw new Error('BgjobEngine.resultFile must be a plain file name inside the job dir '
        + '(no path separators, no ".."): ' + String(this.resultFile))
    }
    // 契约字段由宿主读取：注册后不可写（防止插件在 apply() 之后改声明绕过校验）。
    for (const key of ['sandboxPolicy', 'pidFiles', 'resultFile']) {
      Object.defineProperty(this, key, { writable: false, enumerable: true })
    }
    this.resolve ||= async () => ({})
    this.buildMeta ||= () => ({})
    this.writeFiles ||= async () => ({})
    // 两种 engine 形态：
    //   - 描述符引擎（新链路）：提供 buildDescriptor，任务定义由 host.mjs 承载；
    //   - 旧链路引擎：提供 buildTr 返回 schtasks /TR 字符串。
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
        // 卸载即注销：外部引擎插件重载时会再次 registerEngine，不去重就会报
        // "already registered" 且留下指向已销毁闭包的僵尸 engine。只删自己注册的那一份，
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
