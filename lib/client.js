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
      "settings.gui.revealDesc": "在文件资源管理器中打开离线工具所在目录（tools），方便找 dsh-bgjobs-gui.bat 或建快捷方式。"
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
      "settings.gui.revealDesc": "Reveal the offline tools folder in File Explorer (find dsh-bgjobs-gui.bat or pin a shortcut)."
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
    module2.exports = { stateColor, stateLabel, normalizePath, readActiveCwd, PANEL_Z, TOAST_Z, DONE_AGE_MS, GRIP_H, ToastComponent, iconEl, IconTrash, IconClock, IconClose, IconChevronDown, IconChevronRight, IconFolderOpen, IconFolderClose, SelfToast, CtrlBtn, MiniBtn, Toggle, portalBody, clampToViewport };
  }
});

// lib/client-src/panel.js
var require_panel = __commonJS({
  "lib/client-src/panel.js"(exports2, module2) {
    var React = require("react");
    var h = React.createElement;
    var { makeT } = require_i18n();
    var { useMonitorVisible } = require_monitor();
    var { stateColor, stateLabel, normalizePath, readActiveCwd, DONE_AGE_MS, PANEL_Z, TOAST_Z, GRIP_H, ToastComponent, iconEl, IconTrash, IconClock, IconClose, IconChevronDown, IconChevronRight, IconFolderOpen, IconFolderClose, SelfToast, CtrlBtn, MiniBtn, Toggle, portalBody, clampToViewport } = require_ui();
    function Panel({ sessions: sessionsProp, getSessions, t, monitor }) {
      if (typeof t !== "function") t = makeT("zh");
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
      }, [jobs]);
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
            const el = minimized ? ballRef.current : panelRef.current;
            if (!el) return prev;
            const r = el.getBoundingClientRect();
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
        const el = panelRef.current;
        if (!anchor || !el) return;
        const r = el.getBoundingClientRect();
        const c = clampToViewport(anchor.x - r.width, anchor.y, r.width, r.height);
        setPos(c);
        foldAnchorRef.current = null;
      }, [open, minimized]);
      const startDrag = (e) => {
        if (e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest("[data-bgjobs-ctrl]")) return;
        const el = minimized ? ballRef.current : panelRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
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
      const placed = (el) => {
        if (pos) {
          el.left = pos.x;
          el.top = pos.y;
        } else {
          el.right = 16;
          el.bottom = 16;
        }
        return el;
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
      const visibleJobs = onlyActive && activeNorm ? jobs.filter((j) => isUnderActive(j.workdir)) : jobs;
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
            { onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, onClick: () => {
              if (!draggedRef.current) setOpen(true);
            }, style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 0", cursor: "grab", touchAction: "none", userSelect: "none" } },
            visibleJobs.map((job) => h(
              "div",
              { key: "f-" + job.id, title: t("row.expand.title"), style: { display: "flex", alignItems: "center", gap: 8, height: 30, padding: "0 28px 0 10px", borderBottom: "1px solid var(--dsw-alias-border-l1)" } },
              h("span", { style: { width: 7, height: 7, borderRadius: "50%", flex: "none", background: stateColor(job) } }),
              // 名称按内容自适应（basis auto），仅当整条宽度触顶 420 时才收缩省略。
              h("span", { style: { flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 } }, job.name),
              h("span", { style: { color: stateColor(job), flex: "none", fontSize: 11, fontWeight: 600 } }, stateLabel(job, t))
            )),
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
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 10, padding: "4px 12px 6px", fontSize: 11, opacity: 0.85 } },
              h(Toggle, { checked: onlyActive, onChange: setOnlyActive, title: t("only.session.title"), label: t("only.session") }),
              onlyActive && activeCwd ? h("span", { title: activeCwd, style: { opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 } }, activeCwd) : null,
              h(
                "div",
                { style: { marginLeft: "auto", display: "flex", alignItems: "center" } },
                h(Toggle, { checked: fullAccess, onChange: toggleFullAccess, title: t("full.access.title"), label: t("full.access"), onColor: "var(--dsw-alias-state-warn-primary)" })
              )
            ),
            // 列表区：可滚动；按工作区分组，组头吸顶、可点击折叠。
            h(
              "div",
              { style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "0 8px 4px" } },
              visibleJobs.length === 0 ? h("div", { style: { opacity: 0.6, padding: 8 } }, jobs.length === 0 ? t("list.empty") : t("list.empty.scope")) : h(
                "div",
                null,
                groups.map((g) => h(
                  "div",
                  { key: "g-" + g.wd },
                  h(
                    "div",
                    { onClick: () => toggleGroup(g.wd), title: collapsed.has(g.wd) ? t("grp.expand") : t("grp.collapse"), style: { position: "sticky", top: 0, zIndex: 1, background: "var(--dsw-alias-bg-layer-3)", padding: "4px 8px", fontSize: 11, fontWeight: 600, opacity: 0.65, borderBottom: "1px solid var(--dsw-alias-border-l1)", cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center" } },
                    h("span", { style: { display: "inline-flex", alignItems: "center", width: 14, flex: "none" } }, collapsed.has(g.wd) ? iconEl(IconChevronRight, "▸", 12) : iconEl(IconChevronDown, "▾", 12)),
                    h("span", { style: { display: "inline-flex", alignItems: "center", marginRight: 4, flex: "none" } }, collapsed.has(g.wd) ? iconEl(IconFolderClose, "📁", 12) : iconEl(IconFolderOpen, "📁", 12)),
                    t("grp.count", { wd: g.wd, count: g.jobs.length })
                  ),
                  collapsed.has(g.wd) ? null : g.jobs.map((job) => h(
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
                      h("div", null, h("div", { style: { fontWeight: 600 } }, job.name), h("div", { style: { opacity: 0.55, fontSize: 11, marginTop: 2 } }, job.workdir)),
                      h("span", { style: { color: stateColor(job), fontWeight: 600 } }, stateLabel(job, t))
                    ),
                    sel && sel.id === job.id ? h(
                      "div",
                      { style: { padding: "4px 8px 8px" } },
                      h(
                        "div",
                        { style: { display: "flex", justifyContent: "flex-end", alignItems: "center", marginBottom: 4, gap: 8, fontSize: 11, opacity: 0.75 } },
                        h(
                          "span",
                          { title: job.notified ? t("notify.done.title") : t("notify.pending.title"), style: { display: "inline-flex", alignItems: "center", gap: 3, marginRight: "auto", color: job.notified ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-secondary)" } },
                          job.notified ? t("notify.done") : t("notify.pending")
                        ),
                        h("label", null, h("input", { type: "checkbox", checked: follow, onChange: (e) => setFollow(e.target.checked), style: { marginRight: 4 } }), t("follow.scroll"))
                      ),
                      h("pre", { ref: logRef, style: { margin: 0, padding: 8, background: "var(--dsw-specific-input-major)", borderRadius: 6, maxHeight: 280, overflowY: "auto", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--dsw-alias-label-primary)" } }, job.tail || (job.status === "done" ? logExtra[job.id] ? logExtra[job.id].loading ? t("log.loading") : logExtra[job.id].text || t("log.none") : t("log.none") : t("log.waiting")))
                    ) : null
                  ))
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

// lib/client-src/gui-prefs.js
var require_gui_prefs = __commonJS({
  "lib/client-src/gui-prefs.js"(exports2, module2) {
    var React = require("react");
    function createGuiPrefsStore(initialEnabled = false) {
      let enabled = !!initialEnabled;
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
      return {
        getEnabled: () => enabled,
        setEnabled: (next) => set(next, true),
        apply: (next) => set(next, false),
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
        if (d && typeof d.sidebarEntry === "boolean") store.apply(d.sidebarEntry);
      }).catch(() => {
      });
    }
    function useGuiPrefsEnabled(store) {
      const subscribe = React.useCallback((cb) => store ? store.subscribe(cb) : () => {
      }, [store]);
      const getSnapshot = React.useCallback(() => store ? store.getEnabled() : false, [store]);
      return React.useSyncExternalStore(subscribe, getSnapshot);
    }
    module2.exports = { createGuiPrefsStore, loadGuiPrefs, useGuiPrefsEnabled };
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
    var { useGuiPrefsEnabled } = require_gui_prefs();
    var { useMonitorVisible } = require_monitor();
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
        if (!res.ok) {
          res = await callHost("reveal");
        }
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
        // 行 4：打开所在文件夹（tools 目录；优先官方 open-in-app）
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

// lib/client-src/apply.js
var require_apply = __commonJS({
  "lib/client-src/apply.js"(exports2, module2) {
    var h = require("react").createElement;
    var { makeT, NS, ZH, EN } = require_i18n();
    var { Panel } = require_panel();
    var { BgjobsSidebarAction } = require_sidebar_action();
    var { SettingsSection } = require_settings_section();
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
      const entry = { name: "shell.overlay", id: "bgjobs-monitor", order: 50, label: "bgjobs" };
      if (locale) entry.locale = NS;
      slots.inject("shell.overlay", () => slots.register(entry, (props) => h(Panel, {
        sessions,
        getSessions,
        t: props && props.t || makeT("zh"),
        monitor
      })));
      const guiPrefs = createGuiPrefsStore(false);
      loadGuiPrefs(guiPrefs);
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
    }
    module2.exports = { apply: apply2 };
  }
});

// lib/client-src/index.js
var { apply } = require_apply();
module.exports = { name: "bgjobs-client", inject: ["slots"], apply };

return module.exports;
} });
