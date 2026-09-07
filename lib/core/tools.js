// bgjobs core —— 工具注册域（v0.1.61 结构重构；自 lib/index.js apply 拆分）。
// 7 个 ctx.tools.register：bgjob_submit / bgjob_status / bgjob_wait / bgjob_wait_all /
// bgjob_list / bgjob_pending_list / bgjob_submit_pwsh。execute 经 deps 调用各域 api。

import { BGJOB_NOTIFY_MODES, BGJOB_NOTIFY_DELIVERIES } from '../notify-policy.js'

export function createTools(ctx, store, deps) {
  const registry = store.registry
  const { decideJobSandbox, submitJob } = deps.jobs
  const { waitJobDone, waitAnyOf, waitAllOf, waitSubmittedAny, sessionPendingIds } = deps.wait
  const { statusFromDisk, deliveredOf } = deps.registry

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
        name: { type: 'string', description: '任务名（显示在监控面板与完成通知里）' },
        command: { type: 'string', description: '要执行的命令（可多行；bat 语法，如 for 循环变量用 %%i；for/if 块结构原样保留）' },
        wait: { type: 'number', default: 0, description: '可选：提交成功后原地等待的秒数。0/缺省=不等待立即返回；>0 则内部按 bgjob_wait「全缺省」等待——有会话任务时等 notify 视图（本会话未交付任务）任一先交付即返回（any），会话不可识别/视图为空时回退为等刚提交的这一个（原语义）。范围 1–600，超出 clamp；超时返回 timedOut:true 快照可续等。' },
        workdir: { type: 'string', description: '工作目录绝对路径（DSH 工作区内）' },
        notify: { type: 'string', enum: BGJOB_NOTIFY_MODES, default: 'off', description: '可选：任务结束后是否通知创建它的 agent 会话。off=不通知（缺省，仅网页 Toast）；on-completion=仅成功（exit 0）时通知；on-fail=仅异常退出（exit≠0）时通知；on-exit=任何退出都通知。' },
        notify_mode: { type: 'string', enum: BGJOB_NOTIFY_DELIVERIES, default: 'wakeup', description: '可选：通知送达方式（仅 notify≠off 时有意义）。wakeup=缺省，会话空闲则唤醒一轮（忙碌时排入下一步收件箱，连续唤醒有预算防自激链）；quiet=仅排入收件箱不唤醒（等用户下一条消息才被模型看到）；always=空闲恒唤醒（无预算）。' },
      },
      required: ['name', 'command', 'workdir'],
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
      const createdBySession = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
      // bat 引擎不支持沙箱：受限会话里默认请求全权限（off），需用户批准或 full access 开关。
      const mode = await decideJobSandbox(args, exec, 'bgjob_submit', 'bat')
      const res = await submitJob(args.name, args.command, args.workdir, createdBySession, 'bat', mode, args.notify, args.notify_mode)
      // wait=秒：提交成功后原地等任务结束（同 bgjob_wait；失败不等待）。
      const waitSec = Math.min(Math.max(Number(args.wait) || 0, 0), 600)
      if (res.ok && waitSec > 0) return waitSubmittedAny(res.jobId, exec, waitSec * 1000)
      return res
    },
  })

  const disposeStatus = ctx.tools.register({
    name: 'bgjob_status',
    description: '查询后台任务状态：running/done、exitCode、日志尾部与路径。DSH 重启后旧 id 仍可查（磁盘恢复，任务不丢）。',
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
    description: '等待后台任务结束并立即返回结果（轮询，默认最多 120 秒，可传 timeoutSeconds 覆盖，范围 1–600）。三种用法：① 传单个 jobId——等该任务结束返回其退出码/日志尾（单任务）；② 传 jobIds 数组——任一先结束立即返回（any 竞速，结果含已完成者与仍在等列表）；③ jobId/jobIds 都缺省——等当前 agent 会话提交的任务任一结束（本会话=bgjob_list 同源过滤）。单任务与多任务语义一致：done/removed/not found 均视为结束；超时返回 timedOut:true 快照，可再次调用。',
    presentCall: (args) => ({
      card: 'generic',
      title: '等待后台任务',
      kind: 'execute',
      rawInput: (args && (typeof args.jobId === 'string' ? args.jobId : (Array.isArray(args.jobIds) && args.jobIds[0]))) || undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string', description: '单个任务 id（bgjob_submit 返回的 jobId）；与 jobIds 二选一' },
        jobIds: { type: 'array', items: { type: 'string' }, description: '任务 id 数组：任一先结束即返回（any 竞速）；与 jobId 二选一，都缺省=等本会话任务任一结束' },
        timeoutSeconds: { type: 'number', default: 120, description: '最多等待秒数（默认 120，范围 1–600）' },
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
          waitedMs: { type: 'number' },
          anyDone: { type: 'boolean' },
          allDone: { type: 'boolean' },
          result: { type: 'object' },
          pending: { type: 'array', items: { type: 'string' } },
          results: { type: 'array' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const timeoutMs = Math.min(Math.max(Number(args.timeoutSeconds) || 120, 1), 600) * 1000
      // ① 单 jobId（兼容旧调用：返回原单对象形状）。
      if (typeof args.jobId === 'string' && args.jobId) return waitJobDone(args.jobId, timeoutMs)
      // ② jobIds 数组 → any 竞速。
      if (Array.isArray(args.jobIds) && args.jobIds.length > 0) return waitAnyOf(args.jobIds, timeoutMs)
      // ③ 全缺省 → notify 视图（本会话未交付任务）any；视图为空 → 立即空返回。
      const sessionId = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
      if (sessionId) {
        const ids = sessionPendingIds(sessionId)
        if (ids.length > 0) return waitAnyOf(ids, timeoutMs)
        return { ok: true, anyDone: false, empty: true, timedOut: false, waitedMs: 0, pending: [] }
      }
      return { ok: false, error: 'no jobId/jobIds given and no tasks from the current session' }
    },
  })

  const disposeWaitAll = ctx.tools.register({
    name: 'bgjob_wait_all',
    description: '等待一批后台任务全部结束并返回每个任务的结果（默认最多 120 秒，可传 timeoutSeconds，范围 1–600）。jobIds 传任务 id 数组；缺省 = 等「notify 视图」（本会话尚未交付的任务）全部结束。返回 results（每任务含退出码/日志尾/notified）+ allDone；done 结果返回即置已交付（notified=true，notify 视图剔除）。removed/not found 也视为已结束计入 results；超时返回各任务当前状态 + allDone:false（未交付），可再次调用续等。',
    presentCall: (args) => ({
      card: 'generic',
      title: '等待全部后台任务',
      kind: 'execute',
      rawInput: (args && (Array.isArray(args.jobIds) && args.jobIds[0])) || undefined,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string', description: '单个任务 id（便捷别名，等价 jobIds=[该 id]）' },
        jobIds: { type: 'array', items: { type: 'string' }, description: '任务 id 数组；缺省=等本会话提交的全部任务' },
        timeoutSeconds: { type: 'number', default: 120, description: '最多等待秒数（默认 120，范围 1–600）' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          allDone: { type: 'boolean' },
          timedOut: { type: 'boolean' },
          waitedMs: { type: 'number' },
          results: { type: 'array' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const timeoutMs = Math.min(Math.max(Number(args.timeoutSeconds) || 120, 1), 600) * 1000
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
      return waitAllOf(ids, timeoutMs)
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
    description: '列出当前 agent 会话中「结果尚未交付到上下文」的后台任务（notify 视图：notify 完成通知尚未投递成功、也未被 wait 返回过的任务，含 running 与已结束未交付）。与 bgjob_wait / bgjob_wait_all 缺省使用同一视图；拿到列表后可用它们等结果。',
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

  const disposePwshSubmit = ctx.tools.register({
    name: 'bgjob_submit_pwsh',
    description: '把 PowerShell 命令提交为独立后台任务（与 bgjob_submit 同机制，但 command 为 PowerShell 语法，日志 UTF-8 无乱码，exit <code> 语义安全；pwsh 7 优先、5.1 兜底）。workdir 须为 DSH 工作区内绝对路径。可选 sandbox 约束文件效果（read-only/workspace-write），权限不高于当前会话模式，请求更宽需审批或面板「全权限」。',
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
        wait: { type: 'number', default: 0, description: '可选：提交成功后原地等待的秒数。0/缺省=不等待立即返回；>0 则内部按 bgjob_wait「全缺省」等待——有会话任务时等 notify 视图（本会话未交付任务）任一先交付即返回（any），会话不可识别/视图为空时回退为等刚提交的这一个（原语义）。范围 1–600，超出 clamp；超时返回 timedOut:true 快照可续等。' },
        workdir: { type: 'string', description: '工作目录绝对路径（DSH 工作区内）' },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'off'], description: '可选：任务沙箱模式（复用 dsh 沙箱，仅约束文件效果：read-only 禁止写、workspace-write 只允许写工作目录+临时区；网络不受限）。缺省继承当前受限会话模式，会话全权限则为 off=全权限；任务权限不得高于会话模式——请求更宽（如受限会话里要 off）且 bgjobs 面板 full access 开关关闭时，会弹窗请用户批准（可提供 justification 说明理由）。未挂载 dsh 沙箱策略服务（sandbox-policy）的部署默认拒绝提交，需在面板打开 full access 开关。' },
        justification: { type: 'string', description: '可选：升权理由（当 sandbox 请求权限高于当前会话模式时展示给用户审批）' },
        notify: { type: 'string', enum: BGJOB_NOTIFY_MODES, default: 'off', description: '可选：任务结束后是否通知创建它的 agent 会话。off=不通知（缺省，仅网页 Toast）；on-completion=仅成功（exit 0）时通知；on-fail=仅异常退出（exit≠0）时通知；on-exit=任何退出都通知。' },
        notify_mode: { type: 'string', enum: BGJOB_NOTIFY_DELIVERIES, default: 'wakeup', description: '可选：通知送达方式（仅 notify≠off 时有意义）。wakeup=缺省，会话空闲则唤醒一轮（忙碌时排入下一步收件箱，连续唤醒有预算防自激链）；quiet=仅排入收件箱不唤醒（等用户下一条消息才被模型看到）；always=空闲恒唤醒（无预算）。' },
      },
      required: ['name', 'command', 'workdir'],
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
      const createdBySession = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
      const mode = await decideJobSandbox(args, exec, 'bgjob_submit_pwsh', 'pwsh')
      const res = await submitJob(args.name, args.command, args.workdir, createdBySession, 'pwsh', mode, args.notify, args.notify_mode)
      // wait=秒：提交成功后原地等任务结束（同 bgjob_wait；失败不等待）。
      const waitSec = Math.min(Math.max(Number(args.wait) || 0, 0), 600)
      if (res.ok && waitSec > 0) return waitSubmittedAny(res.jobId, exec, waitSec * 1000)
      return res
    },
  })

  return {
    api: {},
    dispose: [disposeSubmit, disposeStatus, disposeWait, disposeWaitAll, disposeList, disposePending, disposePwshSubmit],
  }
}
