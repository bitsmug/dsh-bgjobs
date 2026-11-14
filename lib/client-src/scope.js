// bgjobs client — 面板作用域（当前会话 / 当前工作区 / 全）纯函数（spec-session-scope.md）。
// 不 require react：面板与 node --test 都可直接加载（同 banner.js / open-settings.js）。
//
// 判据来源（DSH 0.2.x）：SessionListState 只有 ids/byId/phase/projectionsBySession，**没有**
// current；活动会话 = byId 里 retainedBy.mainView > 0 的那一条（DSH 自己的 ui-workspace /
// ui-cordis 同口径）。旧实现的 st.current 恒 undefined，导致「仅当前会话」永远不生效（issue #2）。

const SCOPE_MODES = ['session', 'workspace', 'all']
const DEFAULT_SCOPE = 'session'
const normalizeScope = (v) => (SCOPE_MODES.includes(v) ? v : DEFAULT_SCOPE)

// 归一化工作区路径用于比较：斜杠统一为 \、去尾部斜杠、小写（容忍大小写/尾斜杠差异）。
const normalizePath = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

// 主区域占用的那条会话（取不到 → undefined），全程 try/catch：sessions 服务可能不存在。
// 判据按宿主版本两段式：
//   1) 0.2.x（含 0.2.2-rc.1~rc.3）：byId 里 retainedBy.mainView > 0 —— DSH 自己的客户端同口径；
//   2) 0.1.x：列表显式维护 current（0.2.x 已移除该字段，取不到即跳过）。
// 顺序保证 0.2.x 永远走 1)，不会重蹈"只读 current 导致恒 undefined"的旧 bug。
const activeSessionSummary = (sessions) => {
  if (!sessions || !sessions.list) return undefined
  try {
    const st = sessions.list.getSnapshot()
    const byId = st && st.byId
    if (!byId || typeof byId !== 'object') return undefined
    const retained = Object.values(byId).find((s) => s && s.retainedBy && (s.retainedBy.mainView || 0) > 0)
    if (retained) return retained
    const cur = st.current
    if ((typeof cur === 'string' || typeof cur === 'number') && byId[cur]) return byId[cur]
    return undefined
  } catch (e) { return undefined }
}

const idOf = (s) => (s && s.id !== undefined && s.id !== null && s.id !== '' ? String(s.id) : undefined)

const readActiveSessionId = (sessions) => idOf(activeSessionSummary(sessions))

const readActiveCwd = (sessions) => {
  const s = activeSessionSummary(sessions)
  return s && s.cwd ? String(s.cwd) : undefined
}

// 回显用：displayTitle（宿主给的「标题 > 项目名 > 会话 id」）优先，退化到 id 前 8 位。
const readActiveLabel = (sessions) => {
  const s = activeSessionSummary(sessions)
  if (!s) return undefined
  if (s.displayTitle) return String(s.displayTitle)
  const id = idOf(s)
  return id ? id.slice(0, 8) : undefined
}

const readActiveScopeTarget = (sessions) => ({
  id: readActiveSessionId(sessions),
  cwd: readActiveCwd(sessions),
  label: readActiveLabel(sessions),
})

// 控件隐藏 ⇒ 不过滤（沿用「不让用户看不到开关却被静默过滤」的原则）。
const effectiveScope = ({ scope, onlySessionVisible }) => (onlySessionVisible === false ? 'all' : normalizeScope(scope))

// 可见集唯一出口：返回 { jobs, effectiveMode }（effectiveMode 含降级后的实际口径，用于回显）。
const selectVisibleJobs = (p) => {
  const src = p && typeof p === 'object' ? p : {}
  const jobs = Array.isArray(src.jobs) ? src.jobs : []
  const activeId = src.activeSessionId === undefined || src.activeSessionId === null ? '' : String(src.activeSessionId)
  const activeNorm = src.activeCwd ? normalizePath(src.activeCwd) : ''
  let mode = effectiveScope(src)
  // 降级：session 取不到会话 id ⇒ 退回 workspace；workspace 取不到路径 ⇒ 不过滤。
  if (mode === 'session' && activeId === '') mode = activeNorm ? 'workspace' : 'all'
  if (mode === 'workspace' && activeNorm === '') mode = 'all'
  if (mode === 'all') return { jobs, effectiveMode: 'all' }
  if (mode === 'session') {
    // 老记录没有 createdBySession ⇒ 视为「未知来源」保留，避免升级后任务凭空消失。
    return {
      jobs: jobs.filter((j) => {
        const s = j && j.createdBySession
        return !s || String(s) === activeId
      }),
      effectiveMode: 'session',
    }
  }
  return {
    jobs: jobs.filter((j) => {
      const w = normalizePath(j && j.workdir)
      return w === activeNorm || (activeNorm !== '' && w.startsWith(activeNorm + '\\'))
    }),
    effectiveMode: 'workspace',
  }
}

module.exports = {
  SCOPE_MODES,
  DEFAULT_SCOPE,
  normalizeScope,
  normalizePath,
  readActiveSessionId,
  readActiveCwd,
  readActiveLabel,
  readActiveScopeTarget,
  effectiveScope,
  selectVisibleJobs,
}
