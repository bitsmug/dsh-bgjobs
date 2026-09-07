// bgjobs core —— 等待域（v0.1.61 结构重构；自 lib/index.js apply 拆分）。
// bgjob_wait / bgjob_wait_all / 提交 wait 参数 / notify 视图（缺省等待集合）。
// 跨域：经 deps.watch.checkCompletion 完成检测、deps.registry 交付标记与磁盘回退。

// bgjob_wait 轮询（v0.1.51）：轮询间隔与「任务自身已运行时长」成正比（而非本工具等待时长）：
// 短任务毫秒级响应，任务越久间隔越大；下限 250ms、上限 1s——间隔永远封顶 1s，
// 不会超过任务完成窗口。interval = clamp(250ms, taskAge * WAIT_POLL_RATIO, 1000ms)。
const WAIT_POLL_MS = 250
const WAIT_POLL_MAX_MS = 1000
const WAIT_POLL_RATIO = 0.1   // 任务已运行时长的 10%；约 age=10s 时达 1s 上限

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
  // 未知 id 返回 not found；等待中被清理 → status:'removed'；超时返回 timedOut 快照。
  const waitJobDone = async (jobId, timeoutMs) => {
    const started = Date.now()
    const first = await waitSnapshot(jobId)
    if (!first) return { ok: false, error: 'job not found: ' + jobId }
    if (first.done) {
      return await finishWaitResult(jobId, { ok: true, jobId, status: first.status, exitCode: first.exitCode, name: first.name, logPath: first.logPath, tail: first.tail, timedOut: false, waitedMs: 0 })
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    // startedAt 未知（老任务无 createdAt）→ 回退用本次等待起点，退化为下限 250ms 轮询。
    const startedAt = first.startedAt || started
    while (Date.now() - started < timeoutMs) {
      // 间隔与「任务已运行时长」成正比：taskAge * 10%，下限 250ms、上限 1s。
      // 间隔恒 ≤1s，不会超过任务完成窗口；任务越久查询越稀，检测延迟仍 ≤~1s。
      const taskAge = Math.max(0, Date.now() - startedAt)
      await sleep(Math.min(WAIT_POLL_MAX_MS, Math.max(WAIT_POLL_MS, taskAge * WAIT_POLL_RATIO)))
      const s = await waitSnapshot(jobId)
      if (!s) return { ok: true, jobId, status: 'removed', notified: false, notifiedAt: null, notifiedBy: null, timedOut: false, waitedMs: Date.now() - started }
      if (s.done) {
        return await finishWaitResult(jobId, { ok: true, jobId, status: s.status, exitCode: s.exitCode, name: s.name, logPath: s.logPath, tail: s.tail, timedOut: false, waitedMs: Date.now() - started })
      }
    }
    const cur = await waitSnapshot(jobId)
    return { ok: true, jobId, status: cur ? cur.status : 'removed', exitCode: cur ? cur.exitCode : null, tail: cur ? cur.tail : '', notified: cur ? cur.notified === true : false, notifiedAt: cur ? cur.notifiedAt : null, notifiedBy: cur ? cur.notifiedBy : null, timedOut: true, waitedMs: timeoutMs }
  }

  // ── 多任务等待（any 竞速 + wait_all）──────────────────────────────────────
  // 归一化 id 集合：去重、去空、保持顺序。
  const uniqueIds = (ids) => Array.from(new Set((ids || []).map((x) => String(x)).filter((s) => s.length > 0)))
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
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
  const waitAnyOf = async (ids0, timeoutMs) => {
    const ids = uniqueIds(ids0)
    const started = Date.now()
    const seen = new Set()
    const findFirst = async () => {
      for (const { id, snap } of await snapAll(ids)) {
        const t = entryOf(id, snap, seen, started)
        if (t) return t
      }
      return null
    }
    const first = await findFirst()
    if (first) {
      const result = await finishWaitResult(first.jobId, first)
      return { ok: true, anyDone: true, timedOut: false, waitedMs: 0, result, pending: ids.filter((x) => x !== first.jobId) }
    }
    while (Date.now() - started < timeoutMs) {
      const age = Date.now() - started
      await sleepMs(Math.min(WAIT_POLL_MAX_MS, Math.max(WAIT_POLL_MS, age * WAIT_POLL_RATIO)))
      const hit = await findFirst()
      if (hit) {
        const result = await finishWaitResult(hit.jobId, hit)
        return { ok: true, anyDone: true, timedOut: false, waitedMs: Date.now() - started, result, pending: ids.filter((x) => x !== hit.jobId) }
      }
    }
    // 超时：返回全部当前状态。
    const cur = await snapAll(ids)
    const results = ids.map((id) => {
      const s = cur.find((c) => c.id === id)
      const t = entryOf(id, s ? s.snap : null, seen, started)
      return t || { ok: true, jobId: id, status: s.snap ? s.snap.status : 'removed', exitCode: s.snap && s.snap.exitCode != null ? s.snap.exitCode : null, name: s.snap ? s.snap.name : '', tail: s.snap ? (s.snap.tail || '') : '', notified: s.snap ? (s.snap.notified === true) : false, notifiedAt: s.snap ? s.snap.notifiedAt : null, notifiedBy: s.snap ? s.snap.notifiedBy : null, timedOut: true, waitedMs: timeoutMs }
    })
    return { ok: true, anyDone: false, timedOut: true, waitedMs: timeoutMs, results }
  }
  // all：全部 id 进入终态才返回（done 结果返回前置 delivered·wait）；超时返回逐 id 当前状态。
  const waitAllOf = async (ids0, timeoutMs) => {
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
    const summarize = async () => {
      const results = []
      for (const id of ids) {
        const e = done.get(id)
        results.push(e ? await finishWaitResult(e.jobId, e) : { ok: true, jobId: id, status: 'running', exitCode: null, name: '', tail: '', notified: false, notifiedAt: null, notifiedBy: null, timedOut: true, waitedMs: Date.now() - started })
      }
      return { ok: true, allDone: done.size === ids.length, timedOut: false, waitedMs: Date.now() - started, results }
    }
    await markRound()
    if (done.size === ids.length) return await summarize()
    while (Date.now() - started < timeoutMs) {
      const age = Date.now() - started
      await sleepMs(Math.min(WAIT_POLL_MAX_MS, Math.max(WAIT_POLL_MS, age * WAIT_POLL_RATIO)))
      await markRound()
      if (done.size === ids.length) return await summarize()
    }
    const partial = []
    for (const id of ids) {
      const e = done.get(id)
      partial.push(e ? e : { ok: true, jobId: id, status: 'running', exitCode: null, name: '', tail: '', notified: false, notifiedAt: null, notifiedBy: null, timedOut: true, waitedMs: timeoutMs })
    }
    return { ok: true, allDone: false, timedOut: true, waitedMs: timeoutMs, results: partial }
  }
  // submit 的 wait：缺省 = notify 视图（本会话未交付任务）any；
  // 会话不可解析或视图为空时回退为等刚提交的这一个（原行为兜底）。
  const waitSubmittedAny = async (jobId, exec, timeoutMs) => {
    const sessionId = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : ''
    if (sessionId) {
      const ids = sessionPendingIds(sessionId)
      if (ids.length > 0) return waitAnyOf(ids, timeoutMs)
    }
    return waitJobDone(jobId, timeoutMs)
  }

  return {
    api: {
      sessionJobIds, sessionPendingIds,
      waitSnapshot, waitJobDone, waitAnyOf, waitAllOf, waitSubmittedAny,
    },
    dispose: [],
  }
}
