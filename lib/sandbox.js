// bgjobs —— 沙箱模式判定（v0.1.61 结构重构自 lib/index.js 拆分）。
// bgjob sandbox 词表：read-only < workspace-write < off(全权限)。任务权限不得高于
// 会话访问模式（会话受限时）；更宽的请求经 ctx.approval 弹窗审批或 full access 开关预批准。
// 会话三态：none = 未挂载 sandboxPolicy 服务（无法确认会话模式 → full access 关则拒绝）；
// full = 服务在但会话全权限（danger-full-access）；read-only/workspace-write = 会话受限。

const BGJOB_SANDBOX_MODES = ['read-only', 'workspace-write', 'off']
const BGJOB_SESSION_STATES = ['none', 'full', 'read-only', 'workspace-write']
const SANDBOX_PERM = { 'read-only': 0, 'workspace-write': 1, off: 2 }

/**
 * 计算任务最终 sandbox 模式 + 是否需升权审批（纯函数；apply 里做 ctx 胶水）。
 * @param state - 会话态：'none' = 未挂载 sandboxPolicy 服务；'full' = 服务在但会话
 *   全权限（danger-full-access）；'read-only'/'workspace-write' = 会话受限。
 * @param requested - 显式请求模式（read-only|workspace-write|off）或 undefined（缺省）。
 * @param engine - 'pwsh' 支持受限与 off；'bat' 不支持沙箱（恒全权限）→ 受限会话仅
 *   full access 模式支持（开关关直接拒绝，不走逐次审批）。
 * @param fullAccess - full access 开关（用户预批准全权限后台任务，宽请求不弹窗）。
 * @returns { mode, escalate }：mode = 最终落盘模式；escalate = true 时须先经 ctx.approval
 *   审批，拒绝/取消则不提交。
 * @throws state='none' 且 full access 关（无法确认会话访问模式，fail closed）；
 *   bat 引擎 + 受限会话 + full access 关（恒全权限无法满足"不高于会话模式"）；参数非法。
 */
export function jobSandboxDecision(state, requested, engine, fullAccess) {
  if (!BGJOB_SESSION_STATES.includes(state)) {
    throw new Error('unexpected session state: ' + state)
  }
  if (engine !== 'pwsh' && engine !== 'bat') {
    throw new Error('unexpected engine: ' + engine)
  }
  let mode
  if (engine === 'pwsh') {
    if (requested !== undefined && !BGJOB_SANDBOX_MODES.includes(requested)) {
      throw new Error('invalid sandbox "' + requested + '" (expected read-only | workspace-write | off)')
    }
    if (requested !== undefined) mode = requested
    else mode = state === 'read-only' || state === 'workspace-write' ? state : 'off'
  } else {
    if (requested !== undefined) throw new Error('sandbox is only supported on bgjob_submit_pwsh; use it for sandboxed jobs')
    mode = 'off'
  }
  if (state === 'none') {
    if (!fullAccess) {
      throw new Error(
        'bgjob submit refused: no dsh sandbox policy service is composed, so the session access mode cannot be verified; '
        + 'turn on the "full access" switch in the bgjobs panel to run unrestricted background jobs, '
        + 'or compose the dsh sandbox services (sandbox-policy + a local executor) for restricted jobs',
      )
    }
    return { mode, escalate: false }
  }
  if (state === 'full') return { mode, escalate: false }
  if (engine === 'bat') {
    // bat 引擎任务无法沙箱化、恒为全权限：受限会话里"逐次审批"没有意义（每次都会超限），
    // 唯一出口是 full access 开关（用户全局预批准全权限 = 原模式）。
    if (!fullAccess) {
      throw new Error(
        'bgjob_submit (bat engine) cannot be sandboxed and always runs with full permissions; '
        + 'in a restricted session it is only supported when the "full access" switch in the bgjobs panel is on, '
        + 'or use bgjob_submit_pwsh with an explicit sandbox mode',
      )
    }
    return { mode, escalate: false }
  }
  const escalate = SANDBOX_PERM[mode] > SANDBOX_PERM[state] && !fullAccess
  return { mode, escalate }
}
