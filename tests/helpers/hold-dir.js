// bgjobs tests —— "目录被占住"助手：制造真实的 Windows 删除失败（EBUSY）。
//
// 为什么需要它（缺口 A 的测试）：`fsp.rm(jobDir, { recursive: true })` 只有在目录**真的被占住**
// 时才 EBUSY。实测两条弯路（勿重走）：
//   ① 用 `fsp.open(file, 'r+')` 独占文件句柄 —— Windows 10 1903+ 的 POSIX 语义允许删除
//      "已打开但未标记删除"的文件，递归删除照样成功 ⇒ 造不出 EBUSY；
//   ② 单个文件的 Remove-Item 也成功。
// 有效做法：让一个进程把目标目录**作为自己的当前工作目录**（CWD 被占用 ⇒ 目录不可删），
// 报错与实机现场逐字同型：
//   EBUSY: resource busy or locked, rmdir '<workspace>\.dsh\bgjobs\bg-xxx'
//
// 用法：`node tests/helpers/hold-dir.js <目录>` —— 占住目录直到收到 SIGTERM/SIGINT。
// 就绪信号 = 本进程成功存活（父进程用 child.exitCode/signalCode 判定；失败即非零退出）。
// stdout 不承载协议。

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const target = process.argv[2]
if (!target) {
  console.error('usage: node hold-dir.js <directory>')
  process.exit(2)
}

// 先确认目录存在（不存在时 cwd 会被系统替换成别处，占不住目标）
const stat = await fsp.stat(target).catch(() => null)
if (stat === null || !stat.isDirectory()) {
  console.error('not a directory: ' + target)
  process.exit(2)
}

// 真正占住：把 CWD 切过去。Windows 下目录一旦是某进程的 CWD，rmdir 必 EBUSY。
process.chdir(path.resolve(target))

const release = () => process.exit(0)
process.on('SIGTERM', release)
process.on('SIGINT', release)
setInterval(() => {}, 1000)
