# bgjobs — standalone background jobs for DSH

**English** · [中文](README.md)

[![npm version](https://img.shields.io/npm/v/bgjobs)](https://www.npmjs.com/package/bgjobs)
[![License](https://img.shields.io/npm/l/bgjobs)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

**Run commands outside the DSH process**: jobs are handed to the Windows Task Scheduler service, so closing DSH or the web page does not stop them. A toast appears in the web UI when a job finishes; live output is always one refresh away; and when DSH is offline you can still manage jobs with the standalone CLI/GUI.

Built for long-running work — large downloads, batch scripts, compilation, data sync/export. Submit and walk away; check back anytime.

## Feature overview

| Capability | Description |
|---|---|
| Runs outside DSH | Jobs are hosted via `schtasks`; DSH crashes/shutdowns don't matter |
| Live output panel | Floating panel (bottom-right) refreshes every second: draggable, minimizable to a bubble, collapsible to a job list, theme-aware; grouped by workspace, resizable |
| Manual cleanup | 🧹 click the cleanup icon to open the trash bar: drag a single finished job to delete, or bulk-clean (>24h only / all; follows the view filter) |
| Completion notice | Toast on exit (does not interrupt the session); optionally notify the creating agent (`notify` param) |
| Reconnect & track | Auto-recovers after a DSH restart; old job ids can still be queried from disk |
| Offline management | CLI / GUI that don't need DSH: list / status / log / submit / kill / cleanup |
| Optional sandbox | `bgjob_submit_pwsh` optional `sandbox` constrains job file permissions to no more than the current session mode |
| MCP tool calls | `bgjob_submit_mcp` submits one MCP tool call as a background job (**settings-page switch, off by default**); register servers by hand or import them from the DSH config; optional "pre-warm" resident connection for speed |
| No residue | A finished job removes its own scheduled task; done jobs stay visible until you clean them up |

## Install / uninstall

Prereqs: DSH (`@deepseek-ai/dsh`), PowerShell 7, and Node.js (≥22 for docs below; package requires ^22.19.0 or >=24), Windows.

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

Fix (one-time fix):

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
- `bgjob_submit_pwsh(name, command, workdir, [wait], [sandbox], [justification], [notify], [notify_mode])` — submit a background job (`command` is **PowerShell** syntax, UTF-8 logs, safe `exit <code>` semantics); `wait` same as above;
- `bgjob_submit_mcp(name, workdir, tool, [arguments], server | server_config, [timeout_seconds], [wait], [notify], [notify_mode])` — submit one **MCP tool call** as a background job (third engine, also `schtasks`-hosted, visible in the panel, wait/notify supported). `server` is a name registered on the settings page, `server_config` is an inline config (`{transport:"stdio",command,args,env,cwd}` or `{transport:"streamable-http",url,headers}`) — give exactly one. The job connects to that server and calls the tool once; the result lands in the log and `<jobDir>/result.json` (`channel` records whether it hit a pre-warmed resident connection or did a cold start). Exit codes: `0` success / `1` tool reported an error / `2` connect or call failed / `3` timeout. **Off by default — turn on the "MCP jobs" switch in Settings first** (calls are refused otherwise). As in DSH, the session access mode (read-only, …) does **not** restrict MCP jobs. Check tool names with `bgjob_mcp_tools` first;
- `bgjob_mcp_tools(server | server_config, [refresh])` — list that MCP server's tools (name/description/required fields) to confirm tool names and argument shape before submitting; `refresh: true` bypasses the 10-minute cache. DSH's already-registered `mcp__<server>__*` tools are used first (zero startup cost); only on a miss does it actually connect/spawn the server to probe. Also gated by the "MCP jobs" switch;
- `bgjob_status(jobId)` — query status / exit code / log tail;
- `bgjob_wait(jobId | jobIds, [timeoutSeconds])` — wait for background job(s) and **return immediately** with exit codes and log tails (default up to 120s). Three modes: single `jobId` waits for that job; a `jobIds` array is **any-race** (returns as soon as one finishes, with the finisher + the rest pending); omitting both waits for **any job of the current session** to finish;
- `bgjob_wait_all(jobIds, [timeoutSeconds])` — wait until **all** of the given jobs finish and return each one's exit code/log tail plus `allDone` (on timeout returns partial states to re-wait); omitting `jobIds` waits for all jobs of the current session;
- `bgjob_list` — list all jobs submitted by the current agent session (id/status/exit code); used together with the wait tools' default mode.

Just tell the AI:

> Submit「download https://example.com/large.zip to D:\data」as a background job named「download-big-file」.

Then:

- Job output is streamed live to `<workdir>\.dsh\bgjobs\<jobId>\stdout.log`;
- On exit, `<workdir>\.dsh\bgjobs\<jobId>\exitcode.txt` gets the exit code and a toast pops in the web page;
- By default, completion **does not interrupt the session**; when you want the agent to know and wrap up, pass `notify: on-exit` (or `on-completion` success-only / `on-fail` failure-only), plus optional `notify_mode` (`wakeup` wake an idle session / `quiet` inbox-only / `always`).
- **Delivery marker (notify view)**: each job records whether its result has been delivered into the session context — a completion notice that was injected (`notified·notify`) or a `bgjob_wait`/`bgjob_wait_all` that returned it (`notified·wait`). `bgjob_pending_list` lists the session's **not-yet-delivered** jobs (the notify view), and the default mode of `bgjob_wait`/`bgjob_wait_all` waits only on that view, so an already-delivered result is never returned twice. The web panel and the offline GUI both show a "notified / pending" marker.

## Web panel

Top bar, left to right: cleanup (opens the bottom trash bar: drag a finished job to delete, or bulk-clean >24h / all), collapse (to a compact job list), minimize (floating bubble anchored at the button). Toolbar toggles: "Only this session" (show only the current session's workspace jobs) and "Full access" (pre-approve full-access jobs; off by default). Click a job row to expand its live log. Panel copy follows the DSH UI language (Chinese DSH → Chinese panel, otherwise English).

**MCP jobs (its own Settings page, off by default)**:

- **MCP jobs switch**: controls whether the agent may use `bgjob_submit_mcp` / `bgjob_mcp_tools` (refused, with a pointer to the switch, while off). Takes effect immediately, no DSH restart. As in DSH, the session access mode (read-only, …) does not restrict MCP jobs;
- **MCP servers**: register servers the agent can reference by name (name + JSON config). Each row offers a "Pre-warm" toggle, **Edit** (loads that server's full config — including plaintext env/headers — into the form below), "List tools" (expand tool names, click to copy) and "Delete"; the list only returns env/headers **key names**, never values. Pre-warm keeps a resident connection inside the DSH process so jobs reuse it instead of paying the cold start every time — valid only while DSH runs; on failure the job falls back to an in-job cold start, so correctness never depends on it (stdio benefits most; http transports spawn nothing, so the gain is small);
- **Export / Import**: export as a **DSH YAML** snippet (`@deepseek-ai/dsh-mcp-client` entries, paste into `cordis.patch.yml`) or **bgjobs JSON** (backup/migration, read back by the import box as-is). Import accepts pasted text or a picked file and auto-detects DSH patch snippets / bgjobs JSON / one-or-more server config objects (each needs `serverName`), with "skip / overwrite existing names"; entries containing `!!js` are refused unless you tick the force box (they are never evaluated — fill in env/headers by hand). **Exported text and each job's `mcp.json` contain plaintext secrets — redact before sharing**;
- **MCP in DSH (import)**: reads the `@deepseek-ai/dsh-mcp-client` entries already configured in the **active profile** or the global `cordis.patch.yml` and imports them into the bgjobs registry with one click (read-only with respect to the DSH config). The header shows the active profile and how it was detected (command-line `--profile` / module-path realpath / single profile); entries containing `!!js` expressions are **never evaluated** and are skipped by default (fill in env/headers manually). Both the quoted form (`!!js '"Bearer " + process.env.X'`) and the **unquoted** form (`KEY: !!js process.env.X`) are recognised as needing manual review; if an expression sits somewhere it cannot be pinned to a single entry, every entry in that batch is flagged instead of silently importing the JS text as a plain string.

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

Double-click `tools\dsh-bgjobs-gui.bat` to open a standalone window (no DSH needed): job list/log, submit (bat or pwsh), kill, cleanup (custom age cutoff or all), rebuild index. GUI and Toast copy follow the Windows UI language (zh* → Simplified Chinese, otherwise English); the CLI prints English.

## Data & storage

- Job data: `<workdir>\.dsh\bgjobs\<jobId>\` (`job.json` metadata, `stdout.log` output, `exitcode.txt` exit code; MCP jobs also have `mcp.json` for the call spec and `result.json` for the outcome);
- Global state: `$DSH_HOME\bgjobs\index.json` (job "map"), `$DSH_HOME\bgjobs\fullaccess.json` (full-access switch), `$DSH_HOME\bgjobs\ui-prefs.json` (web UI prefs), `$DSH_HOME\bgjobs\mcp-prefs.json` (MCP jobs switch), `$DSH_HOME\bgjobs\mcp-servers.json` (MCP server registry incl. per-server pre-warm flag), `$DSH_HOME\bgjobs\mcp-tools-cache.json` (tool-list cache, 10 minutes);
- `done` jobs persist by default until you clean them (panel 🧹 / CLI cleanup / GUI).

## Notes & limits

- `workdir` must be an absolute path inside a DSH workspace;
- Jobs run by default "only while the user is logged in": closing DSH/the terminal is fine, but **logging out of Windows terminates jobs**;
- Don't put `> log`-style redirects in your command (the plugin already redirects all output and guarantees UTF-8);
- **Sandbox**: `sandbox` only constrains file effects (writes outside the workspace/temp area are denied), network is unrestricted; it is "best effort", not a mathematical boundary — it fails if the workdir sits in an Everyone-writable location; sandboxed job dirs get Everyone:read (the script text is visible to local users); bat-engine jobs are always full-access, so restricted sessions must enable "Full access" to submit them;
- In a restricted session, requesting more than the session mode triggers an approval prompt — put the reason in `justification`.
- **MCP jobs**: off by default (enable in Settings); if a job is force-killed, its stdio MCP server child may linger (a normal finish is cleaned up by the host, which also kills the pid recorded for a job when you delete it); the "pre-warm" connection is only valid while DSH runs and never changes the "jobs survive DSH" guarantee; the offline CLI/GUI only view and delete MCP jobs — they do not submit MCP calls.
- **A stopped wait is not a failed job**: when you hit stop/interrupt while the agent waits, the wait itself ends **as an error** (the message names each job's current state and says you can wait again). That is DSH's cancellation semantics — once the caller cancels, a successful return cannot reach the model, only an error can; the job keeps running in the background, is not marked delivered, and the agent can call `bgjob_wait` again. A message from another agent during the wait returns normally instead (`stoppedBy: 'message'`).
- **MCP timeout cleanup has a 1–2s grace period**: after an MCP timeout/failure the host closes the connection and reaps the server child (the SDK's `close()` waits ~2s before escalating), so `result.json`'s `durationMs` can exceed `timeoutMs` by 1–2s (the same file records `timeoutMs` for comparison).

## Development

Architecture, mechanism details, testing and release flow: see [docs/developer.md](docs/developer.md).

## License

MIT — see [LICENSE](LICENSE).
