// bgjobs —— 模型可见的后台任务使用指引（v0.1.61 结构重构自 lib/index.js 拆分）。
// 镜像 dsh-ai4scholar 的 buildGuidance：纯文本构建，注明工具族、何时用、注意事项。

/**
 * 模型可见的后台任务使用指引（system prompt guidance）。
 * 镜像 dsh-ai4scholar 的 buildGuidance：纯文本构建，注明工具族、何时用、注意事项。
 */
export function buildBgjobsGuidance() {
  return [
    '可用的后台任务工具：',
    '- bgjob_submit: 把命令提交为独立于 DSH 进程的后台任务（Windows 任务计划程序托管，关 DSH 亦不影响）。适用于长任务：下载/同步/编译/仿真/批量脚本等。command 为 bat 语法（多行逐行执行；for 循环变量写 %%i）；命令含 exit/goto 会提前终止 bat 导致 exitcode 不写入；workdir 必须是工作区内绝对路径。',
    '- bgjob_submit_pwsh: 与 bgjob_submit 同机制（schtasks 托管、面板/Toast），但 command 为 PowerShell 语法（PowerShell 执行，pwsh 7 优先），输出日志 UTF-8（无 cmd GBK/UTF-8 乱码问题）；exit <code> 语义安全。中文输出/管道/需安全退出码的命令优先用此工具。',
    '- 沙箱：bgjob_submit_pwsh 支持可选 sandbox 参数（read-only/workspace-write/off；缺省继承当前受限会话模式，会话全权限则为 off=全权限）。后台任务权限不会高于会话访问模式：受限会话里请求全权限（off）或更宽模式时，若 bgjobs 面板的 full access 开关关闭，会弹窗请用户批准（请附 justification 说明理由）；开关打开则视为用户预批准。沙箱复用 dsh 沙箱、只约束文件效果（写工作目录/临时区外会被拒绝），网络不受限。bat 引擎（bgjob_submit）任务恒为全权限、无法沙箱化：受限会话下仅当 full access 开关开启才可用，否则提交被拒——受限任务请用 bgjob_submit_pwsh。未挂载 dsh 沙箱服务（sandbox-policy）的部署无法确认会话模式：bgjob 默认被拒，需在面板打开 full access 开关（或部署沙箱服务）才能提交。',
    '- bgjob_status: 查询后台任务状态（running/done）、退出码、日志尾部。',
    '- bgjob_wait: 等待后台任务结果（默认最多 120 秒，可传 timeoutSeconds，范围 1–600），结束后立即返回退出码与日志尾部。三种用法：① jobId 单个任务；② jobIds 数组任一先结束即返回（any 竞速，result+pending）；③ 全缺省=等「notify 视图」任一结束——即本会话中结果尚未交付（notify 完成通知未投递成功、也未被 wait 返回）的任务。wait 返回某任务结果即视为把结果交付给本会话（返回 notified:true，notify 视图剔除该任务，避免重复等同一结果）。等待会被两件事自动让路并立即返回 stopped:true：用户在等待中点停止/打断（stoppedBy 为 signal）、或其它 agent 给你发来消息（send_message / 用户 steer 等，stoppedBy 为 message）——返回时不置已交付、任务继续后台跑，请先处理打断它的消息，之后可再次 bgjob_wait 续等，不要重复提交任务。',
    '- bgjob_wait_all: 传 jobIds 数组（或全缺省=notify 视图）等全部结束，返回 results（每任务退出码/日志尾/notified）+ allDone；返回即置已交付；超时 timedOut:true 可续等。一次并行提交多个任务后，用 wait_all 收口比逐个 bgjob_wait 更省。',
    '- bgjob_list: 列出当前会话全部任务（含 notified 状态）；bgjob_pending_list: 列出当前会话「尚未交付」的任务（notify 视图），wait 缺省与它同源——并行提交后先 pending_list 看还有谁没交付，再 wait。',
    '- 可选 wait：bgjob_submit / bgjob_submit_pwsh 传 `wait: <秒>`（1–600）会在提交成功后原地等待——语义同 bgjob_wait「全缺省」：有 notify 视图任务时等任一先交付（any），会话不可识别/视图为空时回退为等刚提交的这一个；超时返回 timedOut 快照，可再调 bgjob_wait 续等。',
    '- 完成通知与交付标记：任务结束默认只弹网页 Toast。需要会话内通知时传 notify（on-completion / on-fail / on-exit）——投递成功后该任务即标记「已通知」（notified=true，notify 视图剔除）；若任务结束但通知投递失败（如 agents 不可用），保持待通知，后续 bgjob_wait 返回也会把它置为已通知。notify_mode 控制送达：wakeup（缺省，空闲唤醒一轮）／quiet（仅收件箱）／always。通知不含日志全文，详情用 bgjob_status 查。',
    '长任务交给 bgjob_submit / bgjob_submit_pwsh 而不是前台执行；任务完成时网页顶部弹出 Toast 提示（不注入会话消息）。',
  ].join('\n')
}
