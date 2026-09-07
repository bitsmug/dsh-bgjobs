// bgjobs —— 构建客户端 bundle（v0.1.61 结构重构起引入）。
// 源码 lib/client-src/*（多文件 CJS）→ 单文件 lib/client.js（产物提交入库）。
// harness 客户端模块运行时铁定单文件：factory 的 require 只解析模块表词，故相对
// import 必须在构建期内联（官方 dsh 同款模型）；react / react-dom /
// @deepseek-ai/dsh-client-ui-primitives 为模块表 seed，保持 external（运行时 require）。
//
// 用法：node scripts/build-client.mjs（或 pnpm build:client）
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

const BANNER = "window.__ModuleLoader__.load({ id: 'bgjobs', factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;\n"
const FOOTER = "\nreturn module.exports;\n} });\n"

const result = await build({
  entryPoints: ['lib/client-src/index.js'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  target: ['es2020'],
  charset: 'utf8',
  logLevel: 'warning',
})

const out = BANNER + result.outputFiles[0].text + FOOTER
writeFileSync('lib/client.js', out, 'utf8')
console.log(`lib/client.js rebuilt from lib/client-src (${out.length} bytes)`)
