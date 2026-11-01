// bgjobs core —— 工具注册域（v0.1.61 结构重构；自 lib/index.js apply 拆分）。
// 10 个 ctx.tools.register：bgjob_submit / bgjob_status / bgjob_wait（logic: any|all）/
// bgjob_list / bgjob_pending_list / bgjob_submit_pwsh / bgjob_submit_mcp / bgjob_mcp_tools /
// bgjob_kill（只终止进程、不删记录）/ bgjob_delete（只删记录、不杀进程；有活进程则拒绝）。
// execute 经 deps 调用各域 api。
// ★ kill / delete 两个入口**不新造语义**：一律原样转达 web 域已外露的 `killJob` / `removeJob`
//   （core/web.js 的 `api: { killJob, removeJob, cleanupDone }`），字段与文案的唯一来源仍是 host。

import { BGJOB_NOTIFY_MODES, BGJOB_NOTIFY_DELIVERIES } from '../notify-policy.js'
import { errorMsg } from '../util.js'
import { MCP_DISABLED_ERROR } from './store.js'
import { buildInboxWatch, concludeTurnOf } from './wait.js'
// 终态来源标记的唯一投影（与 view() / statusFromDisk 共用同一份字段名，见模块头注释）。
import { wrapperGoneOf } from './wrapper-gone.js'
import { getSessionGroups, setSessionGroups, resetSessionGroups, readProjectDefaults, resolveDefaults } from './defaults.js'
import { HELP_TOPICS, HELP_TOPIC_NAMES } from './help.js'

export function createTools(ctx, store, deps) {
  const registry = store.registry
  const { decideJobSandbox, submitJob } = deps.jobs
  const { waitJobDone, waitAnyOf, waitAllOf, waitSubmittedAny, sessionPendingIds } = deps.wait
  const { statusFromDisk, deliveredOf } = deps.registry
  const mcp = deps.mcp
  // kill / delete：host 的现成实现（core/web.js 已外露），工具层只做参数转达。
  const { killJob, removeJob } = deps.web

  // ── 三个引擎的实现（B′：合并口与旧名别名共用同一份实现，避免第二套逻辑） ──────────
  // 原 `bgjob_submit`(bat) / `bgjob_submit_pwsh` / `bgjob_submit_mcp` 的 execute 体原样下沉到这里；
  // 只有 `submitJob` 的第 5 个参数（engine）不同。★ 任何行为改动都应改这里一次，而不是三个 register。

  // ── T3：四层默认合并（L1 插件 config → L2 <workspace>/.dsh/bgjobs.json → L3 会话 → L4 本次参数）──
  // 只在入口合并一次；jobs.js 及以下完全不知道"默认层"的存在（唯一所有者 = core/defaults.js）。
  const withDefaults = (args, exec, group) => {
    const session = exec && exec.agent && exec.agent.session ? exec.agent.session : null
    const sessionId = session ? String(session.id) : ''
    const workspace = session && session.header ? session.header.cwd : void 0
    const config = deps && deps.config ? deps.config : {}
    const resolved = resolveDefaults({ group, config, workspace, sessionId, call: args })
    return { args: { ...resolved.values, ...args }, warnings: resolved.warnings }
  }

  /** 合并 warnings 到返回体（仅在有值时新增该字段，不改变既有形状）。 */
  const withWarnings = (res, warnings) => {
    if (!Array.isArray(warnings) || warnings.length === 0) return res
    if (res === null || typeof res !== 'object') return res
    const merged = Array.isArray(res.warnings) ? [...res.warnings, ...warnings] : [...warnings]
    return { ...res, warnings: merged }
  }

  /** bat 引擎（原来的 bgjob_submit 主体）。 */
  const runBatSubmit = async (args, exec) => {
    const createdBySession = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
    // bat 引擎不支持沙箱：受限会话里默认请求全权限（off），需用户批准或 full access 开关。
    const mode = await decideJobSandbox(args, exec, 'bgjob_submit', 'bat')
    const res = await submitJob(args.name, args.command, args.workdir, createdBySession, 'bat', mode, args.notify, args.notify_mode)
    // wait=秒：提交成功后原地等任务结束（同 bgjob_wait；失败不等待）。任意正数秒；0/非法值=不等待。
    const waitArg = Number(args.wait)
    const waitSec = Number.isFinite(waitArg) && waitArg > 0 ? waitArg : 0
    if (res.ok && waitSec > 0) return waitSubmittedAny(res.jobId, exec, waitSec * 1000)
    return res
  }

  /** pwsh 引擎（原来的 bgjob_submit_pwsh 主体）。 */
  const runPwshSubmit = async (args, exec) => {
    const createdBySession = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
    const mode = await decideJobSandbox(args, exec, 'bgjob_submit_pwsh', 'pwsh')
    // 可选参数经 extra 透传（第 9 个位置参数，MCP 分支已有同款用法）；都不传 ⇒ undefined ⇒ 老路径。
    const extra = {}
    if (args.sandbox_backend !== undefined && args.sandbox_backend !== null) extra.sandboxBackend = args.sandbox_backend
    if (args.output_encoding !== undefined && args.output_encoding !== null) extra.outputEncoding = args.output_encoding
    const res = await submitJob(args.name, args.command, args.workdir, createdBySession, 'pwsh', mode, args.notify, args.notify_mode,
      Object.keys(extra).length > 0 ? extra : undefined)
    // wait=秒：提交成功后原地等任务结束（同 bgjob_wait；失败不等待）。任意正数秒；0/非法值=不等待。
    const waitArg = Number(args.wait)
    const waitSec = Number.isFinite(waitArg) && waitArg > 0 ? waitArg : 0
    if (res.ok && waitSec > 0) return waitSubmittedAny(res.jobId, exec, waitSec * 1000)
    return res
  }

  /** mcp 引擎（原来的 bgjob_submit_mcp 主体）。 */
  const runMcpSubmit = async (args, exec) => {
    // ① 总开关（fail closed；工具常驻注册 + 运行时校验，关掉即时生效、无需重启 DSH）。
    if ((await store.readMcpPrefs()).enabled !== true) return { ok: false, error: MCP_DISABLED_ERROR }
    // ② 解析 server（登记名或内联）。
    let target
    try { target = await mcp.resolveServer(args) } catch (e) { return { ok: false, error: errorMsg(e) } }
    // ③ tool 名纠错：解析出工具清单后校验，避免模型反复猜名字；探测失败不阻断提交
    //    （任务自身会报出真实错误），只有"清单拿到了但没这个 tool"才拒绝。
    try {
      const listing = await mcp.tools(target)
      if (listing && listing.ok === true && Array.isArray(listing.tools) && listing.tools.length > 0) {
        const wanted = String(args.tool)
        if (!listing.tools.some((t) => t.name === wanted)) {
          const names = listing.tools.map((t) => t.name)
          const shown = names.slice(0, 30).join(', ')
          const more = names.length > 30 ? ' (+' + String(names.length - 30) + ' more)' : ''
          return { ok: false, error: 'unknown MCP tool "' + wanted + '" on server "' + (target.name || 'inline') + '"; available tools: ' + shown + more }
        }
      }
    } catch (e) { /* 探测失败忽略：任务里会重新连接并报真实原因 */ }
    // 超时：显式参数 > server 登记值 > 不限时（不写 timeoutMs，runner 视为无限）。
    const timeoutArg = Number(args.timeout_seconds)
    const timeoutMs = Number.isFinite(timeoutArg) && timeoutArg > 0
      ? timeoutArg * 1000
      : (typeof target.timeoutMs === 'number' && target.timeoutMs > 0 ? target.timeoutMs : undefined)
    const serverLabel = target.name.length > 0 ? target.name : 'inline'
    const spec = {
      ...target.config,
      server: serverLabel,
      tool: String(args.tool),
      arguments: args.arguments && typeof args.arguments === 'object' ? args.arguments : {},
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
    const createdBySession = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
    // mcp 引擎恒 off 且不受会话访问模式限制（jobSandboxDecision 对 mcp 早退）——与 DSH 现状一致。
    const mode = await decideJobSandbox(args, exec, 'bgjob_submit_mcp', 'mcp')
    const res = await submitJob(
      args.name, 'mcp: ' + serverLabel + ' → ' + String(args.tool), args.workdir, createdBySession,
      'mcp', mode, args.notify, args.notify_mode, { mcpSpec: spec, serverName: target.name },
    )
    // wait=秒：任意正数秒；0/非法值=不等待（与另外两个 submit 一致）。
    const waitArg = Number(args.wait)
    const waitSec = Number.isFinite(waitArg) && waitArg > 0 ? waitArg : 0
    if (res.ok && waitSec > 0) return waitSubmittedAny(res.jobId, exec, waitSec * 1000)
    return res.ok ? { ...res, engine: 'mcp', server: serverLabel, tool: String(args.tool) } : res
  }

  // ── 别名（旧名）运行时开关（B′）────────────────────────────────────────────────
  // anti-entropy：`aliases` 这个状态**只**住在这里（createTools 闭包），不进 defaults.js 的
  // submit/query/control 三组白名单 —— 否则就出现"两个地方都能改别名开关"的双所有者。
  //
  // 为什么需要它：`bgjob_submit` 合并后，`bgjob_submit_pwsh` / `bgjob_submit_mcp` 变成两个
  // "近名别名"，模型每次都要在三个近似名字里挑一个。给它们一个运行时总开关（默认 on ⇒ 向后
  // 兼容；off ⇒ 下一次请求的工具列表里只剩主名）。这是 compat-exception 的观察/退役手段，
  // 退役触发器 = 下一个大版本直接移除这两个别名。
  const aliasDefs = new Map()   // key: 'pwsh' | 'mcp' → { def, dispose }
  let aliasesEnabled = true

  const applyAliases = (next) => {
    if (next === aliasesEnabled) return
    for (const [, entry] of aliasDefs) {
      if (next === false) {
        if (typeof entry.dispose === 'function') {
          try { entry.dispose() } catch (e) { /* 已注销/已关闭都当成功 */ }
        }
        entry.dispose = void 0
      } else if (entry.dispose === void 0) {
        entry.dispose = ctx.tools.register(entry.def)
      }
    }
    aliasesEnabled = next
  }

  const aliasState = () => ({
    aliases: aliasesEnabled ? 'on' : 'off',
    registered: Array.from(aliasDefs.values()).filter((e) => typeof e.dispose === 'function').length,
    available: aliasDefs.size,
  })

  const disposeSubmit = ctx.tools.register({
    name: 'bgjob_submit',
    description: '把命令提交为独立于 DSH 进程的后台任务（schtasks 托管，关 DSH/终端不影响；面板实时输出、退出弹 Toast、可选 notify 通知创建会话）。command 用 bat 语法，多行逐行执行，for 循环变量写 %%i；workdir 须为 DSH 工作区内绝对路径，任务文件在 <workdir>/.dsh/bgjobs/<id>/。bat 引擎任务恒全权限、不可沙箱化：受限会话仅当面板「全权限」开启才可提交；受限后台任务请用 bgjob_submit_pwsh 的 sandbox 参数。',
    presentCall: (args) => ({
      card: 'generic',
      title: '提交后台任务',
      kind: 'execute',
      rawInput: args && typeof args.name === 'string' ? args.name : undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        engine: { type: 'string', enum: ['auto', 'pwsh', 'bat', 'mcp'], default: 'auto', description: '可选：执行引擎。auto（缺省）=自动判定：有 tool 且给了 server/server_config ⇒ mcp；命令含 bat 特有语法（%%i / goto / call : / if not exist）⇒ bat；否则 pwsh。也可用 bgjob_config 设置默认值。' },
        name: { type: 'string', description: '任务名（显示在监控面板与完成通知里）' },
        command: { type: 'string', description: '要执行的命令（pwsh 引擎按 PowerShell 语法；bat 引擎按 bat 语法。引擎非 mcp 时必填）' },
        wait: { type: 'number', default: 0, description: '可选：提交成功后原地等待的秒数。0/缺省=不等待立即返回；>0 则内部按 bgjob_wait「全缺省」等待——有会话任务时等 notify 视图任一先交付即返回（any）。可传任意正数秒（含小数），不设上限；超时返回 timedOut:true 快照可续等；等待期间用户点停止/打断会让本次调用以错误结束（任务继续后台运行、未标记已交付）。' },
        workdir: { type: 'string', description: '可选：工作目录绝对路径（DSH 工作区内）。缺省=当前会话的工作目录；任务文件在 <workdir>/.dsh/bgjobs/<id>/' },
        notify: { type: 'string', enum: BGJOB_NOTIFY_MODES, default: 'off', description: '可选：任务结束后是否通知创建它的 agent 会话。off=不通知（缺省，仅网页 Toast）；on-completion=仅成功（exit 0）；on-fail=仅异常退出；on-exit=任何退出都通知。' },
        notify_mode: { type: 'string', enum: BGJOB_NOTIFY_DELIVERIES, default: 'wakeup', description: '可选：通知送达方式（仅 notify≠off 时有意义）。wakeup=缺省；quiet=仅排入收件箱不唤醒；always=空闲恒唤醒。' },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'off'], description: '可选（pwsh 引擎）：任务沙箱模式。缺省继承当前会话模式；请求更宽需审批或面板「全权限」。bat 引擎恒全权限、不可沙箱化。' },
        sandbox_backend: { type: 'string', enum: ['acl', 'dsh'], description: '可选（pwsh 引擎）：沙箱后端。acl=内置 ACL runner（缺省）；dsh=复用会话沙箱 provider（需先开「沙箱选择」开关）。' },
        output_encoding: { type: 'string', enum: ['utf8', 'native'], description: '可选（pwsh 引擎）：任务日志解码编码。utf8=缺省；native=按进程继承的控制台码页解码（MATLAB 等本地码页程序必选）。日志文件本身始终 UTF-8。' },
        justification: { type: 'string', description: '可选（pwsh 引擎）：升权理由（sandbox 请求高于当前会话模式时展示给用户审批）。' },
        tool: { type: 'string', description: '（mcp 引擎必填）要调用的 MCP 工具名；可先用 bgjob_mcp_tools 查看清单。' },
        arguments: { type: 'object', additionalProperties: true, description: '可选（mcp 引擎）：工具参数对象，缺省 {}。' },
        server: { type: 'string', description: '（mcp 引擎）设置页登记的 MCP server 名；与 server_config 二选一。' },
        server_config: { type: 'object', additionalProperties: true, description: '（mcp 引擎）内联 server 配置；与 server 二选一。stdio: {transport:"stdio",command,args,env,cwd}；http: {transport:"streamable-http",url,headers}。' },
        timeout_seconds: { type: 'number', description: '可选（mcp 引擎）：工具调用超时秒数。缺省=不限时；server 登记了 timeoutMs 时以登记值为缺省。' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          jobId: { type: 'string' },
          taskName: { type: 'string' },
          logPath: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      // B′ T3：先合并四层默认（L1 插件 config → L2 项目文件 → L3 会话 → L4 本次参数），再判定引擎。
      const mergedDefaults = withDefaults(args, exec, 'submit')
      args = mergedDefaults.args
      const defaultsWarnings = mergedDefaults.warnings
      // ③ 退出码假成功防护：命令里没有以 exit 开头的行 ⇒ 末尾表达式可能把 $LASTEXITCODE 复位成 0
      if (String(args.command || '').length > 0 && !/\bm?^\s*exit\b/m.test(String(args.command || ''))) {
        defaultsWarnings.push('命令里没有以 exit 结尾的行：若最后一句不是 exit ，bgjobs 读到的退出码可能恒为 0（假成功）')
      }
      // workdir 可省：缺省用"当前会话的工作目录"（绝大多数用法就是它）
      if (!args.workdir) {
        const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
          ? exec.agent.session.header.cwd : void 0
        if (typeof cwd === 'string' && cwd.length > 0) args = { ...args, workdir: cwd }
      }
      // name 可省：取 command 首行前 24 字（面板与通知里够用），实在没有就给个时间戳名
      if (typeof args.name !== 'string' || args.name.trim().length === 0) {
        const first = String(args.command || '').trim().split(/\r?\n/)[0].slice(0, 24).trim()
        args = { ...args, name: first.length > 0 ? first : 'bgjob-' + Date.now().toString(36) }
      }      if (typeof args.workdir !== 'string' || args.workdir.length === 0) {
        return { ok: false, error: 'workdir 必填：给一个 DSH 工作区内的绝对路径（或让当前会话有 cwd）' }
      }
      // B′：engine 缺省 auto ⇒ 自动判定（显式 engine 优先；bgjob_config 设的 engine 由上面那层带进来）。
      let engine = args.engine
      let autoDetected = false
      if (engine === undefined || engine === null || engine === 'auto') {
        autoDetected = true
        if (typeof args.tool === 'string' && (args.server !== undefined || args.server_config !== undefined)) {
          engine = 'mcp'
        } else {
          const cmd = typeof args.command === 'string' ? args.command : ''
          // bat 特有语法：批处理 for 变量（%%i）、goto、call 标签、if not exist
          engine = /%%[a-zA-Z]|\bgoto\b|\bcall\s*:|\bif\s+not\s+exist\b/i.test(cmd) ? 'bat' : 'pwsh'
        }
      }
      if (engine === 'mcp') return withWarnings(await runMcpSubmit(args, exec), defaultsWarnings)
      if (typeof args.command !== 'string' || args.command.length === 0) {
        return withWarnings({ ok: false, error: 'engine=' + engine + ' 时 command 必填（mcp 引擎请改用 tool + server/server_config）' }, defaultsWarnings)
      }
      if (engine === 'bat') {
        const res = await runBatSubmit(args, exec)
        if (autoDetected && res && res.ok === true) {
          return withWarnings({ ...res, warnings: ['检测到 bat 特有语法，已按 bat 引擎执行（如需强制 pwsh 请显式传 engine:"pwsh"）'] }, defaultsWarnings)
        }
        return withWarnings(res, defaultsWarnings)
      }
      return withWarnings(await runPwshSubmit(args, exec), defaultsWarnings)
    },
  })

  const disposeStatus = ctx.tools.register({
    name: 'bgjob_status',
    description: '查询后台任务状态：running/done、exitCode、日志尾部与路径。DSH 重启后旧 id 仍可查（磁盘恢复，任务不丢）。仅用于查看当前状态，不要用它循环轮询等待（等待请用 bgjob_wait）。',
    presentCall: (args) => ({
      card: 'generic',
      title: '查询后台任务',
      rawInput: args && typeof args.jobId === 'string' ? args.jobId : undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string', description: '任务 id（bgjob_submit 返回的 jobId）' },
      },
      required: ['jobId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
          exitCode: {},
          logPath: { type: 'string' },
          tail: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const jobId = String(args.jobId)
      const job = registry.get(jobId)
      if (job) {
        return {
          id: job.id, name: job.meta.name, status: job.status,
          exitCode: job.exitCode === undefined ? null : job.exitCode,
          logPath: job.meta.logPath, tail: job.tail.slice(-4000),
          // 「被终止（kill）」标记：被终止时 `exitCode` 通常是 1（taskkill /F
          // 记录的真值），但退出码**只是现象**——它由终止方传入、且"任务自己以 1 退出"与"被我们
          // 终止"同值 ⇒ **来源**只能靠这三个字段（killedAt/killedBy/exitCodeSource）判定。
          // 无此字段时省略。
          ...(job.meta.exitCodeSource === 'killed'
            ? { killed: true, killedAt: job.meta.killedAt === undefined ? null : Number(job.meta.killedAt), killedBy: job.meta.killedBy || 'kill', exitCodeSource: 'killed' }
            : {}),
          // 「包装器已消失、无退出码」标记（v0.2.3）：`exitCode` 为 null 时，光看它分不清
          // "还没结束"与"结束了但没留下退出码" ⇒ 与磁盘回退路径同口径地带上来源字段。
          ...wrapperGoneOf(job.meta),
        }
      }
      // 内存注册表未命中（典型：DSH 会话重启后旧 id 不再被追踪）：回退磁盘查询。
      // 任务由 schtasks 托管，与 DSH 进程无关，可能仍在运行——绝不终止，只读。
      const fromDisk = await statusFromDisk(jobId)
      if (fromDisk) return fromDisk
      return { error: 'job not found: ' + args.jobId }
    },
  })

  const disposeWait = ctx.tools.register({
    name: 'bgjob_wait',
    description: '等待后台任务结束并立即返回。默认等本会话任一未交付任务先结束（any）；传 jobIds 时按 logic 等任一或全部：logic=all 为合取——全部成功才 allDone，任一失败即刻返回 failed 并带 failedJobId。等待会被新入站消息让路（stopped:true、stoppedBy=message，任务继续在后台跑）；★ 不要用前台 sleep 顶替等待。',
    presentCall: (args) => ({
      card: 'generic',
      title: args && args.logic === 'all' ? '等待全部后台任务' : '等待后台任务',
      kind: 'execute',
      rawInput: (args && (typeof args.jobId === 'string' ? args.jobId : (Array.isArray(args.jobIds) && args.jobIds[0]))) || undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string', description: '单个任务 id（bgjob_submit 返回的 jobId）；与 jobIds 二选一' },
        jobIds: { type: 'array', items: { type: 'string' }, description: '任务 id 数组：logic 为 any 时任一先结束即返回（any 竞速）；logic 为 all 时等全部成功；与 jobId 二选一，都缺省=等本会话「notify 视图」' },
        timeoutSeconds: { type: 'number', description: '可选：最多等待秒数。**缺省（不传）＝用设置页「默认等待超时」**（该设置未配置时＝不限时——一直等到任务结束，或被新入站消息让路 / 被用户停止）；显式传 0 或负数＝本次强制不限时；传正数（含小数）＝本次上限，到点返回 timedOut:true 快照可再调用续等' },
        logic: { type: 'string', enum: ['any', 'all'], default: 'any', description: 'any（缺省）= 任一先结束即返回（竞速）；all = 等这批任务「全部成功」才返回 allDone（合取语义：任一失败即刻返回 failed）' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          jobId: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
          exitCode: {},
          logPath: { type: 'string' },
          tail: { type: 'string' },
          timedOut: { type: 'boolean' },
          stopped: { type: 'boolean' },
          stoppedBy: { type: 'string' },
          waitedMs: { type: 'number' },
          anyDone: { type: 'boolean' },
          allDone: { type: 'boolean' },
          failed: { type: 'boolean' },
          failedJobId: { type: 'string' },
          result: { type: 'object' },
          pending: { type: 'array', items: { type: 'string' } },
          results: { type: 'array' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const rawTimeout = args.timeoutSeconds
      const timeoutArg = Number(rawTimeout)
      let timeoutMs
      if (Number.isFinite(timeoutArg) && timeoutArg > 0) {
        timeoutMs = timeoutArg * 1000 // 显式正数：本次上限
      } else if (Number.isFinite(timeoutArg) && rawTimeout !== undefined && rawTimeout !== null && rawTimeout !== '') {
        timeoutMs = Infinity // 显式 0/负数：强制不限时（覆盖设置页默认）
      } else {
        // 未传/非数 → 用设置页「默认等待超时」；未配置（null）→ 不限时。
        // 循环用墙钟判定，不会产生长定时器。
        const prefs = await store.readUiPrefs()
        const dft = prefs && Number.isFinite(prefs.waitTimeoutSeconds) && prefs.waitTimeoutSeconds > 0 ? prefs.waitTimeoutSeconds : 0
        timeoutMs = dft > 0 ? dft * 1000 : Infinity
      }
      const signal = exec && exec.signal ? exec.signal : undefined
      const watchMsg = buildInboxWatch(exec)
      const conclude = concludeTurnOf(exec)
      // logic:'all'（合取）：全部成功才 allDone，任一失败即短路返回；id 解析与①③同规则。
      if (args.logic === 'all') {
        let ids = []
        if (typeof args.jobId === 'string' && args.jobId) ids = [args.jobId]
        else if (Array.isArray(args.jobIds) && args.jobIds.length > 0) ids = args.jobIds
        else {
          const sessionId = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
          if (sessionId) {
            ids = sessionPendingIds(sessionId)
            if (ids.length === 0) return { ok: true, allDone: true, timedOut: false, waitedMs: 0, results: [] }
          }
        }
        if (ids.length === 0) return { ok: false, error: 'no jobId/jobIds given and no tasks from the current session' }
        return waitAllOf(ids, timeoutMs, signal, watchMsg, conclude)
      }
      // ① 单 jobId（兼容旧调用：返回原单对象形状）。
      if (typeof args.jobId === 'string' && args.jobId) return waitJobDone(args.jobId, timeoutMs, signal, watchMsg, conclude)
      // ② jobIds 数组 → any 竞速。
      if (Array.isArray(args.jobIds) && args.jobIds.length > 0) return waitAnyOf(args.jobIds, timeoutMs, signal, watchMsg, conclude)
      // ③ 全缺省 → notify 视图（本会话未交付任务）any；视图为空 → 立即空返回。
      const sessionId = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
      if (sessionId) {
        const ids = sessionPendingIds(sessionId)
        if (ids.length > 0) return waitAnyOf(ids, timeoutMs, signal, watchMsg, conclude)
        return { ok: true, anyDone: false, empty: true, timedOut: false, waitedMs: 0, pending: [] }
      }
      return { ok: false, error: 'no jobId/jobIds given and no tasks from the current session' }
    },
  })

  const disposeList = ctx.tools.register({
    name: 'bgjob_list',
    description: '列出当前 agent 会话提交的全部后台任务（running 与 done 均含），返回 jobId/name/status/exitCode/finishedAt/workdir/logPath/notified（结果是否已交付到本会话上下文：notify 完成通知投递成功或 wait 已返回）。',
    presentCall: () => ({ card: 'generic', title: '列出本会话后台任务', kind: 'execute' }),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          jobs: { type: 'array' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const sessionId = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
      if (!sessionId) return { ok: false, error: 'unknown session' }
      const jobs = Array.from(registry.values())
        .filter((j) => j.meta && j.meta.createdBySession === sessionId)
        .map((j) => ({
          jobId: j.id, name: String(j.meta.name || j.id), status: j.status,
          exitCode: j.exitCode === undefined || j.exitCode === null ? null : j.exitCode,
          finishedAt: j.finishedAt === undefined || j.finishedAt === null ? null : j.finishedAt,
          workdir: j.meta.workdir, logPath: j.meta.logPath,
          ...deliveredOf(j),
        }))
      return { ok: true, sessionId, jobs }
    },
  })

  const disposePending = ctx.tools.register({
    name: 'bgjob_pending_list',
    description: '列出当前 agent 会话中「结果尚未交付到上下文」的后台任务（notify 视图：notify 完成通知尚未投递成功、也未被 wait 返回过的任务，含 running 与已结束未交付）。与 bgjob_wait 缺省（含 logic: all）使用同一视图；拿到列表后可用它等结果。',
    presentCall: () => ({ card: 'generic', title: '列出本会话待交付任务', kind: 'execute' }),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          jobs: { type: 'array' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const sessionId = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
      if (!sessionId) return { ok: false, error: 'unknown session' }
      const jobs = []
      for (const id of sessionPendingIds(sessionId)) {
        const j = registry.get(id)
        if (!j) continue
        jobs.push({
          jobId: j.id, name: String(j.meta.name || j.id), status: j.status,
          exitCode: j.exitCode === undefined || j.exitCode === null ? null : j.exitCode,
          finishedAt: j.finishedAt === undefined || j.finishedAt === null ? null : j.finishedAt,
          workdir: j.meta.workdir, logPath: j.meta.logPath,
          notified: false,
        })
      }
      return { ok: true, sessionId, jobs }
    },
  })

  const pwshSubmitDef = {
    name: 'bgjob_submit_pwsh',
    description: '等价于 bgjob_submit 且 engine 固定为 pwsh（入参/返回契约见该工具）。',
    presentCall: (args) => ({
      card: 'generic',
      title: '提交 PowerShell 后台任务',
      kind: 'execute',
      rawInput: args && typeof args.name === 'string' ? args.name : undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '任务名（显示在监控面板与完成通知里）' },
        command: { type: 'string', description: '要执行的 PowerShell 命令（可多行；PowerShell 语法，如 foreach/管道；exit <code> 安全）' },
        wait: { type: 'number', default: 0, description: '可选：提交成功后原地等待的秒数。0/缺省=不等待立即返回；>0 则内部按 bgjob_wait「全缺省」等待——有会话任务时等 notify 视图（本会话未交付任务）任一先交付即返回（any），会话不可识别/视图为空时回退为等刚提交的这一个（原语义）。可传任意正数秒（含小数，如 0.5），不设上限；超时返回 timedOut:true 快照可续等；等待期间用户点停止/打断会让本次调用**以错误结束**（任务继续后台运行、不标记已交付，可改用 bgjob_wait 续等）。' },
        workdir: { type: 'string', description: '可选：工作目录绝对路径（DSH 工作区内）。缺省=当前会话的工作目录' },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'off'], description: '可选：任务沙箱模式（read-only 禁止写、workspace-write 只允许写工作目录+临时区）。缺省继承当前受限会话模式，会话全权限则为 off=全权限；任务权限不得高于会话模式——请求更宽（如受限会话里要 off）且 bgjobs 面板 full access 开关关闭时，会弹窗请用户批准（可提供 justification 说明理由）。未挂载 dsh 沙箱策略服务（sandbox-policy）的部署默认拒绝提交，需在面板打开 full access 开关。' },
        sandbox_backend: { type: 'string', enum: ['acl', 'dsh'], description: '可选：沙箱后端（需先在设置页开启「沙箱选择」开关）。acl=内置 ACL runner（缺省）；dsh=复用当前会话的 dsh 沙箱 provider（ctx.sandbox.confine）' },
        output_encoding: { type: 'string', enum: ['utf8', 'native'], description: '可选：任务日志的**解码编码**。缺省 utf8 = 按 UTF-8 解码；native = 按**进程继承的控制台码页**解码。日志文件本身始终是 UTF-8。' },
        justification: { type: 'string', description: '可选：升权理由（当 sandbox 请求权限高于当前会话模式时展示给用户审批）' },
        notify: { type: 'string', enum: BGJOB_NOTIFY_MODES, default: 'off', description: '可选：任务结束后是否通知创建它的 agent 会话。off=不通知（缺省，仅网页 Toast）；on-completion=仅成功（exit 0）时通知；on-fail=仅异常退出（exit≠0）时通知；on-exit=任何退出都通知。' },
        notify_mode: { type: 'string', enum: BGJOB_NOTIFY_DELIVERIES, default: 'wakeup', description: '可选：通知送达方式（仅 notify≠off 时有意义）。wakeup=缺省，会话空闲则唤醒一轮（忙碌时排入下一步收件箱，连续唤醒有预算防自激链）；quiet=仅排入收件箱不唤醒（等用户下一条消息才被模型看到）；always=空闲恒唤醒（无预算）。' },
      },
      required: ['command'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          jobId: { type: 'string' },
          taskName: { type: 'string' },
          logPath: { type: 'string' },
          interpreter: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      // B′：与 bgjob_submit 共用同一份实现（engine 固定 pwsh）。
      return runPwshSubmit(args, exec)
    },
  }
  const disposePwshSubmit = ctx.tools.register(pwshSubmitDef)
  aliasDefs.set('pwsh', { def: pwshSubmitDef, dispose: disposePwshSubmit })

  const mcpSubmitDef = {
    name: 'bgjob_submit_mcp',
    description: '等价于 bgjob_submit 且 engine 固定为 mcp（入参/返回契约见该工具）。',
    presentCall: (args) => ({
      card: 'generic',
      title: '提交 MCP 工具调用',
      kind: 'execute',
      rawInput: args && typeof args.name === 'string' ? args.name : undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '任务名（显示在监控面板与完成通知里）' },
        workdir: { type: 'string', description: '可选：工作目录绝对路径（DSH 工作区内）。缺省=当前会话的工作目录；任务文件在 <workdir>/.dsh/bgjobs/<id>/' },
        tool: { type: 'string', description: '要调用的 MCP 工具名（先用 bgjob_mcp_tools 查看该 server 的工具清单）' },
        arguments: { type: 'object', additionalProperties: true, description: '可选：工具参数对象（缺省 {}）' },
        server: { type: 'string', description: '设置页登记的 MCP server 名；与 server_config 二选一' },
        server_config: { type: 'object', additionalProperties: true, description: '内联 MCP server 配置（自包含）；与 server 二选一。stdio: {transport:"stdio",command,args,env,cwd}；http: {transport:"streamable-http",url,headers}' },
        timeout_seconds: { type: 'number', description: '可选：工具调用超时秒数。**缺省（不传）＝不限时**——一直等到工具返回；该 server 在设置页登记了 timeoutMs 时，以登记值为缺省（显式传值仍覆盖）。传任意正数秒（含小数）；超时任务退出码 3' },
        wait: { type: 'number', default: 0, description: '可选：提交成功后原地等待的秒数。0/缺省=不等待立即返回；>0 则内部按 bgjob_wait「全缺省」等待（有会话任务时等 notify 视图任一先交付即返回）。可传任意正数秒，不设上限；超时返回 timedOut:true 快照可续等；等待期间用户点停止/打断会让本次调用**以错误结束**（任务继续后台运行、不标记已交付，可改用 bgjob_wait 续等）。' },
        notify: { type: 'string', enum: BGJOB_NOTIFY_MODES, default: 'off', description: '可选：任务结束后是否通知创建它的 agent 会话。off=不通知（缺省，仅网页 Toast）；on-completion=仅成功（exit 0）时通知；on-fail=仅异常退出（exit≠0）时通知；on-exit=任何退出都通知。' },
        notify_mode: { type: 'string', enum: BGJOB_NOTIFY_DELIVERIES, default: 'wakeup', description: '可选：通知送达方式（仅 notify≠off 时有意义）。wakeup=缺省；quiet=仅排入收件箱不唤醒；always=空闲恒唤醒。' },
      },
      required: ['name', 'workdir', 'tool'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          jobId: { type: 'string' },
          taskName: { type: 'string' },
          logPath: { type: 'string' },
          engine: { type: 'string' },
          server: { type: 'string' },
          tool: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      // B′：与 bgjob_submit 共用同一份实现（engine 固定 mcp）。
      return runMcpSubmit(args, exec)
    },
  }
  const disposeMcpSubmit = ctx.tools.register(mcpSubmitDef)
  aliasDefs.set('mcp', { def: mcpSubmitDef, dispose: disposeMcpSubmit })

  const disposeMcpTools = ctx.tools.register({
    name: 'bgjob_mcp_tools',
    description: '列出某 MCP server 的注册工具（名 + 描述 + 必填字段）。server 与 server_config 二选一；refresh:true 绕过 10 分钟缓存。返回 source: registry|cache|probe。',
    presentCall: (args) => ({
      card: 'generic',
      title: '列出 MCP 工具',
      kind: 'execute',
      rawInput: (args && (typeof args.server === 'string' ? args.server : undefined)) || undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        server: { type: 'string', description: '设置页登记的 MCP server 名；与 server_config 二选一' },
        server_config: { type: 'object', additionalProperties: true, description: '内联 MCP server 配置（自包含）；与 server 二选一' },
        refresh: { type: 'boolean', default: false, description: '可选：true 绕过 10 分钟工具列表缓存强制重取' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          server: { type: 'string' },
          transport: { type: 'string' },
          source: { type: 'string' },
          channel: { type: 'string' },
          tools: { type: 'array' },
          fetchedAt: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      if ((await store.readMcpPrefs()).enabled !== true) return { ok: false, error: MCP_DISABLED_ERROR }
      let target
      try { target = await mcp.resolveServer(args) } catch (e) { return { ok: false, error: errorMsg(e) } }
      return await mcp.tools(target, { refresh: args.refresh === true })
    },
  })

  const disposeConfig = ctx.tools.register({
    name: 'bgjob_config',
    description: '读/写工具的「默认参数」。四层：插件 config → <workspace>/.dsh/bgjobs.json → 本会话 set → 每次调用参数（后者覆盖前者；null=删除该键）。action=get 返回会话层、项目文件路径、别名开关与已注册数；set 写会话层（可同时 set.aliases:"on"|"off" 隐藏/恢复 bgjob_submit_pwsh 与 bgjob_submit_mcp 两个近名别名，下一次请求生效）；reset 清空会话层。项目文件写坏只告警、不影响提交。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'reset', 'help'], description: 'get=读；set=写会话层；reset=清空会话层' },
        set: { type: 'object', additionalProperties: true, description: 'set 时使用。形如 {"submit":{"sandbox":"workspace-write"},"query":{"timeoutSeconds":60},"control":{"reason":"x"}}；一次性参数（command/tool/server/name/workdir）会被拒绝并告警。可含 aliases:"on"|"off"' },
        topic: { type: 'string', description: '仅 action=help 时使用：主题名（submit / query / control / mcp / defaults / aliases / encoding / sandbox / limits）。缺省或未知 ⇒ 返回索引。' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          aliases: { type: 'string' },
          registered: { type: 'number' },
          available: { type: 'number' },
          session: { type: 'object', additionalProperties: true },
          projectPath: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const sessionId = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
      const workspace = exec && exec.agent && exec.agent.session && exec.agent.session.header
        ? exec.agent.session.header.cwd
        : void 0
      if (args.action === 'get') {
        const project = readProjectDefaults(workspace)
        return { ok: true, ...aliasState(), session: getSessionGroups(sessionId), projectPath: project.path || '', projectExists: project.exists === true, warnings: project.warnings }
      }
      if (args.action === 'reset') {
        resetSessionGroups(sessionId)
        return { ok: true, ...aliasState(), reset: true }
      }
      if (args.action === 'help') {
        const topic = typeof args.topic === 'string' ? args.topic.trim() : ''
        if (topic.length === 0) return { ok: true, topic: 'index', help: HELP_TOPICS.index, topics: HELP_TOPIC_NAMES }
        if (Object.prototype.hasOwnProperty.call(HELP_TOPICS, topic)) return { ok: true, topic, help: HELP_TOPICS[topic], topics: HELP_TOPIC_NAMES }
        return { ok: true, topic: 'index', help: HELP_TOPICS.index, topics: HELP_TOPIC_NAMES, warnings: ['未知主题 "' + topic + '"，已返回索引（可用：' + HELP_TOPIC_NAMES.join(', ') + '）'] }
      }
      const set = args.set && typeof args.set === 'object' ? args.set : {}
      const warnings = []
      if (set.aliases === 'on' || set.aliases === 'off') {
        try { applyAliases(set.aliases === 'on') } catch (e) { warnings.push('aliases 切换失败：' + errorMsg(e)) }
      } else if (set.aliases !== void 0) {
        warnings.push('set.aliases 只接受 "on" 或 "off"（已忽略）')
      }
      const applied = setSessionGroups(sessionId, set)
      if (applied.warnings.length > 0) warnings.push(...applied.warnings)
      return { ok: true, ...aliasState(), session: applied.groups, warnings }
    },
  })

  const disposeKill = ctx.tools.register({
    name: 'bgjob_kill',
    description: '终止后台任务的**进程树**（只杀进程、不删记录）。无活进程时什么都不做（返回 mode:absent）。被终止的任务补写非 0 退出码 + exitCodeSource:killed ⇒ bgjob_wait 读到失败口径。force 只用于越过「无法判定进程状态」这一道门。',
    presentCall: (args) => ({
      card: 'generic',
      title: '终止后台任务',
      kind: 'execute',
      rawInput: args && typeof args.jobId === 'string' ? args.jobId : undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string', description: '任务 id（bgjob_submit 返回的 jobId）' },
        force: { type: 'boolean', default: false, description: '可选：**仅用于越过 mode:"unknown"**（无法判定该任务是否仍有活进程时的门槛）——默认 false ⇒ 不动作、只回 needsForce:true 与警告；不是"更用力地杀"，对"有活进程"/"无活进程"两种情形完全无影响。' },
        reason: { type: 'string', description: '可选：终止原因（记进 job.json 的 killedBy，供事后审计区分是谁/为什么终止的；缺省仍是 "kill"）' },
      },
      required: ['jobId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          jobId: { type: 'string' },
          mode: { type: 'string', description: 'kill（终止了活进程，记录保留）/ absent（未发现活进程 ⇒ 什么都没做）/ unknown（无法判定）' },
          killed: { type: 'boolean' },
          exitCode: {},
          exitCodeSource: { type: 'string' },
          recordsKept: { type: 'boolean' },
          note: { type: 'string' },
          needsForce: { type: 'boolean' },
          forced: { type: 'boolean' },
          error: { type: 'string' },
          warnings: { type: 'array' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      return await killJob(String(args.jobId), { force: args.force === true, reason: args.reason })
    },
  })

  const disposeDelete = ctx.tools.register({
    name: 'bgjob_delete',
    description: '删除后台任务的**记录**（job 目录 + 计划任务注册 + 中央索引；只删记录、**不杀进程**）。**若该任务仍有活进程 ⇒ 拒绝**并提示先 kill（mode:"kill" + error）——delete 绝不越界杀进程。**无法判定进程状态时**（探针跑不起来）返回 mode:"unknown" 且不删记录，需显式 force:true 才继续；force 只越过这道门。',
    presentCall: (args) => ({
      card: 'generic',
      title: '删除任务记录',
      kind: 'execute',
      rawInput: args && typeof args.jobId === 'string' ? args.jobId : undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        jobId: { type: 'string', description: '任务 id（bgjob_submit 返回的 jobId）' },
        force: { type: 'boolean', default: false, description: '可选：**仅用于越过 mode:"unknown"**（无法判定该任务是否仍有活进程时的门槛）——默认 false ⇒ 不删任何记录、只回 needsForce:true 与警告；不是"强删"，对"有活进程"/"无活进程"两种情形完全无影响。' },
      },
      required: ['jobId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string', description: 'delete（只删了记录）/ kill（有活进程 ⇒ 拒绝，提示先 kill）/ unknown（无法判定）' },
          removed: { type: 'string' },
          jobDirRemoved: { type: 'boolean' },
          registryRemoved: { type: 'boolean' },
          indexRemoved: { type: 'boolean' },
          needsForce: { type: 'boolean' },
          forced: { type: 'boolean' },
          error: { type: 'string' },
          warnings: { type: 'array' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      return await removeJob(String(args.jobId), { force: args.force === true })
    },
  })

  return {
    api: {},
    dispose: [disposeSubmit, disposeStatus, disposeWait, disposeList, disposePending, disposePwshSubmit, disposeMcpSubmit, disposeMcpTools, disposeKill, disposeDelete],
  }
}
