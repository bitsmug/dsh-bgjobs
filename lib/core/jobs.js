// bgjobs core —— 提交域（v0.1.61 结构重构；自 lib/index.js apply 拆分）。
// 会话态判定 + 沙箱决策（审批胶水）+ 任务提交（schtasks 双引擎脚本落盘/创建/运行）。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strip, errorMsg, probeAnsiCodePage, codePageLabel } from '../util.js'
import { BGJOB_NOTIFY_MODES, BGJOB_NOTIFY_DELIVERIES } from '../notify-policy.js'
import { jobSandboxDecision } from '../sandbox.js'
import { resolveBgjobsHome } from '../index-store.js'
import { DSH_BACKEND_DISABLED_ERROR } from './store.js'
import {
  SCHTASKS, ICACLS, runSchtasks, resolveSandboxRunner, resolveNodeExeInfo,
  probeNodeVersion, peSubsystem,
} from '../runners.js'
import { encodeDescriptor, buildTarget, validateDescriptor, DESCRIPTOR_VERSION } from '../exec/descriptor.mjs'
import { planLaunch, directStrategy, wscriptShimStrategy, isWshDisabled } from '../exec/launch.mjs'
import { buildPwshEnvelope, buildPwshDelivery, buildEnvPrefix } from '../exec/envelope.mjs'
import { registerAndStartTask } from '../exec/task.mjs'

/** 链首薄主机（插件包内固定文件；I1）。 */
const HOST_SCRIPT = fileURLToPath(new URL('../exec/host.mjs', import.meta.url))

export function createJobs(ctx, store, deps) {
  const registry = store.registry
  const { readFullAccess, readSandboxBackends, readLaunchHidden } = store
  const { startWatch } = deps.watch
  const { indexUpsert } = deps.registry
  const { engines } = deps

  /**
   * 会话态：'none'（未挂载 sandboxPolicy 服务）/ 'full'（服务在但 resolve 得
   * danger-full-access，会话全权限）/ 受限模式（read-only/workspace-write）。
   * resolve 失败或返回意外 mode 时 fail-closed 抛错——绝不把受限会话静默当全权限。
   */
  const sessionModeOf = (exec) => {
    const policySvc = ctx.get('sandboxPolicy')
    if (!policySvc) return 'none'
    const session = exec && exec.agent && exec.agent.session
    let pol
    try { pol = policySvc.resolve(session ? { session } : {}) } catch (e) {
      throw new Error('bgjob: sandbox policy resolve failed: ' + errorMsg(e))
    }
    const mode = pol && pol.mode
    if (mode === 'danger-full-access') return 'full'
    if (mode === 'read-only' || mode === 'workspace-write') return mode
    throw new Error('bgjob: unexpected sandbox policy mode: ' + String(mode))
  }
  /**
   * bgjob_submit/bgjob_submit_pwsh 公共判定：默认继承会话模式（pwsh）/恒 off（bat）。
   * 未挂载沙箱服务（state='none'）且 full access 关 → 拒绝（jobSandboxDecision 抛错）；
   * bat 引擎恒全权限、无法沙箱化 → 受限会话仅 full access 模式支持（关则拒绝，不走逐次审批）；
   * pwsh 受限会话更宽请求在 full access 开关关时经 ctx.approval 弹窗审批（镜像 dsh 升权流程）。
   * 返回最终 sandboxMode（'off'|'read-only'|'workspace-write'）——resolved 值，落盘 job.json。
   */
  const decideJobSandbox = async (args, exec, toolName, engine) => {
    const fullAccess = await readFullAccess()
    const state = sessionModeOf(exec)
    const { mode, escalate } = jobSandboxDecision(
      state,
      engine === 'pwsh' ? args.sandbox : undefined,
      engine,
      fullAccess,
    )
    if (escalate) {
      if (!exec || !exec.agent) throw new Error('bgjob sandbox escalation requires an agent session')
      const approval = ctx.get('approval')
      if (!approval) throw new Error('bgjob sandbox escalation requires the approval service, but none is composed')
      const label = mode === 'off' ? 'full access' : mode
      const reason = 'escalate bgjob sandbox to ' + label + ': '
        + (typeof args.justification === 'string' && args.justification.trim().length > 0 ? args.justification : 'background task needs wider filesystem access')
      const outcome = await approval.request({
        agent: exec.agent,
        toolName,
        callId: exec.callId,
        reason,
        ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      })
      if (outcome !== 'allowed-once') {
        if (outcome === 'rejected') throw new Error('the user rejected escalating this bgjob to "' + label + '"')
        if (outcome === 'cancelled') throw new Error('approval for escalating this bgjob to "' + label + '" was cancelled')
        throw new Error('bgjob sandbox escalation requires approval, but no approval channel is available')
      }
    }
    return mode
  }

  /**
   * 描述符链路提交（v0.4 P0，spec v7 §4.3/§4.4）：执行输入全部进任务定义，
   * 工作区只写 job.json（记录）与 cmd.ps1（原始命令，仅供人读）；不生成任何可执行脚本，
   * 因此也不做任何 ACL 处理。
   */
  const submitDescriptorJob = async (p) => {
    const {
      jobId, taskName, jobDir, workdir, jobName, command, createdBySession,
      eng, extra, sandboxed, sandboxMode, sandboxBackend, outputEncoding,
      notifyOn, notifyDelivery,
    } = p
    const logPath = jobDir + '\\stdout.log'
    const exitcodePath = jobDir + '\\exitcode.txt'
    const jsonPath = jobDir + '\\job.json'
    let sandboxTemp = ''
    const cleanupDir = () => Promise.all(
      [jobDir, sandboxTemp].filter(Boolean).map((x) => fsp.rm(x, { recursive: true, force: true }).catch(() => {})),
    )
    try {
      await fsp.mkdir(jobDir, { recursive: true })
    } catch (e) {
      return { ok: false, error: 'create job dir failed: ' + errorMsg(e) }
    }
    const r = await eng.resolve(ctx, { workdir, extra })
    if (r && r.error) { await cleanupDir(); return { ok: false, error: r.error } }
    const resolveOut = r || {}
    const meta = {
      id: jobId, name: String(jobName), workdir, taskName, jobDir,
      ...(extra && extra.env && typeof extra.env === 'object' ? { env: extra.env } : {}),
      logPath, exitcodePath, jsonPath, command: String(command),
      createdBySession: String(createdBySession || ''), createdAt: Date.now(), status: 'running',
      sandbox: sandboxMode,
      outputEncoding,
      // 日志字节所属码页（v11）：auto/utf8 收尾后是 UTF-8 ⇒ 65001；native 落系统 ANSI 码页。
      // 读取端（registry/watch/面板）按它解码，native 日志不再被当 UTF-8 读成乱码。
      logCodePage: outputEncoding === 'native' ? (probeAnsiCodePage() || 936) : 65001,
      // 日志格式（v13）：auto 运行期是 28591 字节成像（需显示层还原），收尾后 host 落
      // `log.format='utf8'` 并由 watch 把它改成 'utf8' ⇒ 读取端不再解码（保住 `°±·` 这类文本）。
      ...(outputEncoding === 'auto' ? { logFormat: 'latin1-legacy' } : {}),
      layout: 2,
      ...(notifyOn !== 'off' ? { notify: notifyOn, notifyMode: notifyDelivery } : {}),
    }
    Object.assign(meta, eng.buildMeta(ctx, meta, resolveOut, extra))
    // env = 命令前缀（§4.3）：在用户命令之前赋值，沙箱只决定进程初始环境，脚本内赋值永远最后
    // 生效 ⇒ direct / acl / dsh 三条链路一致，不依赖 provider 是否支持 temp 重定向。
    // 非法键名 / 非标量值 / 含换行是入参错误，提交期 fail loud（不再静默剔除）。
    let envPrefix = ''
    try {
      envPrefix = buildEnvPrefix(meta.engine === 'bat' ? 'bat' : 'pwsh', extra && extra.env)
    } catch (e) {
      await cleanupDir()
      return { ok: false, error: errorMsg(e) }
    }
    const effectiveCommand = envPrefix + String(command)
    if (envPrefix !== '') meta.envPrefix = envPrefix
    meta.effectiveCommand = effectiveCommand
    // host 自身也必须是真 node：任务计划里 GUI 子系统 exe 会静默失败（无日志、假成功）。
    const hostNode = await resolveNodeExeInfo(workdir)
    if (hostNode === null) {
      await cleanupDir()
      return { ok: false, error: 'a real console-subsystem node executable could not be located for the task host' }
    }
    if (await peSubsystem(hostNode.exe) === 2) {
      await cleanupDir()
      return { ok: false, error: 'task host needs a console-subsystem node (got a GUI-subsystem executable: ' + hostNode.exe + ')' }
    }
    meta.nodeExe = hostNode.exe
    meta.nodeExeSource = hostNode.source
    // dsh 后端：提交期 confine() 一次，结果（含 -EncodedCommand 信封）整条进描述符 `a`。
    // ★ 不传 sessionId（§12-E4）：否则产物指向会话级 temp，DSH 退出后任务必然失败。
    if (sandboxed && sandboxBackend === 'dsh') {
      if (!(await readSandboxBackends())) {
        await cleanupDir()
        return { ok: false, error: DSH_BACKEND_DISABLED_ERROR }
      }
      const sandboxSvc = ctx.get('sandbox')
      if (!sandboxSvc || typeof sandboxSvc.confine !== 'function') {
        await cleanupDir()
        return { ok: false, error: 'sandbox_backend=dsh requires the dsh sandbox service (ctx.sandbox), but no sandbox provider is composed in this profile' }
      }
      if (typeof meta.interpreter !== 'string' || meta.interpreter.length === 0) {
        await cleanupDir()
        return { ok: false, error: 'sandbox_backend=dsh requires a resolved interpreter' }
      }
      const policy = { mode: sandboxMode, workspaceRoot: workdir }
      const envelope = buildPwshEnvelope(effectiveCommand, { encoding: outputEncoding, interpreter: meta.interpreter })
      let confined
      try {
        confined = await sandboxSvc.confine(buildPwshDelivery({ interpreter: meta.interpreter, envelope }), policy)
      } catch (e) {
        await cleanupDir()
        return { ok: false, error: 'sandbox confine failed: ' + errorMsg(e) }
      }
      const confinedArgv = confined && Array.isArray(confined.argv) ? confined.argv : null
      if (confinedArgv === null || confinedArgv.length === 0) {
        await cleanupDir()
        return { ok: false, error: 'sandbox confine returned no argv' }
      }
      meta.sandboxBackend = 'dsh'
      meta.confinedArgv = confinedArgv
      if (typeof confined.enforcement === 'string') meta.enforcement = confined.enforcement
    }
    // acl 后端：runner 绝对路径 + 私有 temp 根（workspace 之外）。不再需要 icacls（无脚本可读）。
    if (sandboxed && sandboxBackend !== 'dsh') {
      const sbRunner = await resolveSandboxRunner()
      if (!sbRunner) {
        await cleanupDir()
        return { ok: false, error: 'sandbox requested but runner not found: install @deepseek-ai/dsh-sandbox-windows-acl in the plugin (pnpm install) or set BGJOBS_SANDBOX_RUNNER' }
      }
      sandboxTemp = path.join(resolveBgjobsHome(), 'bgjobs', 'sandbox', jobId)
      try { await fsp.mkdir(sandboxTemp, { recursive: true }) } catch (e) {
        await cleanupDir()
        return { ok: false, error: 'create sandbox temp failed: ' + errorMsg(e) }
      }
      meta.sandboxBackend = 'acl'
      meta.sandboxRunnerPath = sbRunner
      meta.sandboxTempPath = sandboxTemp
      const nodeExeVersion = await probeNodeVersion(hostNode.exe)
      meta.nodeExeVersion = nodeExeVersion
      if (nodeExeVersion === null) meta.sandboxRunnerNodeVersionProbeFailed = true
    }
    const fields = eng.buildDescriptor(ctx, { meta, sandbox: sandboxMode, backend: sandboxBackend, resolveOut, extra })
    if (fields && fields.error) { await cleanupDir(); return { ok: false, error: fields.error } }
    const descriptor = {
      v: DESCRIPTOR_VERSION,
      m: fields.m,
      id: jobId,
      n: String(jobName),
      e: fields.e,
      o: fields.o,
      s: String(createdBySession || ''),
      w: workdir,
      ...(fields.b !== undefined ? { b: fields.b } : {}),
      ...(fields.p !== undefined ? { p: fields.p } : {}),
      ...(fields.t !== undefined ? { t: fields.t } : {}),
      ...(fields.c !== undefined ? { c: fields.c } : {}),
      ...(fields.a !== undefined ? { a: fields.a } : {}),
    }
    let action
    const launchWarnings = []
    try {
      validateDescriptor(descriptor)
      const target = buildTarget({ nodeExe: hostNode.exe, hostScript: HOST_SCRIPT, jobDir, descriptor: encodeDescriptor(descriptor) })
      // 启动策略（spec-launch-strategy.md）：缺省 direct ⇒ 动作与加本特性前**逐字相同**（L11）；
      // 面板开关开启才经包内 launch.vbs（GUI 子系统）启动，避免 Windows Terminal 下的可见窗口。
      let strategy = directStrategy
      if (await readLaunchHidden()) {
        if (isWshDisabled()) {
          launchWarnings.push('hide-window unavailable: Windows Script Host is disabled; the task was launched directly and a console window may appear')
        } else {
          strategy = wscriptShimStrategy
        }
      }
      action = planLaunch({ target, strategy, errorDir: jobDir })
      meta.rootKind = action.rootKind
      meta.launch = action.rootKind === 'shim' ? 'wscript-shim' : 'direct'
    } catch (e) {
      await cleanupDir()
      return { ok: false, error: errorMsg(e) }
    }
    const job = {
      id: jobId, meta, status: 'running', exitCode: undefined, pos: 0, tail: '',
      decoder: new TextDecoder(codePageLabel(meta.logCodePage)), watch: undefined, checkTimer: undefined,
      lastCompletionCheck: 0, completionTask: undefined,
    }
    try {
      await fsp.writeFile(jsonPath, JSON.stringify(meta), 'utf8')
      await fsp.writeFile(meta.recordPath, '\uFEFF' + String(effectiveCommand).split(/\r?\n/).join('\r\n') + '\r\n', 'utf8')
    } catch (e) {
      await cleanupDir()
      return { ok: false, error: 'write job files failed: ' + errorMsg(e) }
    }
    const started = await registerAndStartTask({ taskName, execute: action.execute, args: action.arguments, workdir })
    if (!started.ok) {
      await cleanupDir()
      return { ok: false, error: started.error }
    }
    registry.set(jobId, job)
    startWatch(job)
    indexUpsert(job)
    return { ok: true, jobId, taskName, logPath, ...(launchWarnings.length > 0 ? { warnings: launchWarnings } : {}) }
  }

  const submitJob = async (jobName, command, workdirRaw, createdBySession, engine = 'bat', sandboxMode = 'off', notify = 'off', notifyMode = 'wakeup', extra) => {
    // notify/notifyMode 防御性归一（schema enum 已挡非法值；程序直调也 fail-soft 到缺省）。
    const notifyOn = BGJOB_NOTIFY_MODES.includes(notify) ? notify : 'off'
    const notifyDelivery = BGJOB_NOTIFY_DELIVERIES.includes(notifyMode) ? notifyMode : 'wakeup'
    const workdir = strip(String(workdirRaw))
    const jobId = 'bg-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36)
    const taskName = 'dsh-bgj-' + jobId
    const jobDir = workdir + '\\.dsh\\bgjobs\\' + jobId
    const logPath = jobDir + '\\stdout.log'
    const exitcodePath = jobDir + '\\exitcode.txt'
    const jsonPath = jobDir + '\\job.json'
    // Engine registry 查找：engine 未注册 → fail-closed，且在建 jobDir **之前**返回（零副作用）。
    const eng = engines ? engines.get(engine) : null
    if (eng === null) return { ok: false, error: 'bgjobs: engine "' + engine + '" not registered' }
    const sandboxed = sandboxMode !== 'off'
    // 沙箱后端（实验，默认关；开关见 store.js 的 sandbox-backends）：'acl' = 内置 ACL runner
    // （老路径，**逐字不变**）；'dsh' = 复用会话的 dsh 沙箱 provider（ctx.sandbox.confine）。
    // 取值只认这两个；★ v0.3.3 起**缺省/未传 = 'dsh'**（ACL 档受限令牌起不了 MATLAB/.NET/py 等真程序，
  // 典型报错 ''Fatal Startup Error: System Error: File system inconsistency''）；显式写 'acl' 仍可退回老路径。
  // ★ 校验放在建 jobDir **之前** ⇒ 非法值零副作用。
    const rawBackend = extra && extra.sandboxBackend !== undefined && extra.sandboxBackend !== null
      ? String(extra.sandboxBackend) : ''
    if (rawBackend !== '' && rawBackend !== 'acl' && rawBackend !== 'dsh') {
      return { ok: false, error: 'invalid sandbox_backend: "' + rawBackend + '" (expected acl | dsh)' }
    }
    const sandboxBackend = rawBackend === 'acl' ? 'acl' : 'dsh'
    // 逐任务编码选择（v0.2.6 引入；v0.3.2 新增 'auto' 并设为**新缺省**）：只认
    // undefined（⇒ 'auto'）/ 'utf8' / 'native' / 'auto'；其它值 fail loud。
    // ★ 与 sandboxBackend 同样放在建 jobDir **之前** ⇒ 非法值零副作用。
    // auto = 无损捕获（28591 成像）+ 收尾检测（严格 UTF-8 通过⇒UTF-8，否则⇒系统 ANSI 码页），见 buildPwshRunner。
    const rawEncoding = extra && extra.outputEncoding !== undefined && extra.outputEncoding !== null
      ? String(extra.outputEncoding) : ''
    if (rawEncoding !== '' && rawEncoding !== 'utf8' && rawEncoding !== 'native' && rawEncoding !== 'auto') {
      return { ok: false, error: 'invalid output_encoding: "' + rawEncoding + '" (expected utf8 | native | auto)' }
    }
    const outputEncoding = rawEncoding === '' ? 'auto' : rawEncoding
    // 沙箱任务需要 engine 声明支持（runner 包装 `解释器 -File job.ps1`；bat 语法经 cmd /c 引号
    // 陷阱多，不接）。此分支对 bgjob_submit(bat) 不可达（决策函数恒给 off）。
    if (sandboxed && !eng.supportsSandbox) return { ok: false, error: 'bgjobs: engine "' + engine + '" does not support sandbox' }
    // ── 描述符链路（v0.4 P0）：engine 提供 buildDescriptor ⇒ 执行输入全部进任务定义 ──
    if (typeof eng.buildDescriptor === 'function') {
      return await submitDescriptorJob({
        jobId, taskName, jobDir, workdir, jobName, command, createdBySession,
        eng, extra, sandboxed, sandboxMode, sandboxBackend, outputEncoding,
        notifyOn, notifyDelivery,
      })
    }
    // 以下为旧链路（bat / 外部 mcp engine）：仍生成脚本 + schtasks /Create /TR。
    // sandboxTemp：runner 私有临时根（须在 workspace 之外——assertTempRootOutsideWorkspace）。
    let sandboxTemp = ''
    const cleanupDir = () => Promise.all(
      [jobDir, sandboxTemp].filter(Boolean).map((p) => fsp.rm(p, { recursive: true, force: true }).catch(() => {})),
    )
    const deleteTask = () => runSchtasks([SCHTASKS, '/Delete', '/TN', taskName, '/F'], workdir)
    try {
      await fsp.mkdir(jobDir, { recursive: true })
    } catch (e) {
      return { ok: false, error: 'create job dir failed: ' + errorMsg(e) }
    }
    // engine 解析（提交时烘焙解释器绝对路径等进 meta）。
    const r = await eng.resolve(ctx, { workdir, extra })
    if (r && r.error) { await cleanupDir(); return { ok: false, error: r.error } }
    const resolveOut = r || {}
    const meta = {
      id: jobId, name: String(jobName), workdir, taskName, jobDir,
    ...(extra && extra.env && typeof extra.env === 'object' ? { env: extra.env } : {}),
      logPath, exitcodePath, jsonPath, command: String(command),
      createdBySession: String(createdBySession || ''), createdAt: Date.now(), status: 'running',
      sandbox: sandboxMode, // resolved 模式（含 off）落盘：审计 + recover/离线展示无需再推导
      // 编码选择（v0.2.6 引入；v0.3.2 起 pwsh 引擎**恒落盘**）：显示层解码闸门与读取端都靠该字段。
      // 老任务 job.json 无此字段 = 历史 utf8 语义（闸门不命中、离线重生成脚本走老形态）。
      ...(engine === 'pwsh'
        ? {
            outputEncoding,
            logCodePage: outputEncoding === 'native' ? (probeAnsiCodePage() || 936) : 65001,
            ...(outputEncoding === 'auto' ? { logFormat: 'latin1-legacy' } : {}),
          }
        : {}),
      // 完成通知创建者（v0.1.31）：off 省略；on 时落盘触发条件 + 交付方式供 recover/离线只读
      ...(notifyOn !== 'off' ? { notify: notifyOn, notifyMode: notifyDelivery } : {}),
    }
    // engine 特有 meta（解释器路径 / 脚本路径 / mcp 字段等）。
    Object.assign(meta, eng.buildMeta(ctx, meta, resolveOut, extra))
    // ── dsh 后端（实验；仅「开关开 + sandbox_backend='dsh'」时可达）──────────────────
    // 复用会话的 dsh 沙箱 provider：confine() 是**纯 argv 包装**（不 spawn、不持句柄、不订阅
    // DSH 生命周期）⇒ 提交期算一次、把结果烘进 run.ps1；任务仍由 schtasks 托管 ⇒ 关掉 DSH
    // 也不影响执行（与 README「进程外独立运行」的承诺一致）。
    // 该分支**跳过** ACL 档专属的一切：runner 路径解析、真 node（koffi N-API ABI）解析、
    // PE 子系统守卫、$DSH_HOME/bgjobs/sandbox/<id> 私有 temp 根（MXC 档下该位置不可读写）。
    if (sandboxed && sandboxBackend === 'dsh') {
      if (!(await readSandboxBackends())) {
        await cleanupDir()
        return { ok: false, error: DSH_BACKEND_DISABLED_ERROR }
      }
      const sandboxSvc = ctx.get('sandbox')
      if (!sandboxSvc || typeof sandboxSvc.confine !== 'function') {
        await cleanupDir()
        return { ok: false, error: 'sandbox_backend=dsh requires the dsh sandbox service (ctx.sandbox), but no sandbox provider is composed in this profile' }
      }
      // policy 形状 = { mode, workspaceRoot }（与 shell 沙箱执行器同款；参考 @deepseek-ai/dsh-pwsh-sandbox）。
      const policy = { mode: sandboxMode, workspaceRoot: workdir }
      const argv = [meta.interpreter, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', meta.scriptPath]
      let confined
      try {
        confined = await sandboxSvc.confine(argv, policy)
      } catch (e) {
        await cleanupDir()
        return { ok: false, error: 'sandbox confine failed: ' + errorMsg(e) }
      }
      const confinedArgv = confined && Array.isArray(confined.argv) ? confined.argv : null
      if (confinedArgv === null || confinedArgv.length === 0) {
        await cleanupDir()
        return { ok: false, error: 'sandbox confine returned no argv' }
      }
      meta.sandboxBackend = 'dsh'
      meta.confinedArgv = confinedArgv
      if (typeof confined.enforcement === 'string') meta.enforcement = confined.enforcement
    }
    // 沙箱任务 wiring：解析 runner 绝对路径 + 私有临时根（$DSH_HOME/bgjobs/sandbox/<id>，
    // 位于 workspace 之外）；node 用【真 node】（koffi 原生绑定 ABI 匹配）。
    if (sandboxed && sandboxBackend !== 'dsh') {
      const sbRunner = await resolveSandboxRunner()
      if (!sbRunner) {
        await cleanupDir()
        return { ok: false, error: 'sandbox requested but runner not found: install @deepseek-ai/dsh-sandbox-windows-acl in the plugin (pnpm install) or set BGJOBS_SANDBOX_RUNNER' }
      }
      // runner 必须由真 node 拉起（v0.1.90-alpha，issue #1）：execPath 是 GUI 子系统 exe 时
      // （桌面版 Electron），被 run.ps1 重定向 stdout 到文件会静默秒退 → 日志空白 + 假 exit 0。
      // 解析优先级见 resolveNodeExeImpl（v0.1.91：同源 node 先于 where.exe）；都拿不到 →
      // fail-closed 报错，绝不退回 execPath 假成功。
      const sbChoice = await resolveNodeExeInfo(workdir)
      // 文案中性（v0.1.91）：现在是多层探测（basename/env/自带/where），不是单靠 where.exe。
      // ⚠ 别顺手改下面的 GUI 守卫文案/判据（同文件紧邻分支，各自独立）。
      if (sbChoice === null) {
        await cleanupDir()
        return { ok: false, error: 'sandbox requested but a real console-subsystem node executable could not be located' }
      }
      const sbNodeExe = sbChoice.exe
      meta.nodeExeSource = sbChoice.source
      // PE 守卫：确证 GUI 子系统（Subsystem=2）→ 响亮拒绝；读不到/非 PE → 放行（见 peSubsystem）。
      if (await peSubsystem(sbNodeExe) === 2) {
        await cleanupDir()
        return { ok: false, error: 'sandbox runner needs a console-subsystem node (got a GUI-subsystem executable: ' + sbNodeExe + ')' }
      }
      sandboxTemp = path.join(resolveBgjobsHome(), 'bgjobs', 'sandbox', jobId)
      try { await fsp.mkdir(sandboxTemp, { recursive: true }) } catch (e) {
        await cleanupDir()
        return { ok: false, error: 'create sandbox temp failed: ' + errorMsg(e) }
      }
      meta.sandboxRunnerPath = sbRunner
      meta.sandboxTempPath = sandboxTemp
      meta.nodeExe = sbNodeExe
      // 所选 node 的版本（v0.1.91）：挑定解释器后真跑一次 `node --version`（短超时，见 runners.js）。
      // **纯诊断字段**——探测失败/超时/认不出 ⇒ 记 null 并附 `sandboxRunnerNodeVersionProbeFailed` 提示，
      // **绝不因此让提交失败**。★ 不设版本下限阈值：koffi 的实际版本要求未取证，先积累数据再判。
      const nodeExeVersion = await probeNodeVersion(sbNodeExe)
      meta.nodeExeVersion = nodeExeVersion
      if (nodeExeVersion === null) meta.sandboxRunnerNodeVersionProbeFailed = true
    }
    const job = { id: jobId, meta, status: 'running', exitCode: undefined, pos: 0, tail: '', decoder: new TextDecoder(codePageLabel(meta.logCodePage)), watch: undefined, checkTimer: undefined, lastCompletionCheck: 0, completionTask: undefined }
    try {
      const wf = await eng.writeFiles(ctx, { id: jobId, meta }, resolveOut, extra)
      if (wf && wf.error) { await cleanupDir(); return { ok: false, error: wf.error } }
      await fsp.writeFile(jsonPath, JSON.stringify(meta), 'utf8')
    } catch (e) {
      await cleanupDir()
      return { ok: false, error: 'write job files failed: ' + errorMsg(e) }
    }
    // 沙箱任务：jobDir 授 Everyone 只读——受限子进程（去 Authenticated Users/INTERACTIVE）要读
    // job.ps1/解释器，jobDir 位于用户目录（默认无 Everyone 读）会直接读不到而失败。副作用：
    // job.ps1（用户命令文本）对本地用户可读，README 已注明。
    // ★ dsh 后端不需要这条：容器按策略白名单读（进程不降权、不走受限令牌），且 icacls 在
    //   某些卷（属主非本账号）会失败并连带拒掉整次提交。
    if (sandboxed && sandboxBackend !== 'dsh') {
      const grant = await runSchtasks([ICACLS, jobDir, '/grant', 'Everyone:(OI)(CI)RX', '/T', '/C'], workdir)
      if (grant.exitCode !== 0) {
        await cleanupDir()
        return { ok: false, error: 'icacls grant failed for sandboxed job: ' + grant.stderr + grant.stdout }
      }
    }
    const d = new Date(Date.now() + 60000)
    const st = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
    // /TR 目标：pwsh 引擎直接调解释器执行 run.ps1（-WindowStyle Hidden 隐藏控制台窗口）；
    // bat / mcp 引擎经 wscript.exe 执行 launch.vbs（SW_HIDE 隐藏启动 run.bat）。
    // Node spawn 传 argv 数组：/TR 值用普通引号形式（"prog" -args "path"），Node 自会做命令行
    // 转义；PS 侧（Invoke-BgjobsSchtasks 用 Arguments 字符串）需整体引号+内部转义，见
    // dsh-bgjobs-lib.ps1 的 Submit-BgjobsJob（双端此处写法不同，勿强求镜像）。
    const trValue = eng.buildTr(ctx, { meta })
    const create = await runSchtasks([SCHTASKS, '/Create', '/TN', taskName, '/TR', trValue, '/SC', 'ONCE', '/ST', st, '/F'], workdir)
    if (create.exitCode !== 0) {
      await cleanupDir()
      return { ok: false, error: 'schtasks create failed: ' + create.stderr + create.stdout }
    }
    const run = await runSchtasks([SCHTASKS, '/Run', '/TN', taskName], workdir)
    if (run.exitCode !== 0) {
      // /Create 已成功但 /Run 失败：先删任务计划，再删目录，防系统残留 dsh-bgj-* 任务。
      await deleteTask()
      await cleanupDir()
      return { ok: false, error: 'schtasks run failed: ' + run.stderr + run.stdout }
    }
    // /Run 已触发执行：立即禁用任务计划，防 /ST（now+60s）整分再触发导致任务双跑。
    // 用 /Change /DISABLE 而非 /Delete：/Run 的实例是异步排队启动的，若紧接着 /Delete，
    // Task Scheduler 会连同注册一起丢弃排队中的运行实例→进程从未启动→永远 running 且无日志。
    // 禁用保留注册（运行实例照常跑完），bat 末尾自删与 done 兜底 /Delete 变无害 no-op。
    await runSchtasks([SCHTASKS, '/Change', '/TN', taskName, '/DISABLE'], workdir).catch(() => {})
    registry.set(jobId, job)
    startWatch(job)
    indexUpsert(job)
    return { ok: true, jobId, taskName, logPath }
  }

  return {
    api: { decideJobSandbox, submitJob },
    dispose: [],
  }
}
