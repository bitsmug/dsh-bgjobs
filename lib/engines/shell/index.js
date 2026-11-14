// bgjobs —— 内置 shell engines（bat + pwsh）。
// bat / pwsh 的脚本生成与解释器解析在此收拢；沙箱 wiring（runner 路径、icacls、confine）
// 仍由 jobs.js 负责。
//
// ★ v0.4（P0）：pwsh 改走**描述符链路** —— 只提供 buildDescriptor（字段契约见
//   spec v7 §4.3），执行输入是任务定义里的 `<node> host.mjs <jobDir> <descriptor>`；
//   工作区不再生成/执行机电脚本。bat 仍走旧链路（P1 再迁移）。

import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { BgjobEngine } from '../../core/engines.js'
import { buildBat, buildCmdBat, buildLaunchVbs } from '../../scripts.js'
import { resolveShell } from '../../runners.js'

/** bat engine：纯 cmd 批处理，经 wscript+vbs 隐藏窗口。阶段 0 不支持 sandbox。 */
export const batEngine = new BgjobEngine({
  id: 'bat',
  label: 'CMD',
  supportsSandbox: false,

  async resolve() { return {} },

  buildMeta(_ctx, baseMeta) {
    const jobDir = path.dirname(baseMeta.jsonPath)
    return {
      engine: 'bat',
      cmdPath: jobDir + '\\cmd.bat',
      launchVbsPath: jobDir + '\\launch.vbs',
      // bat 共用管线还要写 run.bat；留空让 jobs.js 共用逻辑不报错
    }
  },

  async writeFiles(_ctx, job) {
    const meta = job.meta
    const jobDir = path.dirname(meta.jsonPath)
    // run.bat（共用管线）+ cmd.bat（用户命令）+ launch.vbs（隐藏窗口启动器）
    await fsp.writeFile(meta.cmdPath, buildCmdBat(job), 'utf8')
    await fsp.writeFile(path.join(jobDir, 'run.bat'), buildBat(job), 'utf8')
    await fsp.writeFile(meta.launchVbsPath, buildLaunchVbs(), 'utf8')
    return {}
  },

  buildTr(_ctx, job) {
    const wscriptExe = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\wscript.exe'
    return '"' + wscriptExe + '" "' + job.meta.launchVbsPath + '"'
  },
})

/** pwsh engine：PowerShell 7 / 5.1，走描述符链路（工作区只留记录与输出）。 */
export const pwshEngine = new BgjobEngine({
  id: 'pwsh',
  label: 'PowerShell',
  supportsSandbox: true,

  async resolve() {
    const shell = await resolveShell()
    if (shell === null) {
      return { error: 'PowerShell not found: install pwsh (7+) or Windows PowerShell' }
    }
    return { shell }
  },

  buildMeta(_ctx, baseMeta, resolveOut) {
    const jobDir = path.dirname(baseMeta.jsonPath)
    return {
      engine: 'pwsh',
      // 记录文件（原始命令，仅供人读；不参与执行），host 侧日志固定为 stdout.log。
      recordPath: jobDir + '\\cmd.ps1',
      interpreter: resolveOut.shell.exe,
    }
  },

  /**
   * 描述符字段（spec v7 §7）：engine 只声明"怎么执行这条命令"，公共字段
   * （v/id/n/s/w）由 jobs.js 填。`c` 用 effectiveCommand（含 env 前缀）。
   */
  buildDescriptor(_ctx, { meta }) {
    const encoding = meta.outputEncoding || 'auto'
    const command = meta.effectiveCommand === undefined ? meta.command : meta.effectiveCommand
    if (meta.sandboxBackend === 'dsh') {
      return { m: 'sandbox', b: 'dsh', e: 'pwsh', o: encoding, a: meta.confinedArgv }
    }
    if (meta.sandbox && meta.sandbox !== 'off') {
      return {
        m: 'sandbox', b: 'acl', e: 'pwsh', o: encoding,
        c: command, p: meta.sandbox,
        ...(meta.sandboxTempPath ? { t: meta.sandboxTempPath } : {}),
      }
    }
    return { m: 'direct', e: 'pwsh', o: encoding, c: command }
  },
})
