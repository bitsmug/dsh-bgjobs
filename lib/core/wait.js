// bgjobs core —— 等待域（v0.1.61 结构重构；自 lib/index.js apply 拆分）。
// bgjob_wait / bgjob_wait_all / 提交 wait 参数 / notify 视图（缺省等待集合）。
// 跨域：经 deps.watch.checkCompletion 完成检测、deps.registry 交付标记与磁盘回退。

// bgjob_wait 轮询（v0.1.51）：轮询间隔与「任务自身已运行时长」成正比（而非本工具等待时长）：
// 短任务毫秒级响应，任务越久间隔越大；下限 250ms、上限 1s——间隔永远封顶 1s，
// 不会超过任务完成窗口。interval = clamp(250ms, taskAge * WAIT_POLL_RATIO, 1000ms)。
const WAIT_POLL_MS = 250
const WAIT_POLL_MAX_MS = 1000
const WAIT_POLL_RATIO = 0.1   // 任务已运行时长的 10%；约 age=10s 时达 1s 上限

// 用户停止/打断（v0.1.71 起）：DSH 停止按钮触发 agent.cancel → 当前 turn 的 AbortSignal abort。
// v0.1.74 起语义修正为**抛工具自有错误**（文案带快照要点 + 续等指引）：DSH 的取消不变式会把
// 「取消后 settle 的成功结果」替换成合成错误 ABORTED（详见 stoppedError 的注释），所以返回值
// 送达不了模型；抛错才能让调用方看到可操作的信息。任务不终止、不标记已交付，可再次调用续等。
// v0.1.72：等待也可被「新入站消息」自动让路——其它 agent 的 send_message 走 steer 到
// 本 agent 的 next-step inbox、等最近 step 边界消费；bgjob_wait 是步内长工具没有边界，
// 故在轮询内对 exec.agent.inbox 做「wait 起点基准 + 差分」检测，出现任意新消息即**成功返回**
// stopped:true / stoppedBy:'message' 让路。inbox 不存在则不启用。
// v0.1.82：让路时同时调 exec.concludeTurn() 声明「本回合终结」（见 concludeTurnOf）——DSH 随即在投递
// 边界领取 inbox 把消息交给模型（next-step 立即开下一步；仅 next-turn 排队则回合结束、自动开新回合），
// 不必靠 agent 自觉收敛回合。另：bgjob_wait_all 改为合取语义（全部成功才 allDone，任一失败即短路返回）。

// 可中止 sleep：signal 已/被 abort 立即返回；否则 ms 后返回（abort 事件唤醒，不等满间隔）。
function abortableSleep(signal, ms) {
  return new Promise((resolve) => {
    if (signal === undefined || signal === null) { setTimeout(resolve, ms); return }
    if (signal.aborted) { resolve(); return }
    let settled = false
    const finish = () => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); clearTimeout(timer); resolve() }
    const onAbort = () => finish()
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// 构造「新入站消息」检测器（wait 起点基准 + 轮询差分 inbox.nextStep/nextTurn 的消息 id 序列）。
// exec.agent.inbox 为 DSH 公开契约（Agent.inbox: Inbox；get nextStep/nextTurn）。返回
// ()=>boolean（true = 相比 wait 起点有新消息到达）或 undefined（无 agent.inbox → 不启用）。
export function buildInboxWatch(exec) {
  try {
    const agent = exec && exec.agent
    const inbox = agent && agent.inbox
    if (!inbox || typeof inbox !== 'object') return undefined
    const key = (msgs) => Array.from(msgs || []).map((m) => String(m && m.id !== undefined ? m.id : m)).join('\u0000')
    const baseline = key(inbox.nextStep) + '|' + key(inbox.nextTurn)
    return () => (key(inbox.nextStep) + '|' + key(inbox.nextTurn)) !== baseline
  } catch (e) {
    // inbox 形态异常（非 ReactLoopAgent 实现等）→ 退化为无消息观察。
    return undefined
  }
}

// v0.1.82：让路后把控制权交还 DSH。DSH 的工具执行契约提供 exec.concludeTurn()——把本次**成功**结果标记为
// 「终结当前 agent 回合」（dsh-tools ToolRunContext.concludeTurn → ToolExecutionSuccess.concludesTurn；
// 一方先例：dsh-subagent-in-process-driver 的 structured_output 工具）。
// 让路后 DSH 会自己领取 inbox：next-step 消息立即开下一步投递；仅 next-turn 排队的消息则在回合结束、
// inbox.hasPending 为真时自动开新回合投递。不声明则 agent 须自行收敛回合，排队消息可能长期递不进来
// （bgjob_wait 是步内长工具、没有步边界，反复等待会一直占住回合）。
// exec 无该方法（测试替身 / 非标准实现）→ 静默跳过，退化为现有行为。
export function concludeTurnOf(exec) {
  return () => {
    try { if (exec && typeof exec.concludeTurn === 'function') exec.concludeTurn() } catch { /* 冻结/异常实现 → 不声明 */ }
  }
}

// 单一任务当前状态的「stopped」返回（新消息让路时用；不置 delivered）。
// 注意：**用户停止/打断（signal abort）不走这里**——见下面的 stoppedError 说明。
function stoppedSingle(jobId, s, waitedMs, stoppedBy = 'signal') {
  return {
    ok: true, jobId,
    status: s ? s.status : 'removed',
    exitCode: s && s.exitCode !== undefined && s.exitCode !== null ? s.exitCode : null,
    name: s ? s.name : '',
    logPath: s ? s.logPath : null,
    tail: s ? s.tail : '',
    notified: s ? s.notified === true : false,
    notifiedAt: s && s.notifiedAt !== undefined && s.notifiedAt !== null ? s.notifiedAt : null,
    notifiedBy: s && s.notifiedBy !== undefined && s.notifiedBy !== null ? s.notifiedBy : null,
    timedOut: false, stopped: true, stoppedBy, waitedMs,
  }
}

/**
 * v0.1.74：用户停止/打断（caller signal abort）时**抛工具自有错误**，而不是返回 stopped 快照。
 *
 * 为什么：DSH 的取消不变式里，已启动调用在 caller 取消后 settle 的**成功**结果会被注册表替换为
 * 合成错误 `Error: tool call aborted`（`packages/core/tools/src/index.ts:1539-1543` 的
 * `isAborted(signal) ? toolAbortedResult(result) : result`，以及 `:1580-1585` / `:1599-1607`
 * 两处 `callerCancelled(exec) && !result.isError` 复核）——所以「停止时返回快照」在结构上送达不了
 * 模型。反过来说，**抛出的错误不会被替换**（复核条件都带 `!isError`），first-party 工具
 * （tool-bash/tool-pwsh/jobs-local）也是这么做的。故：把快照要点与续等指引写进错误文案，
 * 语义不变——任务继续后台跑、不标记交付、可再调一次续等。
 *
 * 注：`errorInfo()` 只对 harness 的 HarnessError 实例产出 `{name, code}`（index.ts:635-641），
 * 本项目不引 harness 依赖，故结构化信息在 message 文本里；`err.code` 仅插件侧测试/日志使用。
 */
const WAIT_STOPPED_CODE = 'BGJOB_WAIT_STOPPED'
function stoppedError(toolLabel, waitedMs, entries) {
  const shown = entries.slice(0, 3).map((e) => e.id + '=' + e.status + (e.exitCode === null || e.exitCode === undefined ? '' : '(exit ' + e.exitCode + ')'))
  const more = entries.length > 3 ? ' …(+' + String(entries.length - 3) + ' more)' : ''
  const err = new Error(
    toolLabel + ' was stopped by the user after ' + (waitedMs / 1000).toFixed(1) + 's; jobs: ' + shown.join(', ') + more
    + ' — they keep running in the background and were NOT marked delivered; call ' + toolLabel + ' again to continue waiting'
    + ' (bgjob_status / bgjob_list give details).',
  )
  err.code = WAIT_STOPPED_CODE
  return err
}

export function createWait(ctx, store, deps) {
  const registry = store.registry
  const { checkCompletion } = deps.watch
  const { deliveredOf, markDeliveredId, statusFromDisk } = deps.registry

  // bgjob_wait 用快照：注册表命中 → running 时顺手走一次既有 checkCompletion
  //（幂等，负责置 done/写 job.json/通知）；未命中 → statusFromDisk；两者皆无 → null。
  const waitSnapshot = async (jobId) => {
    const job = registry.get(String(jobId))
    if (job) {
      if (job.status === 'running') { try { await checkCompletion(job) } catch { /* 尚未结束 */ } }
      const dv = deliveredOf(job)
      return {
        found: true, done: job.status !== 'running',
        id: job.id, name: String(job.meta.name || job.id),
        status: job.status, exitCode: job.exitCode === undefined || job.exitCode === null ? null : job.exitCode,
        logPath: job.meta.logPath, tail: job.tail.slice(-4000),
        startedAt: Number(job.meta.createdAt) || null,
        notified: dv.notified, notifiedAt: dv.notifiedAt, notifiedBy: dv.notifiedBy,
      }
    }
    const disk = await statusFromDisk(jobId)
    if (disk) return { found: true, done: disk.status === 'done', id: disk.id, name: disk.name, status: disk.status, exitCode: disk.exitCode, logPath: disk.logPath, tail: disk.tail, startedAt: disk.createdAt, notified: disk.notified, notifiedAt: disk.notifiedAt, notifiedBy: disk.notifiedBy }
    return null
  }

  // 命中即交付：wait 返回某任务结果前，把它置 delivered·wait（未交付时才写），并取最新快照补字段。
  const finishWaitResult = async (jobId, base) => {
    await markDeliveredId(jobId, 'wait')
    const s = await waitSnapshot(jobId)
    return Object.assign({}, base, s
      ? { notified: s.notified === true, notifiedAt: s.notifiedAt === undefined || s.notifiedAt === null ? null : s.notifiedAt, notifiedBy: s.notifiedBy === undefined || s.notifiedBy === null ? null : s.notifiedBy }
      : { notified: true, notifiedAt: null, notifiedBy: 'wait' })
  }

  // 等一个任务结束（bgjob_wait 与 submit 的 wait 参数共用；返回形状一致）。
  // 未知 id 返回 not found；等待中被清理 → status:'removed'；超时返回 timedOut 快照；
  // 用户停止/打断（signal abort）→ **抛 stoppedError**（不返回快照，见其注释）；
  // 新入站消息（watchMsg）→ 成功返回 stopped:true / stoppedBy:'message' 快照，并调 conclude() 把回合
  // 交还 DSH（见 concludeTurnOf）。两者都不置 delivered、可续等。
  const waitJobDone = async (jobId, timeoutMs, signal, watchMsg, conclude) => {
    const started = Date.now()
    // 一进来就被取消（或取消发生在下面的快照/轮询期间）：抛结构化错误（见 stoppedError 说明）。
    if (signal && signal.aborted) throw stoppedError('bgjob_wait', 0, [{ id: jobId, status: 'unknown', exitCode: null }])
    const first = await waitSnapshot(jobId)
    if (!first) return { ok: false, error: 'job not found: ' + jobId }
    if (first.done) {
      if (signal && signal.aborted) throw stoppedError('bgjob_wait', Date.now() - started, [{ id: jobId, status: first.status, exitCode: first.exitCode }])
      return await finishWaitResult(jobId, { ok: true, jobId, status: first.status, exitCode: first.exitCode, name: first.name, logPath: first.logPath, tail: first.tail, timedOut: false, waitedMs: 0 })
    }
    // startedAt 未知（老任务无 createdAt）→ 回退用本次等待起点，退化为下限 250ms 轮询。
    const startedAt = first.startedAt || started
    let s = first
    while (!(signal && signal.aborted) && !(watchMsg && watchMsg()) && Date.now() - started < timeoutMs) {
      // 间隔与「任务已运行时长」成正比：taskAge * 10%，下限 250ms、上限 1s。
      // 间隔恒 ≤1s，不会超过任务完成窗口；任务越久查询越稀，检测延迟仍 ≤~1s。
      const taskAge = Math.max(0, Date.now() - startedAt)
      await abortableSleep(signal, Math.min(WAIT_POLL_MAX_MS, Math.max(WAIT_POLL_MS, taskAge * WAIT_POLL_RATIO)))
      s = await waitSnapshot(jobId)
      if (!s) return { ok: true, jobId, status: 'removed', notified: false, notifiedAt: null, notifiedBy: null, timedOut: false, waitedMs: Date.now() - started }
      if (s.done) {
        // 用户已停止 → 成功结果会被 DSH 丢弃，故同样抛错（文案含真实终态，便于判断"其实已跑完"）。
        if (signal && signal.aborted) throw stoppedError('bgjob_wait', Date.now() - started, [{ id: jobId, status: s.status, exitCode: s.exitCode }])
        return await finishWaitResult(jobId, { ok: true, jobId, status: s.status, exitCode: s.exitCode, name: s.name, logPath: s.logPath, tail: s.tail, timedOut: false, waitedMs: Date.now() - started })
      }
    }
    // 用户停止/打断：抛结构化错误（任务仍在跑、未交付；可再次 bgjob_wait 续等）。
    if (signal && signal.aborted) throw stoppedError('bgjob_wait', Date.now() - started, [{ id: jobId, status: s ? s.status : 'removed', exitCode: s ? s.exitCode : null }])
    // 新入站消息让路：**成功返回** stopped 快照（不涉及 abort，值能正常送达），并声明本回合终结——
    // DSH 随即在投递边界把 inbox 消息作为正式用户消息交给模型（排队消息则结束回合并自动开新回合）。
    if (watchMsg && watchMsg()) {
      if (conclude) conclude()
      return stoppedSingle(jobId, s, Date.now() - started, 'message')
    }
    const cur = await waitSnapshot(jobId)
    return { ok: true, jobId, status: cur ? cur.status : 'removed', exitCode: cur ? cur.exitCode : null, tail: cur ? cur.tail : '', notified: cur ? cur.notified === true : false, notifiedAt: cur ? cur.notifiedAt : null, notifiedBy: cur ? cur.notifiedBy : null, timedOut: true, waitedMs: timeoutMs }
  }

  // ── 多任务等待（any 竞速 + wait_all）──────────────────────────────────────
  // 归一化 id 集合：去重、去空、保持顺序。
  const uniqueIds = (ids) => Array.from(new Set((ids || []).map((x) => String(x)).filter((s) => s.length > 0)))
  // 当前会话（exec.agent.session.id）提交的任务 id：registry 里 createdBySession 相同者。
  const sessionJobIds = (sessionId) =>
    Array.from(registry.values())
      .filter((j) => j.meta && j.meta.createdBySession === String(sessionId))
      .map((j) => j.id)
  // notify 视图：本会话「尚未交付（pending）」任务 id（结果还没进 agent 上下文）。
  // 缺省 wait / bgjob_pending_list 与它同源。
  const sessionPendingIds = (sessionId) =>
    Array.from(registry.values())
      .filter((j) => j.meta && j.meta.createdBySession === String(sessionId)
        && (j.meta.notifiedAt === undefined || j.meta.notifiedAt === null))
      .map((j) => j.id)
  // 逐 id 快照（同一轮），供 any/all 循环复用。
  const snapAll = async (ids) => {
    const out = []
    for (const id of ids) out.push({ id, snap: await waitSnapshot(id) })
    return out
  }
  // 快照 → 终态条目；未终态返回 null。seen 区分「从未见过（not found）」与「消失（removed）」。
  const entryOf = (id, snap, seen, started) => {
    if (!snap) {
      return seen.has(id)
        ? { ok: true, jobId: id, status: 'removed', exitCode: null, name: '', tail: '', notified: false, notifiedAt: null, notifiedBy: null, error: undefined }
        : { ok: false, jobId: id, notified: false, notifiedAt: null, notifiedBy: null, error: 'job not found: ' + id }
    }
    seen.add(id)
    if (!snap.done) return null
    return {
      ok: true, jobId: id, status: snap.status,
      exitCode: snap.exitCode === undefined || snap.exitCode === null ? null : snap.exitCode,
      name: snap.name, tail: snap.tail || '', logPath: snap.logPath || null,
      notified: snap.notified === true, notifiedAt: snap.notifiedAt === undefined || snap.notifiedAt === null ? null : snap.notifiedAt,
      notifiedBy: snap.notifiedBy === undefined || snap.notifiedBy === null ? null : snap.notifiedBy,
      timedOut: false, waitedMs: Date.now() - started,
    }
  }
  // any：任一 id 进入终态（done/removed/not found）即返回该结果；done 命中即置 delivered·wait。
  // 用户停止/打断（signal abort）→ **抛结构化错误**（见 stoppedError）；新入站消息（watchMsg）→ 成功返回
  // stopped 快照，并调 conclude() 把回合交还 DSH。
  const waitAnyOf = async (ids0, timeoutMs, signal, watchMsg, conclude) => {
    const ids = uniqueIds(ids0)
    const started = Date.now()
    const seen = new Set()
    if (signal && signal.aborted) throw stoppedError('bgjob_wait', 0, ids.map((id) => ({ id, status: 'unknown', exitCode: null })))
    const findFirst = async () => {
      for (const { id, snap } of await snapAll(ids)) {
        const t = entryOf(id, snap, seen, started)
        if (t) return t
      }
      return null
    }
    const first = await findFirst()
    if (first) {
      if (signal && signal.aborted) throw stoppedError('bgjob_wait', Date.now() - started, [{ id: first.jobId, status: first.status, exitCode: first.exitCode }])
      const result = await finishWaitResult(first.jobId, first)
      return { ok: true, anyDone: true, timedOut: false, waitedMs: 0, result, pending: ids.filter((x) => x !== first.jobId) }
    }
    while (!(signal && signal.aborted) && !(watchMsg && watchMsg()) && Date.now() - started < timeoutMs) {
      const age = Date.now() - started
      await abortableSleep(signal, Math.min(WAIT_POLL_MAX_MS, Math.max(WAIT_POLL_MS, age * WAIT_POLL_RATIO)))
      const hit = await findFirst()
      if (hit) {
        if (signal && signal.aborted) throw stoppedError('bgjob_wait', Date.now() - started, [{ id: hit.jobId, status: hit.status, exitCode: hit.exitCode }])
        const result = await finishWaitResult(hit.jobId, hit)
        return { ok: true, anyDone: true, timedOut: false, waitedMs: Date.now() - started, result, pending: ids.filter((x) => x !== hit.jobId) }
      }
    }
    // 到这里 = 超时，或用户停止/新消息让路。
    const stoppedBy = signal && signal.aborted ? 'signal' : (watchMsg && watchMsg() ? 'message' : null)
    const cur = await snapAll(ids)
    const results = ids.map((id) => {
      const s = cur.find((c) => c.id === id)
      const t = entryOf(id, s ? s.snap : null, seen, started)
      if (t) return t
      const running = { ok: true, jobId: id, status: s && s.snap ? s.snap.status : 'removed', exitCode: s && s.snap && s.snap.exitCode != null ? s.snap.exitCode : null, name: s && s.snap ? s.snap.name : '', tail: s && s.snap ? (s.snap.tail || '') : '', notified: s && s.snap ? (s.snap.notified === true) : false, notifiedAt: s && s.snap ? s.snap.notifiedAt : null, notifiedBy: s && s.snap ? s.snap.notifiedBy : null }
      return stoppedBy
        ? { ...running, timedOut: false, stopped: true, stoppedBy, waitedMs: Date.now() - started }
        : { ...running, timedOut: true, waitedMs: timeoutMs }
    })
    if (stoppedBy === 'signal') throw stoppedError('bgjob_wait', Date.now() - started, results.map((r) => ({ id: r.jobId, status: r.status, exitCode: r.exitCode })))
    if (stoppedBy === 'message') {
      if (conclude) conclude()
      return { ok: true, anyDone: false, timedOut: false, stopped: true, stoppedBy, waitedMs: Date.now() - started, results }
    }
    return { ok: true, anyDone: false, timedOut: true, waitedMs: timeoutMs, results }
  }
  // all：合取语义（v0.1.82）——全部**成功**结束才 allDone:true；任一任务失败即短路返回 failed:true
  // （合取已确定为假，不必再等剩余任务）。done 结果返回前置 delivered·wait；超时/被打断返回逐 id 当前状态。
  const waitAllOf = async (ids0, timeoutMs, signal, watchMsg, conclude) => {
    const ids = uniqueIds(ids0)
    const started = Date.now()
    const seen = new Set()
    const done = new Map() // jobId → 终态条目
    const markRound = async () => {
      const rest = ids.filter((id) => !done.has(id))
      if (rest.length === 0) return
      for (const { id, snap } of await snapAll(rest)) {
        const t = entryOf(id, snap, seen, started)
        if (t) done.set(id, t)
      }
    }
    // 失败判定：非 0 退出码，或无法确认成功（被清理 removed / 找不到 not found）。
    // entryOf 已把 exitCode 归一为 number|null；not found 的条目没有 status/exitCode。
    // 注：exitCode 为 null（done 但读不到退出码）同样无法确认成功 → e.exitCode !== 0 为真。
    const failureOf = (e) => e.ok === false || e.status === 'removed' || e.exitCode !== 0
    const firstFailure = () => {
      for (const id of ids) {
        const e = done.get(id)
        if (e && failureOf(e)) return e
      }
      return undefined
    }
    const abortError = () => stoppedError('bgjob_wait_all', Date.now() - started, ids.map((id) => {
      const e = done.get(id)
      return { id, status: e ? e.status : 'unknown', exitCode: e ? e.exitCode : null }
    }))
    // 失败短路：已终态者按终态条目并置交付（与"全部结束"一致，否则缺省 wait 会把它们再返回一次）；
    // 未结束者给 running 占位并列进 pending。不 concludeTurn——失败是"有活要干"，回合应继续。
    const summarizeFailFast = async (f) => {
      const results = []
      for (const id of ids) {
        const e = done.get(id)
        results.push(e
          ? await finishWaitResult(e.jobId, e)
          : { ok: true, jobId: id, status: 'running', exitCode: null, name: '', tail: '', notified: false, notifiedAt: null, notifiedBy: null, timedOut: false, waitedMs: Date.now() - started })
      }
      return { ok: true, allDone: false, failed: true, failedJobId: f.jobId, timedOut: false, waitedMs: Date.now() - started, results, pending: ids.filter((id) => !done.has(id)) }
    }
    // 每次快照后的统一判定（顺序固定：全部成功结束 > 让路 > 失败短路）。返回结果对象；
    // undefined = 继续等；letgo = 让路（循环外按 message 收尾）。
    let letgo = false
    const settle = async () => {
      if (done.size === ids.length && firstFailure() === undefined) {
        if (signal && signal.aborted) throw abortError()
        return await summarize()
      }
      // 让路优先于失败：有人在等，先把回合交还 DSH；失败信息随时可再查。
      if (watchMsg && watchMsg()) { letgo = true; return undefined }
      const f = firstFailure()
      if (f) {
        if (signal && signal.aborted) throw abortError()
        return await summarizeFailFast(f)
      }
      return undefined
    }
    const summarize = async () => {
      const results = []
      for (const id of ids) {
        const e = done.get(id)
        results.push(e ? await finishWaitResult(e.jobId, e) : { ok: true, jobId: id, status: 'running', exitCode: null, name: '', tail: '', notified: false, notifiedAt: null, notifiedBy: null, timedOut: true, waitedMs: Date.now() - started })
      }
      return { ok: true, allDone: done.size === ids.length, timedOut: false, waitedMs: Date.now() - started, results }
    }
    // 超时或被信号/新消息打断的收尾：逐 id 当前状态（done 的用已收集终态；不置 delivered——被打断不交付）。
    const summarizePartial = async (stoppedBy) => {
      const cur = await snapAll(ids)
      const results = []
      for (const id of ids) {
        const e = done.get(id)
        if (e) { results.push(e); continue }
        const s = cur.find((c) => c.id === id)
        const t = entryOf(id, s ? s.snap : null, seen, started)
        results.push(t || { ok: true, jobId: id, status: s && s.snap ? s.snap.status : 'removed', exitCode: s && s.snap && s.snap.exitCode != null ? s.snap.exitCode : null, name: s && s.snap ? s.snap.name : '', tail: s && s.snap ? (s.snap.tail || '') : '', notified: s && s.snap ? (s.snap.notified === true) : false, notifiedAt: s && s.snap ? s.snap.notifiedAt : null, notifiedBy: s && s.snap ? s.snap.notifiedBy : null, timedOut: !stoppedBy, ...(stoppedBy ? { stopped: true, stoppedBy } : {}), waitedMs: stoppedBy ? Date.now() - started : timeoutMs })
      }
      return {
        ok: true, allDone: false,
        timedOut: !stoppedBy,
        ...(stoppedBy ? { stopped: true, stoppedBy } : {}),
        waitedMs: stoppedBy ? Date.now() - started : timeoutMs,
        results,
      }
    }
    await markRound()
    const firstHit = await settle()
    if (firstHit) return firstHit
    while (!letgo && !(signal && signal.aborted) && Date.now() - started < timeoutMs) {
      const age = Date.now() - started
      await abortableSleep(signal, Math.min(WAIT_POLL_MAX_MS, Math.max(WAIT_POLL_MS, age * WAIT_POLL_RATIO)))
      await markRound()
      const hit = await settle()
      if (hit) return hit
    }
    const stoppedBy = signal && signal.aborted ? 'signal' : (watchMsg && watchMsg() ? 'message' : null)
    if (stoppedBy === 'signal') throw abortError()
    // 让路：声明本回合终结，由 DSH 在投递边界把 inbox 消息交给模型（见 concludeTurnOf）。
    if (stoppedBy === 'message' && conclude) conclude()
    return await summarizePartial(stoppedBy)
  }
  // submit 的 wait：缺省 = notify 视图（本会话未交付任务）any；
  // 会话不可解析或视图为空时回退为等刚提交的这一个（原行为兜底）。
  // signal = exec.signal（DSH 停止按钮 → abort）、watchMsg = 新入站消息检测（send_message 等）、
  // conclude = 让路时声明回合终结（exec.concludeTurn），分别透传给 any / 单任务等待。
  const waitSubmittedAny = async (jobId, exec, timeoutMs) => {
    const signal = exec && exec.signal ? exec.signal : undefined
    const watchMsg = buildInboxWatch(exec)
    const conclude = concludeTurnOf(exec)
    const sessionId = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
    if (sessionId) {
      const ids = sessionPendingIds(sessionId)
      if (ids.length > 0) return waitAnyOf(ids, timeoutMs, signal, watchMsg, conclude)
    }
    return waitJobDone(jobId, timeoutMs, signal, watchMsg, conclude)
  }

  return {
    api: {
      sessionJobIds, sessionPendingIds,
      waitSnapshot, waitJobDone, waitAnyOf, waitAllOf, waitSubmittedAny,
    },
    dispose: [],
  }
}
