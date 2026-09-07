// bgjobs core —— 通知域（v0.1.61 结构重构；自 lib/index.js apply 拆分）。
// 完成通知创建者：可选 notify 参数（v0.1.31）。只对创建者会话当前仍 live 的 agent 送达，
// 拿不到（无 agents 服务/会话已关/跨作用域）静默跳过，client toast 仍兜底。
// 本域仅依赖 ctx（agents/on 事件），不依赖其它域。

import { randomUUID } from 'node:crypto'
import { BGJOB_NOTIFY_DELIVERIES } from '../notify-policy.js'

export function createNotify(ctx) {
  // ── 可选：任务结束后通知创建者（v0.1.31，opt-in notify 参数）────────────
  // v0.1.8 因污染会话流把 host 完成通知整体移除（改 client 半 toast）；本块按任务
  // 显式 notify 配置恢复「会话内通知」：只对创建者会话当前仍 live 的 agent 送达，
  // 拿不到（无 agents 服务/会话已关/跨作用域）静默跳过，client toast 仍兜底。
  const BGJOB_WAKE_BUDGET = 2 // 同 agent 连续被 bgjob 完成通知唤醒的上限（防自激链）
  const wakeSpent = new Map() // sessionId → 连续唤醒次数；用户领走消息后重置
  // 用户主动领走收件箱消息（source.kind === 'user'）→ 模型回到跟用户交互，重置唤醒预算。
  const disposeWokeReset = ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    try {
      if (agent && agent.id !== undefined && message && message.source && message.source.kind === 'user') {
        wakeSpent.delete(String(agent.id))
      }
    } catch (e) { /* 事件形状异常不影响主流程 */ }
  })
  /** 通知文案（一行，不含日志全文——详情引导 bgjob_status）。 */
  const noticeText = (job, exitCode) => {
    const label = exitCode === 0 ? '已完成' : '已结束（exit code ' + exitCode + '）'
    return '后台任务「' + job.meta.name + '」' + label
  }
  /** 构造发给创建者 agent 的消息（对齐 UserMessage：id/role/content/source）。 */
  const buildNoticeMessage = (job, exitCode) => ({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: noticeText(job, exitCode) }],
    source: { kind: 'plugin', plugin: 'bgjobs' },
  })
  /** 按 notify_mode 把完成通知送达创建者会话。返回是否投递成功（尽力而为，不抛错破坏主流程）。 */
  const deliverCompletionNotice = (job) => {
    const sessionId = String(job.meta.createdBySession || '')
    if (!sessionId) return false
    const agents = ctx.get('agents')
    if (!agents) return false
    let agent
    try { agent = agents.get(sessionId) } catch (e) { return false }
    if (!agent) return false
    const message = buildNoticeMessage(job, job.exitCode)
    const mode = BGJOB_NOTIFY_DELIVERIES.includes(job.meta.notifyMode) ? job.meta.notifyMode : 'wakeup'
    const deliver = (fn) => { try { fn(message); return true } catch (e) { return false } }
    if (mode === 'quiet') return deliver((m) => agent.inject(m))
    let idle = false
    try { idle = agent.status === 'idle' } catch (e) { idle = false }
    if (!idle) return deliver((m) => agent.inject(m))
    // 空闲：wakeup（预算内）与 always 都 followup 唤醒一轮；超预算走 inject。
    if (mode === 'wakeup' && (wakeSpent.get(sessionId) || 0) >= BGJOB_WAKE_BUDGET) return deliver((m) => agent.inject(m))
    if (mode === 'wakeup') wakeSpent.set(sessionId, (wakeSpent.get(sessionId) || 0) + 1)
    return deliver((m) => agent.followup(m))
  }

  return {
    api: { deliverCompletionNotice },
    dispose: [disposeWokeReset],
  }
}
