// bgjobs tests —— 纯函数（utils/builders/sandbox 判定）（v0.1.61 自 tests/index.test.js 拆分）。
// 共享工具与套件隔离见 ./helpers/common.js。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  apply, strip, buildBat, buildCmdBat, buildPwshRunner, buildPs1, buildLaunchVbs, parseExitCode,
  jobSandboxDecision, shouldNotifyForExit,
  setSchtasksRunner, setShellResolver, setSandboxRunnerResolver,
  resolveBgjobsHome, bgjobsIndexPath, readBgjobsIndex, writeBgjobsIndex,
  updateBgjobsIndex, rebuildBgjobsIndex, buildBgjobsGuidance,
} from '../lib/index.js'
import {
  makeDshHome, makeWorkdir, makeCtx, makeFakeRunner, attachWebServer,
  runningPlugin, waitFor, setFullAccessEnabled, restrictedPolicy, fullPolicy,
  agentHandle, submitAndFinish, scheduleExitWrite, installSuiteHooks,
} from './helpers/common.js'

installSuiteHooks()

test('strip: 保留盘符根路径的尾部反斜杠', () => {
  assert.equal(strip('C:\\'), 'C:\\')
  assert.equal(strip('c:\\'), 'c:\\')
})


test('strip: 去掉普通路径尾部斜杠（/ 与 \\）', () => {
  assert.equal(strip('C:\\Users\\bgjobs-dev\\'), 'C:\\Users\\bgjobs-dev')
  assert.equal(strip('C:/Users/pseudo/'), 'C:/Users/pseudo')
  assert.equal(strip('C:\\Users'), 'C:\\Users')
})


test('parseExitCode: 正常/负数/无数字', () => {
  assert.equal(parseExitCode('0'), 0)
  assert.equal(parseExitCode('-1'), -1)
  assert.equal(parseExitCode(' 42 \n'), 42)
  assert.equal(parseExitCode('abc'), null)
  assert.equal(parseExitCode(''), null)
})


test('buildBat: run.bat 用 call 包裹子 bat 整体重定向，含 chcp 65001，无逐行重定向', () => {
  const job = {
    meta: {
      workdir: 'C:\\work', command: 'echo hi\n\necho bye', jsonPath: 'C:\\work\\job.json',
      logPath: 'C:\\work\\log.txt', exitcodePath: 'C:\\work\\exit.txt', taskName: 'dsh-bgj-x',
    },
  }
  const bat = buildBat(job)
  assert.ok(bat.startsWith('@echo off\r\n'))
  assert.ok(bat.includes('>nul chcp 65001'))
  assert.ok(bat.includes('cd /d "C:\\work"'))
  // 命令被 call 包裹整体重定向到 cmd.bat（由 jsonPath 推导），不逐行重定向。
  assert.ok(bat.includes('call "C:\\work\\cmd.bat" >> "C:\\work\\log.txt" 2>&1'))
  assert.ok(!bat.includes('echo hi >> "C:\\work\\log.txt" 2>&1'))
  assert.ok(!bat.includes('echo bye >> "C:\\work\\log.txt" 2>&1'))
})


test('buildCmdBat: 用户命令原样保留（含空行与 for/if 块行）', () => {
  const job = {
    meta: {
      workdir: 'C:\\work',
      command: 'for /L %%i in (1,1,3) do (\n  echo step %%i\n)\necho done',
    },
  }
  assert.equal(buildCmdBat(job), 'for /L %%i in (1,1,3) do (\r\n  echo step %%i\r\n)\r\necho done\r\n')
  // 空行保留，不出现逐行重定向破坏块结构。
  const job2 = { meta: { workdir: 'C:\\work', command: 'echo a\n\necho b' } }
  assert.equal(buildCmdBat(job2), 'echo a\r\n\r\necho b\r\n')
})


test('buildBat: cmdPath 显式指定时优先使用；exitcode 写入顺序符合 cmd 陷阱（`> file echo` 在日志 marker 之后，自删最后）', () => {
  const job = {
    meta: {
      workdir: 'C:\\work', command: 'exit 3', jsonPath: 'C:\\work\\job.json',
      cmdPath: 'C:\\work\\my-cmd.bat',
      logPath: 'C:\\work\\log.txt', exitcodePath: 'C:\\work\\exit.txt', taskName: 'dsh-bgj-x',
    },
  }
  const bat = buildBat(job)
  assert.ok(bat.includes('call "C:\\work\\my-cmd.bat" >> "C:\\work\\log.txt" 2>&1'))
  const logMarker = bat.indexOf('>> "C:\\work\\log.txt" echo [BGJOB] exit code: %bgrc%')
  const exitWrite = bat.indexOf('> "C:\\work\\exit.txt" echo %bgrc%')
  const selfDelete = bat.indexOf('schtasks /Delete /TN dsh-bgj-x /F >nul 2>&1')
  assert.ok(logMarker >= 0 && exitWrite >= 0 && selfDelete >= 0)
  assert.ok(exitWrite > logMarker, 'exitcode 写入应在日志 marker 之后')
  assert.ok(selfDelete > exitWrite, '自删任务应在写 exitcode 之后')
})


test('buildPwshRunner: run.ps1 用 & job.ps1 *> 重定向；exitcode 顺序与自删同 buildBat（无 cmd 语法）', () => {
  const job = {
    meta: {
      workdir: 'C:\\work', jsonPath: 'C:\\work\\job.json',
      scriptPath: 'C:\\work\\job.ps1',
      logPath: 'C:\\work\\log.txt', exitcodePath: 'C:\\work\\exit.txt', taskName: 'dsh-bgj-x',
    },
  }
  const ps1 = buildPwshRunner(job)
  assert.ok(ps1.startsWith('# bgjobs pwsh runner'))
  assert.ok(!ps1.includes('@echo off'), '不应再有 cmd bat 语法')
  assert.ok(ps1.includes("Set-Location -LiteralPath 'C:\\work'"))
  assert.ok(ps1.includes("& 'C:\\work\\job.ps1' *> $logPath"), '应以 & 调用 job.ps1 并 *> 重定向全部流')
  assert.ok(ps1.includes("$logPath = 'C:\\work\\log.txt'"))
  const logMarker = ps1.indexOf("[System.IO.File]::AppendAllText($logPath, '[BGJOB] exit code: ' + $code + [Environment]::NewLine, $utf8)")
  const exitWrite = ps1.indexOf("[System.IO.File]::WriteAllText('C:\\work\\exit.txt', [string]$code, $utf8)")
  const selfDelete = ps1.indexOf("& schtasks /Delete /TN 'dsh-bgj-x' /F *> $null")
  assert.ok(logMarker >= 0 && exitWrite >= 0 && selfDelete >= 0)
  assert.ok(exitWrite > logMarker, 'exitcode 写入应在日志 marker 之后')
  assert.ok(selfDelete > exitWrite, '自删任务应在写 exitcode 之后')
  assert.ok(ps1.includes("try {") && ps1.includes('} catch {'), 'try/catch 兜底保证 exitcode 必写')
  assert.ok(ps1.includes('0xFF -and $logBytes[1] -eq 0xFE'), '5.1 UTF-16LE 日志转 UTF-8 兜底')
})


test('buildPwshRunner: scriptPath 缺省时由 jsonPath 推导 job.ps1', () => {
  const job = {
    meta: {
      workdir: 'C:\\work', jsonPath: 'C:\\work\\job.json',
      logPath: 'C:\\work\\log.txt', exitcodePath: 'C:\\work\\exit.txt', taskName: 'dsh-bgj-x',
    },
  }
  assert.ok(buildPwshRunner(job).includes("& 'C:\\work\\job.ps1' *> $logPath"))
})


test('buildLaunchVbs: 纯 ASCII 模板，FSO 自推导目录启动同目录 run.bat（SW_HIDE=0，等待）', () => {
  const vbs = buildLaunchVbs()
  assert.match(vbs, /^[\x00-\x7F]*\r\n$/, 'launch.vbs 应为纯 ASCII')
  assert.ok(vbs.includes('CreateObject("Scripting.FileSystemObject")'))
  assert.ok(vbs.includes('GetParentFolderName(WScript.ScriptFullName)'))
  assert.ok(vbs.includes('sh.Run """" & dir & "\\run.bat""", 0, True'), '应以 SW_HIDE(0) 隐藏启动并等待(True)')
  assert.ok(!vbs.includes('powershell'), 'bat 引擎启动器不得依赖 PowerShell')
})


test('buildPs1: 编码 preamble + 用户命令原样保留（含空行）', () => {
  const job = { meta: { workdir: 'C:\\work', command: 'Write-Output "中文"\n\n1..3 | ForEach-Object { "step $_" }' } }
  const ps1 = buildPs1(job)
  assert.ok(ps1.startsWith('# bgjobs: 强制 UTF-8 输出'))
  assert.ok(ps1.includes('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'))
  assert.ok(ps1.includes('$OutputEncoding = [System.Text.UTF8Encoding]::new($false)'))
  // 命令原样（CRLF 归一，含空行）
  assert.ok(ps1.includes('Write-Output "中文"\r\n\r\n1..3 | ForEach-Object { "step $_" }\r\n'))
})

// ── 工具注册契约 ──

