# bgjobs — standalone background jobs for DSH

**English** · [中文](README.md)

[![npm version](https://img.shields.io/npm/v/bgjobs)](https://www.npmjs.com/package/bgjobs)
[![GitHub tag](https://img.shields.io/github/v/tag/bitsmug/dsh-bgjobs)](https://github.com/bitsmug/dsh-bgjobs/tags)
[![publish](https://github.com/bitsmug/dsh-bgjobs/actions/workflows/publish.yml/badge.svg)](https://github.com/bitsmug/dsh-bgjobs/actions/workflows/publish.yml)
[![License](https://img.shields.io/npm/l/bgjobs)](LICENSE)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/bitsmug/dsh-bgjobs)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

**Run commands outside the DSH process**: jobs are handed to the Windows Task Scheduler service, so closing the DSH process or the web page does not stop them; a floating panel in the web UI shows live output; and when DSH is offline you can still manage jobs with the standalone CLI/GUI.

Built for long-running work — large downloads, batch scripts, compilation, data sync/export — **a DSH crash (usually OOM) does not affect running jobs either**.

## Quick install

1. Open the official DSH desktop client or the web page, click the "Plugins" entry in the left navigation bar, go to the plugin page and click "Add plugin" in the top-right corner;
2. Enter `bgjobs` in the plugin install box (or the latest from GitHub: `github:bitsmug/dsh-bgjobs`) and confirm; on the first install it asks you to allow `pnpm approve build` — click allow and install again.

## Table of contents

- [Quick install](#quick-install)
- [Feature overview](#feature-overview)
- [Prerequisites & compatibility](#prerequisites--compatibility)
- [Install / uninstall](#install--uninstall)
- [Usage (agent tools)](#usage-agent-tools)
- [Web panel](#web-panel)
- [Offline CLI (works without DSH)](#offline-cli-works-without-dsh)
- [GUI](#gui)
- [Configuration & data](#configuration--data)
- [Notes & limits](#notes--limits)
- [Development](#development)
- [Contributing](#contributing)
- [Recent updates](#recent-updates)
- [License](#license)

## Feature overview

| Capability | Description |
|---|---|
| Runs outside DSH | Jobs are hosted via `schtasks`; a DSH crash/shutdown doesn't matter |
| Live output panel | Floating panel (bottom-right) refreshes every second: draggable, minimizable to a bubble, collapsible to a job list, theme-aware; grouped by workspace, resizable; the sidebar-bottom entry hides/shows it in one click. Rows show a live **Runtime** (growing while running, total time once done), and each field can be placed in the list / detail view / hidden |
| Manual cleanup | 🧹 click the cleanup icon to open the trash bar: drag a single finished job to delete, or bulk-clean (>24h only / all; follows the view filter). Jobs whose process state **cannot be determined** (the probe/lookup itself failed) first show a **warning confirmation box** (it spells out that continuing may leave an invisible orphan process and shows the original reason) — only 「confirm cleanup」 sends `force`; cancelling deletes nothing |
| Completion notice | Toast on exit (does not interrupt the session); optionally notify the creating agent (`notify` param) |
| In-session waiting | `bgjob_wait` lets the agent wait for results **without hogging the conversation**: unlimited by default (configurable via "Default wait timeout" in Settings), released immediately when a new inbound message yields or the user stops it; supports any-race and all-conjunctive (fail fast) modes |
| Reconnect & track | Auto-recovers after a DSH restart; old job ids can still be queried from disk |
| Offline management | CLI / GUI that don't need DSH: list / status / log / submit / kill (terminate processes) / delete (remove records) / cleanup |
| Optional sandbox | `bgjob_submit_pwsh` can pass `sandbox` to constrain job file permissions (never wider than the current session mode). With the **Sandbox selection** switch on (experimental, off by default) it can also pass `sandbox_backend: 'dsh'` to reuse the current session's dsh sandbox provider (`ctx.sandbox.confine`) instead, with support for the [dsh-sandbox-mxc](https://github.com/bitsmug/dsh-sandbox-mxc) backend (file and network constraints). Switch = panel "Sandbox selection" |
| MCP tool calls | `bgjob_submit_mcp` submits one MCP tool call as a background job (**settings-page switch, off by default; sandboxing not supported yet**); register servers by hand or import them from the DSH config; each server has a "Pre-warm / Cold start / Disabled" three-state control (disabled servers refuse agent calls) |
| No residue | A finished job removes its own scheduled task; done jobs stay visible until you clean them up |

## Prerequisites & compatibility

| Prerequisite | Compatible | Recommended |
|---|---|---|
| Windows | `10`-`11` | `11` (build `>=26300`) |
| PowerShell 7+ | `>=7.6.5` (sandbox features need the [zip build of PowerShell](https://learn.microsoft.com/zh-cn/powershell/scripting/install/install-powershell-on-windows?view=powershell-7.6#install-the-zip-package)) | [`>=7.7.0`](https://github.com/PowerShell/PowerShell/releases#release-v7.7.0-preview.5) |
| DSH | `0.1.2-rc.1` ~ `0.2.1-rc.2` (rc builds) ([official desktop build](https://www.deepseek.com/harness/) / run [npx @deepseek-ai/dsh web](https://github.com/deepseek-ai/deepseek-harness#run-from-npm) via Win+R) | `0.2.1-rc.2` |
| Node.js | `^22.19.0 \|\| >=24.0.0` (or automatically use the Node bundled with the official desktop build) | [`>=24.22.0`](https://nodejs.org/zh-cn/download) |

| Optional plugin | Compatible |
|---|---|
| [dsh-sandbox-mxc](https://github.com/bitsmug/dsh-sandbox-mxc) | `0.1.1` |
| [dsh-multi-folder](https://github.com/AngelosZou/dsh-multi-folder) | `0.3.3` |

## Install / uninstall

**Method A (easiest: plugin manager (the GUI plugin entry); DSH v0.2.0-rc.2)**

1. Open the official DSH desktop client or the web page, click the "Plugins" entry in the left navigation bar, go to the plugin page and click "Add plugin" in the top-right corner;
2. Enter `bgjobs` in the plugin install box (or the latest from GitHub: `github:bitsmug/dsh-bgjobs`) and confirm; on the first install it asks you to allow `pnpm approve build` — click allow and install again.

**Method B (fast, npm release)**

```powershell
$pf="web"; dsh plugin --profile $pf add bgjobs || dsh plugin --profile $pf approve-builds koffi; dsh plugin --profile $pf add bgjobs && Write-Host "✓ bgjobs installed successfully!" -ForegroundColor Green
```

> Replace `web` with your own profile name and paste the whole line into PowerShell (pwsh). The first `add` raises `ERR_PNPM_IGNORED_BUILDS` (koffi build script not approved); `||` then automatically runs `approve-builds` to approve and build koffi, the second `add` succeeds, and "bgjobs installed" is printed.

**Method C (always latest, from GitHub)**

```powershell
$pf="web"; dsh plugin --profile $pf add github:bitsmug/dsh-bgjobs || dsh plugin --profile $pf approve-builds koffi; dsh plugin --profile $pf add github:bitsmug/dsh-bgjobs && Write-Host "✓ bgjobs installed successfully!" -ForegroundColor Green
```

> Pulls the default branch directly from the GitHub repo — **always the newest code** (published and unpublished alike), no registry-lag. All methods above install under the name `bgjobs`, so the uninstall command is the same.

**From dsh-market install fails with `ERR_PNPM_IGNORED_BUILDS`?**

The plugin depends on the native library `koffi`; installing it triggers a build script, and pnpm ≥10 blocks dependency build scripts by default (a GitHub install also runs `prepare`). The error looks like:

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: koffi@3.2.1
dsh: pnpm failed in profile directory <your DSH home>\profiles\<profile>
```

Fix (replace `web` with your own `<profile>` name and paste the whole line into PowerShell (pwsh)):

```powershell
$pf="web"; dsh plugin --profile $pf approve-builds koffi; dsh plugin --profile $pf add bgjobs
```

The first command approves and runs koffi's build script; the second `add` then succeeds.

If your DSH version has no `approve-builds` subcommand, edit `pnpm-workspace.yaml` (the error prints its full path) manually: the failed `add` left a placeholder `set this to true or false` — change it to `true`, then re-run `add`:

```yaml
allowBuilds:
  koffi: true
```

Only the first install needs this — once koffi is compiled it stays compiled, and upgrades/reinstalls don't repeat the step.

Restart DSH afterwards (that means **fully quit and relaunch** — both the desktop client and the web version): the "Background Jobs Monitor" panel appears bottom-right of the web page and the agent gains `bgjob_submit` / `bgjob_submit_pwsh` / `bgjob_submit_mcp` / `bgjob_mcp_tools` / `bgjob_status` / `bgjob_wait` / `bgjob_kill` / `bgjob_delete` tools (the two MCP tools require turning on the "MCP jobs" switch in Settings first).

**Method D (local source)**

1. Put the repo in a local plugin directory (avoid non-ASCII in the path), e.g. `D:\dsh\plugins\bgjobs`;
2. Make DSH's module resolver find it (junction the plugin dir to DSH's `node_modules\bgjobs`, or add the dir to DSH's plugin scan paths); for local dev also run `pnpm install` once inside the plugin dir (sandbox runner deps, below);
3. Append the mount to `<DSH_HOME>\profiles\<profile>\cordis.patch.yml`:

```yaml
- insert:
    - id: bgjobs
      name: bgjobs
```

**Uninstall:** `dsh plugin --profile <profile> remove bgjobs`

> Methods B / C / D all need a **DSH restart** (fully quit and relaunch) to take effect.

## Usage (agent tools)

**Tool overview** (full parameters, values and boundaries: [docs/developer.md](docs/developer.md); the per-tool semantics will be merged into that document shortly)

| Tool | In one line |
|---|---|
| `bgjob_submit` | Submit a background job (`command` is **bat** syntax) |
| `bgjob_submit_pwsh` | Submit a background job (**PowerShell** syntax; UTF-8 logs, safe `exit <code>` semantics; optional `sandbox` / `sandbox_backend` / `output_encoding`) |
| `bgjob_submit_mcp` | Submit one **MCP tool call** as a background job (off by default, needs the "MCP jobs" switch; exit codes 0/1/2/3) |
| `bgjob_mcp_tools` | List a MCP server's tool names / descriptions / required fields (cached; `refresh: true` forces a re-read) |
| `bgjob_status` | Query status / exit code / log tail (**don't poll it**; terminal-state authority and the `wrapper-gone` three states are in developer.md) |
| `bgjob_wait` | Wait for job(s) and return immediately; `logic: 'any'` (default, race) / `'all'` (conjunctive); `timeoutSeconds` defaults to the "Default wait timeout" in Settings |
| `bgjob_list` | List all jobs submitted by the current agent session (id/status/exit code) |
| `bgjob_kill` | **Terminate the process tree only, never delete records** (writes back non-zero exit code 1 + `exitCodeSource: 'killed'`; `mode` has three values, `unknown` needs an explicit `force`) |
| `bgjob_delete` | **Delete records only, never kill processes** (refused while a live process remains, tells you to `kill` first; `mode` has three values) |

Just tell the AI (name the workdir and job name, and say whether you want it to wait for the result / notify you):

> Run this whole chain in the background — clone the Linux kernel into `D:\work\linux`, then `make -j16` — and notify me when it finishes (`notify: on-exit`); don't let the build tie up the conversation.

> Start two background jobs in parallel: one downloading a dataset, one rebuilding; **show me whichever finishes first** and let the other keep running (any-race, no need to wait for all).

> Convert the 30 CSVs under `D:\data` to UTF-8 in one batch with the pwsh engine; I need **all of them to succeed before continuing** — stop as soon as any one fails (`logic: 'all'`).

> Submit one MCP call as a background job: server `glm`, tool `web_search`, query「latest LLM progress」, and send the result back to this session when it's done.

- Job output is streamed live to `<workdir>\.dsh\bgjobs\<jobId>\stdout.log`;
- On exit, `<workdir>\.dsh\bgjobs\<jobId>\exitcode.txt` gets the exit code and a toast pops in the web page;
- By default, completion **does not interrupt the session**; when you want the agent to know and wrap up, pass `notify: on-exit` (or `on-completion` success-only / `on-fail` failure-only), plus optional `notify_mode` (`wakeup` wake an idle session / `quiet` inbox-only / `always`).
- **Delivery marker (notify view)**: each job records whether its result has been delivered into the session context — a completion notice that was injected (`notified·notify`) or a `bgjob_wait` that returned it (`notified·wait`). `bgjob_pending_list` lists the session's **not-yet-delivered** jobs (the notify view), and the default mode of `bgjob_wait` (including `logic: 'all'`) waits only on that view, so an already-delivered result is never returned twice. The web panel and the offline GUI both show a "notified / pending" marker.

## Web panel

Top bar, left to right: cleanup (opens the bottom trash bar: drag a finished job to delete, or bulk-clean >24h / all), collapse (to a compact job list), minimize (floating bubble anchored at the button). Toolbar toggles: "Only this session" (show only the current session's workspace jobs) and "Full access" (pre-approve full-access jobs; off by default). Click a job row to expand its live log. Rows show a live "Runtime" by default (growing while running, total time once done); move it to the detail view or hide it under Settings → Background Jobs → Field display. Panel copy follows the DSH UI language (Chinese DSH → Chinese panel, otherwise English).

**Sidebar entry**: the left sidebar (chat-list column) has a bgjobs entry at the bottom — at full width it shows "Background Jobs", collapsed to a narrow rail it is the icon only. Click it to hide/show the whole floating panel; while the panel is hidden, jobs keep running and completion toasts still pop. The entry can be toggled under **DSH Settings → Background Jobs** (**hidden by default**).

**The bgjobs pages in DSH Settings** (gear at the bottom-left): two pages — "Background Jobs" and "MCP jobs". The panel's title bar also has two shortcuts: ⚙ opens the "Background Jobs" page, the data-gear icon opens "MCP jobs" (each can be hidden under Settings → Background Jobs → UI elements).

- "Background Jobs" (shows the current plugin version): ① sidebar-entry toggle (off by default; turning it on adds an entry at the bottom of the sidebar — click it to hide/show the floating panel); ② monitor-panel toggle (show/hide the floating panel and bubble, independent of the entry); ③ **"Default wait timeout"** (number input + Save): the default `timeoutSeconds` for `bgjob_wait` when the agent omits it — `0`/empty means unlimited; ④ Open the offline GUI in its own window (the row shows the GUI script path); ⑤ Open the tools folder in File Explorer (find `dsh-bgjobs-gui.bat` there if the GUI won't open); ⑥ **Field display**: place each job field in the list / detail view / hidden (includes the "Runtime" field).

**MCP jobs (its own Settings page, off by default)**:

- **MCP jobs switch**: controls whether the agent may use `bgjob_submit_mcp` / `bgjob_mcp_tools` (refused, with a pointer to the switch, while off). Takes effect immediately, no DSH restart. As in DSH, the session access mode (read-only, …) does not restrict MCP jobs;
- **MCP servers**: register servers the agent can reference by name (name + JSON config). Each row has three buttons — **Pre-warm / Cold start / Disabled** — plus **Edit** (loads that server's full config — including plaintext env/headers — into the form below), "List tools" (expand tool names, click to copy) and "Delete"; the list only returns env/headers **key names**, never values. **Pre-warm** keeps a resident connection inside the DSH process so jobs reuse it instead of paying the cold start every time — valid only while DSH runs; on failure the job falls back to an in-job cold start, so correctness never depends on it. Only failures that definitely did not execute anything fall back — **a call that was already sent is never re-run when it fails or times out** (no duplicate side effects); such a job ends with exit code `2`/`3` and can be resubmitted (v0.1.84). **Cold start** enables the server without a resident connection. **Disabled** makes `bgjob_submit_mcp` / `bgjob_mcp_tools` refuse that server and drops its resident connection, while "List tools" still works;
- **Export / Import**: export as a **DSH YAML** snippet (`@deepseek-ai/dsh-mcp-client` entries, paste into `cordis.patch.yml`) or **bgjobs JSON** (backup/migration, read back by the import box as-is). Import accepts pasted text or a picked file and auto-detects DSH patch snippets / bgjobs JSON / one-or-more server config objects (each needs `serverName`), with "skip / overwrite existing names"; entries containing `!!js` are refused unless you tick the force box (they are never evaluated — fill in env/headers by hand). **Exported text and each job's `mcp.json` contain plaintext secrets — redact before sharing**;
- **MCP in DSH (import)**: reads the `@deepseek-ai/dsh-mcp-client` entries already configured in the **active profile** or the global `cordis.patch.yml` and imports them into the bgjobs registry with one click (read-only with respect to the DSH config). The header shows the active profile; entries containing `!!js` expressions are **never evaluated** and are skipped by default (fill in env/headers manually). Any expression that cannot be pinned to a single entry flags the whole batch for manual review instead of silently importing the JS text as a plain string.

## Offline CLI (works without DSH)

```powershell
# run from the tools/ directory
.\dsh-bgjobs.ps1 list
.\dsh-bgjobs.ps1 status -Id <id>
.\dsh-bgjobs.ps1 log -Id <id> [-Tail 100]
.\dsh-bgjobs.ps1 submit -Name <n> -Command <c> -Workdir <dir> [-Pwsh]
.\dsh-bgjobs.ps1 kill -Id <id> [-Force]                    # terminate processes only (records kept; writes the non-zero exit code 1 = the value taskkill records)
.\dsh-bgjobs.ps1 delete -Id <id> [-NoDeleteDir] [-Force]   # remove records only (refused while a live process remains — kill first)
.\dsh-bgjobs.ps1 cleanup [-OlderThanHours 24]   # 0 = clean all
.\dsh-bgjobs.ps1 index -Workdir <dir>
```

When the process state **cannot be determined** (the probe/lookup itself failed) nothing is done by default: the CLI
prints a warning and exits with code `3`; add `-Force` to go ahead (the GUI's equivalent is the "cannot determine
process state" confirmation box).

## GUI

Double-click `tools\dsh-bgjobs-gui.bat` to open a standalone window (no DSH needed): job list/log, submit (bat or pwsh), kill processes (records kept), delete records (finished / no-process jobs only), cleanup (custom age cutoff or all), rebuild index. The toolbar's **"📌 Desktop shortcut"** button creates a shortcut to this GUI on the current user's desktop in one click (double-click to open, no console window flash). GUI and Toast copy follow the Windows UI language (zh* → Simplified Chinese, otherwise English); the CLI prints English. **Can't find the GUI?** DSH Settings → Background Jobs → "Open the offline GUI" / "Open the tools folder" launches it or locates the script.

## Configuration & data

### Environment variables

All of the following are **optional** (usually nothing to set):

- `BGJOBS_SANDBOX_RUNNER` — explicit path to the sandbox runner (auto-detected by default; a sandbox submission fails loudly when none is found).
- `BGJOBS_DSH_HOME` — the "portable-first" home for the offline GUI/CLI; set it explicitly when you need to pin it down (v0.1.89).
- `DSH_HOME` — source of the global state directory (state lives under `$DSH_HOME\bgjobs\`); usually provided by DSH.
- `DSH_DESKTOP_NODE_EXECUTABLE` — where the desktop build's runtime node comes from (the "real node" a sandboxed job needs is preferred from there).
- `BGJOBS_PWSH`  explicit path to the PowerShell interpreter.

### Data & storage

- Job data: `<workdir>\.dsh\bgjobs\<jobId>\` (`job.json` metadata, `stdout.log` output, `exitcode.txt` exit code; MCP jobs also have `mcp.json` for the call spec and `result.json` for the outcome);
- Global state: `$DSH_HOME\bgjobs\` (`index.json` job "map", `fullaccess.json` full-access switch, `ui-prefs.json` web UI prefs, `mcp-*.json` MCP switch/registry/cache; per-file details in [docs/developer.md](docs/developer.md));
- `done` jobs persist by default until you clean them (panel 🧹 / CLI cleanup / GUI).

## Notes & limits

- `workdir` must be an absolute path inside a DSH workspace;
- Jobs run by default "only while the user is logged in": closing DSH/the terminal is fine, but **logging out of Windows terminates jobs**;
- Don't put `> log`-style redirects in your command (the plugin already redirects all output and guarantees UTF-8);
- **Sandbox**: `sandbox` only constrains file effects (writes outside the workspace/temp area are denied), network is unrestricted; it is "best effort", not a mathematical boundary — it fails if the workdir sits in an Everyone-writable location; sandboxed job dirs are readable by local users (the script text is visible); bat-engine jobs are always full-access, so restricted sessions must enable "Full access" to submit them;
- In a restricted session, requesting more than the session mode triggers an approval prompt — put the reason in `justification`. The panel's **"Full access" switch does not change the session access mode** (it does not touch DSH's mode): it only decides whether such a wider request is approved via that prompt (off) or let through directly (on), and the job is still persisted with its resolved mode.
- **MCP jobs**: off by default (enable in Settings); a job's stdio MCP server child is reaped by **`kill`** using the recorded pid (`delete` only removes records and never kills processes — if the server child is still alive, delete refuses and tells you to kill first); each server has a "Pre-warm / Cold start / Disabled" three-state control in Settings — **Disabled** makes `bgjob_submit_mcp` / `bgjob_mcp_tools` refuse that server and drops its resident connection (while "List tools" still works); the "pre-warm" connection is only valid while DSH runs and never changes the "jobs survive DSH" guarantee; the offline CLI/GUI only view jobs, kill processes and delete records — they do not submit MCP calls. **`mcp-servers.json`, exported text and each job's `mcp.json` contain plaintext secrets — redact before sharing or archiving.**
- **A stopped wait is not a failed job**: when you hit stop/interrupt while the agent waits, the wait itself ends **as an error** (the message names each job's current state and says you can wait again). That is DSH's cancellation semantics — once the caller cancels, a successful return cannot reach the model, only an error can; the job keeps running in the background, is not marked delivered, and the agent can call `bgjob_wait` again. A message from another agent during the wait returns normally instead (`stoppedBy: 'message'`): that result carries **no message body**, but the call **declares the current turn finished** — DSH then delivers the message (yours or another agent's) to the agent as a regular user message, queued next-turn prompts included; the agent should not paper over it with more waiting or blocking work.
- **MCP timeout cleanup has a 1–2s grace period**: after an MCP timeout/failure the host closes the connection and reaps the server child (closing alone waits ~2s), so `result.json`'s `durationMs` can exceed `timeoutMs` by 1–2s (the same file records `timeoutMs` for comparison).

## Development

Architecture, mechanism details, testing and release flow: see [docs/developer.md](docs/developer.md).

## Contributing

Issues and PRs are welcome: bug reports, panel / CLI experience, docs and translations (the Chinese and English mirrors must be kept in sync) are all good to file.

- Repository: <https://github.com/bitsmug/dsh-bgjobs>
- Issues and suggestions: <https://github.com/bitsmug/dsh-bgjobs/issues>
- Architecture, mechanism, tests and release flow: [docs/developer.md](docs/developer.md)

## Recent updates

v0.1.71 → v0.2.6

- **Fixed mojibake in sandboxed pwsh job logs**: added `output_encoding` — choose a job log's decoding per task (v0.2.6).
- **Fixed sandbox jobs picking the MSIX build of pwsh, which broke container jobs**: PowerShell resolution now **skips the WindowsApps alias** and takes the first non-MSIX hit, plus a new **`BGJOBS_PWSH`** environment variable to override the interpreter explicitly (highest priority) (v0.2.6).
- **New "Sandbox selection" (experimental, off by default): a background job can use the dsh sandbox backend** (v0.2.5).
- **Fixed a concurrency defect that finalised one job twice (an occasional duplicate completion notification)** (v0.2.4).
- **Fixed "dead jobs shown as running"** (v0.2.3).
- **Fixed pre-warm being blocked when node lives under a path containing spaces** (v0.2.1).
- **The two "completion banner" switches now form their own settings group** (v0.2.1).
- **Added bgjob_kill and bgjob_delete tools** (v0.2.0-alpha).
- **Sandboxed pwsh jobs start faster**: a per-process cost that was paid on every launch (and that did nothing for log encoding anyway) is gone, so startup waits are shorter — **job behaviour, logs and exit codes are unchanged** (v0.1.92).
- **Sandboxed pwsh jobs no longer show a blank log with a fake success**: the desktop (Electron) build's `process.execPath` is a GUI-subsystem executable, and when the runner redirects its stdout to a file it **exits silently right away** — so the job ended with `exit 0` and an empty log. Sandboxed runners now use a **real node** (DSH's own node first); if `PATH` has none either, submission **fails loudly** (`a real node executable not found`) instead of faking success. A finished job matching "instant exit + exit 0 + log containing only `[BGJOB]` markers" gets a `suspect` hint in `job.json` / the panel (a hint only — status, exit code and notify semantics are untouched) (v0.1.90).
- DSH 0.2.0-rc.2 supported (v0.1.87).
- **Fixed completion notices breaking the session on DSH 0.1.7**: the `notify` message's source marker now uses the newer form (the old `{ kind: 'plugin', … }` was rejected by DSH 0.1.7's session admission, surfacing as a failed turn — `format v4 message requires a producer-owned source kind` — and the event was refused before it reached disk, leaving no trace in the session log) (v0.1.86).
- **Fixed MCP tools being executed twice through the pre-warm channel**: the pre-warm proxy call waited only 3 seconds and then "fell back to a cold start", so any tool taking longer than 3 seconds ran twice; the client's abort budget now matches the call timeout (a backstop for a host that stops responding only), and the proxy marks whether the call was actually sent — a failure/timeout after that point is **never re-run** and ends with exit code `2`/`3` (v0.1.84).
- **`bgjob_wait_all` merged into `bgjob_wait`**: a new `logic` parameter (`any` default / `all` conjunctive) now provides everything the old `bgjob_wait_all` did (`allDone` only when all succeeded; any failure returns at once with `failed` + `failedJobId` + the rest `pending`) via `bgjob_wait({ ..., logic: 'all' })`; tool count 9 → 8 (v0.1.83).
- **Yielding to a new message now hands the turn back automatically**: when `bgjob_wait` / `bgjob_wait_all` returns because of a new inbound message (`stoppedBy: 'message'`) it **declares the current turn finished** (the DSH tool-execution contract's `exec.concludeTurn`), and DSH then delivers that message to the agent as a regular user message — no more "the agent keeps waiting and the message never gets through" (v0.1.82).
- **`bgjob_wait_all` switched to conjunctive semantics**: `allDone` is true only when **every job succeeded**; any failure (non-zero exit code / cleaned up / not found) returns at once with `failed:true` + `failedJobId` + the finished jobs' `results` + the rest in `pending` instead of waiting for stragglers. After parallel submission the default posture is now `bgjob_wait`'s any-race (handle whichever lands first) (v0.1.82).
- **The guidance now explicitly forbids waiting with system sleep**: wait with `bgjob_wait` / `bgjob_wait_all` only, never `sleep` / `Start-Sleep` / `timeout` and never a "loop over `bgjob_status`"; the guidance was restructured into sections and now covers `bgjob_submit_mcp` / `bgjob_mcp_tools` (v0.1.82).
- **New MCP background-job engine** (v0.1.80).
- **A pending wait can be stopped at any time**: hitting stop/interrupt while the agent waits releases it immediately instead of tying up the conversation; the job keeps running in the background and can be waited on again (v0.1.71).
- Failures are no longer silent: the settings page shows the reason directly.

## License

MIT — see [LICENSE](LICENSE).
