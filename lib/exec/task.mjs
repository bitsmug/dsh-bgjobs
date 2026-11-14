// bgjobs exec —— 计划任务注册/启动/删除（spec v7 §4.1 / §4.3）。
//
// 单路径：`New-ScheduledTaskAction` + `Register-ScheduledTask` + `Start-ScheduledTask`
// （CIM）。**不设 trigger**，因此不存在 `schtasks /Create /SC ONCE` 的 now+60s 二次触发，
// 也不需要 `/Change /DISABLE`。不做 XML 回退（`schtasks /TR` 有 261 字符限制，撑不住描述符）。

import path from 'node:path'
import { runSchtasks, SCHTASKS } from '../runners.js'

/** 固定的 Windows PowerShell 5.1（注册任务用；与任务 action 的解释器无关）。 */
export function powershellExe() {
  return (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
}

/** PowerShell 单引号字面量（内部 `'` 双写）。 */
function psLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** 以 -EncodedCommand 跑一段固定脚本；返回 runSchtasks 的结果。 */
export async function runPowershell(script, workdir) {
  const encoded = Buffer.from(String(script), 'utf16le').toString('base64')
  return runSchtasks([powershellExe(), '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], workdir)
}

/**
 * 注册并立即启动任务。失败时（含"已注册但启动失败"）尽力注销注册，避免残留 dsh-bgj-*。
 * 返回 `{ ok: true }` / `{ ok: false, error }`。
 */
export async function registerAndStartTask({ taskName, execute, args, workdir }) {
  if (typeof taskName !== 'string' || taskName.length === 0) return { ok: false, error: 'task name is required' }
  if (typeof execute !== 'string' || execute.length === 0) return { ok: false, error: 'task execute is required' }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $bgjobAction = New-ScheduledTaskAction -Execute ' + psLiteral(execute) + ' -Argument ' + psLiteral(args),
    '  Register-ScheduledTask -TaskName ' + psLiteral(taskName) + ' -Action $bgjobAction -Force | Out-Null',
    '  Start-ScheduledTask -TaskName ' + psLiteral(taskName),
    '} catch {',
    '  try { Unregister-ScheduledTask -TaskName ' + psLiteral(taskName) + ' -Confirm:$false -ErrorAction SilentlyContinue } catch { }',
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    '  exit 1',
    '}',
  ].join('\r\n')
  const result = await runPowershell(script, workdir)
  if (!result || result.exitCode !== 0) {
    const detail = String((result && (result.stderr || result.stdout)) || '').trim()
    return { ok: false, error: 'register scheduled task failed: ' + (detail || ('exit ' + (result && result.exitCode))) }
  }
  return { ok: true }
}

/** 幂等删除任务注册（任务不存在也算成功）。 */
export async function deleteScheduledTask(taskName, workdir) {
  try {
    return await runSchtasks([SCHTASKS, '/Delete', '/TN', String(taskName), '/F'], workdir)
  } catch (e) {
    return { exitCode: null, stdout: '', stderr: String((e && e.message) || e) }
  }
}

/** 查询本插件的任务（TaskName/State/Date）；失败返回 null（对账静默放弃）。 */
export async function listBgjobsTasks(workdir) {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$bgjobTasks = @(Get-ScheduledTask -TaskName 'dsh-bgj-*' -ErrorAction SilentlyContinue | Select-Object "
      + "@{ n = 'name'; e = { $_.TaskName } }, "
      + "@{ n = 'state'; e = { [string]$_.State } }, "
      + "@{ n = 'date'; e = { if ($_.Date) { $_.Date.ToString('o') } else { '' } } })",
    'if ($bgjobTasks.Count -eq 0) { Write-Output \'[]\' } else { Write-Output ($bgjobTasks | ConvertTo-Json -Compress) }',
  ].join('\r\n')
  const result = await runPowershell(script, workdir)
  if (!result || result.exitCode !== 0) return null
  const text = String(result.stdout || '').trim()
  if (text.length === 0) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return null
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  return items
    .filter((item) => item && typeof item.name === 'string')
    .map((item) => ({
      name: item.name,
      state: String(item.state || ''),
      date: Number.isFinite(Date.parse(item.date)) ? Date.parse(item.date) : 0,
    }))
}

/** host 结束时的任务注销（host 侧调用）。 */
export function taskNameOf(jobId) {
  return 'dsh-bgj-' + String(jobId)
}

/** jobDir 末段 → jobId（ID_RE 已在描述符校验里限制字符集）。 */
export function jobIdOfDir(jobDir) {
  return path.basename(String(jobDir || ''))
}
