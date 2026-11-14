// bgjobs tests —— 纯函数（utils/builders/sandbox 判定）（v0.1.61 自 tests/index.test.js 拆分）。
// 共享工具与套件隔离见 ./helpers/common.js。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  apply, strip, buildBat, buildCmdBat, buildPwshRunner, buildPs1, buildLaunchVbs, parseExitCode,
  decodeAutoText, tailText, writeFileAtomic,
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
  assert.equal(strip('X:\\'), 'X:\\')
  assert.equal(strip('c:\\'), 'c:\\')
})


test('strip: 去掉普通路径尾部斜杠（/ 与 \\）', () => {
  assert.equal(strip('X:\\Users\\bgjobs-dev\\'), 'X:\\Users\\bgjobs-dev')
  assert.equal(strip('X:/Users/pseudo/'), 'X:/Users/pseudo')
  assert.equal(strip('X:\\Users'), 'X:\\Users')
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
      workdir: 'X:\\work', command: 'echo hi\n\necho bye', jsonPath: 'X:\\work\\job.json',
      logPath: 'X:\\work\\log.txt', exitcodePath: 'X:\\work\\exit.txt', taskName: 'dsh-bgj-x',
    },
  }
  const bat = buildBat(job)
  assert.ok(bat.startsWith('@echo off\r\n'))
  assert.ok(bat.includes('>nul chcp 65001'))
  assert.ok(bat.includes('cd /d "X:\\work"'))
  // 命令被 call 包裹整体重定向到 cmd.bat（由 jsonPath 推导），不逐行重定向。
  assert.ok(bat.includes('call "X:\\work\\cmd.bat" >> "X:\\work\\log.txt" 2>&1'))
  assert.ok(!bat.includes('echo hi >> "X:\\work\\log.txt" 2>&1'))
  assert.ok(!bat.includes('echo bye >> "X:\\work\\log.txt" 2>&1'))
})


test('buildCmdBat: 用户命令原样保留（含空行与 for/if 块行）', () => {
  const job = {
    meta: {
      workdir: 'X:\\work',
      command: 'for /L %%i in (1,1,3) do (\n  echo step %%i\n)\necho done',
    },
  }
  assert.equal(buildCmdBat(job), 'for /L %%i in (1,1,3) do (\r\n  echo step %%i\r\n)\r\necho done\r\n')
  // 空行保留，不出现逐行重定向破坏块结构。
  const job2 = { meta: { workdir: 'X:\\work', command: 'echo a\n\necho b' } }
  assert.equal(buildCmdBat(job2), 'echo a\r\n\r\necho b\r\n')
})


test('buildBat: cmdPath 显式指定时优先使用；exitcode 写入顺序符合 cmd 陷阱（`> file echo` 在日志 marker 之后，自删最后）', () => {
  const job = {
    meta: {
      workdir: 'X:\\work', command: 'exit 3', jsonPath: 'X:\\work\\job.json',
      cmdPath: 'X:\\work\\my-cmd.bat',
      logPath: 'X:\\work\\log.txt', exitcodePath: 'X:\\work\\exit.txt', taskName: 'dsh-bgj-x',
    },
  }
  const bat = buildBat(job)
  assert.ok(bat.includes('call "X:\\work\\my-cmd.bat" >> "X:\\work\\log.txt" 2>&1'))
  const logMarker = bat.indexOf('>> "X:\\work\\log.txt" echo [BGJOB] exit code: %bgrc%')
  const exitWrite = bat.indexOf('> "X:\\work\\exit.txt" echo %bgrc%')
  const selfDelete = bat.indexOf('schtasks /Delete /TN dsh-bgj-x /F >nul 2>&1')
  assert.ok(logMarker >= 0 && exitWrite >= 0 && selfDelete >= 0)
  assert.ok(exitWrite > logMarker, 'exitcode 写入应在日志 marker 之后')
  assert.ok(selfDelete > exitWrite, '自删任务应在写 exitcode 之后')
})


test('buildPwshRunner: run.ps1 用 & job.ps1 *> 重定向；exitcode 顺序与自删同 buildBat（无 cmd 语法）', () => {
  const job = {
    meta: {
      workdir: 'X:\\work', jsonPath: 'X:\\work\\job.json',
      scriptPath: 'X:\\work\\job.ps1',
      logPath: 'X:\\work\\log.txt', exitcodePath: 'X:\\work\\exit.txt', taskName: 'dsh-bgj-x',
    },
  }
  const ps1 = buildPwshRunner(job)
  assert.ok(ps1.startsWith('# bgjobs pwsh runner'))
  assert.ok(!ps1.includes('@echo off'), '不应再有 cmd bat 语法')
  assert.ok(ps1.includes("Set-Location -LiteralPath 'X:\\work'"))
  assert.ok(ps1.includes("& 'X:\\work\\job.ps1' *> $logPath"), '应以 & 调用 job.ps1 并 *> 重定向全部流')
  assert.ok(ps1.includes("$logPath = 'X:\\work\\log.txt'"))
  const logMarker = ps1.indexOf("[System.IO.File]::AppendAllText($logPath, '[BGJOB] exit code: ' + $code + [Environment]::NewLine, $utf8)")
  const exitWrite = ps1.indexOf("[System.IO.File]::WriteAllText('X:\\work\\exit.txt', [string]$code, $utf8)")
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
      workdir: 'X:\\work', jsonPath: 'X:\\work\\job.json',
      logPath: 'X:\\work\\log.txt', exitcodePath: 'X:\\work\\exit.txt', taskName: 'dsh-bgj-x',
    },
  }
  assert.ok(buildPwshRunner(job).includes("& 'X:\\work\\job.ps1' *> $logPath"))
})


test('buildLaunchVbs: 纯 ASCII 模板，FSO 自推导目录启动同目录 run.bat（SW_HIDE=0，等待）', () => {
  const vbs = buildLaunchVbs()
  assert.match(vbs, /^[\x00-\x7F]*\r\n$/, 'launch.vbs 应为纯 ASCII')
  assert.ok(vbs.includes('CreateObject("Scripting.FileSystemObject")'))
  assert.ok(vbs.includes('GetParentFolderName(WScript.ScriptFullName)'))
  assert.ok(vbs.includes('sh.Run """" & dir & "\\run.bat""", 0, True'), '应以 SW_HIDE(0) 隐藏启动并等待(True)')
  assert.ok(!vbs.includes('powershell'), 'bat 引擎启动器不得依赖 PowerShell')
})


test('buildPs1: 5.1（含 interpreter 缺失的 fail-safe）写编码 preamble + 用户命令原样保留（含空行）', () => {
  // 无 meta.interpreter ⇒ 判据拿不到 ⇒ fail-safe 当 5.1，preamble 照写（v0.1.92 条件化）
  const job = { meta: { workdir: 'X:\\work', command: 'Write-Output "中文"\n\n1..3 | ForEach-Object { "step $_" }' } }
  const ps1 = buildPs1(job)
  assert.ok(ps1.startsWith('# bgjobs: 强制 UTF-8 输出'))
  assert.ok(ps1.includes('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'))
  assert.ok(ps1.includes('$OutputEncoding = [System.Text.UTF8Encoding]::new($false)'))
  assert.ok(!ps1.includes('Add-Type'), 'v0.1.92：preamble 不再含 Add-Type（现编译 C#，+0.6 s/次且对 5.1 产物零语义）')
  // 命令原样（CRLF 归一，含空行）
  assert.ok(ps1.includes('Write-Output "中文"\r\n\r\n1..3 | ForEach-Object { "step $_" }\r\n'))
})


test('buildPs1: 解释器是 powershell.exe（5.1）时写编码 preamble，但不含 Add-Type（v0.1.92）', () => {
  const ps51 = buildPs1({
    meta: { interpreter: 'X:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', command: "Write-Output '中文'" },
  })
  assert.ok(ps51.startsWith('# bgjobs: 强制 UTF-8 输出'))
  assert.ok(ps51.includes('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'))
  assert.ok(ps51.includes('$OutputEncoding = [System.Text.UTF8Encoding]::new($false)'))
  assert.ok(!ps51.includes('Add-Type'), '5.1 也不需要 Add-Type（乱码由 run.ps1 的 FF FE 转换兜底）')
})


test('buildPs1: 解释器是 pwsh 7（pwsh/pwsh.exe）时整段跳过编码 preamble（v0.1.92）', () => {
  for (const interpreter of ['X:\\Program Files\\PowerShell\\7\\pwsh.exe', 'pwsh', '/usr/local/bin/pwsh']) {
    const ps7 = buildPs1({ meta: { interpreter, command: "Write-Output '中文'" } })
    assert.ok(!ps7.startsWith('# bgjobs:'), interpreter + '：pwsh 7 不应写 preamble 注释（连第一行也不写）')
    assert.ok(!ps7.includes('OutputEncoding'), interpreter + '：pwsh 7 不应写任何编码设置')
    assert.equal(ps7, "Write-Output '中文'\r\n", interpreter + '：pwsh 7 的 job.ps1 应只有用户命令')
  }
})


test('buildPwshRunner: 两种解释器的 run.ps1 都设 [Console]::OutputEncoding = $utf8（v0.1.95 乱码修复），FF FE 兜底保留', () => {
  const baseMeta = {
    workdir: 'X:\\work', jsonPath: 'X:\\work\\job.json', logPath: 'X:\\work\\log.txt',
    exitcodePath: 'X:\\work\\exit.txt', taskName: 'dsh-bgj-x',
  }
  const fixLine = '[Console]::OutputEncoding = $utf8'
  const redirectLine = "& 'X:\\work\\job.ps1' *> $logPath"
  const runner7 = buildPwshRunner({ meta: { ...baseMeta, interpreter: 'X:\\fake\\pwsh.exe' } })
  assert.ok(!runner7.includes('Add-Type'), 'run.ps1 不应再含 Add-Type')
  // v0.1.95 乱码修复：pwsh 7 只在 stdout 被重定向时才强制 UTF-8；进程拥有控制台时（schtasks /
  // -WindowStyle Hidden）保留继承的 CP 936 ⇒ native node 的 UTF-8 中文被按 936 解码成乱码。
  // 正向断言：pwsh 7 的 run.ps1 也必须含该行（旧断言「pwsh 7 不应写编码设置」已作废，勿改回）。
  assert.ok(runner7.includes(fixLine), 'pwsh 7 的 run.ps1 必须含编码兜底行（期望：' + fixLine + '）')
  assert.ok(runner7.includes('[Console]::OutputEncoding'), 'pwsh 7 的 run.ps1 必须含 [Console]::OutputEncoding')
  const runner51 = buildPwshRunner({ meta: { ...baseMeta, interpreter: 'X:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' } })
  assert.ok(runner51.includes('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'), '5.1 的 run.ps1 仍写编码 preamble')
  assert.ok(runner51.includes(fixLine), '5.1 的 run.ps1 同样含编码兜底行（与 preamble 幂等，同一个 $utf8）')
  assert.ok(!runner51.includes('Add-Type'))
  for (const runnerText of [runner7, runner51]) {
    // 行序：$utf8 先定义（复用同一处定义、不重复 new）→ 兜底行 → 重定向
    const defineIndex = runnerText.indexOf('$utf8 = New-Object System.Text.UTF8Encoding($false)')
    const fixIndex = runnerText.indexOf(fixLine)
    const redirectIndex = runnerText.indexOf(redirectLine)
    assert.ok(defineIndex >= 0 && fixIndex >= 0 && redirectIndex >= 0, '三行都必须在')
    assert.ok(defineIndex < fixIndex, '$utf8 必须先定义（禁止重复 new）')
    assert.ok(fixIndex < redirectIndex, '编码设置必须在 `*> $logPath` 之前')
    // 乱码兜底（5.1 UTF-16LE → UTF-8）两端都必须在
    assert.ok(runnerText.includes('0xFF') && runnerText.includes('0xFE'), 'FF FE 检测转换不得丢')
  }
})


test('buildPwshRunner: output_encoding=native 改用继承码页；默认一个 $nativeEnc 都不许有（互证，v0.2.6）', () => {
  const baseMeta = {
    workdir: 'X:\\work', jsonPath: 'X:\\work\\job.json', logPath: 'X:\\work\\log.txt',
    exitcodePath: 'X:\\work\\exit.txt', taskName: 'dsh-bgj-x', interpreter: 'X:\\fake\\pwsh.exe',
  }
  const nativeLine = '$nativeEnc = [Console]::OutputEncoding'
  const fallbackLine = 'if ($nativeEnc.CodePage -eq 65001) { $nativeEnc = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage) }'
  const nativeRunner = buildPwshRunner({ meta: { ...baseMeta, outputEncoding: 'native' } })
  assert.ok(nativeRunner.includes(nativeLine), 'native：必须含"取继承码页"那行')
  assert.ok(nativeRunner.includes(fallbackLine), 'native：继承到 65001 时必须兜底到系统 ANSI 码页（否则 native 与 utf8 等价）')
  assert.ok(nativeRunner.includes('[Console]::OutputEncoding = $nativeEnc'), 'native：解码行改用 $nativeEnc')
  assert.ok(!nativeRunner.includes('[Console]::OutputEncoding = $utf8'), 'native：不得再按 UTF-8 解码')
  assert.ok(nativeRunner.indexOf(nativeLine) < nativeRunner.indexOf('$pidPath'), '$nativeEnc 必须在 $pidPath（= 任何覆盖之前）之前取')
  assert.ok(nativeRunner.indexOf('[Console]::OutputEncoding = $nativeEnc') < nativeRunner.indexOf('*> $logPath'), '编码设置必须在 `*> $logPath` 之前')
  const utf8Runner = buildPwshRunner({ meta: { ...baseMeta } })
  assert.ok(!utf8Runner.includes('$nativeEnc'), '默认路径不得出现 $nativeEnc（逐字节不变）')
  assert.ok(!utf8Runner.includes('$autoActive') && !utf8Runner.includes('28591'), '无字段（存量任务）不得出现 auto 形态（逐字节不变）')
  assert.ok(utf8Runner.includes('[Console]::OutputEncoding = $utf8'), '默认路径仍按 UTF-8 解码')
  for (const t of [nativeRunner, utf8Runner]) {
    assert.ok(t.includes('0xFF') && t.includes('0xFE'), 'FF FE 检测转换不得丢')
    assert.ok(!t.includes('Add-Type'), 'run.ps1 不应含 Add-Type')
  }
})

test('buildPwshRunner: output_encoding=auto 无损捕获（28591）+ 收尾检测块；显式 utf8 保持老形态（v0.3.2）', () => {
  const baseMeta = {
    workdir: 'X:\\work', jsonPath: 'X:\\work\\job.json', logPath: 'X:\\work\\log.txt',
    exitcodePath: 'X:\\work\\exit.txt', taskName: 'dsh-bgj-x', interpreter: 'X:\\fake\\pwsh.exe',
  }
  const autoRunner = buildPwshRunner({ meta: { ...baseMeta, outputEncoding: 'auto' } })
  assert.ok(autoRunner.includes('$autoActive = $false'), 'auto：须先声明 $autoActive')
  assert.ok(autoRunner.includes('[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(28591)'), 'auto：28591 无损成像')
  assert.ok(autoRunner.includes('if ($autoActive) {'), 'auto：须含收尾检测块')
  assert.ok(autoRunner.includes('System.Text.UTF8Encoding($false, $true)'), 'auto：严格 UTF-8（throwOnInvalidBytes）试错')
  assert.ok(autoRunner.includes('ANSICodePage'), 'auto：ANSI 码页兜底')
  assert.ok(autoRunner.includes('[System.Text.RegularExpressions.Regex]::Replace'), 'auto：逐段替换')
  assert.ok(!autoRunner.includes('$nativeEnc'), 'auto：不得含 $nativeEnc')
  // 顺序：28591 赋值在 `*>` 之前；收尾块在 FF FE 块之后、exit marker 之前（host 读到 exitcode 时日志已重写）
  assert.ok(autoRunner.indexOf('GetEncoding(28591)') < autoRunner.indexOf('*> $logPath'), '28591 赋值必须在 `*> $logPath` 之前')
  assert.ok(autoRunner.indexOf('if ($autoActive) {') > autoRunner.indexOf('0xFE'), '收尾块必须在 FF FE 块之后')
  assert.ok(autoRunner.indexOf('if ($autoActive) {') < autoRunner.indexOf('[BGJOB] exit code:'), '收尾块必须在 exit marker 之前')
  assert.ok(autoRunner.includes('0xFF') && autoRunner.includes('0xFE'), 'FF FE 检测转换不得丢')
  // 显式 utf8 = 老形态（强制档，逐字节不变）
  const utf8Runner = buildPwshRunner({ meta: { ...baseMeta, outputEncoding: 'utf8' } })
  assert.ok(!utf8Runner.includes('$autoActive') && !utf8Runner.includes('28591'), '显式 utf8 不得出现 auto 形态')
  assert.ok(!utf8Runner.includes('$nativeEnc'), '显式 utf8 不得出现 $nativeEnc')
  assert.ok(utf8Runner.includes('[Console]::OutputEncoding = $utf8'), '显式 utf8 仍按 UTF-8 解码')
})

test('decodeAutoText: UTF-8/GBK 字节成像还原、纯 ASCII 与正常中文原样、幂等（v0.3.2）', () => {
  const image = (bytes) => Array.from(bytes).map((b) => String.fromCharCode(b)).join('')
  // UTF-8 成像（node 类程序的输出）：'中文' 的 UTF-8 字节
  const utf8Imaged = image(new TextEncoder().encode('中文'))
  assert.equal(decodeAutoText(utf8Imaged), '中文', 'UTF-8 成像段应还原为中文')
  // GBK 成像（MATLAB 类本地码页程序）：'中文' 的 GBK 字节 D6 D0 CE C4
  const gbkImaged = image([0xd6, 0xd0, 0xce, 0xc4])
  assert.equal(decodeAutoText(gbkImaged), '中文', 'GBK 成像段应还原为中文')
  // 混合：ASCII 前缀 + 成像段 + ASCII 后缀
  assert.equal(decodeAutoText('ok: ' + utf8Imaged + ' done'), 'ok: 中文 done', '成像段外的 ASCII 原样')
  // 纯 ASCII / 正常中文（无成像段）原样
  assert.equal(decodeAutoText('plain ascii 123'), 'plain ascii 123')
  assert.equal(decodeAutoText('正常中文'), '正常中文')
  assert.equal(decodeAutoText(''), '')
  // 幂等：收尾重写后再套一遍是 no-op
  assert.equal(decodeAutoText(decodeAutoText(utf8Imaged)), '中文')
  assert.equal(decodeAutoText(decodeAutoText(gbkImaged)), '中文')
})

test('decodeAutoText: 含 > U+00FF 的真 UTF-8 行不得被逆映射（v15 整行闸门）', () => {
  const image = (bytes) => Array.from(bytes).map((b) => String.fromCharCode(b)).join('')
  // 现场：auto 收尾把 PS 写出的真 UTF-8 行 `PS: 中文 °±·℃` 里的 °±· 当成成像 ⇒ 压成 B0 B1 B7 ⇒ GBK `氨`
  assert.equal(decodeAutoText('PS: 中文 °±·℃'), 'PS: 中文 °±·℃', '含中文/℃ 的行原样返回')
  // 同一份日志里成像行仍要还原（逐行判定，互不牵连）
  const gbkImaged = image([0xd6, 0xd0, 0xce, 0xc4])
  assert.equal(decodeAutoText('PS: 中文 °±·℃\r\n' + gbkImaged + '\r\n'), 'PS: 中文 °±·℃\r\n中文\r\n')
})

test('writeFileAtomic: 覆盖已有文件、内容完整、不留临时文件（v16）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bgjobs-atomic-'))
  try {
    const file = path.join(dir, 'exitcode.txt')
    await fsp.writeFile(file, '9', 'utf8')
    await writeFileAtomic(file, '7')
    assert.equal(await fsp.readFile(file, 'utf8'), '7')
    assert.deepEqual((await fsp.readdir(dir)).filter((n) => n !== 'exitcode.txt'), [], '不得残留 .tmp 文件')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('tailText: 尾部窗口在行边界切，不切出半个多字节字符（v12）', () => {
  assert.equal(tailText('short', 100), 'short')
  assert.equal(tailText(null, 10), '')
  // 落点恰在行边界：直接取后 cap 个字符
  const aligned = 'abcd\n'.repeat(10)
  assert.equal(tailText(aligned, 45), aligned.slice(5))
  // 落点在行中：跳过残缺首行，且不改变尾部内容
  const lines = Array.from({ length: 50 }, (_, i) => String(i).padStart(3, '0') + '-abcdef').join('\n')
  const cut = tailText(lines, 100)
  assert.ok(cut.length <= 100)
  assert.ok(lines.endsWith(cut), '尾部内容不变')
  assert.ok(/^\d{3}-abcdef/.test(cut), '首行完整（不残留半行）')
  // 单行超长：退回硬切（末尾残片由 decodeAutoText 丢弃）
  assert.equal(tailText('x'.repeat(200), 50), 'x'.repeat(50))
})

test('decodeAutoText: 末尾写了一半的多字节序列不产生 �（v12 mid-character truncation）', () => {
  const image = (bytes) => Array.from(bytes).map((b) => String.fromCharCode(b)).join('')
  // UTF-8 半个字（'中' = E4 B8 AD，只写进前 2 字节）
  assert.equal(decodeAutoText(image([0xe4, 0xb8])), '', '残缺 UTF-8 尾部丢弃，不回落 GBK')
  assert.equal(decodeAutoText('NODE-' + image([0xe4, 0xb8, 0xad, 0xe4, 0xb8])), 'NODE-中')
  // GBK 悬空前导字节（'中' = D6 D0）
  assert.equal(decodeAutoText(image([0x41, 0xd6])), 'A')
  assert.equal(decodeAutoText(image([0xd6, 0xd0, 0xd6])), '中')
  assert.equal(decodeAutoText(image([0xd6, 0xd0])), '中')
  // 行边界窗口 + 成像文本：整条链路不产生 �
  const imaged = image(new TextEncoder().encode('alpha\nbeta\n中文\n'))
  assert.equal(decodeAutoText(tailText(imaged, 10)), '中文\n')
})

// ── 工具注册契约 ──

