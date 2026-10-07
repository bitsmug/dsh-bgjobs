// bgjobs core —— 网页面板路由域（v0.1.61 结构重构；自 lib/index.js apply 拆分）。
// /bgjobs/state|log|fullaccess|uiprefs|gui|mcpprefs|mcpservers|dsh-mcp|kill|delete|cleanup 前缀路由。

import { promises as fsp } from 'node:fs'
import { TAIL_CAP, errorMsg } from '../util.js'
import { SCHTASKS, runSchtasks } from '../runners.js'
import { killJobProcessTree, detectJobProcesses, KILLED_EXIT_CODE } from '../kill-tree.js'
import { shouldNotifyForExit } from '../notify-policy.js'
import { guiScriptInfo, launchGui, revealGuiFolder } from '../gui-launch.js'
import { readBgjobsVersion } from '../meta.js'
import { readMcpConfigs, describeDshMcp, serializeServers, parseServerImport } from '../dsh-profiles.js'

export function createWeb(ctx, store, deps) {
  const {
    registry, readFullAccess, setFullAccess, readUiPrefs, setUiPrefs, resetDisplay, DEFAULT_DISPLAY, DEFAULT_ELEMENTS, DEFAULT_WAIT_TIMEOUT_SECONDS,
    readMcpPrefs, setMcpPrefs, readMcpServers, setMcpServer, deleteMcpServer, setMcpServerState, isReady,
  } = store
  const { closeWatch } = deps.watch
  const { indexRemove, view, readJobLogTail, markToastedId, markDelivered } = deps.registry
  // 完成后通知创建者（v0.1.31）。kill 路径要按失败口径通知：补写的 1 ≠ 0 ⇒ on-completion 不命中。
  const deliverCompletionNotice = deps.notify && typeof deps.notify.deliverCompletionNotice === 'function'
    ? deps.notify.deliverCompletionNotice
    : () => false
  // MCP：工具列表域（§5b 单一口径）+ 预热域（§7）。
  const mcp = deps.mcp
  const prewarm = deps.prewarm || null

  // ── kill / delete 共用的收尾工具 ──────────────────────────────────────────
  /** kill 证据字段（与既有字段**同名同义**，别改名：上游/测试/面板已在用）。 */
  const killEvidenceFields = (killed) => ({
    ...(killed.pid !== undefined ? { killedPid: killed.pid, killedFile: killed.file, killedVerified: killed.verified === true } : {}),
    ...(Array.isArray(killed.killedPids) ? { killedPids: killed.killedPids } : {}),
    ...(Array.isArray(killed.matched) ? { matchedPids: killed.matched } : {}),
    // 反查兜底的证据：每个 pid + 命令行片段（缺口 B 要求"动手前把匹配到的 pid + 命令行打进返回值"）
    ...(Array.isArray(killed.killed) ? { killedProcesses: killed.killed } : {}),
    ...(Array.isArray(killed.survivors) ? { survivors: killed.survivors } : {}),
    // taskkill 的非零输出只作证据（"非零 ≠ 失败"：最外层根的 /T 带走子根后，子根会报 128 找不到进程）
    ...(typeof killed.stderr === 'string' && killed.stderr.length > 0 ? { killStderr: killed.stderr } : {}),
  })

  /** schtasks 调用（spawn 失败记 warning，绝不抛）。 */
  const runSchtasksRecorded = async (job, argv, label, warnings) => {
    try { return await runSchtasks(argv, job.meta.workdir) }
    catch (e) { warnings.push(label + ' spawn failed: ' + errorMsg(e)); return { exitCode: null, stdout: '', stderr: '' } }
  }

  /**
   * 计划任务注册的收尾：`/End`（running）+ `/Delete`（幂等：bat/pwsh 正常跑完已自删，非零属正常）。
   * ★ 计划任务**不是任务记录**（记录 = job 目录 / 中央索引 / 注册表）——这里删它只是不留下已死的
   * 注册项，kill 与 delete 两条路径都要做（kill 后任务已死，留着注册项毫无意义）。
   */
  const endScheduledTask = async (job, warnings) => {
    if (job.status === 'running') {
      const ended = await runSchtasksRecorded(job, [SCHTASKS, '/End', '/TN', job.meta.taskName], 'schtasks /End', warnings)
      if (ended.exitCode !== 0) {
        warnings.push('schtasks /End exit ' + ended.exitCode + ': ' + String(ended.stderr || ended.stdout || '').trim())
      }
    }
    const deleted = await runSchtasksRecorded(job, [SCHTASKS, '/Delete', '/TN', job.meta.taskName, '/F'], 'schtasks /Delete', warnings)
    if (deleted.exitCode !== 0) {
      warnings.push('schtasks /Delete exit ' + deleted.exitCode + ': ' + String(deleted.stderr || deleted.stdout || '').trim())
    }
  }

  /**
   * kill 成功后的**终态补写**（★ 只动任务自己的终态，记录一律保留）。
   * 为什么必须由 host 补：`exitcode.txt` 原本只由 runner 收尾时写，而进程被 `taskkill /F` 杀掉时
   * runner 根本没机会写 ⇒ 不补的话 `bgjob_wait` 会一直等到超时、面板永远显示 running。
   *   ① `<jobDir>\exitcode.txt` = `KILLED_EXIT_CODE`(1) ⇒ wait/面板都看到**非 0 退出码**；
   *   ② job.json 落 status/exitCode/finishedAt + `exitCodeSource:'killed'` + `killedAt`/`killedBy`
   *      ⇒ 事后能区分"自己退出的非 0"与"被我们终止"；
   *   ③ 内存注册表同步（status='done'）⇒ `/bgjobs/state` 立刻显示终态，不必等下一 tick；
   *   ④ 关 watch（终态已由我们写入）+ 按既有 notify 策略通知创建者：1 ≠ 0 ⇒ `on-fail`/`on-exit`
   *      命中、**`on-completion` 不命中** ⇒ 被终止的任务在 notify 里表现为失败，不会被报成"完成"。
   */
  const markJobKilled = async (job, warnings, killedBy) => {
    const result = { ok: true, exitcodeWritten: false, jobJsonUpdated: false, terminalKept: false }
    // 已结束的任务（典型：mcp 任务的孤儿 server 进程）被 kill：终态与退出码必须**保持原样**，绝不覆盖。
    if (job.status === 'done') return Object.assign(result, { terminalKept: true })
    const at = Date.now()
    job.status = 'done'
    job.exitCode = KILLED_EXIT_CODE
    job.finishedAt = at
    job.meta.killedAt = at
    job.meta.killedBy = (typeof killedBy === 'string' && killedBy.length > 0) ? killedBy : 'kill'
    job.meta.exitCodeSource = 'killed'
    closeWatch(job)
    try {
      await fsp.writeFile(job.meta.exitcodePath, String(KILLED_EXIT_CODE), 'utf8')
      result.exitcodeWritten = true
    } catch (e) {
      result.ok = false
      result.error = 'write exitcode.txt failed: ' + errorMsg(e)
    }
    const finalMeta = Object.assign({}, job.meta, { status: 'done', exitCode: KILLED_EXIT_CODE, finishedAt: at })
    try {
      await fsp.writeFile(job.meta.jsonPath, JSON.stringify(finalMeta), 'utf8')
      result.jobJsonUpdated = true
    } catch (e) {
      result.ok = false
      result.error = (result.error ? result.error + ' | ' : '') + 'write job.json failed: ' + errorMsg(e)
    }
    if (shouldNotifyForExit(job.meta.notify, KILLED_EXIT_CODE)) {
      try {
        if (deliverCompletionNotice(job)) await markDelivered(job, 'notify')
      } catch (e) { warnings.push('notify failed: ' + errorMsg(e)) }
    }
    return result
  }

  // 读 JSON 请求体（上限保护）；非 JSON / 空体 / 超限 / 无流（测试桩）→ null（回退 query 形式）。
  const readJsonBody = (req) => new Promise((resolve) => {
    if (!req || typeof req.on !== 'function') { resolve(null); return }
    let size = 0
    const chunks = []
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => {
      size += c.length
      if (size > 100000) { try { req.destroy() } catch (e) { /* ignore */ } finish(null); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')) } catch (e) { finish(null) }
    })
    req.on('error', () => finish(null))
  })

  // ── force：**只用来越过 `mode:'unknown'` 这道门槛**（用户裁定，2026-10-08）──────────
  // 传参形态（两条路由同口径，唯一判据是"有没有显式 force"）：
  //   ① query `?force=1`（推荐 —— 与既有 `id` 同形态：`/bgjobs/delete?id=<id>&force=1`）；
  //   ② JSON body `{ force: true }`（POST 且查询串里**没写** force 时才看 body，避免无谓地消费请求体）。
  // 判定不需要 force 的情形（`live` / `absent`）**完全不受 force 影响**：传了也不改行为、也不打 forced 标记。
  const FORCE_TRUE = new Set(['1', 'true', 'yes'])
  const parseForce = (raw) => {
    if (raw === true) return true
    if (raw === false || raw === null || raw === undefined) return false
    return FORCE_TRUE.has(String(raw).trim().toLowerCase())
  }
  const resolveForce = async (url, req) => {
    const fromQuery = url.searchParams.get('force')
    if (fromQuery !== null) return parseForce(fromQuery)
    if (String(req && req.method ? req.method : '').toUpperCase() !== 'POST') return false
    const body = await readJsonBody(req)
    return body !== null && typeof body === 'object' ? parseForce(body.force) : false
  }
  // `mode:'unknown'` 的两条文案（唯一来源 ⇒ 路由 / CLI / GUI / 文档口径一致）。
  // 为什么默认不执行：unknown = **无法判定**该任务是否仍有活进程（探针或反查本身跑不起来）——
  // 此时"清理/删除"有可能删出一个**看不见还在跑的孤儿进程**，所以按裁定先拦下、只警告，
  // 要动手必须由用户显式 force（CLI -Force / HTTP ?force=1 / GUI 确认框）。
  const unknownWarning = (reason) => '无法判定该任务的进程状态（' + reason + '）：按裁定默认不执行，仅警告'
  const unknownError = (reason, what) => '无法判定本任务是否仍有活进程：' + reason
    + ' —— 已按裁定不执行（' + what + '）；如确认要继续，请显式加 force（HTTP ?force=1 / CLI -Force / GUI 确认框）'

  // ── kill / delete 是**两种语义**（用户裁定，2026-10-07；边界于 2026-10-08 更正）──────
  // ★★ 更正（2026-10-08）：**kill 内部【没有】delete 分支** —— 一个 `kill` 请求永远只是
  //   "终止进程"，绝不偷偷变成"删除记录"。老话「进程不存在 ⇒ delete 语义」的正确读法是
  //   **「调用方在无活进程时该去调 delete」**，不是"kill 替它转 delete"；两个动作各自纯粹，
  //   "谁该做什么"由**调用方**决定（CLI/GUI/面板/agent 各按自己的意图选路由）。
  //   落地：无活进程 ⇒ kill 回 `mode:'absent'` + `killed:false` + note「未发现该任务的活进程…」，
  //   **不杀进程、不删任何记录、也不动计划任务注册**（记录/注册表/索引/目录一律原封不动）。
  // ★ kill   = **只终止进程**（对运行中的任务）：pid 文件 → 归属核验 → `taskkill /PID <pid> /T /F`
  //   → ≤2s 核验整树消失；**无 pid 文件**（bat 引擎 / 0.1.94 前的历史任务）⇒ 按 jobDir/taskName
  //   反查进程树（缺口 B，见 lib/kill-tree.js 的 killByReverseLookup）——`schtasks /End` 打印
  //   SUCCESS 却够不到任务根起的后代（沙箱 pwsh 是 pwsh(run.ps1) → node(runner.js) →
  //   pwsh(job.ps1) 三层；bat 是 wscript(launch.vbs) → cmd(run.bat) → 用户命令）。
  //   ★ kill **不删任何记录**：job 目录 / 中央索引 / 注册表**全部保留**，任务变成"已被终止"的终态
  //   （host 侧补写 `exitcode.txt = 1`（taskkill /F 记录的真值）+ job.json 的 killedAt/killedBy/exitCodeSource:'killed'）
  //   ⇒ `bgjob_wait` 拿到**非 0 退出码**、notify 按失败口径通知，绝不读成"成功完成"。
  //   要彻底清掉 ⇒ **之后再调 delete**（两步分开，谁都不替谁做）。
  // ★ delete = **只删记录**（对已完成的任务；"进程不存在"也归此）：动手前先确认**没有活进程**，
  //   再删 job 目录 + 注册表 + 中央索引。有活进程 ⇒ 拒绝并提示先 kill（delete 绝不越界杀进程，
  //   否则又会造出"面板看不见但进程还在跑"的孤儿）。清理与报告**解耦**（缺口 A）：目录删不净也要
  //   清注册表/索引（否则留下 `status:'running'` 的僵尸条目），失败先记 failures，最后据此定 ok/error。
  //   ★ delete 也**不越界到 kill**：不为了"对称"去杀进程（那是 kill 的事）。
  // ★ mode（返回值标记，`killJob` 与 `removeJob` 各自纯粹）：kill 回 'kill'（有活进程、本次终止了
  //   它，记录保留）/ 'absent'（**未发现本任务的活进程** ⇒ kill 什么都没做、也没删任何记录）/
  //   'unknown'（探针/反查本身跑不起来 ⇒ 无法判定；保守 ok:false，绝不谎报）；delete 回 'delete'
  //   （本次只删记录）/ 'kill'（有活进程 ⇒ 拒绝，提示先 kill）/ 'unknown'（无法判定）。
  //   判据一律来自 kill-tree 的 processFound / detectJobProcesses，**不靠 error 文案猜**。
  //   ★ 字段名与其它可取值一字未改：旧值 'delete'（= kill 内部借用 delete 语义）按 2026-10-08
  //   裁定改为 'absent' —— kill 不再借 delete 的名字（见下方 killJob 的 mode 处注释）。
  // ★ processFound 三态（语义分流的唯一判据）：true（有活进程）/ false（**未发现活进程** ⇒ kill
  //   无可终止，要清记录由调用方去调 delete）/ null 或 'unknown'（无法判定）。
  // ★★ unknown ⇒ **默认什么也不做**（用户裁定，2026-10-08）：两条路由都只回警告 + `needsForce: true`，
  //   不终止任何进程、不删任何记录；**只有显式 force** 才越过这道门槛（回 `forced: true`）。
  //   边界：`live`（kill 语义）与 `absent`（**未发现活进程** ⇒ kill 什么都不做、什么都不删）
  //   **完全不受 force 影响** —— 传不传 force 行为一模一样，也不会出现 `forced` 标记。
  //   （`absent` 只描述 kill 自己的判定结果；"要清记录"是调用方去调 delete 的事，与本路由无关。）
  //   清理入口 `/bgjobs/cleanup` 走 removeJob（不带 force）
  //   ⇒ 遇到 unknown 的 done 任务同样被拦下并记进 `skipped`（如实回传，不静默跳过）。
  const killJob = async (jobId, options = {}) => {
    const force = options.force === true
    // 可选审计标签：谁/为什么终止的。**不改既有默认**——不传时 job.json 的 killedBy 仍是 'kill'。
    const killedBy = typeof options.reason === 'string' && options.reason.length > 0 ? options.reason : undefined
    const job = registry.get(String(jobId))
    if (job === undefined) return { ok: false, error: 'job not found: ' + jobId }
    const warnings = []
    const failures = []
    const killed = await killJobProcessTree(job)
      .catch((e) => ({ ok: false, error: 'kill process tree failed: ' + errorMsg(e), processFound: null }))
    if (!killed.ok) failures.push(String(killed.error))
    if (killed.note !== undefined) warnings.push(killed.note)
    if (Array.isArray(killed.warnings)) warnings.push(...killed.warnings)
    const evidence = killEvidenceFields(killed)
    // ★★ mode：本次实际走了哪种语义。'absent' = **未发现本任务的活进程**（不是"转 delete"——
    //    kill 内部没有任何删除记录的代码路径；要清记录请调用方去调 delete）。字段名与其余取值
    //    （'kill' / 'unknown' / delete 侧的 'delete'）一字未改，只有 kill 侧旧值 'delete' 改为 'absent'。
    const mode = killed.processFound === true ? 'kill' : (killed.processFound === false ? 'absent' : 'unknown')
    // ★★ unknown 门槛（用户裁定，2026-10-08）：无法判定有没有活进程 ⇒ 默认什么都不做，只警告 + 要求 force。
    //    注意 kill 路径在 unknown 下本来就"无从下手"（反查查询本身跑不起来 ⇒ 连杀谁都不知道），
    //    所以 force 在这里只解除门槛、绝不谎报成功：真杀掉了才会是 ok:true。
    const gateBlocked = mode === 'unknown' && !force
    const forced = mode === 'unknown' && force
    const unknownReason = failures.length > 0 ? failures.join(' | ') : '进程查询本身跑不起来'
    if (gateBlocked) warnings.push(unknownWarning(unknownReason))
    if (forced) warnings.push('无法判定该任务的进程状态：已按显式 force 继续执行（' + unknownReason + '）')
    const base = {
      mode, jobId: job.id,
      // killed = **确实终止了本任务的进程**（不是"尝试过"）：杀失败/没进程可杀一律 false。
      killed: killed.ok === true && mode === 'kill',
      recordsKept: true,
      ...evidence, ...(warnings.length > 0 ? { warnings } : {}),
      ...(forced ? { forced: true } : {}),
    }
    if (gateBlocked) {
      return {
        ...base, ok: false, needsForce: true,
        error: unknownError(unknownReason, '未终止任何进程，记录原封不动'),
      }
    }
    if (!killed.ok) {
      // ★ 唯一的"kill 失败"：**进程还在、且杀不掉**（归属核验失败 / taskkill 非零且核验仍活 / 杀后仍活）。
      // 记录一律保留（recordsKept）——用户可再试，或先看 error 里的原因。
      return { ...base, ok: false, error: failures.join(' | ') }
    }
    if (mode === 'absent') {
      // ★★ 无活进程 ⇒ kill **只如实回**「未发现该任务的活进程」：**不杀任何进程、不删任何记录，
      //    也不替调用方转 delete**（2026-10-08 更正掉的就是这个"内部转 delete"的分支）。
      //    这里提前 return 的位置与旧实现一致（不动计划任务注册、不补写终态——没有进程被终止），
      //    变的只是**语义与文案**：kill 不再把自己说成 delete 语义，也不再暗示"本次只可能删记录"。
      return {
        ...base, ok: true,
        note: '未发现该任务的活进程 ⇒ 无可终止；kill 只终止进程，本次未删除任何记录（job 目录/索引/注册表原封不动），要清记录请调用 delete',
        ...(killed.skipped !== undefined ? { skipped: killed.skipped } : {}),
      }
    }
    // 有活进程且整树已消失 ⇒ 收尾：计划任务注册（不是任务记录）+ 被终止的终态补写。
    await endScheduledTask(job, warnings)
    const marked = await markJobKilled(job, warnings, killedBy)
    if (!marked.ok) failures.push(String(marked.error))
    return {
      ...base,
      ok: failures.length === 0,
      // 已结束的任务（如 mcp 孤儿 server）被 kill：退出码保持它自己的，绝不覆盖成 KILLED_EXIT_CODE。
      exitCode: marked.terminalKept === true
        ? (job.exitCode === undefined || job.exitCode === null ? null : job.exitCode)
        : KILLED_EXIT_CODE,
      exitcodeWritten: marked.exitcodeWritten === true,
      jobJsonUpdated: marked.jobJsonUpdated === true,
      terminalKept: marked.terminalKept === true,
      status: job.status,
      finishedAt: job.finishedAt === undefined || job.finishedAt === null ? null : job.finishedAt,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(failures.length > 0 ? { error: failures.join(' | ') } : {}),
    }
  }

  // 一键清理：删除所有已完成（done）任务，包括异常退出（exitCode !== 0）。
  // ★ 语义（2026-10-07 起）：走的是 **delete**（只删记录）；若某个 done 任务仍有活进程（典型：mcp 孤儿
  //   server），removeJob 会**明确拒绝** ⇒ 记进 skipped 一并回传（绝不静默杀掉进程，也绝不静默跳过）。
  // ★ unknown 门槛（用户裁定，2026-10-08）：本路径**不带 force** ⇒ 判定不出进程状态的 done 任务
  //   同样被拦下（只警告、不删），也进 skipped 如实回传 —— 批量清理绝不替用户 force。
  const cleanupDone = async () => {
    const removed = []
    const skipped = []
    for (const job of Array.from(registry.values())) {
      if (job.status !== 'done') continue
      const r = await removeJob(job.id)
      if (r.ok) removed.push(job.id)
      else skipped.push({ id: job.id, mode: r.mode === undefined ? null : r.mode, error: r.error === undefined ? '' : String(r.error) })
    }
    return { ok: true, removed, ...(skipped.length > 0 ? { skipped } : {}) }
  }

  const removeJob = async (jobId, options = {}) => {
    const force = options.force === true
    let forced = false
    const job = registry.get(String(jobId))
    if (job === undefined) return { ok: false, error: 'job not found: ' + jobId }
    const warnings = []
    const failures = []
    // ⓪ 前置判定：delete 只删记录 ⇒ 先确认没有本任务的活进程（有活进程是 kill 的事）。
    const detected = await detectJobProcesses(job)
      .catch((e) => ({ state: 'unknown', error: 'detect processes failed: ' + errorMsg(e) }))
    if (detected.state === 'live') {
      const where = detected.pid !== undefined
        ? ('PID ' + detected.pid + ' (' + detected.file + ') 仍存活')
        : ('按 jobDir/taskName 反查到活进程 ' + (Array.isArray(detected.matched) ? detected.matched.join(', ') : ''))
      return {
        ok: false, mode: 'kill', removed: job.id,
        jobDirRemoved: false, registryRemoved: false, indexRemoved: false,
        ...(detected.pid !== undefined ? { livePid: detected.pid, liveFile: detected.file } : {}),
        error: 'job is still running（' + where + '）—— delete 只删记录、不杀进程：请先 kill，再 delete',
      }
    }
    if (detected.state === 'unknown') {
      // ★★ unknown 门槛（用户裁定，2026-10-08）：**无法判定**有没有活进程 ⇒ **不删任何记录**，只警告 + 要求 force。
      //    删记录有可能删出一个"看不见但还在跑"的孤儿 ⇒ 默认一律拦下（running / done 同口径，不再有例外）。
      const unknownReason = String(detected.error)
      if (!force) {
        warnings.push(unknownWarning(unknownReason))
        return {
          ok: false, mode: 'unknown', removed: job.id,
          jobDirRemoved: false, registryRemoved: false, indexRemoved: false,
          needsForce: true,
          error: unknownError(unknownReason, '未删除任何记录，job 目录/注册表/索引原封不动'),
          warnings,
        }
      }
      forced = true
      warnings.push('无法判定该任务的进程状态：已按显式 force 继续执行 delete（只删记录，不杀任何进程）—— ' + unknownReason)
    }
    if (detected.reason === 'pid-reused') {
      // 如实记 warning（旧实现在 kill 路径里也是这么报的）：该 pid 与本任务无关 ⇒ 不算"有活进程"，不误杀。
      warnings.push('pid reuse guard: PID ' + detected.pid + ' (' + detected.file
        + ') 的命令行不含本任务 jobDir/taskName —— 该 pid 已被系统复用给无关进程；本任务进程不存在（不误杀）')
    }
    closeWatch(job)
    // ① 计划任务注册收尾：/End（running）+ /Delete（幂等：任务已自删时 schtasks 非零属正常，只记不报）。
    //    计划任务**不是任务记录**（记录 = job 目录 / 中央索引 / 注册表），删它只为不留下已死的注册项。
    await endScheduledTask(job, warnings)
    // ② 删 job 目录（孤儿持句柄时如实报——旧实现吞掉它正是"目录删不掉却报成功"的来源）
    // ★ 失败**不再提前 return**：只记进 failures，继续把注册表 / 索引 / 沙箱临时根清完。
    let jobDirRemoved = true
    try {
      await fsp.rm(job.meta.jobDir, { recursive: true, force: true })
    } catch (e) {
      jobDirRemoved = false
      failures.push('remove job dir failed: ' + errorMsg(e))
    }
    // ③ 沙箱临时根（尽力而为：失败记 warning，不阻断清理）
    if (job.meta.sandboxTempPath) {
      try { await fsp.rm(job.meta.sandboxTempPath, { recursive: true, force: true }) }
      catch (e) { warnings.push('remove sandbox temp failed: ' + errorMsg(e)) }
    }
    // ④ 注册表 + 中央索引清理：**无条件执行**（缺口 A 的核心）
    registry.delete(job.id)
    indexRemove(job.id)
    return {
      ok: failures.length === 0,
      mode: 'delete',
      removed: job.id,
      jobDirRemoved,
      registryRemoved: true,
      indexRemoved: true,
      ...(forced ? { forced: true } : {}),
      ...(failures.length > 0 ? { error: failures.join(' | ') } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  }

  // 对「已登记、启用且 prewarm: true」的 server 预连（MCP 总开关开启时才有意义；纯加速，失败即回退冷启动）。
  const warmPrewarmServers = async () => {
    if (prewarm === null) return
    const { servers } = await readMcpServers()
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg && cfg.prewarm === true && cfg.enabled !== false) prewarm.warm(name).catch(() => {})
    }
  }

  // 客户端面板轮询路由
  const disposeRoutes = ctx.inject(['webServer'], (webCtx) => {
    const handler = async (req, res) => {
      const url = new URL(String(req.url || '/'), 'http://localhost')
      const pathname = url.pathname
      const writeJson = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      if (pathname === '/bgjobs/state') {
        // ready=false ⇒ recover+一次性种子尚未跑完，任务列表可能是空/不全的中间态；
        // client 见 ready=false 跳过整段横幅判定（否则空基线会把存量 done 全判成"新完成"）。
        writeJson(200, { ok: true, ready: isReady(), fullAccess: await readFullAccess(), jobs: Array.from(registry.values()).map(view) })
        return
      }
      if (pathname === '/bgjobs/log') {
        // 按需读任务日志（client 展开 done 任务且快照无输出时 lazy fetch）。
        const id = url.searchParams.get('id')
        if (!id) { writeJson(400, { ok: false, error: 'missing id' }); return }
        const text = await readJobLogTail(id, TAIL_CAP)
        if (text === undefined) { writeJson(404, { ok: false, error: 'not found' }); return }
        writeJson(200, { ok: true, text })
        return
      }
      if (pathname === '/bgjobs/fullaccess') {
        // GET → 当前开关；POST ?enabled=1|0 → 切换（用户预批准全权限后台任务）。
        if (req.method === 'POST') {
          const enabled = url.searchParams.get('enabled')
          if (enabled === null) { writeJson(400, { ok: false, error: 'missing enabled' }); return }
          writeJson(200, await setFullAccess(enabled === '1' || enabled === 'true'))
        } else {
          writeJson(200, { ok: true, enabled: await readFullAccess() })
        }
        return
      }
      if (pathname === '/bgjobs/uiprefs') {
        // GET → 当前 UI 偏好（sidebarEntry + display + defaultDisplay）；
        // POST → 设置：JSON body { sidebarEntry?, display? }，或 ?action=resetDisplay（一键恢复默认），
        //        兼容旧形式 ?sidebarEntry=0|1。
        if (req.method === 'POST') {
          if (url.searchParams.get('action') === 'resetDisplay') {
            writeJson(200, await resetDisplay())
            return
          }
          const body = await readJsonBody(req)
          if (body && typeof body === 'object') {
            if (body.action === 'resetDisplay') { writeJson(200, await resetDisplay()); return }
            const patch = {}
            if ('sidebarEntry' in body) patch.sidebarEntry = body.sidebarEntry === true
            if ('display' in body) patch.display = body.display
            if ('elements' in body) patch.elements = body.elements
            if ('waitTimeoutSeconds' in body) patch.waitTimeoutSeconds = body.waitTimeoutSeconds
            if ('bannerSeedVersion' in body) patch.bannerSeedVersion = body.bannerSeedVersion
            writeJson(200, await setUiPrefs(patch))
            return
          }
          const raw = url.searchParams.get('sidebarEntry')
          if (raw === null) { writeJson(400, { ok: false, error: 'missing uiprefs' }); return }
          writeJson(200, await setUiPrefs({ sidebarEntry: raw === '1' || raw === 'true' }))
        } else {
          const prefs = await readUiPrefs()
          writeJson(200, {
            ok: true,
            sidebarEntry: prefs.sidebarEntry,
            display: prefs.display,
            elements: prefs.elements,
            waitTimeoutSeconds: prefs.waitTimeoutSeconds,
            bannerSeedVersion: prefs.bannerSeedVersion,
            defaultDisplay: { ...DEFAULT_DISPLAY },
            defaultElements: { ...DEFAULT_ELEMENTS },
            defaultWaitTimeoutSeconds: DEFAULT_WAIT_TIMEOUT_SECONDS,
          })
        }
        return
      }
      if (pathname === '/bgjobs/toasted') {
        // POST { ids: string[] } → 把「网页横幅已弹过」写回各任务 job.json（幂等：已有标记不再改）。
        // 口径：client **先弹后写**——本路由失败最坏只是下次重复弹一次，绝不漏弹；client 不重试。
        // 开关 bannerMemo=false（无记忆模式）⇒ 直接 no-op（不写盘，刷新即重弹）；ids 非数组 ⇒ 400；
        // 不存在/已标记的 id 忽略并记一行（绝不 500）。
        if (req.method !== 'POST') { writeJson(405, { ok: false, error: 'method not allowed' }); return }
        const prefs = await readUiPrefs()
        if (prefs.elements && prefs.elements.bannerMemo === false) { writeJson(200, { ok: true, skipped: 'memo-off' }); return }
        const body = await readJsonBody(req)
        const ids = body && typeof body === 'object' && Array.isArray(body.ids) ? body.ids : null
        if (ids === null) { writeJson(400, { ok: false, error: 'missing ids' }); return }
        const marked = []
        const ignored = []
        for (const raw of ids) {
          const id = String(raw === undefined || raw === null ? '' : raw).trim()
          if (!id) continue
          if (await markToastedId(id, 'web')) marked.push(id)
          else ignored.push(id)
        }
        if (ignored.length > 0) console.warn('[bgjobs] /bgjobs/toasted: ignored ' + ignored.length + ' id(s): ' + ignored.join(', '))
        writeJson(200, { ok: true, marked, ignored })
        return
      }
      if (pathname === '/bgjobs/gui') {
        // GET → GUI 脚本信息 + 版本（设置页展示路径/版本）；POST ?action=open|reveal（缺省 open）→ 启动。
        if (req.method === 'POST') {
          const action = url.searchParams.get('action') || 'open'
          writeJson(200, action === 'reveal' ? await revealGuiFolder() : await launchGui())
        } else {
          writeJson(200, { ok: true, ...(await guiScriptInfo()), version: await readBgjobsVersion() })
        }
        return
      }
      if (pathname === '/bgjobs/mcpprefs') {
        // GET → MCP 任务总开关（默认关）；POST ?enabled=0|1 → 切换。开关即时生效（工具常驻注册 +
        // 运行时校验）。联动预热：开启 → 对 prewarm 的 server 预连；关闭 → 断开全部常驻连接。
        if (req.method === 'POST') {
          const raw = url.searchParams.get('enabled')
          if (raw === null) { writeJson(400, { ok: false, error: 'missing enabled' }); return }
          const enabled = raw === '1' || raw === 'true'
          const res = await setMcpPrefs({ enabled })
          if (enabled) await warmPrewarmServers()
          else if (prewarm !== null) await prewarm.unwarmAll()
          writeJson(200, res)
        } else {
          writeJson(200, { ok: true, enabled: (await readMcpPrefs()).enabled })
        }
        return
      }
      if (pathname === '/bgjobs/mcpservers') {
        const name = url.searchParams.get('name') || ''
        if (req.method === 'POST') {
          // 删除登记（存在常驻连接一并断开）
          if (url.searchParams.get('delete') === '1') {
            const res = await deleteMcpServer(name)
            if (res.ok && prewarm !== null) await prewarm.unwarm(name)
            writeJson(200, res.ok ? { ok: true, name } : res)
            return
          }
          // 每 server 状态按钮（?enabled=0|1 与/或 ?prewarm=0|1）：预热态才预连，其余（含禁用）断开常驻连接
          const enabledRaw = url.searchParams.get('enabled')
          const prewarmRaw = url.searchParams.get('prewarm')
          if (enabledRaw !== null || prewarmRaw !== null) {
            const patch = {}
            if (enabledRaw !== null) patch.enabled = enabledRaw === '1' || enabledRaw === 'true'
            if (prewarmRaw !== null) patch.prewarm = prewarmRaw === '1' || prewarmRaw === 'true'
            const res = await setMcpServerState(name, patch)
            if (!res.ok) { writeJson(200, res); return }
            const saved = res.servers[name]
            if (prewarm !== null) {
              if (saved.enabled !== false && saved.prewarm === true) prewarm.warm(name).catch(() => {})
              else await prewarm.unwarm(name)
            }
            writeJson(200, { ok: true, name, enabled: saved.enabled !== false, prewarm: saved.prewarm === true })
            return
          }
          // 从粘贴/上传的文本导入（?import=1；body { text, mode:'skip'|'overwrite', force }）：
          // 兼容 DSH patch 片段 / bgjobs 原生 JSON / 单个配置 / 配置数组；含 !!js 默认拒导（force=1 才导）。
          if (url.searchParams.get('import') === '1') {
            const body = await readJsonBody(req)
            const text = body && typeof body.text === 'string' ? body.text : ''
            const mode = (body && body.mode === 'overwrite') || url.searchParams.get('mode') === 'overwrite' ? 'overwrite' : 'skip'
            const force = (body && body.force === true) || url.searchParams.get('force') === '1'
            const parsed = parseServerImport(text)
            if (parsed.error !== undefined) { writeJson(200, { ok: false, source: parsed.source, error: parsed.error }); return }
            const imported = []
            const skipped = []
            const rejected = []
            for (const row of parsed.servers) {
              if (row.needsAttention === true && !force) {
                rejected.push({ name: row.name, reason: row.attentionReason || 'needs manual attention' })
                continue
              }
              const exists = (await readMcpServers()).servers[row.name] !== undefined
              if (exists && mode !== 'overwrite') { skipped.push({ name: row.name, reason: 'already registered' }); continue }
              const res = await setMcpServer(row.name, row.config)
              if (!res.ok) { rejected.push({ name: row.name, reason: res.error }); continue }
              imported.push(row.name)
              const saved = res.servers[row.name]
              if (prewarm !== null && saved && saved.prewarm === true && saved.enabled !== false) prewarm.warm(row.name).catch(() => {})
            }
            writeJson(200, { ok: true, source: parsed.source, hasJsTag: parsed.hasJsTag === true, imported, skipped, rejected })
            return
          }
          // 「列出工具」：用户显式操作 → 不受 MCP 总开关限制（refresh 强制重取）；禁用 server 也允许手动探测
          if (url.searchParams.get('probe') === '1') {
            try {
              const target = await mcp.resolveServer({ server: name }, { allowDisabled: true })
              writeJson(200, await mcp.tools(target, { refresh: true }))
            } catch (e) {
              writeJson(200, { ok: false, error: errorMsg(e) })
            }
            return
          }
          // 新增/覆盖：?config=<urlencoded JSON>，或 JSON body { name, config }
          const rawConfig = url.searchParams.get('config')
          const body = rawConfig === null ? await readJsonBody(req) : null
          let config = null
          let key = name
          if (rawConfig !== null) {
            try { config = JSON.parse(rawConfig) } catch (e) { writeJson(400, { ok: false, error: 'invalid config json' }); return }
          } else if (body && typeof body === 'object' && body.config && typeof body.config === 'object') {
            config = body.config
            if (typeof body.name === 'string' && body.name.trim().length > 0) key = body.name.trim()
          }
          if (config === null) { writeJson(400, { ok: false, error: 'missing config' }); return }
          const res = await setMcpServer(key, config)
          if (!res.ok) { writeJson(200, res); return }
          const saved = res.servers[key]
          if (prewarm !== null) {
            if (saved && saved.prewarm === true && saved.enabled !== false) prewarm.warm(key).catch(() => {})
            else await prewarm.unwarm(key)
          }
          writeJson(200, { ok: true, name: key, server: saved })
          return
        }
        // GET → 登记清单（**不回传 env/headers 的值**，只回传键名，防泄漏）
        // 出口三态：?export=yaml|json（导出）→ ?name=<n>（单条明细，编辑用，**含值**）→ 列表。
        const exportFmt = url.searchParams.get('export')
        if (exportFmt !== null) {
          const { servers } = await readMcpServers()
          const out = serializeServers(servers, { name: url.searchParams.get('name') || '*' })
          writeJson(200, { ok: true, format: exportFmt === 'json' ? 'json' : 'yaml', names: out.names, text: exportFmt === 'json' ? out.json : out.yaml })
          return
        }
        const detailName = url.searchParams.get('name')
        if (detailName !== null && detailName !== '') {
          const { servers } = await readMcpServers()
          const cfg = servers[detailName]
          if (cfg === undefined || cfg === null) { writeJson(200, { ok: false, error: 'server not found: ' + detailName }); return }
          writeJson(200, { ok: true, name: detailName, config: cfg })
          return
        }
        const { servers } = await readMcpServers()
        const cache = await mcp.readCache()
        const warmState = new Map((prewarm === null ? [] : prewarm.status()).map((s) => [s.name, s]))
        const rows = Object.entries(servers).map(([n, cfg]) => {
          const registryTools = mcp.registryTools(n)
          const cached = cache[n]
          const warmRec = warmState.get(n)
          const toolCount = registryTools !== null
            ? registryTools.length
            : (cached && Array.isArray(cached.tools) ? cached.tools.length : null)
          return {
            name: n,
            transport: cfg.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
            target: cfg.transport === 'streamable-http'
              ? String(cfg.url || '')
              : [String(cfg.command || ''), ...(Array.isArray(cfg.args) ? cfg.args : [])].join(' '),
            envKeys: Object.keys(cfg.env || {}),
            headerKeys: Object.keys(cfg.headers || {}),
            timeoutMs: typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : null,
            prewarm: cfg.prewarm === true,
            enabled: cfg.enabled !== false,
            warm: !!(warmRec && warmRec.warm),
            status: warmRec ? warmRec.status : null,
            lastError: warmRec && warmRec.lastError ? warmRec.lastError : null,
            toolCount,
            toolSource: registryTools !== null ? 'registry' : (cached !== undefined ? 'cache' : null),
          }
        })
        writeJson(200, { ok: true, servers: rows })
        return
      }
      if (pathname === '/bgjobs/dsh-mcp') {
        // GET → 活动 profile 判定 + 各 scope 的 DSH MCP 条目（只读，含 !!js/disabled 标注）；
        // POST ?action=import&scope=<active|global|profile:NAME>&name=<serverName|*>&force=0|1
        //      → 一次性导入成 bgjobs server 登记（同名不覆盖；含 !!js 的默认拒导，force=1 才导）。
        if (req.method === 'POST') {
          if (url.searchParams.get('action') !== 'import') { writeJson(400, { ok: false, error: 'unknown action' }); return }
          const scopeRaw = url.searchParams.get('scope') || 'active'
          const scope = scopeRaw.startsWith('profile:') ? scopeRaw.slice('profile:'.length) : scopeRaw
          const want = url.searchParams.get('name') || '*'
          const force = url.searchParams.get('force') === '1'
          const cfg = await readMcpConfigs(scope)
          if (!cfg.exists) {
            writeJson(200, { ok: false, error: cfg.parseError ? ('parse failed: ' + cfg.parseError) : ('no DSH MCP config found for scope ' + scopeRaw) })
            return
          }
          const current = await readMcpServers()
          const imported = []
          const skipped = []
          const rejected = []
          for (const row of cfg.servers || []) {
            if (want !== '*' && row.serverName !== want) continue
            if (current.servers[row.serverName] !== undefined) { skipped.push({ name: row.serverName, reason: 'already registered' }); continue }
            if (row.needsAttention === true && !force) {
              rejected.push({ name: row.serverName, reason: row.attentionReason || 'needs manual attention (re-import with force=1 then fill in env/headers)' })
              continue
            }
            const res = await setMcpServer(row.serverName, row.config)
            if (res.ok) imported.push(row.serverName)
            else rejected.push({ name: row.serverName, reason: res.error })
          }
          writeJson(200, { ok: true, scope: cfg.scope, imported, skipped, rejected })
          return
        }
        const data = await describeDshMcp({ includeOthers: url.searchParams.get('all') === '1' })
        const { servers } = await readMcpServers()
        writeJson(200, { ok: true, existing: Object.keys(servers), ...data })
        return
      }
      if (pathname === '/bgjobs/kill') {
        const id = url.searchParams.get('id')
        if (!id) { writeJson(400, { ok: false, error: 'missing id' }); return }
        // ★ force 只用来越过 `mode:'unknown'` 门槛：?force=1（query，推荐）或 body { force: true }。
        writeJson(200, await killJob(id, { force: await resolveForce(url, req) }))
        return
      }
      if (pathname === '/bgjobs/delete') {
        const id = url.searchParams.get('id')
        if (!id) { writeJson(400, { ok: false, error: 'missing id' }); return }
        writeJson(200, await removeJob(id, { force: await resolveForce(url, req) }))
        return
      }
      if (pathname === '/bgjobs/cleanup') {
        writeJson(200, await cleanupDone())
        return
      }
      res.writeHead(404)
      res.end()
    }
    return webCtx.webServer.register({ kind: 'prefix', path: '/bgjobs', handler })
  })

  return {
    api: { killJob, removeJob, cleanupDone },
    dispose: [disposeRoutes],
  }
}
