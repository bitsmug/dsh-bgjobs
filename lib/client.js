window.__ModuleLoader__.load({ id: 'bgjobs', factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// lib/client-src/i18n.js
var require_i18n = __commonJS({
  "lib/client-src/i18n.js"(exports2, module2) {
    var NS = "bgjobs";
    var ZH = {
      "panel.title": "后台任务监控",
      "ball.title": "bgjobs 后台任务（{total} 个，运行中 {running} 个）——点击展开",
      "drag.move": "拖拽移动面板",
      "state.running": "● 运行中",
      "state.done": "✓ 已结束",
      "state.exit": "✗ 退出 {code}",
      "toast.done": "后台任务「{name}」已完成",
      "toast.exit": "后台任务「{name}」已结束（exit={code}）",
      "wd.unknown": "（未知工作区）",
      "grp.count": "{wd}（{count}）",
      "grp.expand": "展开该工作区的任务",
      "grp.collapse": "折叠该工作区的任务",
      "cleanup.menuTitle": "清理/删除：开启底部垃圾篓（拖拽已结束任务，或一键批量清理）",
      "trash.older": "清理超24h",
      "trash.older.title": "仅删除完成超过 24h 的已完成任务（24h 内默认保留）",
      "trash.all": "清理全部",
      "trash.all.title": "删除当前视图中所有已完成任务（含 24h 内）",
      "collapse.btn.title": "折叠为仅任务列表（隐藏标题栏/筛选/分组路径，点击列表展开）",
      "minimize.btn.title": "最小化为悬浮球（球会出现在按钮位置）",
      "only.session": "仅当前会话",
      "only.session.title": "只显示当前 active 会话工作区（含其子目录）下的任务",
      "full.access": "全权限",
      "full.access.title": "预批准全权限后台任务（原模式）。开启后受限会话里的宽权限请求不再逐次弹审批；未挂载 dsh 沙箱策略服务的部署也必须开启才能提交任务。",
      "list.empty": "暂无后台任务（agent 用 bgjob_submit 提交）",
      "list.empty.scope": "当前会话工作区暂无任务（关闭筛选可查看全部）",
      "job.trashHint": "拖到下方垃圾篓可删除",
      "follow.scroll": "自动滚动",
      "notify.done": "✓ 已通知",
      "notify.done.title": "该任务结果已交付到会话上下文（来源：notify 完成通知或 bgjob_wait 返回）",
      "notify.pending": "○ 待通知",
      "notify.pending.title": "该任务结果尚未交付到会话上下文（notify 未投递成功、也未被 bgjob_wait 返回；agent 可用 bgjob_pending_list / bgjob_wait 等它）",
      "log.waiting": "（等待输出…）",
      "log.none": "（无输出）",
      "log.loading": "（加载日志…）",
      "log.garbled": "（⚠ 此日志在写入时发生编码损坏：任务进程以 GBK 输出却被按 UTF-8 记录，中文已不可恢复。pwsh 引擎的新任务已修复此问题。）",
      "trash.bar": "垃圾篓（拖到这里删除）",
      "resize.handle": "拖动调节面板大小",
      "fold.grip.title": "点击展开面板",
      "row.expand.title": "点击展开完整面板",
      "btn.expand.title": "展开完整面板",
      "footer.label": "后台任务",
      "footer.hide": "隐藏 bgjobs 后台任务面板",
      "footer.show": "显示 bgjobs 后台任务面板",
      "settings.nav": "后台任务",
      "settings.title": "后台任务（bgjobs）",
      "settings.intro": "管理 DSH 网页里的 bgjobs 入口与离线工具。",
      "settings.entryLabel": "左侧栏显隐按钮",
      "settings.entryDesc": "在 DSH 左侧栏底部显示/隐藏「后台任务」入口（点击可整体隐藏/唤出监控面板）。",
      "settings.gui.open": "打开离线 GUI",
      "settings.gui.openDesc": "启动独立的管理窗口（不依赖 DSH）；若未出现，可到下方路径双击 dsh-bgjobs-gui.bat。",
      "settings.gui.reveal": "打开所在文件夹",
      "settings.gui.path": "离线 GUI 所在位置：",
      "settings.gui.opened": "已启动离线 GUI。",
      "settings.gui.openedReveal": "已在资源管理器中打开离线工具目录。",
      "settings.gui.openedHint": "已发起启动。若几秒内没出现窗口，请用「打开所在文件夹」双击 dsh-bgjobs-gui.bat。",
      "settings.gui.failed": "操作失败：{error}",
      "settings.panel": "监控面板",
      "settings.panelDesc": "显示/隐藏网页右下角的监控面板（含悬浮球）；与左侧栏入口开关相互独立。",
      "settings.gui.revealDesc": "在文件资源管理器中打开离线工具所在目录（tools），方便找 dsh-bgjobs-gui.bat 或建快捷方式。",
      // 字段显示（每字段：列表 / 详情 / 隐藏）
      "settings.display.title": "字段显示",
      "settings.display.desc": "选择每个任务字段显示在「任务列表」、「展开详情」，或隐藏。",
      "settings.display.tab.custom": "自定义配置",
      "settings.display.tab.default": "默认配置",
      "settings.display.defaultDesc": "默认：名称、状态、任务路径显示在列表，其余字段隐藏。",
      "settings.display.reset": "一键恢复默认",
      "settings.display.resetDone": "已恢复默认配置",
      "display.list": "列表",
      "display.detail": "详情",
      "display.hidden": "隐藏",
      "display.show": "显示",
      "settings.display.fieldsLabel": "字段",
      "settings.display.elementsLabel": "界面元素",
      "element.onlySession": "仅当前会话",
      "element.fullAccess": "全权限",
      "element.groupHeader": "折叠该工作区的任务",
      "element.notify": "待通知",
      "element.settingsButton": "设置入口",
      "element.mcpSettingsButton": "MCP 设置入口",
      "gearbtn.title": "打开设置（后台任务）",
      "gearbtn.mcpTitle": "打开设置（MCP 任务）",
      "settings.open.failed": "未能自动打开设置，请在左下角「设置 → 后台任务」查看。",
      "field.id": "任务ID",
      "field.name": "名称",
      "field.status": "状态",
      "field.exitCode": "退出码",
      "field.workdir": "任务路径",
      "field.command": "命令",
      "field.createdAt": "开始时间",
      "field.finishedAt": "完成时间",
      "engine.pwsh": "PowerShell",
      "engine.mcp": "MCP",
      "detail.channel": "执行通道",
      "channel.prewarm": "预热（常驻连接）",
      "channel.cold": "冷启动",
      // MCP 任务（独立设置页：总开关 + server 登记 + 导入导出 + 从 DSH 导入）
      "settings.mcp.nav": "MCP 任务",
      "settings.mcp.title": "MCP 任务（bgjobs）",
      "settings.mcp.intro": "让 agent 把 MCP 工具调用提交为后台任务；下面的 server 供 agent 按名引用，也可导出成 DSH 配置片段。",
      "settings.mcp.switchTitle": "MCP 任务",
      "settings.mcp.switchDesc": "允许 agent 用 bgjob_submit_mcp 把 MCP 工具调用提交为后台任务（schtasks 托管，关 DSH 也继续跑；默认关闭）。与 DSH 一致：会话访问模式（read-only 等）不限制 MCP 任务。",
      "settings.mcp.on": "已开启——agent 可提交 MCP 任务。",
      "settings.mcp.off": "已关闭——bgjob_submit_mcp / bgjob_mcp_tools 会被拒绝。",
      "settings.mcp.failed": "操作失败：{error}",
      "settings.mcp.servers": "MCP 服务器",
      "settings.mcp.serversDesc": "登记 agent 可按名引用的 MCP server（stdio：command/args/env；streamable-http：url/headers）。",
      "settings.mcp.prewarmHint": "「预热」＝为这个 server 在 DSH 进程内保持一条常驻连接：任务复用同一条连接、省去每次冷启动的握手/启动。只在 DSH 存活期间有效；连接失败或 DSH 不在时会自动回退为任务内冷启动，不影响任务正确性（http 传输本身不启动子进程，提速有限；stdio 收益最明显）。",
      "settings.mcp.secretHint": "env / headers 里的密钥会明文保存在 $DSH_HOME/bgjobs/mcp-servers.json，并随任务写入任务目录的 mcp.json；导出的文本同样含明文，分享或归档前请自行脱敏。",
      "settings.mcp.edit": "编辑",
      "settings.mcp.editing": "正在编辑「{name}」",
      "settings.mcp.cancelEdit": "取消编辑",
      "settings.mcp.saveChanges": "保存修改",
      "settings.mcp.editLoaded": "已载入「{name}」的配置（含 env/headers 明文），改完点「保存修改」。",
      "settings.mcp.exportTitle": "导出配置",
      "settings.mcp.exportDesc": "导出 DSH 兼容片段（@deepseek-ai/dsh-mcp-client，可直接并入 cordis.patch.yml）或 bgjobs 原生 JSON（备份/迁移，可被下方「导入」原样吃回）。",
      "settings.mcp.exportFormat": "格式",
      "settings.mcp.exportFmtDsh": "DSH YAML（cordis.patch）",
      "settings.mcp.exportFmtNative": "bgjobs JSON",
      "settings.mcp.exportScope": "范围",
      "settings.mcp.exportAll": "全部",
      "settings.mcp.export": "导出",
      "settings.mcp.exportDone": "已生成 {count} 条（{format}）。",
      "settings.mcp.copy": "复制",
      "settings.mcp.copiedText": "已复制到剪贴板。",
      "settings.mcp.importTitle": "导入配置",
      "settings.mcp.importDesc": "粘贴或选择文件：支持 DSH 的 cordis.patch.yml 片段（@deepseek-ai/dsh-mcp-client）、bgjobs 导出的 JSON，或单个/多个 server 配置对象（需带 serverName）。",
      "settings.mcp.importPlaceholder": "在此粘贴 YAML / JSON…",
      "settings.mcp.importModeSkip": "同名跳过",
      "settings.mcp.importModeOverwrite": "同名覆盖",
      "settings.mcp.importForce": "同时导入含 !!js 的条目（不会求值；导入后需手填 env/headers）",
      "settings.mcp.import": "导入",
      "settings.mcp.importEmpty": "请先粘贴或选择要导入的内容。",
      "settings.mcp.importDone": "导入完成（来源：{source}）",
      "settings.mcp.importFailed": "导入失败：{error}",
      "settings.mcp.empty": "尚未登记任何 MCP server。可在下方新增，或从「DSH 已有 MCP」一键导入。",
      "settings.mcp.add": "新增 / 覆盖（同名覆盖）",
      "settings.mcp.namePlaceholder": "server 名（如 demo）",
      "settings.mcp.configPlaceholder": '{"transport":"stdio","command":"node","args":["..."]} 或 {"transport":"streamable-http","url":"..."}',
      "settings.mcp.save": "保存",
      "settings.mcp.saved": "已保存 server「{name}」。",
      "settings.mcp.saveFailed": "保存失败：{error}",
      "settings.mcp.nameRequired": "请填写 server 名。",
      "settings.mcp.prewarm": "预热",
      "settings.mcp.modeCold": "冷启动",
      "settings.mcp.modeDisabled": "禁用",
      "settings.mcp.modeHint": "每行右侧三态：预热（琥珀，启用并保持常驻连接）/ 冷启动（绿，启用但每次任务内冷启动）/ 禁用（灰，agent 调用被拒绝并断开常驻连接）。",
      "settings.mcp.modeTitlePrewarm": "启用并保持常驻连接（加速；失败自动回退冷启动）",
      "settings.mcp.modeTitleCold": "启用，但不保持常驻连接：每次任务内冷启动",
      "settings.mcp.modeTitleDisabled": "禁用：bgjob_submit_mcp / bgjob_mcp_tools 会拒绝该 server，并断开其常驻连接",
      "settings.mcp.warm": "已常驻",
      "settings.mcp.listTools": "列出工具",
      "settings.mcp.toolsCount": "{count} 个工具（{source}）",
      "settings.mcp.toolsFailed": "列出工具失败：{error}",
      "settings.mcp.copyTool": "点击复制工具名",
      "settings.mcp.copied": "已复制「{name}」",
      "settings.mcp.delete": "删除",
      "settings.mcp.deleted": "已删除 server「{name}」。",
      "settings.dsh.title": "DSH 已有 MCP（导入）",
      "settings.dsh.loading": "读取中…",
      "settings.dsh.profile": "当前 profile：{name}（判定来源：{by}）",
      "settings.dsh.profileUnknown": "无法自动判定当前 profile（{reason}）——请在下方手动选择范围。",
      "settings.dsh.scope": "范围",
      "settings.dsh.scopeActive": "当前 profile",
      "settings.dsh.scopeGlobal": "全局",
      "settings.dsh.import": "导入",
      "settings.dsh.importAll": "全部导入",
      "settings.dsh.imported": "已导入：{names}",
      "settings.dsh.skipped": "已存在跳过：{names}",
      "settings.dsh.rejected": "需人工处理：{names}",
      "settings.dsh.importFailed": "导入失败：{error}",
      "settings.dsh.none": "该范围内没有可导入的条目。",
      "settings.dsh.unavailable": "该范围不可用（profile 未判定或不存在）。",
      "settings.dsh.noFile": "该范围内没有 DSH MCP 配置文件。",
      "settings.dsh.disabled": "DSH 侧已停用",
      "settings.dsh.registered": "已在 bgjobs 登记",
      "settings.dsh.needsAttention": "含 !!js 表达式：不会求值，导入后需手动补 env/headers",
      "settings.dsh.hint": "导入只做一次性拷贝（不修改 DSH 配置）；DSH 侧后续改动不会自动同步，可再次导入对比。"
    };
    var EN = {
      "panel.title": "Background Jobs",
      "ball.title": "bgjobs: {total} job(s), {running} running — click to expand",
      "drag.move": "Drag to move",
      "state.running": "● running",
      "state.done": "✓ done",
      "state.exit": "✗ exit {code}",
      "toast.done": 'Background job "{name}" completed',
      "toast.exit": 'Background job "{name}" ended (exit={code})',
      "wd.unknown": "(unknown workspace)",
      "grp.count": "{wd} ({count})",
      "grp.expand": "Expand jobs in this workspace",
      "grp.collapse": "Collapse jobs in this workspace",
      "cleanup.menuTitle": "Cleanup/delete: open the trash bar (drag finished jobs or bulk-clean)",
      "trash.older": "Clean >24h",
      "trash.older.title": "Delete only jobs finished over 24h ago (default keeps the last 24h)",
      "trash.all": "Clean all",
      "trash.all.title": "Delete every finished job in the current view (incl. <24h)",
      "collapse.btn.title": "Collapse to a compact job list (hides header/filters/group paths; click a row to expand)",
      "minimize.btn.title": "Minimize to a floating ball (it appears where the button was)",
      "only.session": "This session",
      "only.session.title": "Show only jobs under the active session workspace (incl. subdirectories)",
      "full.access": "Full access",
      "full.access.title": "Pre-approve full-access background jobs. When on, wider-than-session permission requests no longer prompt each time; deployments without the dsh sandbox policy service must also enable this to submit.",
      "notify.done": "✓ notified",
      "notify.done.title": "This job result was delivered into the session context (via notify completion or a bgjob_wait return)",
      "notify.pending": "○ pending",
      "notify.pending.title": "This job result has not been delivered into the session context yet (notify not delivered, not returned by bgjob_wait); the agent can wait via bgjob_pending_list / bgjob_wait",
      "list.empty": "No background jobs yet (an agent submits them via bgjob_submit)",
      "list.empty.scope": "No jobs under the current session workspace (turn off the filter to see all)",
      "job.trashHint": "Drag to the trash below to delete",
      "follow.scroll": "Auto-scroll",
      "log.waiting": "(waiting for output…)",
      "log.none": "(no output)",
      "log.garbled": "(⚠ This log was corrupted while being written: the job emitted GBK but it was recorded as UTF-8, so Chinese is unrecoverable. New pwsh-engine jobs are fixed.)",
      "trash.bar": "Trash — drop here to delete",
      "resize.handle": "Drag to resize",
      "fold.grip.title": "Click to expand",
      "row.expand.title": "Click to expand full panel",
      "btn.expand.title": "Expand full panel",
      "footer.label": "Jobs",
      "footer.hide": "Hide the bgjobs background-jobs panel",
      "footer.show": "Show the bgjobs background-jobs panel",
      "settings.nav": "Background Jobs",
      "settings.title": "Background Jobs (bgjobs)",
      "settings.intro": "Manage the bgjobs web entry and offline tools.",
      "settings.entryLabel": "Sidebar toggle button",
      "settings.entryDesc": 'Show/hide the "Background Jobs" entry at the bottom of the DSH sidebar (click toggles the monitor panel).',
      "settings.gui.open": "Open offline GUI",
      "settings.gui.openDesc": "Launches the standalone manager window (no DSH needed); if it does not appear, double-click dsh-bgjobs-gui.bat at the path below.",
      "settings.gui.reveal": "Reveal in folder",
      "settings.gui.path": "Offline GUI location:",
      "settings.gui.opened": "Offline GUI launched.",
      "settings.gui.openedReveal": "Opened the offline tools folder in File Explorer.",
      "settings.gui.openedHint": 'Launch requested. If no window appears in a few seconds, use "Reveal in folder" and double-click dsh-bgjobs-gui.bat.',
      "settings.gui.failed": "Action failed: {error}",
      "settings.panel": "Monitor panel",
      "settings.panelDesc": "Show/hide the floating monitor panel (incl. the ball) at the bottom-right; independent of the sidebar entry toggle.",
      "settings.gui.revealDesc": "Reveal the offline tools folder in File Explorer (find dsh-bgjobs-gui.bat or pin a shortcut).",
      // field display (per field: list / detail / hidden)
      "settings.display.title": "Field display",
      "settings.display.desc": "Choose whether each job field shows in the task list, in the expanded details, or is hidden.",
      "settings.display.tab.custom": "Custom",
      "settings.display.tab.default": "Default",
      "settings.display.defaultDesc": "Default: Name, Status and Path show in the list; the other fields are hidden.",
      "settings.display.reset": "Restore defaults",
      "settings.display.resetDone": "Defaults restored",
      "display.list": "List",
      "display.detail": "Detail",
      "display.hidden": "Hidden",
      "display.show": "Show",
      "settings.display.fieldsLabel": "Fields",
      "settings.display.elementsLabel": "UI elements",
      "element.onlySession": "This session",
      "element.fullAccess": "Full access",
      "element.groupHeader": "Workspace group header",
      "element.notify": "Notify status",
      "element.settingsButton": "Settings shortcut",
      "element.mcpSettingsButton": "MCP settings shortcut",
      "gearbtn.title": "Open settings (Background Jobs)",
      "gearbtn.mcpTitle": "Open settings (MCP jobs)",
      "settings.open.failed": "Could not open Settings automatically; open Settings → Background Jobs manually.",
      "field.id": "Job ID",
      "field.name": "Name",
      "field.status": "Status",
      "field.exitCode": "Exit",
      "field.workdir": "Path",
      "field.command": "Command",
      "field.createdAt": "Started",
      "field.finishedAt": "Finished",
      "engine.pwsh": "PowerShell",
      "engine.mcp": "MCP",
      "detail.channel": "Channel",
      "channel.prewarm": "pre-warmed (resident connection)",
      "channel.cold": "cold start",
      // MCP jobs (its own settings page: master switch + server registry + import/export + import from DSH)
      "settings.mcp.nav": "MCP jobs",
      "settings.mcp.title": "MCP jobs (bgjobs)",
      "settings.mcp.intro": "Let agents submit MCP tool calls as background jobs; the servers below are what agents reference by name, and can be exported as DSH config snippets.",
      "settings.mcp.switchTitle": "MCP jobs",
      "settings.mcp.switchDesc": "Let agents submit MCP tool calls as background jobs via bgjob_submit_mcp (schtasks-managed, keeps running after DSH exits; off by default). Same as DSH: the session access mode (read-only, …) does not restrict MCP jobs.",
      "settings.mcp.on": "On — agents can submit MCP jobs.",
      "settings.mcp.off": "Off — bgjob_submit_mcp / bgjob_mcp_tools are refused.",
      "settings.mcp.failed": "Action failed: {error}",
      "settings.mcp.servers": "MCP servers",
      "settings.mcp.serversDesc": "Register MCP servers agents can reference by name (stdio: command/args/env; streamable-http: url/headers).",
      "settings.mcp.prewarmHint": "Pre-warm keeps a resident connection to this server inside the DSH process, so jobs reuse it instead of paying the handshake/startup every time. It is valid only while DSH runs; when the connection fails or DSH is gone, jobs automatically fall back to an in-job cold start — correctness never depends on it (http transports spawn nothing, so the gain is small there; stdio benefits most).",
      "settings.mcp.secretHint": "Secrets in env / headers are stored in plaintext in $DSH_HOME/bgjobs/mcp-servers.json and copied into each job's mcp.json; exported text is plaintext too — redact before sharing or archiving.",
      "settings.mcp.edit": "Edit",
      "settings.mcp.editing": 'Editing "{name}"',
      "settings.mcp.cancelEdit": "Cancel edit",
      "settings.mcp.saveChanges": "Save changes",
      "settings.mcp.editLoaded": 'Loaded "{name}" (including plaintext env/headers); change it and press "Save changes".',
      "settings.mcp.exportTitle": "Export",
      "settings.mcp.exportDesc": "Export a DSH-compatible snippet (@deepseek-ai/dsh-mcp-client, paste into cordis.patch.yml) or bgjobs-native JSON (backup/migration; the import box below reads it back as-is).",
      "settings.mcp.exportFormat": "Format",
      "settings.mcp.exportFmtDsh": "DSH YAML (cordis.patch)",
      "settings.mcp.exportFmtNative": "bgjobs JSON",
      "settings.mcp.exportScope": "Scope",
      "settings.mcp.exportAll": "All",
      "settings.mcp.export": "Export",
      "settings.mcp.exportDone": "Generated {count} entr(y/ies) ({format}).",
      "settings.mcp.copy": "Copy",
      "settings.mcp.copiedText": "Copied to clipboard.",
      "settings.mcp.importTitle": "Import",
      "settings.mcp.importDesc": "Paste or pick a file: a DSH cordis.patch.yml snippet (@deepseek-ai/dsh-mcp-client), bgjobs-exported JSON, or one/more server config objects (each needs serverName).",
      "settings.mcp.importPlaceholder": "Paste YAML / JSON here…",
      "settings.mcp.importModeSkip": "Skip existing names",
      "settings.mcp.importModeOverwrite": "Overwrite existing names",
      "settings.mcp.importForce": "Also import entries containing !!js (not evaluated; fill in env/headers afterwards)",
      "settings.mcp.import": "Import",
      "settings.mcp.importEmpty": "Paste or pick something to import first.",
      "settings.mcp.importDone": "Import finished (source: {source})",
      "settings.mcp.importFailed": "Import failed: {error}",
      "settings.mcp.empty": 'No MCP server registered yet. Add one below, or import from "MCP in DSH".',
      "settings.mcp.add": "Add / overwrite (same name overwrites)",
      "settings.mcp.namePlaceholder": "server name (e.g. demo)",
      "settings.mcp.configPlaceholder": '{"transport":"stdio","command":"node","args":["..."]} or {"transport":"streamable-http","url":"..."}',
      "settings.mcp.save": "Save",
      "settings.mcp.saved": 'Saved server "{name}".',
      "settings.mcp.saveFailed": "Save failed: {error}",
      "settings.mcp.nameRequired": "Please enter a server name.",
      "settings.mcp.prewarm": "Pre-warm",
      "settings.mcp.modeCold": "Cold start",
      "settings.mcp.modeDisabled": "Disabled",
      "settings.mcp.modeHint": "Each row has three modes: Pre-warm (amber — enabled with a resident connection) / Cold start (green — enabled, cold start per job) / Disabled (grey — agent calls are refused and the resident connection is dropped).",
      "settings.mcp.modeTitlePrewarm": "Enabled with a resident connection (faster; falls back to a cold start on failure)",
      "settings.mcp.modeTitleCold": "Enabled without a resident connection: cold start inside each job",
      "settings.mcp.modeTitleDisabled": "Disabled: bgjob_submit_mcp / bgjob_mcp_tools refuse this server and its resident connection is dropped",
      "settings.mcp.warm": "resident",
      "settings.mcp.listTools": "List tools",
      "settings.mcp.toolsCount": "{count} tool(s) ({source})",
      "settings.mcp.toolsFailed": "Listing tools failed: {error}",
      "settings.mcp.copyTool": "Click to copy the tool name",
      "settings.mcp.copied": 'Copied "{name}"',
      "settings.mcp.delete": "Delete",
      "settings.mcp.deleted": 'Deleted server "{name}".',
      "settings.dsh.title": "MCP in DSH (import)",
      "settings.dsh.loading": "Loading…",
      "settings.dsh.profile": "Active profile: {name} (detected by: {by})",
      "settings.dsh.profileUnknown": "Cannot determine the active profile ({reason}) — pick a scope below.",
      "settings.dsh.scope": "Scope",
      "settings.dsh.scopeActive": "Active profile",
      "settings.dsh.scopeGlobal": "Global",
      "settings.dsh.import": "Import",
      "settings.dsh.importAll": "Import all",
      "settings.dsh.imported": "Imported: {names}",
      "settings.dsh.skipped": "Skipped (existing): {names}",
      "settings.dsh.rejected": "Needs manual work: {names}",
      "settings.dsh.importFailed": "Import failed: {error}",
      "settings.dsh.none": "Nothing to import in this scope.",
      "settings.dsh.unavailable": "This scope is unavailable (profile unknown or missing).",
      "settings.dsh.noFile": "No DSH MCP config file in this scope.",
      "settings.dsh.disabled": "disabled in DSH",
      "settings.dsh.registered": "already registered",
      "settings.dsh.needsAttention": "Contains a !!js expression: not evaluated, fill in env/headers manually after import",
      "settings.dsh.hint": "Import is a one-off copy (DSH config is never modified); later DSH changes do not sync — import again to compare."
    };
    var fmt = (tpl, params) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => params && k in params ? String(params[k]) : m);
    var lookup = (dict, key) => dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : void 0;
    var makeT = (active) => (key, params) => {
      const lang = active === "zh" ? ZH : EN;
      const other = active === "zh" ? EN : ZH;
      return fmt(lookup(lang, key) ?? lookup(other, key) ?? key, params);
    };
    module2.exports = { NS, ZH, EN, makeT };
  }
});

// lib/client-src/monitor.js
var require_monitor = __commonJS({
  "lib/client-src/monitor.js"(exports2, module2) {
    var React = require("react");
    function createMonitorStore(initialVisible = true) {
      let visible = !!initialVisible;
      const listeners = /* @__PURE__ */ new Set();
      const emit = () => {
        for (const fn of [...listeners]) {
          try {
            fn();
          } catch (e) {
          }
        }
      };
      return {
        getVisible: () => visible,
        setVisible: (v) => {
          const next = !!v;
          if (next === visible) return;
          visible = next;
          emit();
        },
        toggle: () => {
          visible = !visible;
          emit();
        },
        subscribe: (fn) => {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        }
      };
    }
    function useMonitorVisible(monitor) {
      const subscribe = React.useCallback((cb) => monitor ? monitor.subscribe(cb) : () => {
      }, [monitor]);
      const getSnapshot = React.useCallback(() => monitor ? monitor.getVisible() : true, [monitor]);
      return React.useSyncExternalStore(subscribe, getSnapshot);
    }
    module2.exports = { createMonitorStore, useMonitorVisible };
  }
});

// lib/client-src/gui-prefs.js
var require_gui_prefs = __commonJS({
  "lib/client-src/gui-prefs.js"(exports2, module2) {
    var React = require("react");
    var DEFAULT_DISPLAY = {
      id: "hidden",
      name: "list",
      status: "list",
      exitCode: "hidden",
      workdir: "list",
      command: "hidden",
      createdAt: "hidden",
      finishedAt: "hidden"
    };
    var DISPLAY_VALUES = ["list", "detail", "hidden"];
    var DEFAULT_ELEMENTS = { settingsButton: true, mcpSettingsButton: true, onlySession: true, fullAccess: true, groupHeader: true, notify: true };
    function createGuiPrefsStore(initialEnabled = false) {
      let enabled = !!initialEnabled;
      let display = { ...DEFAULT_DISPLAY };
      let elements = { ...DEFAULT_ELEMENTS };
      let defaultDisplay = { ...DEFAULT_DISPLAY };
      let defaultElements = { ...DEFAULT_ELEMENTS };
      const listeners = /* @__PURE__ */ new Set();
      const emit = () => {
        for (const fn of [...listeners]) {
          try {
            fn();
          } catch (e) {
          }
        }
      };
      const set = (value, persist) => {
        const next = !!value;
        if (next !== enabled) {
          enabled = next;
          emit();
        }
        if (!persist) return;
        fetch("/bgjobs/uiprefs?sidebarEntry=" + (next ? 1 : 0), { method: "POST" }).then((r) => r.json()).then((d) => {
          if (d && typeof d.sidebarEntry === "boolean" && d.sidebarEntry !== enabled) {
            enabled = d.sidebarEntry;
            emit();
          }
        }).catch(() => {
        });
      };
      const applyDisplay = (obj) => {
        if (!obj || typeof obj !== "object") return;
        const next = { ...display };
        let changed = false;
        for (const k of Object.keys(DEFAULT_DISPLAY)) {
          if (DISPLAY_VALUES.includes(obj[k]) && obj[k] !== next[k]) {
            next[k] = obj[k];
            changed = true;
          }
        }
        display = next;
        if (changed) emit();
      };
      const applyDefaults = (obj) => {
        if (!obj || typeof obj !== "object") return;
        const next = { ...defaultDisplay };
        for (const k of Object.keys(DEFAULT_DISPLAY)) if (DISPLAY_VALUES.includes(obj[k])) next[k] = obj[k];
        defaultDisplay = next;
      };
      const applyElements = (obj) => {
        if (!obj || typeof obj !== "object") return;
        const next = { ...elements };
        let changed = false;
        for (const k of Object.keys(DEFAULT_ELEMENTS)) {
          if (typeof obj[k] === "boolean" && obj[k] !== next[k]) {
            next[k] = obj[k];
            changed = true;
          }
        }
        elements = next;
        if (changed) emit();
      };
      const applyDefaultElements = (obj) => {
        if (!obj || typeof obj !== "object") return;
        const next = { ...defaultElements };
        for (const k of Object.keys(DEFAULT_ELEMENTS)) if (typeof obj[k] === "boolean") next[k] = obj[k];
        defaultElements = next;
      };
      const applyHostPrefs = (d) => {
        if (!d) return;
        if (d.display) applyDisplay(d.display);
        if (d.elements) applyElements(d.elements);
        if (d.defaultDisplay) applyDefaults(d.defaultDisplay);
        if (d.defaultElements) applyDefaultElements(d.defaultElements);
      };
      const persistDisplay = (next) => fetch("/bgjobs/uiprefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display: next })
      }).then((r) => r.json()).then(applyHostPrefs).catch(() => {
      });
      const setDisplayField = (key, value) => {
        if (!(key in DEFAULT_DISPLAY) || !DISPLAY_VALUES.includes(value)) return;
        const next = { ...display, [key]: value };
        applyDisplay(next);
        persistDisplay(next);
      };
      const setElement = (key, visible) => {
        if (!(key in DEFAULT_ELEMENTS)) return;
        const next = { ...elements, [key]: !!visible };
        applyElements(next);
        fetch("/bgjobs/uiprefs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ elements: next })
        }).then((r) => r.json()).then(applyHostPrefs).catch(() => {
        });
      };
      const resetDisplay = () => {
        const next = { ...defaultDisplay };
        const nextEl = { ...defaultElements };
        applyDisplay(next);
        applyElements(nextEl);
        fetch("/bgjobs/uiprefs?action=resetDisplay", { method: "POST" }).then((r) => r.json()).then(applyHostPrefs).catch(() => {
        });
      };
      return {
        getEnabled: () => enabled,
        setEnabled: (next) => set(next, true),
        apply: (next) => set(next, false),
        getDisplay: () => display,
        applyDisplay,
        getDefaultDisplay: () => defaultDisplay,
        applyDefaults,
        getElements: () => elements,
        applyElements,
        getDefaultElements: () => defaultElements,
        applyDefaultElements,
        setDisplayField,
        setElement,
        resetDisplay,
        subscribe: (fn) => {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        }
      };
    }
    function loadGuiPrefs(store) {
      fetch("/bgjobs/uiprefs").then((r) => r.json()).then((d) => {
        if (!d) return;
        if (typeof d.sidebarEntry === "boolean") store.apply(d.sidebarEntry);
        if (d.display) store.applyDisplay(d.display);
        if (d.elements) store.applyElements(d.elements);
        if (d.defaultDisplay) store.applyDefaults(d.defaultDisplay);
        if (d.defaultElements) store.applyDefaultElements(d.defaultElements);
      }).catch(() => {
      });
    }
    function useGuiPrefsEnabled(store) {
      const subscribe = React.useCallback((cb) => store ? store.subscribe(cb) : () => {
      }, [store]);
      const getSnapshot = React.useCallback(() => store ? store.getEnabled() : false, [store]);
      return React.useSyncExternalStore(subscribe, getSnapshot);
    }
    function useGuiPrefsDisplay(store) {
      const subscribe = React.useCallback((cb) => store ? store.subscribe(cb) : () => {
      }, [store]);
      const getSnapshot = React.useCallback(() => store ? store.getDisplay() : null, [store]);
      return React.useSyncExternalStore(subscribe, getSnapshot);
    }
    function useGuiPrefsElements(store) {
      const subscribe = React.useCallback((cb) => store ? store.subscribe(cb) : () => {
      }, [store]);
      const getSnapshot = React.useCallback(() => store ? store.getElements() : null, [store]);
      return React.useSyncExternalStore(subscribe, getSnapshot);
    }
    module2.exports = { createGuiPrefsStore, loadGuiPrefs, useGuiPrefsEnabled, useGuiPrefsDisplay, useGuiPrefsElements, DEFAULT_DISPLAY, DEFAULT_ELEMENTS };
  }
});

// lib/client-src/open-settings.js
var require_open_settings = __commonJS({
  "lib/client-src/open-settings.js"(exports2, module2) {
    var TRIGGER_SELECTOR = '[data-slot="sidebar.settings"] button[aria-haspopup="dialog"]';
    var TARGET_ROW_ID = "bgjobs";
    var PARENTS = [
      { id: "plugins", label: "插件入口" },
      { id: null, label: "插件" },
      { id: null, label: "Plugins" },
      { id: null, label: "Plugin entry" }
    ];
    var CLICKABLE = 'button, [role="tab"], [role="button"], [role="menuitem"], [aria-expanded], summary';
    var WAIT_MS = 1500;
    var visible = (el) => !!(el && el.getClientRects && el.getClientRects().length);
    var textOf = (el) => el && el.textContent ? el.textContent.replace(/\s+/g, " ").trim() : "";
    var attrEscape = (s) => String(s || "").replace(/["\\]/g, "\\$&");
    var DECOR = /[▾▸◂▴▲▼◀▶^›»‹«]/g;
    var normalizeLabel = (s) => String(s || "").replace(DECOR, "").replace(/\s+/g, " ").trim().replace(/\s*[(（]\s*\d+\s*[)）]\s*$/, "").trim();
    var settingsDialog = () => document.querySelector('[role="dialog"][aria-modal="true"]');
    var findByRowId = (root, id) => {
      if (!id) return null;
      const el = root.querySelector('[data-snav-row="' + attrEscape(id) + '"]');
      return el && visible(el) ? el : null;
    };
    var findByLabel = (root, label) => {
      const target = normalizeLabel(label);
      if (!target) return null;
      const matches = Array.from(root.querySelectorAll(CLICKABLE)).filter((el) => visible(el) && normalizeLabel(textOf(el)) === target);
      if (matches.length === 0) return null;
      const deepest = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
      const pool = deepest.length ? deepest : matches;
      return pool.find((el) => el.tagName === "BUTTON" || el.getAttribute("role") === "tab") || pool[0];
    };
    var waitFor = (fn) => new Promise((resolve) => {
      const t0 = Date.now();
      const step = () => {
        let v = null;
        try {
          v = fn();
        } catch (e) {
          v = null;
        }
        if (v || Date.now() - t0 > WAIT_MS) resolve(v || null);
        else requestAnimationFrame(step);
      };
      step();
    });
    async function openBgjobsSettings({ label, rowId } = {}) {
      if (!label || typeof document === "undefined") return "no-trigger";
      const targetId = rowId === void 0 ? TARGET_ROW_ID : rowId;
      let dlg = settingsDialog();
      if (!dlg) {
        const trigger = document.querySelector(TRIGGER_SELECTOR);
        if (!trigger) return "no-trigger";
        try {
          trigger.click();
        } catch (e) {
          return "no-trigger";
        }
        dlg = await waitFor(settingsDialog);
        if (!dlg) return "no-trigger";
      }
      const findTarget = () => findByRowId(dlg, targetId) || findByLabel(dlg, label);
      const direct = findTarget();
      if (direct) {
        try {
          direct.click();
        } catch (e) {
        }
        return "section";
      }
      for (const parent of PARENTS) {
        const row = findByRowId(dlg, parent.id) || findByLabel(dlg, parent.label);
        if (!row) continue;
        try {
          row.click();
        } catch (e) {
          continue;
        }
        const found = await waitFor(findTarget);
        if (found) {
          try {
            found.click();
          } catch (e) {
          }
          return "tab";
        }
      }
      const late = findTarget();
      if (late) {
        try {
          late.click();
        } catch (e) {
        }
        return "section";
      }
      return "notfound";
    }
    module2.exports = { openBgjobsSettings };
  }
});

// lib/client-src/ui.js
var require_ui = __commonJS({
  "lib/client-src/ui.js"(exports2, module2) {
    var React = require("react");
    var h = React.createElement;
    var primitives = null;
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (e) {
    }
    var ToastComponent = primitives ? primitives.Toast : null;
    var IconTrash = primitives ? primitives.IconTrashOutline16 : null;
    var IconClock = primitives ? primitives.IconClockOutline16 : null;
    var IconClose = primitives ? primitives.IconCloseOutline16 : null;
    var IconChevronDown = primitives ? primitives.IconChevronDownOutline14 : null;
    var IconChevronRight = primitives ? primitives.IconChevronRightOutline14 : null;
    var IconFolderOpen = primitives ? primitives.IconFolderOpen16 : null;
    var IconFolderClose = primitives ? primitives.IconFolderClose16 : null;
    var IconSettings = primitives ? primitives.IconSettingsOutline16 : null;
    var IconDataOutline16 = primitives ? primitives.IconDataOutline16 : null;
    var ReactDOM = null;
    try {
      ReactDOM = require("react-dom");
    } catch (e) {
    }
    var stateColor = (job) => {
      if (job.status === "running") return "var(--dsw-alias-state-business-primary)";
      if (job.status === "done" && job.exitCode === 0) return "var(--dsw-alias-state-success-primary)";
      return "var(--dsw-alias-state-error-primary)";
    };
    var stateLabel = (job, t) => {
      if (job.status === "running") return t("state.running");
      if (job.status === "done" && job.exitCode === 0) return t("state.done");
      return t("state.exit", { code: String(job.exitCode) });
    };
    var normalizePath = (p) => String(p || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    var readActiveCwd = (sessions) => {
      if (!sessions) return void 0;
      try {
        const st = sessions.list.getSnapshot();
        if (!st || st.current === void 0) return void 0;
        const cur = st.byId && st.byId[st.current];
        return cur && cur.cwd ? String(cur.cwd) : void 0;
      } catch (e) {
        return void 0;
      }
    };
    var PANEL_Z = 2147483e3;
    var TOAST_Z = PANEL_Z + 1;
    var DONE_AGE_MS = 24 * 60 * 60 * 1e3;
    var GRIP_H = 26;
    var portalBody = (node) => ReactDOM && typeof document !== "undefined" && document.body ? ReactDOM.createPortal(node, document.body) : node;
    var clampToViewport = (x, y, width, height, pad) => {
      const PAD = pad === void 0 ? 8 : pad;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      return {
        x: Math.min(Math.max(x, PAD), Math.max(PAD, vw - width - PAD)),
        y: Math.min(Math.max(y, PAD), Math.max(PAD, vh - height - PAD))
      };
    };
    function SelfToast({ text, onDone }) {
      React.useEffect(() => {
        const t = setTimeout(onDone, 4e3);
        return () => {
          clearTimeout(t);
        };
      }, []);
      return h("div", { role: "alert", style: {
        position: "fixed",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: TOAST_Z,
        background: "var(--dsw-alias-bg-layer-3)",
        color: "var(--dsw-alias-label-primary)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8,
        padding: "8px 16px",
        boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
        fontFamily: "var(--dsw-font-family)",
        fontSize: 13
      } }, text);
    }
    function CtrlBtn({ title, onClick, active, children }) {
      const [hover, setHover] = React.useState(false);
      return h("div", {
        "data-bgjobs-ctrl": true,
        title,
        onClick: (e) => {
          e.stopPropagation();
          onClick(e);
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          width: 24,
          height: 24,
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          cursor: "pointer",
          background: hover ? "var(--dsw-specific-selector)" : "transparent",
          color: active || hover ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)"
        }
      }, children);
    }
    var iconEl = (Icon, fallback, size) => Icon ? h(Icon, { size: size || 14, style: { display: "block" } }) : h("span", { style: { fontSize: size || 14, lineHeight: 1 } }, fallback);
    function MiniBtn({ title, onClick, children }) {
      const [hover, setHover] = React.useState(false);
      return h("span", {
        title,
        onClick: (e) => {
          e.stopPropagation();
          onClick && onClick(e);
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          padding: "2px 6px",
          borderRadius: 4,
          cursor: "pointer",
          whiteSpace: "nowrap",
          background: hover ? "var(--dsw-specific-selector)" : "transparent",
          color: hover ? "var(--dsw-alias-label-primary)" : void 0
        }
      }, children);
    }
    function Toggle({ checked, onChange, title, label, onColor }) {
      return h(
        "label",
        { title, style: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer", whiteSpace: "nowrap" } },
        h("input", { type: "checkbox", checked, onChange: (e) => onChange(e.target.checked), style: { position: "absolute", opacity: 0, pointerEvents: "none" } }),
        h(
          "span",
          { "aria-hidden": true, style: { width: 30, height: 18, borderRadius: 9, flex: "none", position: "relative", background: checked ? onColor || "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-border-l2)", transition: "background 0.15s ease" } },
          h("span", { style: { position: "absolute", top: 2, left: checked ? 14 : 2, width: 14, height: 14, borderRadius: "50%", background: "var(--dsw-alias-bg-layer-3)", boxShadow: "0 1px 2px rgba(0,0,0,0.4)", transition: "left 0.15s ease" } })
        ),
        h("span", { style: { fontSize: 11 } }, label)
      );
    }
    module2.exports = { stateColor, stateLabel, normalizePath, readActiveCwd, PANEL_Z, TOAST_Z, DONE_AGE_MS, GRIP_H, ToastComponent, iconEl, IconTrash, IconClock, IconClose, IconChevronDown, IconChevronRight, IconFolderOpen, IconFolderClose, IconSettings, IconDataOutline16, SelfToast, CtrlBtn, MiniBtn, Toggle, portalBody, clampToViewport };
  }
});

// lib/client-src/panel.js
var require_panel = __commonJS({
  "lib/client-src/panel.js"(exports2, module2) {
    var React = require("react");
    var h = React.createElement;
    var { makeT } = require_i18n();
    var { useMonitorVisible } = require_monitor();
    var { useGuiPrefsDisplay, useGuiPrefsElements, DEFAULT_DISPLAY, DEFAULT_ELEMENTS } = require_gui_prefs();
    var { openBgjobsSettings } = require_open_settings();
    var { stateColor, stateLabel, normalizePath, readActiveCwd, DONE_AGE_MS, PANEL_Z, TOAST_Z, GRIP_H, ToastComponent, iconEl, IconTrash, IconClock, IconClose, IconChevronDown, IconChevronRight, IconFolderOpen, IconFolderClose, IconSettings, IconDataOutline16, SelfToast, CtrlBtn, MiniBtn, Toggle, portalBody, clampToViewport } = require_ui();
    var FIELD_KEYS = ["id", "name", "status", "exitCode", "workdir", "command", "createdAt", "finishedAt"];
    var pad2 = (n) => String(n).padStart(2, "0");
    var fmtTime = (ms) => {
      if (ms === null || ms === void 0 || ms === "") return "-";
      const d = new Date(Number(ms));
      if (isNaN(d.getTime())) return "-";
      return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    };
    var oneLine = (s) => String(s === null || s === void 0 ? "" : s).replace(/\r?\n/g, " ").trim();
    function Panel({ sessions: sessionsProp, getSessions, t, monitor, guiPrefs }) {
      if (typeof t !== "function") t = makeT("zh");
      const display = useGuiPrefsDisplay(guiPrefs) || DEFAULT_DISPLAY;
      const whereOf = (key) => display && display[key] || "hidden";
      const fieldText = (job, key) => {
        switch (key) {
          case "id":
            return String(job.id || "");
          case "name":
            return String(job.name || "");
          case "status":
            return stateLabel(job, t);
          case "exitCode":
            return job.exitCode === null || job.exitCode === void 0 ? "-" : String(job.exitCode);
          case "workdir":
            return String(job.workdir || "");
          case "command":
            return String(job.command || "");
          case "createdAt":
            return fmtTime(job.createdAt);
          case "finishedAt":
            return fmtTime(job.finishedAt);
          default:
            return "";
        }
      };
      const listSecondary = (job) => FIELD_KEYS.filter((k) => whereOf(k) === "list" && k !== "name" && k !== "status").map((k) => ({ key: k, text: oneLine(fieldText(job, k)) })).filter((x) => x.text !== "");
      const detailKeys = FIELD_KEYS.filter((k) => whereOf(k) === "detail");
      const elements = useGuiPrefsElements(guiPrefs) || DEFAULT_ELEMENTS;
      const el = (k) => elements[k] !== false;
      const [liveSessions, setLiveSessions] = React.useState(sessionsProp);
      const sessionsRef = React.useRef(liveSessions);
      sessionsRef.current = liveSessions;
      const getSessionsRef = React.useRef(getSessions);
      getSessionsRef.current = getSessions;
      const sessions = liveSessions;
      const [jobs, setJobs] = React.useState([]);
      const [fullAccess, setFullAccess] = React.useState(false);
      const [open, setOpen] = React.useState(true);
      const [minimized, setMinimized] = React.useState(false);
      const [selected, setSelected] = React.useState(null);
      const [follow, setFollow] = React.useState(true);
      const [pos, setPos] = React.useState(null);
      const [size, setSize] = React.useState(null);
      const [onlyActive, setOnlyActive] = React.useState(true);
      const [activeCwd, setActiveCwd] = React.useState(() => readActiveCwd(sessionsProp));
      const [collapsed, setCollapsed] = React.useState(() => /* @__PURE__ */ new Set());
      const [trashOpen, setTrashOpen] = React.useState(false);
      const [toasts, setToasts] = React.useState([]);
      const [logExtra, setLogExtra] = React.useState({});
      const logFetchingRef = React.useRef(/* @__PURE__ */ new Set());
      const prevDoneRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const draggedRef = React.useRef(false);
      const resizeRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const ballRef = React.useRef(null);
      const foldAnchorRef = React.useRef(null);
      const logRef = React.useRef(null);
      const listRef = React.useRef(null);
      const listInitRef = React.useRef(false);
      const foldListRef = React.useRef(null);
      const foldInitRef = React.useRef(false);
      const listScrollRef = React.useRef(0);
      const listRestoreRef = React.useRef(false);
      const prevOpenRef = React.useRef(open);
      const prevMinRef = React.useRef(minimized);
      const followRef = React.useRef(true);
      followRef.current = follow;
      const visible = useMonitorVisible(monitor);
      const withVisible = (style) => visible ? style : Object.assign({}, style, { display: "none" });
      const dismissToast = (id) => {
        setToasts((prev) => prev.filter((t2) => t2.id !== id));
      };
      const stopRef = React.useRef(false);
      const poll = () => fetch("/bgjobs/state").then((r) => r.json()).then((d) => {
        if (stopRef.current) return;
        const jobs2 = Array.isArray(d && d.jobs) ? d.jobs : [];
        setJobs(jobs2);
        if (d && typeof d.fullAccess === "boolean") setFullAccess(d.fullAccess);
        try {
          const probe = getSessionsRef.current;
          if (probe) {
            const fresh = probe();
            if (fresh !== sessionsRef.current) {
              sessionsRef.current = fresh;
              setLiveSessions(fresh);
            }
          }
        } catch (e) {
        }
        const svc = sessionsRef.current;
        if (svc) {
          const cwdNow = readActiveCwd(svc);
          setActiveCwd((prev2) => cwdNow === prev2 ? prev2 : cwdNow);
        }
        const prev = prevDoneRef.current;
        const next = /* @__PURE__ */ new Set();
        for (const j of jobs2) if (j.status === "done") next.add(j.id);
        if (prev !== null) {
          for (const j of jobs2) {
            if (j.status !== "done" || prev.has(j.id)) continue;
            const exitCode = j.exitCode === 0 ? t("toast.done", { name: j.name }) : t("toast.exit", { name: j.name, code: String(j.exitCode) });
            setToasts((cur) => [...cur, { id: "toast-" + j.id + "-" + Date.now(), text: exitCode }]);
          }
        }
        prevDoneRef.current = next;
      }).catch(() => {
      });
      const pollNow = () => {
        poll();
      };
      const callHost = async (url) => {
        try {
          const r = await fetch(url, { method: "POST" });
          return await r.json();
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      };
      const deleteJob = async (id) => {
        const r = await callHost("/bgjobs/delete?id=" + encodeURIComponent(id));
        if (r && r.ok) {
          setSelected((s) => s === id ? null : s);
          pollNow();
        }
        return r;
      };
      const ensureLog = (job) => {
        if (!job || job.status !== "done" || job.tail) return;
        const id = job.id;
        if (logExtra[id] || logFetchingRef.current.has(id)) return;
        logFetchingRef.current.add(id);
        setLogExtra((prev) => ({ ...prev, [id]: { loading: true, text: "" } }));
        fetch("/bgjobs/log?id=" + encodeURIComponent(id)).then((r) => r.json()).then((d) => setLogExtra((prev) => ({ ...prev, [id]: { loading: false, text: d && d.ok ? String(d.text || "") : "" } }))).catch(() => setLogExtra((prev) => ({ ...prev, [id]: { loading: false, text: "" } }))).finally(() => logFetchingRef.current.delete(id));
      };
      const toggleSelect = (job) => {
        const next = selected === job.id ? null : job.id;
        setSelected(next);
        if (next) ensureLog(job);
      };
      const renderLogText = (job) => {
        const txt = job.tail || (job.status === "done" ? logExtra[job.id] ? logExtra[job.id].loading ? t("log.loading") : logExtra[job.id].text || t("log.none") : t("log.none") : t("log.waiting"));
        let n = 0;
        for (let i = 0; i < txt.length; i++) if (txt.charCodeAt(i) === 65533) n++;
        return (n >= 6 ? t("log.garbled") + "\n" : "") + txt;
      };
      const cleanupVisible = async (olderOnly) => {
        const cutoff = Date.now() - DONE_AGE_MS;
        const done = visibleJobs.filter((j) => j.status === "done" && (!olderOnly || j.finishedAt !== null && j.finishedAt !== void 0 && j.finishedAt <= cutoff));
        if (done.length === 0) {
          pollNow();
          return { ok: true, removed: [] };
        }
        const removed = [];
        for (const j of done) {
          const r = await callHost("/bgjobs/delete?id=" + encodeURIComponent(j.id));
          if (r && r.ok) removed.push(j.id);
        }
        setSelected((s) => done.some((j) => j.id === s) ? null : s);
        pollNow();
        return { ok: true, removed };
      };
      const toggleFullAccess = async (enabled) => {
        try {
          const r = await fetch("/bgjobs/fullaccess?enabled=" + (enabled ? 1 : 0), { method: "POST" });
          const d = await r.json();
          if (d && typeof d.enabled === "boolean") setFullAccess(d.enabled);
        } catch (e) {
        }
      };
      const dragJobRef = React.useRef(null);
      const [trashHot, setTrashHot] = React.useState(false);
      const trashRef = React.useRef(null);
      const deletable = (job) => trashOpen && job.status === "done";
      const onJobDown = (e, job) => {
        if (e.button !== 0 || !deletable(job)) return;
        dragJobRef.current = job;
        e.currentTarget.setPointerCapture(e.pointerId);
      };
      const onJobMove = (e) => {
        if (!dragJobRef.current) return;
        const trash = trashRef.current;
        if (!trash) return;
        const r = trash.getBoundingClientRect();
        setTrashHot(e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
      };
      const onJobUp = async (e) => {
        const job = dragJobRef.current;
        dragJobRef.current = null;
        if (!job) return;
        const trash = trashRef.current;
        let hit = false;
        if (trash) {
          const r = trash.getBoundingClientRect();
          hit = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        }
        setTrashHot(false);
        if (hit) await deleteJob(job.id);
      };
      React.useEffect(() => {
        stopRef.current = false;
        poll();
        const iv = setInterval(poll, 1e3);
        return () => {
          stopRef.current = true;
          clearInterval(iv);
        };
      }, []);
      React.useEffect(() => {
        if (!sessions) return;
        let alive = true;
        let unsubscribe;
        try {
          unsubscribe = sessions.list.subscribe(() => {
            if (alive) setActiveCwd(readActiveCwd(sessions));
          });
        } catch (e) {
        }
        return () => {
          alive = false;
          if (typeof unsubscribe === "function") unsubscribe();
        };
      }, [sessions]);
      React.useEffect(() => {
        if (logRef.current && followRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
      }, [jobs, logExtra]);
      React.useEffect(() => {
        const el2 = listRef.current;
        if (prevOpenRef.current === false && open || prevMinRef.current === true && !minimized) {
          listRestoreRef.current = true;
        }
        if (prevOpenRef.current === true && !open) {
          foldInitRef.current = false;
        }
        prevOpenRef.current = open;
        prevMinRef.current = minimized;
        if (el2) {
          const max = Math.max(0, el2.scrollHeight - el2.clientHeight);
          if (listRestoreRef.current) {
            el2.scrollTop = Math.min(listScrollRef.current, max);
            listRestoreRef.current = false;
          } else if (!listInitRef.current && el2.scrollHeight > el2.clientHeight + 2) {
            el2.scrollTop = el2.scrollHeight;
            listInitRef.current = true;
          }
        }
        const fel = foldListRef.current;
        if (fel && !foldInitRef.current && fel.scrollHeight > fel.clientHeight + 2) {
          fel.scrollTop = fel.scrollHeight;
          foldInitRef.current = true;
        }
      }, [jobs, open, minimized]);
      React.useEffect(() => {
        const keys = Object.keys(logExtra);
        if (keys.length === 0) return;
        const ids = new Set(jobs.map((j) => j.id));
        let changed = false;
        const next = {};
        for (const k of keys) {
          if (ids.has(k)) next[k] = logExtra[k];
          else changed = true;
        }
        if (changed) setLogExtra(next);
      }, [jobs, logExtra]);
      React.useEffect(() => {
        const onResize = () => {
          setPos((prev) => {
            if (!prev) return prev;
            const el2 = minimized ? ballRef.current : panelRef.current;
            if (!el2) return prev;
            const r = el2.getBoundingClientRect();
            const c = clampToViewport(prev.x, prev.y, r.width, r.height);
            return c.x === prev.x && c.y === prev.y ? prev : c;
          });
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
      }, [minimized]);
      React.useEffect(() => {
        if (minimized || !open || !panelRef.current) return;
        setPos((prev) => {
          if (!prev) return prev;
          const r = panelRef.current.getBoundingClientRect();
          const c = clampToViewport(prev.x, prev.y, r.width, r.height);
          return c.x === prev.x && c.y === prev.y ? prev : c;
        });
      }, [minimized, open]);
      React.useEffect(() => {
        if (open || minimized) {
          foldAnchorRef.current = null;
          return;
        }
        const anchor = foldAnchorRef.current;
        const el2 = panelRef.current;
        if (!anchor || !el2) return;
        const r = el2.getBoundingClientRect();
        const c = clampToViewport(anchor.x - r.width, anchor.y, r.width, r.height);
        setPos(c);
        foldAnchorRef.current = null;
      }, [open, minimized]);
      const startDrag = (e) => {
        if (e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest("[data-bgjobs-ctrl]")) return;
        const el2 = minimized ? ballRef.current : panelRef.current;
        if (!el2) return;
        const r = el2.getBoundingClientRect();
        setPos({ x: r.left, y: r.top });
        draggedRef.current = false;
        dragRef.current = { startX: e.clientX, startY: e.clientY, origX: r.left, origY: r.top, w: r.width, h: r.height };
        e.currentTarget.setPointerCapture(e.pointerId);
      };
      const moveDrag = (e) => {
        const d = dragRef.current;
        if (!d) return;
        if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 4) draggedRef.current = true;
        const c = clampToViewport(d.origX + e.clientX - d.startX, d.origY + e.clientY - d.startY, d.w, d.h);
        setPos(c);
      };
      const endDrag = () => {
        dragRef.current = null;
      };
      const minimizeToBall = (btnEl) => {
        try {
          const r = btnEl.getBoundingClientRect();
          const x = r.left + r.width / 2 - 24;
          const y = r.top + r.height / 2 - 24;
          setPos({ x, y });
        } catch (e) {
        }
        setMinimized(true);
      };
      const clampSize = (w, h2) => ({
        w: Math.min(Math.max(w, 300), Math.min(900, window.innerWidth - 32)),
        h: Math.min(Math.max(h2, 260), Math.min(720, window.innerHeight - 32))
      });
      const onResizeStart = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const r = panelRef.current.getBoundingClientRect();
        resizeRef.current = { startX: e.clientX, startY: e.clientY, w: r.width, h: r.height };
        e.currentTarget.setPointerCapture(e.pointerId);
      };
      const onResizeMove = (e) => {
        const d = resizeRef.current;
        if (!d) return;
        setSize(clampSize(d.w + e.clientX - d.startX, d.h + e.clientY - d.startY));
      };
      const onResizeEnd = () => {
        resizeRef.current = null;
      };
      const sel = jobs.find((j) => j.id === selected) || null;
      const running = jobs.filter((j) => j.status === "running").length;
      const rootStyle = {
        position: "fixed",
        zIndex: PANEL_Z,
        background: "var(--dsw-alias-bg-layer-3)",
        color: "var(--dsw-alias-label-primary)",
        border: "1px solid var(--dsw-alias-border-l2)",
        boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
        fontFamily: "var(--dsw-font-family)",
        fontSize: 13
      };
      const placed = (el2) => {
        if (pos) {
          el2.left = pos.x;
          el2.top = pos.y;
        } else {
          el2.right = 16;
          el2.bottom = 16;
        }
        return el2;
      };
      const renderToasts = toasts.map(
        (t2) => ToastComponent ? h(ToastComponent, { key: t2.id, text: t2.text, onDone: () => dismissToast(t2.id) }) : h(SelfToast, { key: t2.id, text: t2.text, onDone: () => dismissToast(t2.id) })
      );
      if (minimized) {
        const ballStyle = withVisible(placed(Object.assign({}, rootStyle, {
          width: 48,
          height: 48,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "grab",
          touchAction: "none",
          userSelect: "none"
        })));
        return portalBody(h(
          React.Fragment,
          null,
          renderToasts,
          h(
            "div",
            {
              ref: ballRef,
              style: ballStyle,
              title: t("ball.title", { total: String(jobs.length), running: String(running) }),
              onPointerDown: startDrag,
              onPointerMove: moveDrag,
              onPointerUp: endDrag,
              onPointerCancel: endDrag,
              // 拖动悬浮球后不自动展开（拖动也会派发 click，用位移阈值区分）。
              onClick: () => {
                if (!draggedRef.current) setMinimized(false);
              }
            },
            h("span", { style: { fontWeight: 700, fontSize: 15, color: running > 0 ? "var(--dsw-alias-state-business-primary)" : void 0 } }, "⏱" + (jobs.length || "")),
            running > 0 ? h("span", { style: { position: "absolute", top: 2, right: 2, width: 9, height: 9, borderRadius: "50%", background: "var(--dsw-alias-state-business-primary)" } }) : null
          )
        ));
      }
      const activeNorm = activeCwd ? normalizePath(activeCwd) : "";
      const isUnderActive = (workdir) => {
        const w = normalizePath(workdir);
        return w === activeNorm || activeNorm !== "" && w.startsWith(activeNorm + "\\");
      };
      const visibleJobs = onlyActive && el("onlySession") && activeNorm ? jobs.filter((j) => isUnderActive(j.workdir)) : jobs;
      const groups = [];
      const groupMap = /* @__PURE__ */ new Map();
      for (const job of visibleJobs) {
        const wd = job.workdir || t("wd.unknown");
        let g = groupMap.get(wd);
        if (!g) {
          g = [];
          groupMap.set(wd, g);
          groups.push({ wd, jobs: g });
        }
        g.push(job);
      }
      const toggleGroup = (wd) => setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(wd)) next.delete(wd);
        else next.add(wd);
        return next;
      });
      const panelW = size ? size.w : 440;
      const panelH = size ? size.h : Math.min(460, Math.max(190, 120 + visibleJobs.length * 44));
      const foldedH = visibleJobs.length === 0 ? GRIP_H : Math.min(10 + visibleJobs.length * 30, 310);
      const foldedW = Math.max(140, Math.min(panelW, 420));
      const panelStyle = open ? placed(Object.assign({}, rootStyle, {
        width: panelW,
        maxWidth: "92vw",
        height: panelH,
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden"
      })) : placed(Object.assign({}, rootStyle, {
        width: "fit-content",
        minWidth: 140,
        maxWidth: foldedW,
        height: foldedH,
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden"
      }));
      return portalBody(h(
        React.Fragment,
        null,
        renderToasts,
        h(
          "div",
          { ref: panelRef, style: withVisible(panelStyle) },
          open ? h(
            "div",
            { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px 6px 12px", borderBottom: "1px solid var(--dsw-alias-border-l1)", cursor: "grab", touchAction: "none", userSelect: "none" }, onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, title: t("drag.move") },
            h("div", { style: { fontWeight: 700, fontSize: 13 } }, t("panel.title") + (jobs.length ? " (" + jobs.length + ")" : "")),
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 2 } },
              // ⚙ 设置入口：打开 DSH 设置并定位到「后台任务」（受「界面元素」显隐控制）。
              el("settingsButton") ? h(
                CtrlBtn,
                { title: t("gearbtn.title"), onClick: () => {
                  openBgjobsSettings({ label: t("settings.nav") }).then((r) => {
                    if (r === "notfound" || r === "no-trigger") {
                      setToasts((cur) => [...cur, { id: "toast-settings-" + Date.now(), text: t("settings.open.failed") }]);
                    }
                  }).catch(() => {
                    setToasts((cur) => [...cur, { id: "toast-settings-" + Date.now(), text: t("settings.open.failed") }]);
                  });
                } },
                iconEl(IconSettings, "⚙", 14)
              ) : null,
              // 数据齿轮入口：打开 DSH 设置并定位到「MCP 任务」页（受「界面元素」独立开关控制）。
              el("mcpSettingsButton") ? h(
                CtrlBtn,
                { title: t("gearbtn.mcpTitle"), onClick: () => {
                  openBgjobsSettings({ label: t("settings.mcp.nav"), rowId: "bgjobs-mcp" }).then((r) => {
                    if (r === "notfound" || r === "no-trigger") {
                      setToasts((cur) => [...cur, { id: "toast-settings-mcp-" + Date.now(), text: t("settings.open.failed") }]);
                    }
                  }).catch(() => {
                    setToasts((cur) => [...cur, { id: "toast-settings-mcp-" + Date.now(), text: t("settings.open.failed") }]);
                  });
                } },
                iconEl(IconDataOutline16, "🗄", 14)
              ) : null,
              h(
                CtrlBtn,
                { title: t("cleanup.menuTitle"), active: trashOpen, onClick: () => setTrashOpen(!trashOpen) },
                iconEl(IconTrash, "🧹", 14)
              ),
              h(
                CtrlBtn,
                { title: t("collapse.btn.title"), onClick: (e) => {
                  setTrashOpen(false);
                  try {
                    const r = e.currentTarget.getBoundingClientRect();
                    foldAnchorRef.current = { x: r.right + 4, y: r.top };
                  } catch (err) {
                  }
                  setOpen(false);
                } },
                iconEl(IconChevronDown, "▾", 14)
              ),
              h(
                CtrlBtn,
                { title: t("minimize.btn.title"), onClick: (e) => minimizeToBall(e.currentTarget) },
                iconEl(IconClose, "×", 16)
              )
            )
          ) : visibleJobs.length === 0 ? h(
            "div",
            { title: t("fold.grip.title"), onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, onClick: () => {
              if (!draggedRef.current) setOpen(true);
            }, style: { flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", cursor: "grab", touchAction: "none", userSelect: "none" } },
            h(
              "div",
              { style: { display: "flex", gap: 3 } },
              h("span", { style: { width: 4, height: 4, borderRadius: "50%", background: "var(--dsw-alias-border-l2)" } }),
              h("span", { style: { width: 4, height: 4, borderRadius: "50%", background: "var(--dsw-alias-border-l2)" } }),
              h("span", { style: { width: 4, height: 4, borderRadius: "50%", background: "var(--dsw-alias-border-l2)" } })
            )
          ) : h(
            "div",
            { ref: foldListRef, onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, onClick: () => {
              if (!draggedRef.current) setOpen(true);
            }, style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 0", cursor: "grab", touchAction: "none", userSelect: "none" } },
            visibleJobs.map((job) => {
              const sec = listSecondary(job);
              return h(
                "div",
                { key: "f-" + job.id, title: t("row.expand.title"), style: { display: "flex", alignItems: "center", gap: 8, height: 30, padding: "0 28px 0 10px", borderBottom: "1px solid var(--dsw-alias-border-l1)" } },
                h("span", { style: { width: 7, height: 7, borderRadius: "50%", flex: "none", background: stateColor(job) } }),
                // 名称按内容自适应（basis auto），仅当整条宽度触顶 420 时才收缩省略。
                whereOf("name") === "list" ? h("span", { style: { flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 } }, job.name) : null,
                sec.length ? h(
                  "span",
                  { title: sec.map((x) => t("field." + x.key) + ": " + x.text).join(" · "), style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, opacity: 0.55 } },
                  sec.map((x, i) => h("span", { key: x.key }, (i > 0 ? " · " : "") + t("field." + x.key) + " " + x.text))
                ) : null,
                whereOf("status") === "list" ? h("span", { style: { color: stateColor(job), flex: "none", fontSize: 11, fontWeight: 600 } }, stateLabel(job, t)) : null
              );
            }),
            // 右侧显式展开入口（无标题栏时唯一常显箭头）。
            h(
              "div",
              { "data-bgjobs-ctrl": true, title: t("btn.expand.title"), onClick: (e) => {
                e.stopPropagation();
                setOpen(true);
              }, style: { position: "absolute", right: 2, top: 2, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, cursor: "pointer", color: "var(--dsw-alias-label-secondary)" } },
              iconEl(IconChevronDown, "▸", 14)
            )
          ),
          open ? h(
            "div",
            { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" } },
            // 工具栏：仅当前会话过滤 + full access 两个 toggle（文字精简，细节进 tooltip）。
            // 两个开关均可由设置页隐藏；都隐藏时整行不渲染（避免空白）。
            el("onlySession") || el("fullAccess") ? h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 10, padding: "4px 12px 6px", fontSize: 11, opacity: 0.85 } },
              el("onlySession") ? h(Toggle, { checked: onlyActive, onChange: setOnlyActive, title: t("only.session.title"), label: t("only.session") }) : null,
              el("onlySession") && onlyActive && activeCwd ? h("span", { title: activeCwd, style: { opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 } }, activeCwd) : null,
              el("fullAccess") ? h(
                "div",
                { style: { marginLeft: "auto", display: "flex", alignItems: "center" } },
                h(Toggle, { checked: fullAccess, onChange: toggleFullAccess, title: t("full.access.title"), label: t("full.access"), onColor: "var(--dsw-alias-state-warn-primary)" })
              ) : null
            ) : null,
            // 列表区：可滚动；按工作区分组，组头吸顶、可点击折叠。
            h(
              "div",
              { ref: listRef, onScroll: (e) => {
                listScrollRef.current = e.currentTarget.scrollTop;
              }, style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "0 8px 4px" } },
              visibleJobs.length === 0 ? h("div", { style: { opacity: 0.6, padding: 8 } }, jobs.length === 0 ? t("list.empty") : t("list.empty.scope")) : h(
                "div",
                null,
                groups.map((g) => h(
                  "div",
                  { key: "g-" + g.wd },
                  // 分组头（吸顶、可点击折叠）可由设置页隐藏；隐藏后不再折叠该组（始终展开）。
                  el("groupHeader") ? h(
                    "div",
                    { onClick: () => toggleGroup(g.wd), title: collapsed.has(g.wd) ? t("grp.expand") : t("grp.collapse"), style: { position: "sticky", top: 0, zIndex: 1, background: "var(--dsw-alias-bg-layer-3)", padding: "4px 8px", fontSize: 11, fontWeight: 600, opacity: 0.65, borderBottom: "1px solid var(--dsw-alias-border-l1)", cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center" } },
                    h("span", { style: { display: "inline-flex", alignItems: "center", width: 14, flex: "none" } }, collapsed.has(g.wd) ? iconEl(IconChevronRight, "▸", 12) : iconEl(IconChevronDown, "▾", 12)),
                    h("span", { style: { display: "inline-flex", alignItems: "center", marginRight: 4, flex: "none" } }, collapsed.has(g.wd) ? iconEl(IconFolderClose, "📁", 12) : iconEl(IconFolderOpen, "📁", 12)),
                    t("grp.count", { wd: g.wd, count: g.jobs.length })
                  ) : null,
                  el("groupHeader") && collapsed.has(g.wd) ? null : g.jobs.map((job) => {
                    const sec = listSecondary(job);
                    return h(
                      "div",
                      {
                        key: job.id,
                        style: { opacity: trashOpen && job.status !== "done" ? 0.55 : 1, cursor: deletable(job) ? "grab" : "default", touchAction: "none" },
                        onPointerDown: (e) => onJobDown(e, job),
                        onPointerMove: onJobMove,
                        onPointerUp: onJobUp,
                        onPointerCancel: onJobUp,
                        title: deletable(job) ? t("job.trashHint") : void 0
                      },
                      h(
                        "div",
                        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px", borderRadius: 6, cursor: "pointer", background: sel && sel.id === job.id ? "var(--dsw-specific-selector)" : "transparent" }, onClick: () => toggleSelect(job) },
                        h(
                          "div",
                          { style: { minWidth: 0, flex: "1 1 auto" } },
                          whereOf("name") === "list" ? h(
                            "div",
                            { style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                            job.name,
                            // 引擎标签：bat 是默认（不标），pwsh/mcp 标出，便于一眼区分任务类型。
                            job.engine && job.engine !== "bat" ? h("span", { style: { marginLeft: 6, fontSize: 10, fontWeight: 400, padding: "0 4px", borderRadius: 4, verticalAlign: "middle", opacity: 0.75, background: "var(--dsw-specific-selector)" } }, t("engine." + job.engine)) : null
                          ) : null,
                          sec.length ? h(
                            "div",
                            { title: sec.map((x) => t("field." + x.key) + ": " + x.text).join(" · "), style: { opacity: 0.55, fontSize: 11, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                            sec.map((x, i) => h("span", { key: x.key }, (i > 0 ? " · " : "") + t("field." + x.key) + " " + x.text))
                          ) : null
                        ),
                        whereOf("status") === "list" ? h("span", { style: { color: stateColor(job), fontWeight: 600, flex: "none", marginLeft: 8 } }, stateLabel(job, t)) : null
                      ),
                      sel && sel.id === job.id ? h(
                        "div",
                        { style: { padding: "4px 8px 8px" } },
                        h(
                          "div",
                          { style: { display: "flex", justifyContent: "flex-end", alignItems: "center", marginBottom: 4, gap: 8, fontSize: 11, opacity: 0.75 } },
                          // 「已通知/待通知」标记可由设置页隐藏（自动滚动勾选保留）。
                          el("notify") ? h(
                            "span",
                            { title: job.notified ? t("notify.done.title") : t("notify.pending.title"), style: { display: "inline-flex", alignItems: "center", gap: 3, marginRight: "auto", color: job.notified ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-secondary)" } },
                            job.notified ? t("notify.done") : t("notify.pending")
                          ) : null,
                          h("label", null, h("input", { type: "checkbox", checked: follow, onChange: (e) => setFollow(e.target.checked), style: { marginRight: 4 } }), t("follow.scroll"))
                        ),
                        detailKeys.length ? h(
                          "div",
                          { style: { margin: "0 0 6px", fontSize: 11, opacity: 0.85, color: "var(--dsw-alias-label-secondary)" } },
                          detailKeys.map((k) => h(
                            "div",
                            { key: k, style: { display: "flex", gap: 6, alignItems: "flex-start" } },
                            h("span", { style: { flex: "none", opacity: 0.7 } }, t("field." + k) + ":"),
                            k === "command" ? h("span", { style: { whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--dsw-alias-label-primary)" } }, String(job.command || "")) : h("span", { style: { wordBreak: "break-all", color: "var(--dsw-alias-label-primary)" } }, oneLine(fieldText(job, k)) || "-")
                          ))
                        ) : null,
                        // mcp 任务：显示本次执行通道（prewarm=命中预热常驻连接；cold=任务内冷启动）
                        job.channel ? h(
                          "div",
                          { style: { margin: "0 0 6px", fontSize: 11, opacity: 0.85, color: "var(--dsw-alias-label-secondary)" } },
                          t("detail.channel") + "：" + t("channel." + job.channel)
                        ) : null,
                        h("pre", { ref: logRef, style: { margin: 0, padding: 8, background: "var(--dsw-specific-input-major)", borderRadius: 6, maxHeight: 280, overflowY: "auto", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--dsw-alias-label-primary)" } }, renderLogText(job))
                      ) : null
                    );
                  })
                ))
              )
            ),
            // 垃圾篓：仅删除模式（🧹 已开启）时出现；可拖拽已结束任务到此删除，
            // 右侧小按钮批量清理（超 24h / 全部，作用于当前视图）。
            trashOpen ? h(
              "div",
              {
                ref: trashRef,
                style: { margin: "6px 8px", padding: "3px 6px", borderRadius: 6, border: "1px dashed " + (trashHot ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-border-l2)"), background: trashHot ? "var(--dsw-alias-state-error-primary)" : "transparent", color: trashHot ? "var(--dsw-alias-label-primary-inverted)" : "var(--dsw-alias-label-secondary)", display: "flex", alignItems: "center", gap: 6, fontSize: 12, userSelect: "none" }
              },
              h("span", { style: { display: "inline-flex", alignItems: "center", flex: "none" } }, iconEl(IconTrash, "🗑", 12)),
              h("span", { style: { flex: "1 1 auto", minWidth: 0 } }, t("trash.bar")),
              h(
                "span",
                { style: { display: "inline-flex", gap: 4, flex: "none" } },
                h(
                  MiniBtn,
                  { title: t("trash.older.title"), onClick: () => {
                    setTrashOpen(false);
                    cleanupVisible(true);
                  } },
                  iconEl(IconClock, "🕐", 12),
                  t("trash.older")
                ),
                h(
                  MiniBtn,
                  { title: t("trash.all.title"), onClick: () => {
                    setTrashOpen(false);
                    cleanupVisible(false);
                  } },
                  iconEl(IconTrash, "🗑", 12),
                  t("trash.all")
                )
              )
            ) : null
          ) : null,
          // 右下角大小调节手柄（折叠态隐藏）。
          open ? h("div", { style: { position: "absolute", right: 0, bottom: 0, width: 18, height: 18, cursor: "nwse-resize", touchAction: "none", background: "linear-gradient(135deg, transparent 50%, var(--dsw-alias-border-l2) 50%)" }, onPointerDown: onResizeStart, onPointerMove: onResizeMove, onPointerUp: onResizeEnd, onPointerCancel: onResizeEnd, title: t("resize.handle") }) : null
        )
      ));
    }
    module2.exports = { Panel };
  }
});

// lib/client-src/sidebar-action.js
var require_sidebar_action = __commonJS({
  "lib/client-src/sidebar-action.js"(exports2, module2) {
    var React = require("react");
    var h = React.createElement;
    var { makeT } = require_i18n();
    var { iconEl, IconClock } = require_ui();
    var { useMonitorVisible } = require_monitor();
    var { useGuiPrefsEnabled } = require_gui_prefs();
    function BgjobsSidebarAction({ wide, monitor, prefs, t }) {
      if (typeof t !== "function") t = makeT("zh");
      const visible = useMonitorVisible(monitor);
      const enabled = useGuiPrefsEnabled(prefs);
      const [hover, setHover] = React.useState(false);
      if (!enabled) return null;
      const title = visible ? t("footer.hide") : t("footer.show");
      const rowStyle = {
        display: "flex",
        alignItems: "center",
        justifyContent: wide ? "flex-start" : "center",
        gap: 8,
        flex: "none",
        cursor: "pointer",
        borderRadius: 6,
        userSelect: "none",
        background: hover ? "var(--dsw-specific-selector)" : "transparent",
        color: "var(--dsw-alias-label-primary)"
      };
      if (wide) {
        rowStyle.height = 34;
        rowStyle.padding = "0 10px";
      } else {
        rowStyle.width = 34;
        rowStyle.height = 34;
        rowStyle.padding = 0;
      }
      return h(
        "div",
        {
          role: "button",
          tabIndex: 0,
          title,
          "aria-label": title,
          "aria-expanded": visible,
          onClick: () => {
            if (monitor) monitor.toggle();
          },
          onKeyDown: (e) => {
            if (monitor && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              monitor.toggle();
            }
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: rowStyle
        },
        h("span", { style: { display: "inline-flex", flex: "none" } }, iconEl(IconClock, "⏱", 14)),
        wide ? h("span", { style: { fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, t("footer.label")) : null
      );
    }
    module2.exports = { BgjobsSidebarAction };
  }
});

// lib/client-src/settings-section.js
var require_settings_section = __commonJS({
  "lib/client-src/settings-section.js"(exports2, module2) {
    var React = require("react");
    var h = React.createElement;
    var { makeT } = require_i18n();
    var { useGuiPrefsEnabled, useGuiPrefsDisplay, useGuiPrefsElements } = require_gui_prefs();
    var { useMonitorVisible } = require_monitor();
    var DISPLAY_FIELD_KEYS = ["id", "name", "status", "exitCode", "workdir", "command", "createdAt", "finishedAt"];
    var DISPLAY_VALUE_KEYS = ["list", "detail", "hidden"];
    var ELEMENT_KEYS = ["settingsButton", "mcpSettingsButton", "onlySession", "fullAccess", "groupHeader", "notify"];
    var SwitchC = null;
    try {
      SwitchC = require("@deepseek-ai/dsh-client-ui-primitives").Switch;
    } catch (e) {
    }
    var parentDir = (p) => {
      const s = String(p || "").replace(/[\\/]+$/, "");
      const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
      return i > 0 ? s.slice(0, i) : s;
    };
    function SettingsSection({ t, guiPrefs, monitor }) {
      if (typeof t !== "function") t = makeT("zh");
      const entryEnabled = useGuiPrefsEnabled(guiPrefs);
      const panelVisible = useMonitorVisible(monitor);
      const display = useGuiPrefsDisplay(guiPrefs);
      const elements = useGuiPrefsElements(guiPrefs);
      const [displayTab, setDisplayTab] = React.useState("custom");
      const [resetMsg, setResetMsg] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [guiInfo, setGuiInfo] = React.useState(null);
      const [message, setMessage] = React.useState(null);
      React.useEffect(() => {
        let cancelled = false;
        fetch("/bgjobs/gui").then((r) => r.json()).then((d) => {
          if (!cancelled && d && typeof d.path === "string") setGuiInfo(d);
        }).catch(() => {
        });
        return () => {
          cancelled = true;
        };
      }, []);
      const finish = (ok, key, params) => {
        setMessage({ ok, text: t(key, params) });
        setBusy(false);
      };
      const callHost = (action) => fetch("/bgjobs/gui?action=" + action, { method: "POST" }).then(async (r) => {
        let d = null;
        try {
          d = await r.json();
        } catch (e) {
        }
        if (r.ok && d && d.ok) return { ok: true };
        return { ok: false, error: d && (d.error || d.message) || "HTTP " + r.status };
      }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
      const doReveal = async () => {
        if (busy) return;
        if (!guiInfo || !guiInfo.path) {
          setMessage({ ok: false, text: t("settings.gui.failed", { error: "gui path missing" }) });
          return;
        }
        setBusy(true);
        setMessage(null);
        const dir = parentDir(guiInfo.path);
        let res = null;
        try {
          const r = await fetch("/open-in-app/open", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ app: "explorer", path: dir })
          });
          const d = await r.json().catch(() => null);
          if (r.ok && d && d.ok !== false) res = { ok: true };
          else res = { ok: false, error: d && (d.message || d.code) || "HTTP " + r.status };
        } catch (e) {
          res = { ok: false, error: String(e && e.message || e) };
        }
        if (!res.ok) res = await callHost("reveal");
        if (res.ok) finish(true, "settings.gui.openedReveal");
        else finish(false, "settings.gui.failed", { error: res.error });
      };
      const doOpen = async () => {
        if (busy) return;
        setBusy(true);
        setMessage(null);
        const res = await callHost("open");
        if (res.ok) finish(true, "settings.gui.openedHint");
        else finish(false, "settings.gui.failed", { error: res.error });
      };
      const row = { display: "flex", alignItems: "center", gap: 12, padding: "8px 0" };
      const labelCol = { flex: "1 1 auto", minWidth: 0 };
      const labelMain = { fontWeight: 600, fontSize: 13, color: "var(--dsw-alias-label-primary)" };
      const labelSub = { fontSize: 12, opacity: 0.6, marginTop: 2, color: "var(--dsw-alias-label-secondary)" };
      const actBtn = {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        flex: "none",
        padding: "5px 12px",
        borderRadius: 6,
        cursor: busy ? "default" : "pointer",
        fontSize: 12,
        opacity: busy ? 0.6 : 1,
        userSelect: "none",
        background: "var(--dsw-specific-selector)",
        color: "var(--dsw-alias-label-primary)",
        border: "1px solid var(--dsw-alias-border-l2)"
      };
      const keyAct = (fn) => (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          fn();
        }
      };
      const segStyle = (active) => ({
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 40,
        padding: "3px 8px",
        borderRadius: 6,
        cursor: "pointer",
        userSelect: "none",
        fontSize: 12,
        border: "1px solid " + (active ? "transparent" : "var(--dsw-alias-border-l2)"),
        background: active ? "var(--dsw-specific-selector)" : "transparent",
        color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
        fontWeight: active ? 600 : 400
      });
      const tabStyle = (active) => ({
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 12px",
        borderRadius: 6,
        cursor: "pointer",
        userSelect: "none",
        fontSize: 12,
        marginRight: 6,
        border: "1px solid " + (active ? "var(--dsw-alias-border-l2)" : "transparent"),
        background: active ? "var(--dsw-specific-selector)" : "transparent",
        color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
        fontWeight: active ? 600 : 400
      });
      const curDisplay = display || {};
      const curElements = elements || {};
      const defaultDisplay = guiPrefs && typeof guiPrefs.getDefaultDisplay === "function" ? guiPrefs.getDefaultDisplay() : {};
      const defaultElements = guiPrefs && typeof guiPrefs.getDefaultElements === "function" ? guiPrefs.getDefaultElements() : {};
      const doResetDisplay = () => {
        if (guiPrefs && typeof guiPrefs.resetDisplay === "function") guiPrefs.resetDisplay();
        setResetMsg(t("settings.display.resetDone"));
      };
      const fldRow = (f) => {
        const segments = DISPLAY_VALUE_KEYS.map((v) => h("div", {
          key: v,
          role: "button",
          tabIndex: 0,
          title: t("display." + v),
          style: segStyle(curDisplay[f] === v),
          onClick: () => {
            guiPrefs && guiPrefs.setDisplayField(f, v);
          },
          onKeyDown: keyAct(() => {
            guiPrefs && guiPrefs.setDisplayField(f, v);
          })
        }, t("display." + v)));
        return h(
          "div",
          { key: f, style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0" } },
          h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-primary)" } }, t("field." + f)),
          h("div", { style: { display: "flex", gap: 4, flex: "none" } }, segments)
        );
      };
      const elemRow = (k) => {
        const visible = curElements[k] !== false;
        const seg = (val, label) => h("div", {
          key: String(val),
          role: "button",
          tabIndex: 0,
          title: label,
          style: segStyle(visible === val),
          onClick: () => {
            guiPrefs && guiPrefs.setElement(k, val);
          },
          onKeyDown: keyAct(() => {
            guiPrefs && guiPrefs.setElement(k, val);
          })
        }, label);
        return h(
          "div",
          { key: k, style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0" } },
          h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-primary)" } }, t("element." + k)),
          h("div", { style: { display: "flex", gap: 4, flex: "none" } }, [seg(true, t("display.show")), seg(false, t("display.hidden"))])
        );
      };
      return h(
        "div",
        { style: { padding: "4px 0 8px" } },
        h(
          "div",
          { style: { fontSize: 18, fontWeight: 700, color: "var(--dsw-alias-label-primary)" } },
          t("settings.title"),
          guiInfo && guiInfo.version ? h("span", { style: { marginLeft: 8, fontSize: 12, opacity: 0.55, fontWeight: 400, color: "var(--dsw-alias-label-secondary)" } }, "v" + guiInfo.version) : null
        ),
        h("p", { style: { fontSize: 12, opacity: 0.65, margin: "4px 0 12px", color: "var(--dsw-alias-label-secondary)" } }, t("settings.intro")),
        // 行 1：左侧栏显隐按钮（入口）
        h(
          "div",
          { style: row },
          h(
            "div",
            { style: labelCol },
            h("div", { style: labelMain }, t("settings.entryLabel")),
            h("div", { style: labelSub }, t("settings.entryDesc"))
          ),
          SwitchC ? h(SwitchC, { checked: entryEnabled, onChange: (v) => guiPrefs && guiPrefs.setEnabled(!!v), label: t("settings.entryLabel") }) : h(
            "label",
            { style: { display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", flex: "none", fontSize: 13, color: "var(--dsw-alias-label-primary)" } },
            h("input", { type: "checkbox", checked: entryEnabled, onChange: (e) => guiPrefs && guiPrefs.setEnabled(e.target.checked) }),
            entryEnabled ? t("footer.hide") : t("footer.show")
          )
        ),
        // 行 2：监控面板显隐（直接控制面板/悬浮球）
        h(
          "div",
          { style: row },
          h(
            "div",
            { style: labelCol },
            h("div", { style: labelMain }, t("settings.panel")),
            h("div", { style: labelSub }, t("settings.panelDesc"))
          ),
          SwitchC ? h(SwitchC, { checked: panelVisible, onChange: (v) => monitor && monitor.setVisible(!!v), label: t("settings.panel") }) : h(
            "label",
            { style: { display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", flex: "none", fontSize: 13, color: "var(--dsw-alias-label-primary)" } },
            h("input", { type: "checkbox", checked: panelVisible, onChange: (e) => monitor && monitor.setVisible(e.target.checked) }),
            panelVisible ? t("footer.hide") : t("footer.show")
          )
        ),
        // 行 2.5：字段显示（选项卡：自定义配置 / 默认配置 + 一键恢复）
        h(
          "div",
          { style: { padding: "10px 0 4px", borderTop: "1px solid var(--dsw-alias-border-l1)" } },
          h("div", { style: labelMain }, t("settings.display.title")),
          h("div", { style: labelSub }, t("settings.display.desc")),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", margin: "8px 0 2px" } },
            h("div", { role: "tab", tabIndex: 0, "aria-selected": displayTab === "custom", title: t("settings.display.tab.custom"), style: tabStyle(displayTab === "custom"), onClick: () => setDisplayTab("custom"), onKeyDown: keyAct(() => setDisplayTab("custom")) }, t("settings.display.tab.custom")),
            h("div", { role: "tab", tabIndex: 0, "aria-selected": displayTab === "default", title: t("settings.display.tab.default"), style: tabStyle(displayTab === "default"), onClick: () => setDisplayTab("default"), onKeyDown: keyAct(() => setDisplayTab("default")) }, t("settings.display.tab.default"))
          ),
          displayTab === "custom" ? h(
            "div",
            null,
            h("div", { style: Object.assign({}, labelSub, { margin: "6px 0 2px", fontWeight: 600 }) }, t("settings.display.fieldsLabel")),
            DISPLAY_FIELD_KEYS.map((f) => fldRow(f)),
            h("div", { style: Object.assign({}, labelSub, { margin: "10px 0 2px", fontWeight: 600 }) }, t("settings.display.elementsLabel")),
            ELEMENT_KEYS.map((k) => elemRow(k))
          ) : h(
            "div",
            null,
            h("div", { style: Object.assign({}, labelSub, { margin: "8px 0" }) }, t("settings.display.defaultDesc")),
            h("div", { style: Object.assign({}, labelSub, { margin: "6px 0 2px", fontWeight: 600 }) }, t("settings.display.fieldsLabel")),
            DISPLAY_FIELD_KEYS.map((f) => h(
              "div",
              { key: f, style: { display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 12 } },
              h("span", { style: { opacity: 0.75, color: "var(--dsw-alias-label-secondary)" } }, t("field." + f)),
              h("span", { style: { color: "var(--dsw-alias-label-primary)" } }, t("display." + (defaultDisplay[f] || "hidden")))
            )),
            h("div", { style: Object.assign({}, labelSub, { margin: "10px 0 2px", fontWeight: 600 }) }, t("settings.display.elementsLabel")),
            ELEMENT_KEYS.map((k) => h(
              "div",
              { key: k, style: { display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 12 } },
              h("span", { style: { opacity: 0.75, color: "var(--dsw-alias-label-secondary)" } }, t("element." + k)),
              h("span", { style: { color: "var(--dsw-alias-label-primary)" } }, t(defaultElements[k] === false ? "display.hidden" : "display.show"))
            )),
            h("div", { role: "button", tabIndex: 0, title: t("settings.display.reset"), style: Object.assign({}, actBtn, { marginTop: 8 }), onClick: doResetDisplay, onKeyDown: keyAct(doResetDisplay) }, t("settings.display.reset")),
            resetMsg ? h("div", { role: "status", style: { marginTop: 4, fontSize: 12, color: "var(--dsw-alias-state-success-primary)" } }, resetMsg) : null
          )
        ),
        // 行 3：打开离线 GUI
        h(
          "div",
          { style: row },
          h(
            "div",
            { style: labelCol },
            h("div", { style: labelMain }, t("settings.gui.open")),
            h("div", { style: labelSub }, t("settings.gui.openDesc"))
          ),
          h(
            "div",
            { role: "button", tabIndex: 0, title: t("settings.gui.open"), style: actBtn, onClick: doOpen, onKeyDown: keyAct(doOpen) },
            t("settings.gui.open")
          )
        ),
        // 行 4：打开所在文件夹（tools 目录；host explorer.exe 直开，v0.1.68）
        h(
          "div",
          { style: row },
          h(
            "div",
            { style: labelCol },
            h("div", { style: labelMain }, t("settings.gui.reveal")),
            h("div", { style: labelSub }, t("settings.gui.revealDesc"))
          ),
          h(
            "div",
            { role: "button", tabIndex: 0, title: t("settings.gui.reveal"), style: Object.assign({}, actBtn, { background: "transparent" }), onClick: doReveal, onKeyDown: keyAct(doReveal) },
            t("settings.gui.reveal")
          )
        ),
        // 行 5：GUI 脚本路径
        guiInfo && guiInfo.path ? h(
          "div",
          { style: Object.assign({}, row, { paddingTop: 0 }) },
          h(
            "div",
            { style: labelCol },
            h("div", { style: labelSub }, t("settings.gui.path")),
            h("code", { style: { display: "block", fontSize: 12, marginTop: 2, wordBreak: "break-all", color: "var(--dsw-alias-label-primary)" } }, guiInfo.path)
          )
        ) : null,
        message ? h("div", { role: "status", style: { marginTop: 4, fontSize: 12, opacity: 0.85, color: message.ok ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)" } }, message.text) : null
      );
    }
    module2.exports = { SettingsSection };
  }
});

// lib/client-src/mcp-section.js
var require_mcp_section = __commonJS({
  "lib/client-src/mcp-section.js"(exports2, module2) {
    var React = require("react");
    var h = React.createElement;
    var { makeT } = require_i18n();
    var SwitchC = null;
    try {
      SwitchC = require("@deepseek-ai/dsh-client-ui-primitives").Switch;
    } catch (e) {
    }
    var getJson = (url) => fetch(url).then((r) => r.json());
    var postJson = (url, body) => fetch(url, {
      method: "POST",
      ...body === void 0 ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    }).then((r) => r.json().catch(() => null));
    var copyText = (text) => {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard) return navigator.clipboard.writeText(text);
      } catch (e) {
      }
      return Promise.resolve();
    };
    function McpSettings({ t }) {
      if (typeof t !== "function") t = makeT("zh");
      const [enabled, setEnabled] = React.useState(null);
      const [servers, setServers] = React.useState(null);
      const [dsh, setDsh] = React.useState(null);
      const [scope, setScope] = React.useState("active");
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState(null);
      const [tools, setTools] = React.useState({});
      const [formName, setFormName] = React.useState("");
      const [formConfig, setFormConfig] = React.useState("");
      const [editing, setEditing] = React.useState(null);
      const [copied, setCopied] = React.useState("");
      const [exportFmt, setExportFmt] = React.useState("yaml");
      const [exportScope, setExportScope] = React.useState("*");
      const [exportText, setExportText] = React.useState("");
      const [importText, setImportText] = React.useState("");
      const [importMode, setImportMode] = React.useState("skip");
      const [importForce, setImportForce] = React.useState(false);
      const reloadServers = () => getJson("/bgjobs/mcpservers").then((d) => {
        if (d && d.ok) setServers(d.servers || []);
      }).catch(() => {
      });
      const reloadDsh = () => getJson("/bgjobs/dsh-mcp?all=1").then((d) => {
        if (d && d.ok) setDsh(d);
      }).catch(() => {
      });
      React.useEffect(() => {
        let cancelled = false;
        getJson("/bgjobs/mcpprefs").then((d) => {
          if (!cancelled && d) setEnabled(d.enabled === true);
        }).catch(() => {
        });
        reloadServers();
        reloadDsh();
        return () => {
          cancelled = true;
        };
      }, []);
      const act = async (fn) => {
        if (busy) return;
        setBusy(true);
        setMsg(null);
        try {
          await fn();
        } finally {
          setBusy(false);
        }
      };
      const fail = (e) => setMsg({ ok: false, text: t("settings.mcp.failed", { error: e && e.message || String(e) }) });
      const doToggle = (next) => act(async () => {
        const d = await postJson("/bgjobs/mcpprefs?enabled=" + (next ? "1" : "0"));
        if (d && d.ok) {
          setEnabled(d.enabled === true);
          setMsg({ ok: true, text: d.enabled ? t("settings.mcp.on") : t("settings.mcp.off") });
        } else {
          setMsg({ ok: false, text: t("settings.mcp.failed", { error: d && d.error || "HTTP" }) });
        }
      });
      const doSave = () => act(async () => {
        const name = formName.trim();
        if (!name) {
          setMsg({ ok: false, text: t("settings.mcp.nameRequired") });
          return;
        }
        let config = null;
        try {
          config = JSON.parse(formConfig);
        } catch (e) {
          config = null;
        }
        if (config === null || typeof config !== "object") {
          setMsg({ ok: false, text: t("settings.mcp.saveFailed", { error: "config must be a JSON object" }) });
          return;
        }
        const d = await postJson("/bgjobs/mcpservers", { name, config });
        if (d && d.ok) {
          setMsg({ ok: true, text: t("settings.mcp.saved", { name: d.name }) });
          setFormConfig("");
          setEditing(null);
          await reloadServers();
        } else {
          setMsg({ ok: false, text: t("settings.mcp.saveFailed", { error: d && d.error || "HTTP" }) });
        }
      });
      const doEdit = (name) => act(async () => {
        const d = await getJson("/bgjobs/mcpservers?name=" + encodeURIComponent(name));
        if (!d || !d.ok) {
          setMsg({ ok: false, text: t("settings.mcp.failed", { error: d && d.error || "HTTP" }) });
          return;
        }
        setFormName(name);
        setFormConfig(JSON.stringify(d.config, null, 2));
        setEditing(name);
        setMsg({ ok: true, text: t("settings.mcp.editLoaded", { name }) });
      });
      const cancelEdit = () => {
        setEditing(null);
        setFormName("");
        setFormConfig("");
      };
      const doSetMode = (name, mode) => act(async () => {
        const q = mode === "prewarm" ? "&enabled=1&prewarm=1" : mode === "cold" ? "&enabled=1&prewarm=0" : "&enabled=0";
        const d = await postJson("/bgjobs/mcpservers?name=" + encodeURIComponent(name) + q);
        if (d && d.ok) await reloadServers();
        else setMsg({ ok: false, text: t("settings.mcp.failed", { error: d && d.error || "HTTP" }) });
      });
      const doDelete = (name) => act(async () => {
        const d = await postJson("/bgjobs/mcpservers?name=" + encodeURIComponent(name) + "&delete=1");
        if (d && d.ok) {
          setMsg({ ok: true, text: t("settings.mcp.deleted", { name }) });
          if (editing === name) cancelEdit();
          await reloadServers();
        } else {
          setMsg({ ok: false, text: t("settings.mcp.failed", { error: d && d.error || "HTTP" }) });
        }
      });
      const doProbe = (name) => act(async () => {
        const d = await postJson("/bgjobs/mcpservers?name=" + encodeURIComponent(name) + "&probe=1");
        if (d && d.ok) {
          setTools((prev) => ({ ...prev, [name]: { tools: d.tools || [], source: d.source, channel: d.channel } }));
        } else {
          const error = d && d.error || "HTTP";
          setTools((prev) => ({ ...prev, [name]: { error } }));
          setMsg({ ok: false, text: t("settings.mcp.toolsFailed", { error }) });
        }
      });
      const doExport = () => act(async () => {
        const url = "/bgjobs/mcpservers?export=" + exportFmt + "&name=" + encodeURIComponent(exportScope);
        const d = await getJson(url);
        if (d && d.ok) {
          setExportText(d.text || "");
          setMsg({ ok: true, text: t("settings.mcp.exportDone", { count: (d.names || []).length, format: d.format }) });
        } else {
          setMsg({ ok: false, text: t("settings.mcp.failed", { error: d && d.error || "HTTP" }) });
        }
      });
      const doImport = () => act(async () => {
        if (importText.trim().length === 0) {
          setMsg({ ok: false, text: t("settings.mcp.importEmpty") });
          return;
        }
        const d = await postJson("/bgjobs/mcpservers?import=1", { text: importText, mode: importMode, force: importForce });
        if (!d || !d.ok) {
          setMsg({ ok: false, text: t("settings.mcp.importFailed", { error: d && d.error || "HTTP" }) });
          return;
        }
        const parts = [t("settings.mcp.importDone", { source: d.source })];
        if (d.imported.length > 0) parts.push(t("settings.dsh.imported", { names: d.imported.join(", ") }));
        if (d.skipped.length > 0) parts.push(t("settings.dsh.skipped", { names: d.skipped.map((s) => s.name).join(", ") }));
        if (d.rejected.length > 0) parts.push(t("settings.dsh.rejected", { names: d.rejected.map((s) => s.name).join(", ") }));
        setMsg({ ok: d.imported.length > 0, text: parts.join(" · ") });
        await reloadServers();
      });
      const doImportDsh = (name) => act(async () => {
        const scopeParam = scope === "active" ? "active" : scope === "global" ? "global" : "profile:" + scope;
        const url = "/bgjobs/dsh-mcp?action=import&scope=" + encodeURIComponent(scopeParam) + "&name=" + encodeURIComponent(name);
        const d = await postJson(url);
        if (!d || !d.ok) {
          setMsg({ ok: false, text: t("settings.dsh.importFailed", { error: d && d.error || "HTTP" }) });
          return;
        }
        const parts = [];
        if (d.imported.length > 0) parts.push(t("settings.dsh.imported", { names: d.imported.join(", ") }));
        if (d.skipped.length > 0) parts.push(t("settings.dsh.skipped", { names: d.skipped.map((s) => s.name).join(", ") }));
        if (d.rejected.length > 0) parts.push(t("settings.dsh.rejected", { names: d.rejected.map((s) => s.name).join(", ") }));
        setMsg({ ok: d.imported.length > 0, text: parts.join(" · ") || t("settings.dsh.none") });
        await reloadServers();
        await reloadDsh();
      });
      const labelMain = { fontWeight: 600, fontSize: 13, color: "var(--dsw-alias-label-primary)" };
      const labelSub = { fontSize: 12, opacity: 0.6, marginTop: 2, color: "var(--dsw-alias-label-secondary)" };
      const block = { padding: "10px 0 4px", borderTop: "1px solid var(--dsw-alias-border-l1)" };
      const actBtn = {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        flex: "none",
        padding: "4px 10px",
        borderRadius: 6,
        cursor: busy ? "default" : "pointer",
        fontSize: 12,
        opacity: busy ? 0.6 : 1,
        userSelect: "none",
        background: "var(--dsw-specific-selector)",
        color: "var(--dsw-alias-label-primary)",
        border: "1px solid var(--dsw-alias-border-l2)"
      };
      const ghostBtn = Object.assign({}, actBtn, { background: "transparent" });
      const keyAct = (fn) => (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          fn();
        }
      };
      const srvRow = { display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0", borderTop: "1px dashed var(--dsw-alias-border-l1)" };
      const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11, wordBreak: "break-all" };
      const input = {
        fontSize: 12,
        padding: "4px 8px",
        borderRadius: 6,
        color: "var(--dsw-alias-label-primary)",
        background: "var(--dsw-alias-bg-base)",
        border: "1px solid var(--dsw-alias-border-l2)"
      };
      const textarea = Object.assign({}, mono, {
        width: "100%",
        minHeight: 96,
        padding: 8,
        borderRadius: 6,
        resize: "vertical",
        color: "var(--dsw-alias-label-primary)",
        background: "var(--dsw-specific-input-major)",
        border: "1px solid var(--dsw-alias-border-l2)",
        boxSizing: "border-box"
      });
      const btn = (key, label, fn, style) => h("div", {
        key,
        role: "button",
        tabIndex: 0,
        title: label,
        style: style || actBtn,
        onClick: fn,
        onKeyDown: keyAct(fn)
      }, label);
      const switchEl = (checked, onChange, label) => SwitchC ? h(SwitchC, { checked, onChange, label }) : h(
        "label",
        { style: { display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", flex: "none", fontSize: 13, color: "var(--dsw-alias-label-primary)" } },
        h("input", { type: "checkbox", checked, onChange: (e) => onChange(e.target.checked) })
      );
      const modeBtn = (active, tone, key, label, title, fn) => h("div", {
        key,
        role: "button",
        tabIndex: 0,
        title,
        "aria-pressed": active ? "true" : "false",
        style: Object.assign({}, actBtn, {
          padding: "2px 8px",
          fontSize: 11,
          background: active ? "var(--dsw-specific-selector)" : "transparent",
          border: "1px solid " + (active ? tone : "var(--dsw-alias-border-l1)"),
          color: active ? tone : "var(--dsw-alias-label-secondary)",
          fontWeight: active ? 600 : 400,
          opacity: active ? 1 : 0.6
        }),
        onClick: fn,
        onKeyDown: keyAct(fn)
      }, label);
      const MODE_TONE = {
        prewarm: "var(--dsw-alias-state-warn-label)",
        cold: "var(--dsw-alias-state-success-primary)",
        disabled: "var(--dsw-alias-label-secondary)"
      };
      const modeOf = (s) => s.enabled === false ? "disabled" : s.prewarm === true ? "prewarm" : "cold";
      const currentScopeData = (() => {
        if (!dsh) return null;
        const scopeName = scope === "active" ? dsh.activeProfile : scope === "global" ? "global" : scope;
        if (!scopeName) return null;
        return (dsh.scopes || []).find((s) => s.scope === scopeName) || null;
      })();
      const existing = new Set(dsh && dsh.existing || []);
      const scopeOptions = () => [
        h("option", { key: "active", value: "active" }, t("settings.dsh.scopeActive") + (dsh && dsh.activeProfile ? "（" + dsh.activeProfile + "）" : "")),
        h("option", { key: "global", value: "global" }, t("settings.dsh.scopeGlobal")),
        ...(dsh && dsh.profiles || []).filter((p) => !dsh || p !== dsh.activeProfile).map((p) => h("option", { key: p, value: p }, "profile：" + p))
      ];
      return h(
        "div",
        { style: { padding: "4px 0 8px" } },
        h("div", { style: { fontSize: 18, fontWeight: 700, color: "var(--dsw-alias-label-primary)" } }, t("settings.mcp.title")),
        h("p", { style: { fontSize: 12, opacity: 0.65, margin: "4px 0 12px", color: "var(--dsw-alias-label-secondary)" } }, t("settings.mcp.intro")),
        // ── 1) 总开关 ──
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, padding: "4px 0 2px" } },
          switchEl(enabled === true, doToggle, t("settings.mcp.switchTitle")),
          h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, enabled === true ? t("settings.mcp.on") : t("settings.mcp.off"))
        ),
        h("div", { style: Object.assign({}, labelSub, { marginTop: 2 }) }, t("settings.mcp.switchDesc")),
        // ── 2) MCP 服务器 ──
        h(
          "div",
          { style: block },
          h("div", { style: labelMain }, t("settings.mcp.servers")),
          h("div", { style: labelSub }, t("settings.mcp.serversDesc")),
          h("div", { style: Object.assign({}, labelSub, { marginTop: 4, opacity: 0.75 }) }, t("settings.mcp.modeHint")),
          h("div", { style: Object.assign({}, labelSub, { marginTop: 4, opacity: 0.75 }) }, t("settings.mcp.prewarmHint")),
          servers === null ? null : servers.length === 0 ? h("div", { style: Object.assign({}, labelSub, { padding: "6px 0" }) }, t("settings.mcp.empty")) : servers.map((s) => h(
            "div",
            { key: s.name, style: srvRow },
            h(
              "div",
              { style: { flex: "1 1 auto", minWidth: 0 } },
              h(
                "div",
                { style: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } },
                s.name,
                h("span", { style: { marginLeft: 6, fontWeight: 400, opacity: 0.6 } }, "· " + s.transport),
                s.warm ? h("span", { style: { marginLeft: 6, fontWeight: 400, color: "var(--dsw-alias-state-success-primary)" } }, t("settings.mcp.warm")) : null,
                s.toolCount !== null && s.toolCount !== void 0 ? h("span", { style: { marginLeft: 6, fontWeight: 400, opacity: 0.6 } }, t("settings.mcp.toolsCount", { count: s.toolCount, source: s.toolSource || "-" })) : null
              ),
              h("div", { style: Object.assign({}, mono, { opacity: 0.7, marginTop: 2 }) }, s.target || "-"),
              s.envKeys && s.envKeys.length > 0 ? h("div", { style: Object.assign({}, mono, { opacity: 0.5 }) }, "env: " + s.envKeys.join(", ")) : null,
              s.headerKeys && s.headerKeys.length > 0 ? h("div", { style: Object.assign({}, mono, { opacity: 0.5 }) }, "headers: " + s.headerKeys.join(", ")) : null,
              s.lastError ? h("div", { style: { fontSize: 11, marginTop: 2, color: "var(--dsw-alias-state-error-primary)" } }, s.lastError) : null,
              tools[s.name] ? h(
                "div",
                { style: { marginTop: 4 } },
                tools[s.name].error ? h("div", { style: { fontSize: 11, color: "var(--dsw-alias-state-error-primary)" } }, t("settings.mcp.toolsFailed", { error: tools[s.name].error })) : h(
                  "div",
                  { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                  (tools[s.name].tools || []).map((tool) => h("span", {
                    key: tool.name,
                    role: "button",
                    tabIndex: 0,
                    title: t("settings.mcp.copyTool") + "：" + tool.name + (tool.description ? " — " + tool.description : ""),
                    style: Object.assign({}, mono, { padding: "1px 6px", borderRadius: 4, cursor: "pointer", background: "var(--dsw-specific-selector)" }),
                    onClick: () => {
                      copyText(tool.name);
                      setCopied(tool.name);
                    },
                    onKeyDown: keyAct(() => {
                      copyText(tool.name);
                      setCopied(tool.name);
                    })
                  }, tool.name))
                ),
                copied && (tools[s.name].tools || []).some((x) => x.name === copied) ? h("div", { style: { fontSize: 11, marginTop: 2, color: "var(--dsw-alias-state-success-primary)" } }, t("settings.mcp.copied", { name: copied })) : null
              ) : null
            ),
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 4, flex: "none", alignItems: "flex-end" } },
              h(
                "div",
                { style: { display: "flex", gap: 4, alignItems: "center" } },
                ["prewarm", "cold", "disabled"].map((m) => modeBtn(
                  modeOf(s) === m,
                  MODE_TONE[m],
                  m,
                  t(m === "prewarm" ? "settings.mcp.prewarm" : m === "cold" ? "settings.mcp.modeCold" : "settings.mcp.modeDisabled"),
                  t("settings.mcp.modeTitle" + m.charAt(0).toUpperCase() + m.slice(1)),
                  () => doSetMode(s.name, m)
                ))
              ),
              btn("edit", t("settings.mcp.edit"), () => doEdit(s.name), ghostBtn),
              btn("list", t("settings.mcp.listTools"), () => doProbe(s.name), ghostBtn),
              btn("del", t("settings.mcp.delete"), () => doDelete(s.name), ghostBtn)
            )
          )),
          // 新增 / 编辑表单
          h(
            "div",
            { style: { marginTop: 8 } },
            h(
              "div",
              { style: Object.assign({}, labelSub, { fontWeight: 600 }) },
              editing ? t("settings.mcp.editing", { name: editing }) : t("settings.mcp.add")
            ),
            h(
              "div",
              { style: { display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" } },
              h("input", {
                style: Object.assign({}, input, { flex: "0 0 160px" }),
                placeholder: t("settings.mcp.namePlaceholder"),
                value: formName,
                onChange: (e) => setFormName(e.target.value)
              }),
              h("input", {
                style: Object.assign({}, input, { flex: "1 1 320px" }),
                placeholder: t("settings.mcp.configPlaceholder"),
                value: formConfig,
                onChange: (e) => setFormConfig(e.target.value)
              }),
              editing ? btn("save", t("settings.mcp.saveChanges"), doSave) : btn("save", t("settings.mcp.save"), doSave),
              editing ? btn("cancel", t("settings.mcp.cancelEdit"), cancelEdit, ghostBtn) : null
            )
          ),
          h("div", { style: Object.assign({}, labelSub, { marginTop: 4, opacity: 0.75 }) }, t("settings.mcp.secretHint"))
        ),
        // ── 3) 导出 / 导入 ──
        h(
          "div",
          { style: block },
          h("div", { style: labelMain }, t("settings.mcp.exportTitle")),
          h("div", { style: labelSub }, t("settings.mcp.exportDesc")),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" } },
            h("span", { style: Object.assign({}, labelSub, { marginTop: 0 }) }, t("settings.mcp.exportFormat")),
            h("select", { style: Object.assign({}, input, { minWidth: 120 }), value: exportFmt, onChange: (e) => setExportFmt(e.target.value) }, [
              h("option", { key: "yaml", value: "yaml" }, t("settings.mcp.exportFmtDsh")),
              h("option", { key: "json", value: "json" }, t("settings.mcp.exportFmtNative"))
            ]),
            h("span", { style: Object.assign({}, labelSub, { marginTop: 0 }) }, t("settings.mcp.exportScope")),
            h("select", { style: Object.assign({}, input, { minWidth: 140 }), value: exportScope, onChange: (e) => setExportScope(e.target.value) }, [
              h("option", { key: "*", value: "*" }, t("settings.mcp.exportAll")),
              ...(servers || []).map((s) => h("option", { key: s.name, value: s.name }, s.name))
            ]),
            btn("export", t("settings.mcp.export"), doExport)
          ),
          exportText.length > 0 ? h(
            "div",
            { style: { marginTop: 6 } },
            h("textarea", { style: textarea, readOnly: true, value: exportText }),
            h(
              "div",
              { style: { display: "flex", gap: 6, marginTop: 4 } },
              btn("copy", t("settings.mcp.copy"), () => {
                copyText(exportText);
                setMsg({ ok: true, text: t("settings.mcp.copiedText") });
              }, ghostBtn)
            )
          ) : null
        ),
        h(
          "div",
          { style: block },
          h("div", { style: labelMain }, t("settings.mcp.importTitle")),
          h("div", { style: labelSub }, t("settings.mcp.importDesc")),
          h(
            "div",
            { style: { marginTop: 6 } },
            h("textarea", {
              style: textarea,
              placeholder: t("settings.mcp.importPlaceholder"),
              value: importText,
              onChange: (e) => setImportText(e.target.value)
            })
          ),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" } },
            h("input", {
              type: "file",
              accept: ".yml,.yaml,.json,.txt",
              style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
              onChange: (e) => {
                const f = e.target.files && e.target.files[0];
                if (!f) return;
                Promise.resolve(f.text()).then(setImportText).catch(fail);
              }
            }),
            h("select", { style: Object.assign({}, input, { minWidth: 130 }), value: importMode, onChange: (e) => setImportMode(e.target.value) }, [
              h("option", { key: "skip", value: "skip" }, t("settings.mcp.importModeSkip")),
              h("option", { key: "overwrite", value: "overwrite" }, t("settings.mcp.importModeOverwrite"))
            ]),
            h(
              "label",
              { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--dsw-alias-label-secondary)" } },
              h("input", { type: "checkbox", checked: importForce, onChange: (e) => setImportForce(e.target.checked) }),
              t("settings.mcp.importForce")
            ),
            btn("import", t("settings.mcp.import"), doImport)
          )
        ),
        // ── 4) DSH 已有 MCP ──
        h(
          "div",
          { style: block },
          h("div", { style: labelMain }, t("settings.dsh.title")),
          h("div", { style: labelSub }, dsh === null ? t("settings.dsh.loading") : dsh.activeProfile ? t("settings.dsh.profile", { name: dsh.activeProfile, by: dsh.detectedBy }) : t("settings.dsh.profileUnknown", { reason: dsh.reason || "-" })),
          dsh === null ? null : h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" } },
            h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, t("settings.dsh.scope")),
            h("select", { style: Object.assign({}, input, { minWidth: 160 }), value: scope, onChange: (e) => setScope(e.target.value) }, scopeOptions()),
            btn("all", t("settings.dsh.importAll"), () => doImportDsh("*"), ghostBtn)
          ),
          dsh === null ? null : currentScopeData === null ? h("div", { style: Object.assign({}, labelSub, { padding: "6px 0" }) }, t("settings.dsh.unavailable")) : currentScopeData.exists === false ? h("div", { style: Object.assign({}, labelSub, { padding: "6px 0" }) }, t("settings.dsh.noFile")) : (currentScopeData.servers || []).length === 0 ? h("div", { style: Object.assign({}, labelSub, { padding: "6px 0" }) }, t("settings.dsh.none")) : (currentScopeData.servers || []).map((s) => h(
            "div",
            { key: s.serverName, style: srvRow },
            h(
              "div",
              { style: { flex: "1 1 auto", minWidth: 0 } },
              h(
                "div",
                { style: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } },
                s.serverName,
                h("span", { style: { marginLeft: 6, fontWeight: 400, opacity: 0.6 } }, "· " + s.transport),
                s.enabled === false ? h("span", { style: { marginLeft: 6, fontWeight: 400, opacity: 0.6 } }, t("settings.dsh.disabled")) : null,
                existing.has(s.serverName) ? h("span", { style: { marginLeft: 6, fontWeight: 400, color: "var(--dsw-alias-state-success-primary)" } }, t("settings.dsh.registered")) : null
              ),
              h("div", { style: Object.assign({}, mono, { opacity: 0.7, marginTop: 2 }) }, s.transport === "stdio" ? String(s.config && s.config.command || "") : String(s.config && s.config.url || "")),
              s.needsAttention ? h("div", { style: { fontSize: 11, marginTop: 2, color: "var(--dsw-alias-state-error-primary)" } }, t("settings.dsh.needsAttention")) : null
            ),
            h(
              "div",
              { style: { flex: "none" } },
              btn("import", t("settings.dsh.import"), () => doImportDsh(s.serverName), ghostBtn)
            )
          )),
          h("div", { style: Object.assign({}, labelSub, { marginTop: 4 }) }, t("settings.dsh.hint"))
        ),
        msg ? h("div", {
          role: "status",
          style: { marginTop: 6, fontSize: 12, color: msg.ok ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)" }
        }, msg.text) : null
      );
    }
    module2.exports = { McpSettings };
  }
});

// lib/client-src/apply.js
var require_apply = __commonJS({
  "lib/client-src/apply.js"(exports2, module2) {
    var h = require("react").createElement;
    var { makeT, NS, ZH, EN } = require_i18n();
    var { Panel } = require_panel();
    var { BgjobsSidebarAction } = require_sidebar_action();
    var { SettingsSection } = require_settings_section();
    var { McpSettings } = require_mcp_section();
    var { createMonitorStore } = require_monitor();
    var { createGuiPrefsStore, loadGuiPrefs } = require_gui_prefs();
    function apply2(ctx) {
      const slots = ctx.get("slots");
      if (slots === void 0) return;
      let sessions = void 0;
      try {
        sessions = ctx.get("sessions");
      } catch (e) {
      }
      const getSessions = () => {
        try {
          return ctx.get("sessions");
        } catch (e) {
          return void 0;
        }
      };
      let locale = void 0;
      try {
        locale = ctx.get("locale");
      } catch (e) {
      }
      if (locale && typeof locale.register === "function") {
        ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), "bgjobs: dictionaries");
      }
      const monitor = createMonitorStore(true);
      const guiPrefs = createGuiPrefsStore(false);
      loadGuiPrefs(guiPrefs);
      const entry = { name: "shell.overlay", id: "bgjobs-monitor", order: 50, label: "bgjobs" };
      if (locale) entry.locale = NS;
      slots.inject("shell.overlay", () => slots.register(entry, (props) => h(Panel, {
        sessions,
        getSessions,
        t: props && props.t || makeT("zh"),
        monitor,
        guiPrefs
      })));
      const footerEntry = { name: "sidebar.footer.action", id: "bgjobs-monitor-toggle", order: 60, label: "bgjobs" };
      if (locale) footerEntry.locale = NS;
      slots.inject("sidebar.footer.action", () => slots.register(footerEntry, (props) => h(BgjobsSidebarAction, {
        wide: !!(props && props.wide),
        monitor,
        prefs: guiPrefs,
        t: props && props.t || makeT("zh")
      })));
      const bindNavT = () => {
        if (locale && typeof locale.bind === "function") {
          try {
            return locale.bind(NS);
          } catch (e) {
          }
        }
        return makeT("zh");
      };
      const settingsEntry = { name: "settings.section", id: "bgjobs", order: 30, label: () => bindNavT()("settings.nav") };
      if (locale) settingsEntry.locale = NS;
      slots.inject("settings.section", () => slots.register(settingsEntry, (props) => h(SettingsSection, {
        guiPrefs,
        monitor,
        t: props && props.t || makeT("zh")
      })));
      const mcpEntry = { name: "settings.section", id: "bgjobs-mcp", order: 31, label: () => bindNavT()("settings.mcp.nav") };
      if (locale) mcpEntry.locale = NS;
      slots.inject("settings.section", () => slots.register(mcpEntry, (props) => h(McpSettings, {
        t: props && props.t || makeT("zh")
      })));
    }
    module2.exports = { apply: apply2 };
  }
});

// lib/client-src/index.js
var { apply } = require_apply();
module.exports = { name: "bgjobs-client", inject: ["slots"], apply };

return module.exports;
} });
