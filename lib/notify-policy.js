// bgjobs —— notify 触发判定（v0.1.61 结构重构自 lib/index.js 拆分）。
// notify 触发条件：off 不通知；on-completion 仅 exit 0；on-fail 仅非零退出；on-exit 任何退出。
// notify_mode 交付方式：wakeup（空闲唤醒+预算）/quiet（仅入收件箱）/always（空闲恒唤醒）。

const BGJOB_NOTIFY_MODES = ['off', 'on-completion', 'on-fail', 'on-exit']
const BGJOB_NOTIFY_DELIVERIES = ['wakeup', 'quiet', 'always']

export { BGJOB_NOTIFY_MODES, BGJOB_NOTIFY_DELIVERIES }

/**
 * 任务结束后是否通知创建者（纯函数）。只在状态迁移 done、exitCode 已知后调用。
 * @param notify - notify 配置（off/on-completion/on-fail/on-exit）；undefined 视为 off。
 * @param exitCode - 任务退出码（done 后必为 number；null/undefined 视为尚未结束）。
 * @returns true = 需要通知创建者会话。
 */
export function shouldNotifyForExit(notify, exitCode) {
  if (notify === 'on-completion') return exitCode === 0
  if (notify === 'on-fail') return exitCode !== 0
  if (notify === 'on-exit') return exitCode !== undefined && exitCode !== null
  return false
}
