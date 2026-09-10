// bgjobs core —— 网页面板路由域（v0.1.61 结构重构；自 lib/index.js apply 拆分）。
// /bgjobs/state|log|fullaccess|uiprefs|gui|mcpprefs|mcpservers|dsh-mcp|delete|cleanup 前缀路由。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { TAIL_CAP, errorMsg } from '../util.js'
import { SCHTASKS, runSchtasks } from '../runners.js'
import { guiScriptInfo, launchGui, revealGuiFolder } from '../gui-launch.js'
import { readBgjobsVersion } from '../meta.js'
import { readMcpConfigs, describeDshMcp, serializeServers, parseServerImport } from '../dsh-profiles.js'

export function createWeb(ctx, store, deps) {
  const {
    registry, readFullAccess, setFullAccess, readUiPrefs, setUiPrefs, resetDisplay, DEFAULT_DISPLAY, DEFAULT_ELEMENTS,
    readMcpPrefs, setMcpPrefs, readMcpServers, setMcpServer, deleteMcpServer, setMcpServerPrewarm,
  } = store
  const { closeWatch } = deps.watch
  const { indexRemove, view, readJobLogTail } = deps.registry
  // MCP：工具列表域（§5b 单一口径）+ 预热域（§7）。
  const mcp = deps.mcp
  const prewarm = deps.prewarm || null

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

  // 删除一个任务（网页端"删除/拖拽到垃圾篓"与"一键清理"共用）：
  // running 先 schtasks /End 再 /Delete；done 只 /Delete（bat 可能已自删，幂等）；
  // mcp 任务再按 jobDir\mcp-server.pid 结束残留的 stdio server 子进程（尽力，失败忽略）；
  // 随后删除 job 目录、从 registry 与中央索引移除。
  const removeJob = async (jobId) => {
    const job = registry.get(String(jobId))
    if (job === undefined) return { ok: false, error: 'job not found: ' + jobId }
    closeWatch(job)
    if (job.status === 'running') {
      await runSchtasks([SCHTASKS, '/End', '/TN', job.meta.taskName], job.meta.workdir).catch(() => {})
    }
    await runSchtasks([SCHTASKS, '/Delete', '/TN', job.meta.taskName, '/F'], job.meta.workdir).catch(() => {})
    // mcp 任务的 stdio server 由 runner 冷启动（不在 schtasks 树里）：按落盘 pid 结束，
    // 避免删除任务目录后 server 进程残留（已知限制：任务被强杀时可能来不及写 pid）。
    if (job.meta.engine === 'mcp') {
      try {
        const jobDir = job.meta.jobDir || path.dirname(job.meta.jsonPath)
        const pid = parseInt(await fsp.readFile(path.join(jobDir, 'mcp-server.pid'), 'utf8'), 10)
        if (Number.isInteger(pid) && pid > 0) {
          await runSchtasks(['taskkill.exe', '/PID', String(pid), '/T', '/F'], job.meta.workdir).catch(() => {})
        }
      } catch (e) { /* 无 pid 文件（预热通道未 spawn / 尚未写盘） */ }
    }
    await fsp.rm(job.meta.jobDir, { recursive: true, force: true }).catch(() => {})
    if (job.meta.sandboxTempPath) await fsp.rm(job.meta.sandboxTempPath, { recursive: true, force: true }).catch(() => {})
    registry.delete(job.id)
    indexRemove(job.id)
    return { ok: true, removed: job.id }
  }

  // 一键清理：删除所有已完成（done）任务，包括异常退出（exitCode !== 0）。
  const cleanupDone = async () => {
    const removed = []
    for (const job of Array.from(registry.values())) {
      if (job.status !== 'done') continue
      const r = await removeJob(job.id)
      if (r.ok) removed.push(job.id)
    }
    return { ok: true, removed }
  }

  // 对「已登记且 prewarm: true」的 server 预连（MCP 总开关开启时才有意义；纯加速，失败即回退冷启动）。
  const warmPrewarmServers = async () => {
    if (prewarm === null) return
    const { servers } = await readMcpServers()
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg && cfg.prewarm === true) prewarm.warm(name).catch(() => {})
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
        writeJson(200, { ok: true, fullAccess: await readFullAccess(), jobs: Array.from(registry.values()).map(view) })
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
            defaultDisplay: { ...DEFAULT_DISPLAY },
            defaultElements: { ...DEFAULT_ELEMENTS },
          })
        }
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
          // 每 server 预热开关（开启即预连、关闭即断开）
          const prewarmRaw = url.searchParams.get('prewarm')
          if (prewarmRaw !== null) {
            const on = prewarmRaw === '1' || prewarmRaw === 'true'
            const res = await setMcpServerPrewarm(name, on)
            if (res.ok && prewarm !== null) {
              if (on) prewarm.warm(name).catch(() => {})
              else await prewarm.unwarm(name)
            }
            writeJson(200, res.ok ? { ok: true, name, prewarm: on } : res)
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
              if (prewarm !== null && saved && saved.prewarm === true) prewarm.warm(row.name).catch(() => {})
            }
            writeJson(200, { ok: true, source: parsed.source, hasJsTag: parsed.hasJsTag === true, imported, skipped, rejected })
            return
          }
          // 「列出工具」：用户显式操作 → 不受 MCP 总开关限制（refresh 强制重取）
          if (url.searchParams.get('probe') === '1') {
            try {
              const target = await mcp.resolveServer({ server: name })
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
            if (saved && saved.prewarm === true) prewarm.warm(key).catch(() => {})
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
      if (pathname === '/bgjobs/delete') {
        const id = url.searchParams.get('id')
        if (!id) { writeJson(400, { ok: false, error: 'missing id' }); return }
        writeJson(200, await removeJob(id))
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
    api: { removeJob, cleanupDone },
    dispose: [disposeRoutes],
  }
}
