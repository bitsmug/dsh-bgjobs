// bgjobs —— 模型可见的后台任务使用指引（v0.1.61 结构重构自 lib/index.js 拆分）。
// 镜像 dsh-ai4scholar 的 buildGuidance：纯文本构建，注明工具族、何时用、注意事项。
// v0.1.82：改分节结构；把「不要用系统 sleep」提为第一优先级；让路（stoppedBy:'message'）写成机制陈述
// （本次调用已声明终结当前回合并交还 DSH，消息会自动投递）；bgjob_wait_all 改为合取语义 + 失败短路。

/**
 * 模型可见的后台任务使用指引（system prompt guidance）。
 * 镜像 dsh-ai4scholar 的 buildGuidance：纯文本构建，注明工具族、何时用、注意事项。
 */
export function buildBgjobsGuidance() {
  return [
    '后台任务指引（bgjobs）：长任务一律提交为后台任务，绝不在前台阻塞等待。',

    '【核心原则（最重要）】',
    '- 等结果只用 bgjob_wait / bgjob_wait_all（或 bgjob_submit* 的 wait 参数）；bgjob_status / bgjob_list 只用来"看一眼当前状态"，不要拿它们循环轮询。',
    '- 不要用系统 sleep 等任务：pwsh 的 sleep / Start-Sleep、cmd 的 timeout、bash 的 sleep，以及"前台跑一条长命令顺便等"都属阻塞——占住回合、收不到新消息、可能被超时打断，还浪费上下文。',
    '- 并行提交多个任务后，默认用 bgjob_wait：任一个先结束就返回（jobIds any 竞速；缺省 = 本会话 notify 视图任一先交付）——拿到一个就先看一个、先推进下一步，不要为了"等齐"而空等。',
    '- 只有确实要「全部成功才能继续」（如全部产物到位才打包），或「一个失败就马上停」时才用 bgjob_wait_all——它是合取：全部成功才 allDone，任一失败（含被清理/找不到）即刻返回 failed；只为"等齐"而用它会让最早完成的任务白等。',
    '- 让路是自动的：bgjob_wait / bgjob_wait_all 一旦返回 stopped:true、stoppedBy 为 message，本次调用已声明终结当前回合，DSH 会自己把消息投递给你，不需要你去"抢"回来——见【等待与打断】。',

    '【提交】',
    '- workdir 必须是 DSH 工作区内的绝对路径；任务文件在 <workdir>/.dsh/bgjobs/<id>/（stdout.log 输出、exitcode.txt 退出码），完成时网页顶部弹 Toast（不注入会话消息）。',
    '- bgjob_submit：bat 语法（多行逐行执行；for 循环变量写 %%i）；命令含 exit/goto 会提前终止 bat 导致 exitcode 不写入；bat 引擎恒为全权限、不可沙箱化。',
    '- bgjob_submit_pwsh：PowerShell 语法（pwsh 7 优先、5.1 兜底）；输出日志 UTF-8（无 cmd GBK/UTF-8 乱码问题）、exit <code> 语义安全；中文输出/管道/需安全退出码的命令优先用它。',
    '- bgjob_submit_mcp：把一次 MCP 工具调用提交为后台任务（需先在设置页开启「MCP 任务」开关）；server 与 server_config 二选一；退出码 0 成功 / 1 工具报错 / 2 连接或调用失败 / 3 超时。',
    '- bgjob_mcp_tools：列出某 MCP server 的注册工具（工具名/描述/必填字段）——提交 bgjob_submit_mcp 前先用它确认工具名与参数形状。',
    '- 沙箱（仅 bgjob_submit_pwsh）：可选 read-only / workspace-write / off；缺省继承当前会话模式，会话全权限则为 off。后台任务权限不高于会话访问模式：受限会话里请求更宽模式会弹窗请用户批准（请附 justification），面板 full access 开关打开则视为用户预批准。沙箱复用 dsh 沙箱、只约束文件效果（写工作目录/临时区外会被拒），网络不受限。未挂载 dsh 沙箱服务（sandbox-policy）的部署无法确认会话模式 → bgjob 默认被拒，需打开 full access 开关（或部署沙箱服务）。bat 引擎任务恒全权限、无法沙箱化：受限会话下仅当 full access 开关开启才可提交，否则请改用 bgjob_submit_pwsh。',

    '【等待与打断】',
    '- bgjob_wait：三种用法——① 单个 jobId；② jobIds 数组任一先结束即返回（any 竞速，返回 result + 其余 pending）；③ 两者都缺省 = 等本会话「notify 视图」任一先交付。默认最多 120 秒，timeoutSeconds 范围 1–600。返回某任务结果即视为把该结果交付给本会话（notified:true，notify 视图剔除，避免重复等同一结果）。并行提交多个任务时这也是默认姿势：先拿到的先处理，用返回的 pending / bgjob_pending_list 继续等剩下的。',
    '- bgjob_wait_all：jobIds（缺省 = notify 视图）全部成功才返回 allDone:true；任一任务失败即立刻返回——非 0 退出码、或被清理/找不到（无法确认成功）都算失败，此时返回 failed:true + failedJobId + 已结束者的 results + 其余 pending，不再空等。所以它只用于「必须全部成功才能继续」或「一个失败就马上停」；只为"等齐"而用它会让最早完成的任务白等，那种场景用 bgjob_wait 的 any 竞速。',
    '- submit 的 wait 参数（1–600 秒）：提交成功后原地等待，语义同 bgjob_wait 全缺省；超时返回 timedOut 快照。',
    '- 超时（timedOut:true）→ 任务还在跑，可再次调用续等。',
    '- 用户点停止/打断 → 本次等待"以错误结束"（错误文案含各任务当前状态与续等指引）；这是 DSH 的取消语义，不是任务失败：任务继续后台跑、未标记已交付，需要结果时再 bgjob_wait 续等。',
    '- 收到新入站消息而让路（stopped:true、stoppedBy 为 message）→ 有人/别的 agent 在找你。此时：',
    '  · 该返回不含消息正文，不要试图从返回里找正文；',
    '  · 消息由 DSH 在投递边界作为正式用户消息交给你——本次调用已替你声明终结当前回合，所以它会自动出现：排队在下一步的最迟你的下一次生成就能看到，排队为新提示的则由新回合投递；',
    '  · 因此不要再用等待动作（bgjob_wait / bgjob_wait_all）或耗时/阻塞操作（sleep、长前台命令、批量重活）去顶替它——那只会把回合又占住、让消息递不进来；',
    '  · 任务照旧在后台跑、不置已交付、结果不会丢；先读并回应这条消息，之后需要结果再 bgjob_wait 续等，不要重复提交任务。',

    '【通知与交付】',
    '- notify（on-completion / on-fail / on-exit）+ notify_mode（wakeup 缺省 / quiet / always）：需要 agent 主动得知并收尾时传 notify；投递成功后该任务标记为已通知（notified=true，notify 视图剔除）。',
    '- 交付标记与 notify 视图：完成通知投递成功、或被 bgjob_wait / bgjob_wait_all 返回过，即视为已交付；bgjob_pending_list 列出本会话尚未交付的任务（notify 视图），bgjob_list 列出全部（含 notified 状态）；缺省等待只从这个视图等，已交付的不会重复返回。',
    '- 通知不含日志全文，详情用 bgjob_status 查。',

    '【其它】',
    '- 长任务交给 bgjob_submit / bgjob_submit_pwsh / bgjob_submit_mcp，不要在前台执行。',
  ].join('\n')
}
