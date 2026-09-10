// bgjobs core —— 网页面板路由域（v0.1.61 结构重构；自 lib/index.js apply 拆分）。
// /bgjobs/state|log|fullaccess|delete|cleanup 前缀路由 + 删除/一键清理行为。

import { promises as fsp } from 'node:fs'
import { TAIL_CAP } from '../util.js'
import { SCHTASKS, runSchtasks } from '../runners.js'
import { guiScriptInfo, launchGui, revealGuiFolder } from '../gui-launch.js'
import { readBgjobsVersion } from '../meta.js'

export function createWeb(ctx, store, deps) {
  const { registry, readFullAccess, setFullAccess, readUiPrefs, setUiPrefs, resetDisplay, DEFAULT_DISPLAY, DEFAULT_ELEMENTS } = store
  const { closeWatch } = deps.watch
  const { indexRemove, view, readJobLogTail } = deps.registry

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
  // 随后删除 job 目录、从 registry 与中央索引移除。
  const removeJob = async (jobId) => {
    const job = registry.get(String(jobId))
    if (job === undefined) return { ok: false, error: 'job not found: ' + jobId }
    closeWatch(job)
    if (job.status === 'running') {
      await runSchtasks([SCHTASKS, '/End', '/TN', job.meta.taskName], job.meta.workdir).catch(() => {})
    }
    await runSchtasks([SCHTASKS, '/Delete', '/TN', job.meta.taskName, '/F'], job.meta.workdir).catch(() => {})
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
