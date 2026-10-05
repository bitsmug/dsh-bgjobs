// bgjobs client — 完成横幅（toast）去重判定（v0.1.88）
// 纯函数、零依赖（可被 node:test 直接 require，不会拉起 React）。判定口径见 docs/developer.md
// 「完成横幅的幂等」：host 落盘的 job.json toastedAt/toastedBy + 本轮内存基线双保险。
//
// shouldToast(job, prevSeen, opts) → { toast, memo }
//   job      : /bgjobs/state 的一条任务快照（读 status 与 toasted）
//   prevSeen : 上一轮已见到的 done id 集合；null/undefined = 本次挂载的首轮（只记基线不弹）
//   opts     : { enabled, memo }（缺省均 true；与设置页两个开关同名同义）
//   → toast = 是否弹这条；memo = 是否把「已弹过」写回 host（POST /bgjobs/toasted）
// 优先级：enabled > memo > toasted > 首轮 > 基线。
const shouldToast = (job, prevSeen, opts) => {
  const o = opts && typeof opts === 'object' ? opts : {}
  if (o.enabled === false) return { toast: false, memo: false }   // 总开关关：完全不检测、不弹
  if (!job || job.status !== 'done') return { toast: false, memo: false }
  const seen = prevSeen && typeof prevSeen.has === 'function' ? prevSeen : null
  if (o.memo === false) {
    // 去重关（无记忆模式）：忽略 toasted 标记与"首轮豁免" ⇒ 每次挂载/刷新都对 done 重弹
    // （= 修之前的观感）；同一轮仍靠内存基线防刷屏（每秒轮询不会重复弹同一条）；永不写回。
    if (seen !== null && seen.has(job.id)) return { toast: false, memo: false }
    return { toast: true, memo: false }
  }
  if (job.toasted === true) return { toast: false, memo: false }  // 已弹过（host 落盘标记）
  if (seen === null) return { toast: false, memo: false }         // 首轮：只记基线，不弹
  if (seen.has(job.id)) return { toast: false, memo: false }      // 本轮已见过
  return { toast: true, memo: true }                              // 新完成 ⇒ 弹 + 写回
}
if (typeof module !== 'undefined' && module.exports) module.exports = { shouldToast }
