// bgjobs core —— 提交域（v0.1.61 结构重构；自 lib/index.js apply 拆分）。
// 会话态判定 + 沙箱决策（审批胶水）+ 任务提交（schtasks 双引擎脚本落盘/创建/运行）。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { strip, errorMsg } from '../util.js'
import { BGJOB_NOTIFY_MODES, BGJOB_NOTIFY_DELIVERIES } from '../notify-policy.js'
import { jobSandboxDecision } from '../sandbox.js'
import { resolveBgjobsHome } from '../index-store.js'
import {
  SCHTASKS, ICACLS, runSchtasks, resolveShell, resolveSandboxRunner,
} from '../runners.js'
import { buildPs1, buildPwshRunner, buildCmdBat, buildBat, buildLaunchVbs } from '../scripts.js'

export function createJobs(ctx, store, deps) {
  const registry = store.registry
  const { readFullAccess } = store
  const { startWatch } = deps.watch
  const { indexUpsert } = deps.registry

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

  const submitJob = async (jobName, command, workdirRaw, createdBySession, engine = 'bat', sandboxMode = 'off', notify = 'off', notifyMode = 'wakeup') => {
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
    const batPath = jobDir + '\\run.bat'
    const launchVbsPath = jobDir + '\\launch.vbs'
    const runnerPath = jobDir + '\\run.ps1'
    const cmdPath = jobDir + '\\cmd.bat'
    const wscriptExe = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\wscript.exe'
    const isPwsh = engine === 'pwsh'
    const sandboxed = sandboxMode !== 'off'
    // 沙箱任务只支持 pwsh 引擎（runner 包装 `解释器 -File job.ps1`；bat 语法经 cmd /c 引号
    // 陷阱多，v1 不接）。此分支对 bgjob_submit(bat) 不可达（决策函数恒给 off）。
    if (sandboxed && !isPwsh) return { ok: false, error: 'sandbox is only supported on the PowerShell engine; submit via bgjob_submit_pwsh' }
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
    // pwsh 引擎：先解析 PowerShell 解释器（提交时烘焙绝对路径进 /TR 与 meta.interpreter）。
    let shell = null
    if (isPwsh) {
      shell = await resolveShell()
      if (shell === null) {
        await cleanupDir()
        return { ok: false, error: 'PowerShell not found: install pwsh (7+) or Windows PowerShell' }
      }
    }
    const meta = {
      id: jobId, name: String(jobName), workdir, taskName, jobDir,
      logPath, exitcodePath, jsonPath, command: String(command),
      createdBySession: String(createdBySession || ''), createdAt: Date.now(), status: 'running',
      sandbox: sandboxMode, // resolved 模式（含 off）落盘：审计 + recover/离线展示无需再推导
      // 完成通知创建者（v0.1.31）：off 省略；on 时落盘触发条件 + 交付方式供 recover/离线只读
      ...(notifyOn !== 'off' ? { notify: notifyOn, notifyMode: notifyDelivery } : {}),
    }
    if (isPwsh) {
      meta.engine = 'pwsh'
      meta.scriptPath = jobDir + '\\job.ps1'
      meta.interpreter = shell.exe
    } else {
      meta.cmdPath = cmdPath
    }
    // 沙箱任务 wiring：解析 runner 绝对路径 + 私有临时根（$DSH_HOME/bgjobs/sandbox/<id>，
    // 位于 workspace 之外）；node 用 DSH 进程同款（koffi 原生绑定 ABI 匹配）。
    if (sandboxed) {
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
      meta.sandboxRunnerPath = sbRunner
      meta.sandboxTempPath = sandboxTemp
      meta.nodeExe = process.execPath
    }
    const job = { id: jobId, meta, status: 'running', exitCode: undefined, pos: 0, tail: '', decoder: new TextDecoder(), watch: undefined, checkTimer: undefined, lastCompletionCheck: 0 }
    try {
      if (isPwsh) {
        // job.ps1 / run.ps1 必须以 UTF-8 with BOM 写入：PowerShell 5.1 解析无 BOM 文件按 ANSI/GBK 读，中文会乱。
        const bom = Buffer.from([0xef, 0xbb, 0xbf])
        await fsp.writeFile(meta.scriptPath, Buffer.concat([bom, Buffer.from(buildPs1(job), 'utf8')]))
        await fsp.writeFile(runnerPath, Buffer.concat([bom, Buffer.from(buildPwshRunner(job), 'utf8')]))
      } else {
        await fsp.writeFile(cmdPath, buildCmdBat(job), 'utf8')
        await fsp.writeFile(batPath, buildBat(job), 'utf8')
        // 隐藏窗口启动器：wscript 以 SW_HIDE 运行 run.bat（bat 引擎零 PowerShell 依赖）
        await fsp.writeFile(launchVbsPath, buildLaunchVbs(), 'utf8')
      }
      await fsp.writeFile(jsonPath, JSON.stringify(meta), 'utf8')
    } catch (e) {
      await cleanupDir()
      return { ok: false, error: 'write job files failed: ' + errorMsg(e) }
    }
    // 沙箱任务：jobDir 授 Everyone 只读——受限子进程（去 Authenticated Users/INTERACTIVE）要读
    // job.ps1/解释器，jobDir 位于用户目录（默认无 Everyone 读）会直接读不到而失败。副作用：
    // job.ps1（用户命令文本）对本地用户可读，README 已注明。
    if (sandboxed) {
      const grant = await runSchtasks([ICACLS, jobDir, '/grant', 'Everyone:(OI)(CI)RX', '/T', '/C'], workdir)
      if (grant.exitCode !== 0) {
        await cleanupDir()
        return { ok: false, error: 'icacls grant failed for sandboxed job: ' + grant.stderr + grant.stdout }
      }
    }
    const d = new Date(Date.now() + 60000)
    const st = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
    // /TR 目标：pwsh 引擎直接调解释器执行 run.ps1（-WindowStyle Hidden 隐藏控制台窗口）；
    // bat 引擎经 wscript.exe 执行 launch.vbs（SW_HIDE 隐藏启动 run.bat，零 PowerShell 依赖）。
    // Node spawn 传 argv 数组：/TR 值用普通引号形式（"prog" -args "path"），Node 自会做命令行
    // 转义；PS 侧（Invoke-BgjobsSchtasks 用 Arguments 字符串）需整体引号+内部转义，见
    // dsh-bgjobs-lib.ps1 的 Submit-BgjobsJob（双端此处写法不同，勿强求镜像）。
    const trValue = isPwsh
      ? '"' + shell.exe + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + runnerPath + '"'
      : '"' + wscriptExe + '" "' + launchVbsPath + '"'
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
