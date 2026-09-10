// bgjobs —— 开发工具：清理「多余（重复）的 UTF-8 BOM」。
//
// 背景（真实踩坑）：PowerShell 里用
//   [System.IO.File]::WriteAllText($p, $text, [System.Text.UTF8Encoding]::new($true))
// 写一个**已经带 BOM** 的文件时，会把新 BOM 叠加在旧 BOM 前面 → 文件开头出现
// EF BB BF EF BB BF。PowerShell 只剥掉第一个 BOM，第二个变成内容里的 U+FEFF，
// 于是首行注释被当成命令执行（报 "'works' 不是命令" / "?# 不是命令"），
// 而 ParseFile 语法检查却正常——极难定位。本脚本批量消除这种重复。
//
// 语义（重要，只做减法）：**删掉多余的 BOM，绝不新增 BOM**
//   - 无 BOM 的文件 → 保持无 BOM（不要好心加上，那会污染 diff）
//   - 恰好 1 个 BOM → 原样不动
//   - 2 个及以上     → 收敛为 1 个（保留 BOM 属性，只去掉重复）
// 纯字节级操作（UTF-8 BOM = EF BB BF），不解码文本，不会改坏非 ASCII 内容。
//
// 用法（在仓库根目录执行）：
//   node scripts/fix-bom.mjs                 # 只扫描并报告（不改文件）
//   node scripts/fix-bom.mjs --write         # 实际修复
//   node scripts/fix-bom.mjs --check         # CI 用：发现多余 BOM 时退出码 1
//   node scripts/fix-bom.mjs --all           # 不按扩展名白名单过滤（扫所有文本文件）
//   node scripts/fix-bom.mjs lib tools       # 只扫指定目录/文件
// 也可用 package.json 脚本：pnpm fix:bom / pnpm check:bom
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const BOM_LEN = BOM.length

// 只扫这些扩展名（--all 可关闭白名单）。BOM 问题集中在脚本/文本类文件。
const TEXT_EXTS = new Set([
  '.ps1', '.psm1', '.psd1', '.bat', '.cmd', '.vbs', '.js', '.mjs', '.cjs',
  '.json', '.md', '.yml', '.yaml', '.txt', '.ts', '.tsx', '.css', '.html', '.sh',
])
// 与开发无关的大目录：跳过（--all 也不会进）。
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'coverage', '.cache'])

/** 统计文件开头连续出现了几个 UTF-8 BOM。 */
function countLeadingBoms(buf) {
  let n = 0
  while ((n + 1) * BOM_LEN <= buf.length && buf.compare(BOM, 0, BOM_LEN, n * BOM_LEN, (n + 1) * BOM_LEN) === 0) n++
  return n
}

/** 递归收集待检查文件（跳过 SKIP_DIRS / 按扩展名过滤）。 */
async function collect(targets, useAllowlist) {
  const out = []
  const walk = async (p) => {
    let st
    try { st = await fsp.stat(p) } catch (e) { return }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(p))) return
      for (const name of await fsp.readdir(p)) await walk(path.join(p, name))
      return
    }
    if (!st.isFile()) return
    if (useAllowlist && !TEXT_EXTS.has(path.extname(p).toLowerCase())) return
    out.push(p)
  }
  for (const t of targets) await walk(path.resolve(t))
  return out
}

const args = process.argv.slice(2)
const write = args.includes('--write')
const check = args.includes('--check')
const useAllowlist = !args.includes('--all')
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targets = args.filter((a) => !a.startsWith('--'))
if (targets.length === 0) targets.push(repoRoot)
if (write && check) {
  console.error('fix-bom: --write 与 --check 不能同时使用（--check 只读）')
  process.exit(2)
}

const files = await collect(targets, useAllowlist)
const hits = []
for (const file of files) {
  let buf
  try { buf = await fsp.readFile(file) } catch (e) { continue }
  const n = countLeadingBoms(buf)
  if (n <= 1) continue // 0 或 1 个 BOM：不动（尤其不能给无 BOM 文件加 BOM）
  hits.push({ file, n })
}

if (hits.length === 0) {
  console.log(`fix-bom: 扫描 ${files.length} 个文件，未发现多余 BOM。`)
  process.exit(0)
}

for (const { file, n } of hits) {
  const rel = path.relative(repoRoot, file) || file
  if (!write) {
    console.log(`  多余 BOM ×${n}（应为 1）：${rel}`)
    continue
  }
  const buf = await fsp.readFile(file)
  const fixed = Buffer.concat([BOM, buf.subarray(n * BOM_LEN)])
  await fsp.writeFile(file, fixed)
  console.log(`  已修复 ×${n} → 1：${rel}`)
}

const verb = write ? '已修复' : '发现'
console.log(`fix-bom: ${verb} ${hits.length} 个文件（共扫描 ${files.length} 个）。`)
if (!write && (check || !write)) {
  if (check) console.log('fix-bom: 运行 `node scripts/fix-bom.mjs --write` 可修复。')
  process.exit(check ? 1 : 0)
}
