# bgjobs — standalone background jobs for DSH

> **English** · [中文](README.md)

**Run commands outside the DSH process**: jobs are handed to the Windows Task Scheduler service, so closing DSH, closing the web page, or even closing the terminal does not stop them. A toast appears in the web UI when a job finishes; live output is always one refresh away; and when DSH is offline you can still manage jobs with the standalone CLI/GUI.

Built for long-running work — large downloads, batch scripts, compilation, data sync/export. Submit and walk away; check back anytime.

## Feature overview

| Capability | Description |
|---|---|
| Runs outside DSH | Jobs are hosted via `schtasks`; DSH crashes/shutdowns don't matter |
| Live output panel | Floating panel (bottom-right) refreshes every second: draggable, minimizable to a bubble, collapsible to a job list, theme-aware; grouped by workspace, resizable |
| Manual cleanup | 🧹 pick the scope: >24h only (default keeps the last 24h) or everything; a single job can be dragged to the trash to delete |
| Completion notice | Toast on exit (does not interrupt the session); optionally notify the creating agent (`notify` param) |
| Reconnect & track | Auto-recovers after a DSH restart; old job ids can still be queried from disk |
| Offline management | CLI / GUI that don't need DSH: list / status / log / submit / kill / cleanup |
| Optional sandbox | `bgjob_submit_pwsh` optional `sandbox` constrains job file permissions to no more than the current session mode |
| No residue | A finished job removes its own scheduled task; done jobs stay visible until you clean them up |

## Install / uninstall

Prereqs: DSH (`@deepseek-ai/dsh`) and Node.js (≥18 for docs below; package requires ^22.19.0 or >=24), Windows.

**Method A (recommended, npm release)**

```bat
dsh plugin --profile <profile> add bgjobs
```

> Installs the published version from the npm registry. **Note: registry mirrors can lag** (especially in China, e.g. npmmirror), so a fresh release may not be installable immediately. For the very latest — or to try unpublished changes — use Method B below (direct from GitHub).

**Method B (from GitHub, always latest)**

```bat
dsh plugin --profile <profile> add github:bitsmug/dsh-bgjobs
```

> Pulls the default branch directly from the GitHub repo — **always the newest code** (published and unpublished alike), no registry-lag. Both methods install under the name `bgjobs`, so the uninstall command is the same.

**First install fails with `ERR_PNPM_IGNORED_BUILDS`?**

The plugin depends on the native library `koffi`; installing it triggers a build script, and pnpm ≥10 blocks dependency build scripts by default (a GitHub install also runs `prepare`). The error looks like:

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: koffi@3.1.6
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
dsh: pnpm failed in profile directory <your DSH home>\profiles\<profile>
```

Fix (one-time):

1. Open `pnpm-workspace.yaml` (same location as above; the error prints the full path). The failed `add` already wrote a placeholder line:
   ```yaml
   allowBuilds:
     koffi: set this to true or false
   ```
2. Change the value to `true` (use the exact key your pnpm printed — it may include the version, e.g. `koffi@3.1.6`):
   ```yaml
   allowBuilds:
     koffi: true
   ```
3. Re-run the `add` command above. No further changes needed.

> `pnpm approve-builds` (interactive) does the same thing; the manual edit above is its equivalent. Only the first install needs this — once koffi is compiled it stays compiled, and upgrades/reinstalls don't repeat the step.

Restart DSH afterwards: the "Background Jobs Monitor" panel appears bottom-right of the web page and the agent gains `bgjob_submit` / `bgjob_submit_pwsh` / `bgjob_status` / `bgjob_wait` tools.

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

- `bgjob_submit(name, command, workdir, [wait], [notify], [notify_mode])` — submit a background job (`command` is **bat** syntax); `wait` = seconds to wait for the result after submitting (0/omitted = return immediately);
- `bgjob_submit_pwsh(name, command, workdir, [wait], [sandbox], [justification], [notify], [notify_mode])` — submit a background job (`command` is **PowerShell** syntax, UTF-8 logs, safe `exit <code>` semantics); `wait` same as above (auto-wait after submit);
- `bgjob_status(jobId)` — query status / exit code / log tail;
- `bgjob_wait(jobId, [timeoutSeconds])` — wait until the background job finishes and **return immediately** with its exit code and log tail (default up to 120s; use it when you need the result to continue, instead of foreground `sleep` polling).

Just tell the AI:

> Submit「download https://example.com/large.zip to D:\data」as a background job named「download-big-file」.

Then:

- Job output is streamed live to `<workdir>\.dsh\bgjobs\<jobId>\stdout.log`;
- On exit, `<workdir>\.dsh\bgjobs\<jobId>\exitcode.txt` gets the exit code and a toast pops in the web page;
- By default, completion **does not interrupt the session**; when you want the agent to know and wrap up, pass `notify: on-exit` (or `on-completion` success-only / `on-fail` failure-only), plus optional `notify_mode` (`wakeup` wake an idle session / `quiet` inbox-only / `always`).

## Web panel

Top bar, left to right: cleanup (choose >24h ago / all), collapse (to a compact job list), minimize (floating bubble anchored at the button). Toolbar toggles: "Only this session" (show only the current session's workspace jobs) and "Full access" (pre-approve full-access jobs; off by default). Click a job row to expand its live log. Panel copy follows the DSH UI language (Chinese DSH → Chinese panel, otherwise English).

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

- Job data: `<workdir>\.dsh\bgjobs\<jobId>\` (`job.json` metadata, `stdout.log` output, `exitcode.txt` exit code);
- Global state: `$DSH_HOME\bgjobs\index.json` (job "map"), `$DSH_HOME\bgjobs\fullaccess.json` (full-access switch);
- `done` jobs persist by default until you clean them (panel 🧹 / CLI cleanup / GUI).

## Notes & limits

- `workdir` must be an absolute path inside a DSH workspace;
- Jobs run by default "only while the user is logged in": closing DSH/the terminal is fine, but **logging out of Windows terminates jobs**;
- Don't put `> log`-style redirects in your command (the plugin already redirects all output and guarantees UTF-8);
- **Sandbox**: `sandbox` only constrains file effects (writes outside the workspace/temp area are denied), network is unrestricted; it is "best effort", not a mathematical boundary — it fails if the workdir sits in an Everyone-writable location; sandboxed job dirs get Everyone:read (the script text is visible to local users); bat-engine jobs are always full-access, so restricted sessions must enable "Full access" to submit them;
- In a restricted session, requesting more than the session mode triggers an approval prompt — put the reason in `justification`.

## Development

Architecture, mechanism details, testing and release flow: see [docs/developer.md](docs/developer.md).

## License

MIT — see [LICENSE](LICENSE).
