# bgjobs — standalone background jobs for DSH

**English** · [中文](README.md)

[![npm version](https://img.shields.io/npm/v/bgjobs)](https://www.npmjs.com/package/bgjobs)
[![GitHub tag](https://img.shields.io/github/v/tag/bitsmug/dsh-bgjobs)](https://github.com/bitsmug/dsh-bgjobs/tags)
[![License](https://img.shields.io/npm/l/bgjobs)](LICENSE)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/bitsmug/dsh-bgjobs)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

**Run commands outside the DSH process**: jobs are handed to the Windows Task Scheduler service, so closing DSH or the web page does not stop them. A toast appears in the web UI when a job finishes; live output is always one refresh away; and when DSH is offline you can still manage jobs with the standalone CLI/GUI.

Built for long-running work — large downloads, batch scripts, compilation, data sync/export. Submit and walk away; check back anytime.

## Feature overview

| Capability | Description |
|---|---|
| Runs outside DSH | Jobs are hosted via `schtasks`; DSH crashes/shutdowns don't matter |
| Live output panel | Floating panel (bottom-right) refreshes every second: draggable, minimizable to a bubble, collapsible to a job list, theme-aware; grouped by workspace, resizable; the sidebar-bottom entry hides/shows it in one click. Rows show a live **Runtime** (growing while running, total time once done), and each field can be placed in the list / detail view / hidden |
| Manual cleanup | 🧹 click the cleanup icon to open the trash bar: drag a single finished job to delete, or bulk-clean (>24h only / all; follows the view filter) |
| Completion notice | Toast on exit (does not interrupt the session); optionally notify the creating agent (`notify` param) |
| In-session waiting | `bgjob_wait` lets the agent wait for results **without hogging the conversation**: unlimited by default (configurable via "Default wait timeout" in Settings), released immediately when a new inbound message yields or the user stops it; supports any-race and all-conjunctive (fail fast) modes |
| Reconnect & track | Auto-recovers after a DSH restart; old job ids can still be queried from disk |
| Offline management | CLI / GUI that don't need DSH: list / status / log / submit / kill / cleanup |
| Optional sandbox | `bgjob_submit_pwsh` optional `sandbox` constrains job file permissions to no more than the current session mode |
| MCP tool calls | `bgjob_submit_mcp` submits one MCP tool call as a background job (**settings-page switch, off by default**); register servers by hand or import them from the DSH config; each server has a "Pre-warm / Cold start / Disabled" three-state control (disabled servers refuse agent calls) |
| No residue | A finished job removes its own scheduled task; done jobs stay visible until you clean them up |

## Install / uninstall

Prereqs: DSH (`@deepseek-ai/dsh`), PowerShell 7, and Node.js (`^22.19.0` or ≥24), Windows. (Verified on the web DSH `0.1.2-rc.1` ~ `0.2.0-rc.2` · Windows 10 · PowerShell 7 · Node.js 24) (Desktop version `0.2.0-rc.2` supported, verified) (Sandbox security not verified)

> The MCP engine (`bgjob_submit_mcp`) runs on the plugin's own Node dependencies: `@modelcontextprotocol/sdk` and `yaml` ship with the package and are installed by `dsh plugin add`; a local source checkout needs one `pnpm install`. DSH's bundled Node is enough — nothing else to install.

**Method A (recommended, npm release)**

```sh
$pf="web"; dsh plugin --profile $pf add bgjobs || dsh plugin --profile $pf approve-builds koffi; dsh plugin --profile $pf add bgjobs && Write-Host "✓ bgjobs installed successfully!" -ForegroundColor Green
```

> Replace `web` with your own profile name and paste the whole line into PowerShell (pwsh). The first `add` raises `ERR_PNPM_IGNORED_BUILDS` (koffi build script not approved); `||` then automatically runs `approve-builds` to approve and build koffi, the second `add` succeeds, and "bgjobs installed" is printed.

**Method B (from GitHub, always latest)**

```sh
$pf="web"; dsh plugin --profile $pf add github:bitsmug/dsh-bgjobs || dsh plugin --profile $pf approve-builds koffi; dsh plugin --profile $pf add github:bitsmug/bgjobs && Write-Host "✓ bgjobs installed successfully!" -ForegroundColor Green
```

> Pulls the default branch directly from the GitHub repo — **always the newest code** (published and unpublished alike), no registry-lag. Both methods install under the name `bgjobs`, so the uninstall command is the same.

**From dsh-market install fails with `ERR_PNPM_IGNORED_BUILDS`?**

The plugin depends on the native library `koffi`; installing it triggers a build script, and pnpm ≥10 blocks dependency build scripts by default (a GitHub install also runs `prepare`). The error looks like:

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: koffi@3.2.1
dsh: pnpm failed in profile directory <your DSH home>\profiles\<profile>
```

Fix (replace `web` with your own `<profile>` name and paste the whole line into PowerShell (pwsh)):

```sh
$pf="web"; dsh plugin --profile $pf approve-builds koffi; dsh plugin --profile $pf add bgjobs
```

The first command approves and runs koffi's build script; the second `add` then succeeds.

If your DSH version has no `approve-builds` subcommand, edit `pnpm-workspace.yaml` (the error prints its full path) manually: the failed `add` left a placeholder `set this to true or false` — change it to `true`, then re-run `add`:

```yaml
allowBuilds:
  koffi: true
```

Only the first install needs this — once koffi is compiled it stays compiled, and upgrades/reinstalls don't repeat the step.

Restart DSH afterwards: the "Background Jobs Monitor" panel appears bottom-right of the web page and the agent gains `bgjob_submit` / `bgjob_submit_pwsh` / `bgjob_submit_mcp` / `bgjob_mcp_tools` / `bgjob_status` / `bgjob_wait` tools (the two MCP tools require turning on the "MCP jobs" switch in Settings first).

**Method C (local source)**

1. Put the repo in a local plugin directory (avoid non-ASCII in the path), e.g. `D:\dsh\plugins\bgjobs`;
2. Make DSH's module resolver find it (junction the plugin dir to DSH's `node_modules\bgjobs`, or add the dir to DSH's plugin scan paths); for local dev also run `pnpm install` once inside the plugin dir (sandbox runner deps, below);
3. Append the mount to `<DSH_HOME>\profiles\<profile>\cordis.patch.yml`:

```yaml
- insert:
    - id: bgjobs
      name: bgjobs
```

**Uninstall:** `dsh plugin --profile <profile> remove bgjobs`

## Usage (agent tools)

- `bgjob_submit(name, command, workdir, [wait], [notify], [notify_mode])` — submit a background job (`command` is **bat** syntax); `wait` = seconds to wait in place after submitting (0/omitted = return immediately; >0 behaves like `bgjob_wait` with no ids — wait for any of the current session's jobs to finish, falling back to the just-submitted job when no session info);
- `bgjob_submit_pwsh(name, command, workdir, [wait], [sandbox], [justification], [notify], [notify_mode])` — submit a background job (`command` is **PowerShell** syntax, UTF-8 logs, safe `exit <code>` semantics); `wait` same as above; **sandboxed** jobs (`sandbox` other than `off`) are launched through a separate runner that needs a **real `node`** (console subsystem, preferring the copy from the same origin as DSH — see recent updates v0.1.91); if none is found, the submission **fails loudly** (no more "blank log + fake exit 0");
- `bgjob_submit_mcp(name, workdir, tool, [arguments], server | server_config, [timeout_seconds], [wait], [notify], [notify_mode])` — submit one **MCP tool call** as a background job (third engine, also `schtasks`-hosted, visible in the panel, wait/notify supported). `server` is a name registered on the settings page, `server_config` is an inline config (stdio or streamable-http) — give exactly one. The job connects to that server and calls the tool once; the result lands in the log and `<jobDir>/result.json` (which also records the channel used). Exit codes: `0` success / `1` tool reported an error / `2` connect or call failed / `3` timeout; `timeout_seconds` **is unlimited by default** (when that server has a `timeoutMs` registered on the settings page, that value applies), or pass any positive number of seconds. **Off by default — turn on the "MCP jobs" switch in Settings first** (calls are refused otherwise). As in DSH, the session access mode (read-only, …) does **not** restrict MCP jobs. Check tool names with `bgjob_mcp_tools` first;
- `bgjob_mcp_tools(server | server_config, [refresh])` — list that MCP server's tools (name/description/required fields) to confirm tool names and argument shape before submitting; results are cached and `refresh: true` forces a re-read; also gated by the "MCP jobs" switch;
- `bgjob_status(jobId)` — query status / exit code / log tail; for a look at the current state only — do not poll it in a loop (use `bgjob_wait` to wait);
- `bgjob_wait(jobId | jobIds, [timeoutSeconds], [logic])` — wait for background job(s) and **return immediately** with exit codes and log tails (`timeoutSeconds` **defaults to the "Default wait timeout" set in Settings** — unlimited when that setting is unset, i.e. it waits until the job finishes; pass `0`/a negative number to force unlimited for this call, or a positive number to get a `timedOut: true` snapshot at that point). Two modes (`logic`):
  - **`any` (default)**: a single `jobId` waits for that job; a `jobIds` array is **any-race** (returns as soon as one finishes, with the finisher + the rest `pending`) — the **default posture when several jobs run in parallel**: handle whichever lands first and keep waiting for the rest, no need to wait for all; omitting both waits for **any job of the current session** to finish;
  - **`all` (conjunctive)**: returns `allDone: true` plus each job's exit code/log tail only when **all jobs succeed**; **any failure returns at once** with `failed: true` + `failedJobId` + the finished jobs' `results` + the rest in `pending` (a non-zero exit code, or a cleaned-up/unknown job, both count as failure) — no waiting for the stragglers. Use it only when "everything must succeed before continuing" or when "one failure means stop now"; to make progress as results land, use the default `any`. Omitting `jobIds` waits for all jobs of the current session;
- `bgjob_list` — list all jobs submitted by the current agent session (id/status/exit code); used together with the wait tools' default mode.
- **Do not poll with sleep**: wait with `bgjob_wait`; don't use `sleep` / `Start-Sleep` / `timeout`, nor a "loop over `bgjob_status`" (it occupies the turn and blocks incoming messages).

Just tell the AI (name the workdir and job name, and say whether you want it to wait for the result / notify you):

> Run this whole chain in the background — clone the Linux kernel into `D:\work\linux`, then `make -j16` — and notify me when it finishes (`notify: on-exit`); don't let the build tie up the conversation.

> Start two background jobs in parallel: one downloading a dataset, one rebuilding; **show me whichever finishes first** and let the other keep running (any-race, no need to wait for all).

> Convert the 30 CSVs under `D:\data` to UTF-8 in one batch with the pwsh engine; I need **all of them to succeed before continuing** — stop as soon as any one fails (`logic: 'all'`).

> Submit one MCP call as a background job: server `glm`, tool `web_search`, query「latest LLM progress」, and send the result back to this session when it's done.

Then:

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
.\dsh-bgjobs.ps1 kill -Id <id> [-NoDeleteDir]
.\dsh-bgjobs.ps1 cleanup [-OlderThanHours 24]   # 0 = clean all
.\dsh-bgjobs.ps1 index -Workdir <dir>
```

## GUI

Double-click `tools\dsh-bgjobs-gui.bat` to open a standalone window (no DSH needed): job list/log, submit (bat or pwsh), kill, cleanup (custom age cutoff or all), rebuild index. The toolbar's **"📌 Desktop shortcut"** button creates a shortcut to this GUI on the current user's desktop in one click (double-click to open, no console window flash). GUI and Toast copy follow the Windows UI language (zh* → Simplified Chinese, otherwise English); the CLI prints English. **Can't find the GUI?** DSH Settings → Background Jobs → "Open the offline GUI" / "Open the tools folder" launches it or locates the script.

## Data & storage

- Job data: `<workdir>\.dsh\bgjobs\<jobId>\` (`job.json` metadata, `stdout.log` output, `exitcode.txt` exit code; MCP jobs also have `mcp.json` for the call spec and `result.json` for the outcome);
- Global state: `$DSH_HOME\bgjobs\` (`index.json` job "map", `fullaccess.json` full-access switch, `ui-prefs.json` web UI prefs, `mcp-*.json` MCP switch/registry/cache; per-file details in [docs/developer.md](docs/developer.md));
- `done` jobs persist by default until you clean them (panel 🧹 / CLI cleanup / GUI).

## Notes & limits

- `workdir` must be an absolute path inside a DSH workspace;
- Jobs run by default "only while the user is logged in": closing DSH/the terminal is fine, but **logging out of Windows terminates jobs**;
- Don't put `> log`-style redirects in your command (the plugin already redirects all output and guarantees UTF-8);
- **Sandbox**: `sandbox` only constrains file effects (writes outside the workspace/temp area are denied), network is unrestricted; it is "best effort", not a mathematical boundary — it fails if the workdir sits in an Everyone-writable location; sandboxed job dirs are readable by local users (the script text is visible); bat-engine jobs are always full-access, so restricted sessions must enable "Full access" to submit them;
- In a restricted session, requesting more than the session mode triggers an approval prompt — put the reason in `justification`. The panel's **"Full access" switch does not change the session access mode** (it does not touch DSH's mode): it only decides whether such a wider request is approved via that prompt (off) or let through directly (on), and the job is still persisted with its resolved mode.
- **MCP jobs**: off by default (enable in Settings); if a job is force-killed, its stdio MCP server child may linger (a normal finish is cleaned up by the host, which also kills the pid recorded for a job when you delete it); each server has a "Pre-warm / Cold start / Disabled" three-state control in Settings — **Disabled** makes `bgjob_submit_mcp` / `bgjob_mcp_tools` refuse that server and drops its resident connection (while "List tools" still works); the "pre-warm" connection is only valid while DSH runs and never changes the "jobs survive DSH" guarantee; the offline CLI/GUI only view and delete MCP jobs — they do not submit MCP calls. **`mcp-servers.json`, exported text and each job's `mcp.json` contain plaintext secrets — redact before sharing or archiving.**
- **A stopped wait is not a failed job**: when you hit stop/interrupt while the agent waits, the wait itself ends **as an error** (the message names each job's current state and says you can wait again). That is DSH's cancellation semantics — once the caller cancels, a successful return cannot reach the model, only an error can; the job keeps running in the background, is not marked delivered, and the agent can call `bgjob_wait` again. A message from another agent during the wait returns normally instead (`stoppedBy: 'message'`): that result carries **no message body**, but the call **declares the current turn finished** — DSH then delivers the message (yours or another agent's) to the agent as a regular user message, queued next-turn prompts included; the agent should not paper over it with more waiting or blocking work.
- **MCP timeout cleanup has a 1–2s grace period**: after an MCP timeout/failure the host closes the connection and reaps the server child (closing alone waits ~2s), so `result.json`'s `durationMs` can exceed `timeoutMs` by 1–2s (the same file records `timeoutMs` for comparison).
- **⚠️ Known defect (not yet fixed): a *running* "sandboxed pwsh" job cannot be deleted** — the panel's delete and the offline CLI's `kill` both **return success while the job keeps running**; it also vanishes from the panel list, so you **can neither see nor manage** that process, and its job directory cannot be removed either. In a **restricted session pwsh jobs are sandboxed by default**, so any of them can be affected. Workaround: find the pid in the job directory or the process list and end it with `taskkill /PID <pid> /T /F` (you may need an unrestricted window). Cause and code locations: see "边界与已知限制" in [docs/developer.md](docs/developer.md).

## Development

Architecture, mechanism details, testing and release flow: see [docs/developer.md](docs/developer.md).

## Recent updates (v0.1.62 → v0.1.92)

- **Sandboxed pwsh jobs start faster**: a per-process cost that was paid on every launch (and that did nothing for log encoding anyway) is gone, so startup waits are shorter — **job behaviour, logs and exit codes are unchanged** (v0.1.92).

- **Sandboxed pwsh jobs now work on a machine that only has the desktop DSH build and no other node**: previously a miss from `where.exe node` was a hard error; node selection now prefers a copy of node **from the same origin as the DSH runtime** (including the **node bundled with the desktop build**), falling back to a `PATH` node last. The chosen origin and version are recorded in `job.json` for troubleshooting, and if nothing is found the submission **fails loudly** instead of faking success (v0.1.91).

- **Sandboxed pwsh jobs no longer show a blank log with a fake success**: the desktop (Electron) build's `process.execPath` is a GUI-subsystem executable, and when the runner redirects its stdout to a file it **exits silently right away** — so the job ended with `exit 0` and an empty log. Sandboxed runners now use a **real node** (DSH's own node first); if `PATH` has none either, submission **fails loudly** (`a real node executable not found`) instead of faking success. A finished job matching "instant exit + exit 0 + log containing only `[BGJOB]` markers" gets a `suspect` hint in `job.json` / the panel (a hint only — status, exit code and notify semantics are untouched) (v0.1.90).

- **Portable-first dsh-home detection for the offline GUI/CLI**: the offline tools prefer the portable tree's store and honour a new `BGJOBS_DSH_HOME` override, always showing the resolved source in the status bar (`| home: <source>:<path>`). The pain it fixes: double-clicking `tools\dsh-bgjobs-gui.bat` showed an **empty job list**, because the process inherited an old user-level `DSH_HOME` (pointing at an abandoned store) while the harness itself had moved to the portable store — the two were not reading the same one. An explicitly set `$DSH_HOME` still applies as-is (v0.1.89).
- **Completion banner (toast) dedup persisted on disk**: `toastedAt`/`toastedBy` are now recorded in each job's own `job.json`, two settings switches ("completion banner" and "banner memo") were added, and already-finished jobs no longer pop the banner again after a start or page refresh (v0.1.88).
- DSH 0.2.0-rc.2 supported (v0.1.87).
- **Fixed completion notices breaking the session on DSH 0.1.7**: the `notify` message's source marker now uses the newer form (the old `{ kind: 'plugin', … }` was rejected by DSH 0.1.7's session admission, surfacing as a failed turn — `format v4 message requires a producer-owned source kind` — and the event was refused before it reached disk, leaving no trace in the session log) (v0.1.86).
- **"Default wait timeout" is configurable in Settings**: the value `bgjob_wait` uses when the agent omits `timeoutSeconds` (0/empty = unlimited); passing `0` explicitly still forces unlimited for that one call (v0.1.85).
- **Panel rows show "Runtime"**: while running it shows the elapsed time live (`12s`/`3m05s`/`2h03m`/`1d04h`, growing with the panel's one-second refresh), and the total once done; it is part of Settings → Field display (shown in the list by default, movable to detail or hidden) (v0.1.85).
- **Timeouts are now "any positive number of seconds / unlimited by default"**: the 600-second cap is gone from `bgjob_wait`'s `timeoutSeconds` and `bgjob_submit_mcp`'s `timeout_seconds`, and **omitting them means unlimited** (wait until the result; a new inbound message still yields and the user can still stop it); the submit `wait` parameters also take any positive number of seconds (`0`/omitted still = return immediately) (v0.1.84).
- **Fixed MCP tools being executed twice through the pre-warm channel**: the pre-warm proxy call waited only 3 seconds and then "fell back to a cold start", so any tool taking longer than 3 seconds ran twice; the client's abort budget now matches the call timeout (a backstop for a host that stops responding only), and the proxy marks whether the call was actually sent — a failure/timeout after that point is **never re-run** and ends with exit code `2`/`3` (v0.1.84).
- **`bgjob_wait_all` merged into `bgjob_wait`**: a new `logic` parameter (`any` default / `all` conjunctive) now provides everything the old `bgjob_wait_all` did (`allDone` only when all succeeded; any failure returns at once with `failed` + `failedJobId` + the rest `pending`) via `bgjob_wait({ ..., logic: 'all' })`; tool count 9 → 8 (v0.1.83).
- **Yielding to a new message now hands the turn back automatically**: when `bgjob_wait` / `bgjob_wait_all` returns because of a new inbound message (`stoppedBy: 'message'`) it **declares the current turn finished** (the DSH tool-execution contract's `exec.concludeTurn`), and DSH then delivers that message to the agent as a regular user message — no more "the agent keeps waiting and the message never gets through" (v0.1.82).
- **`bgjob_wait_all` switched to conjunctive semantics**: `allDone` is true only when **every job succeeded**; any failure (non-zero exit code / cleaned up / not found) returns at once with `failed:true` + `failedJobId` + the finished jobs' `results` + the rest in `pending` instead of waiting for stragglers. After parallel submission the default posture is now `bgjob_wait`'s any-race (handle whichever lands first) (v0.1.82).
- **The guidance now explicitly forbids waiting with system sleep**: wait with `bgjob_wait` / `bgjob_wait_all` only, never `sleep` / `Start-Sleep` / `timeout` and never a "loop over `bgjob_status`"; the guidance was restructured into sections and now covers `bgjob_submit_mcp` / `bgjob_mcp_tools` (v0.1.82).
- **New MCP background-job engine**: `bgjob_submit_mcp` submits one MCP tool call as a background job — Task Scheduler-hosted like bat/pwsh, visible in the panel, wait/notify supported; off by default, enabled on the "MCP jobs" settings page (v0.1.80).
- **A separate "MCP jobs" settings page**: master switch, server registry (with edit and "List tools"), export/import (DSH-compatible YAML snippets and bgjobs JSON read back as-is), and one-click import of the MCP entries already in the DSH config (no `!!js` evaluation, with a plaintext-secret warning).
- **Per-server three-state control**: `Pre-warm` (amber — resident connection for speed, falling back to a cold start on failure) / `Cold start` (green — enabled without a resident connection) / `Disabled` (grey — refuses agent calls and drops the resident connection, while "List tools" still works); the buttons carry text so they can't be mistaken for the master switch (v0.1.80).
- **MCP jobs in the panel and on disk**: the list labels the MCP engine and the channel used (pre-warm / cold start), the job directory holds `mcp.json` (the call spec) and `result.json` (the outcome), and deleting a job reaps the stdio server child by its recorded pid.
- **Configurable panel + shortcuts**: each job field can go to the list / detail view / hidden, and UI elements (settings button, MCP settings entry, current-session-only, full access, group headers, notices) can be shown or hidden; the panel's gear button jumps straight to the plugin's settings section (v0.1.73; the data-gear shortcut to the "MCP jobs" page came later, each gated by its own toggle).
- **Log encoding fixed**: GBK log mojibake is gone; log display and encoding handling are more reliable.
- **A pending wait can be stopped at any time**: hitting stop/interrupt while the agent waits releases it immediately instead of tying up the conversation; the job keeps running in the background and can be waited on again (v0.1.71).
- **Messages from other agents interrupt a wait automatically**: a message from another agent during the wait (`send_message` etc.) yields first, so the message is handled and the result picked up later (v0.1.72).
- **The offline GUI opens reliably**: fixed "Open the offline GUI / Open the tools folder" doing nothing from the Background Jobs settings page; the GUI is now hosted by Task Scheduler, so **closing or restarting DSH no longer takes it down**.
- **Plugin-store installs supported**: the offline GUI also opens under pnpm's deep-directory layout (v0.1.70).
- **"Background Jobs" page in DSH Settings**: open the offline GUI in one click, locate its folder, toggle the sidebar entry and the bottom-right monitor panel, and see the plugin version.
- **Sidebar entry**: a one-click hide/show of the monitor panel at the bottom of the sidebar (icon only on a narrow rail).
- **Post-completion actions**: optionally shut down / hibernate / run a custom script (delay and arguments supported, configured in the offline GUI).
- **Offline GUI polish**: auto-refresh no longer jumps to the top, the list/log divider is draggable, and the list headers and refresh flicker are fixed; "Create desktop shortcut" was added.
- Failures are no longer silent: the settings page shows the reason directly.

## License

MIT — see [LICENSE](LICENSE).
