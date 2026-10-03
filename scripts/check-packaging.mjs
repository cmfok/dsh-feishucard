#!/usr/bin/env node
/**
 * check-packaging.mjs —— **打包完整性闸门**
 *
 * 为什么（2026-10-04 实测事故）：
 *   `index.js` 从某版本起 `import './identity-inject.mjs'`，但那个文件**不在 `package.json`
 *   的 `files` 数组里** ⇒ `npm pack` / `npm publish` 出来的包**装上就 `failed to import`**
 *   （整个插件不可用，不是降级）。**在真实服务器部署现场炸出来**：
 *       dsh: warning: 1 entry did not activate
 *       feishu-stream (dsh-feishucard): failed to import
 *   **而本地冒烟一直是绿的** —— 因为开发工作区里有那个文件。
 *   ⇒ **又一次「本地绿 ≠ 发布物绿」。** 所以把这条做成发布前的硬闸门。
 *
 * 检查两件事：
 *   ① 从 package.json 的 `main` 出发，**递归**扫【相对 import / require】，
 *      逐个核对是否被 `files` 覆盖（含目录前缀匹配，如 `"lib"` 覆盖 `lib/x.js`）；
 *   ② `files` 里写了的条目是否**真实存在**（防"写了名字却没那个文件"）。
 *
 * 用法：
 *   node check-packaging.mjs                       # 默认当前目录
 *   node check-packaging.mjs --repo D:\some\repo
 *   node check-packaging.mjs --repo . --quiet      # 只报错
 *
 * 退出码：0 = 通过；1 = 有问题（可直接用于 CI / 发版前闸门）。
 *
 * 🔴 **它自己也要能被证明「会红」** —— 不会红的闸门，等于没有闸门。
 *    自证方法（2026-10-04 实测过一次，**必须 exit 1**）：
 *
 *      mkdir /tmp/pk && cd /tmp/pk
 *      printf '{"name":"pk","version":"0.0.1","main":"index.js","files":["index.js"]}' > package.json
 *      printf "import './dep.js'\n" > index.js
 *      printf 'export const b = 2\n'  > dep.js             # dep.js 【故意不写进 files】
 *      node <repo>/scripts/check-packaging.mjs --repo .    # ⇒ exit 1，并点名 dep.js
 *
 *    反证：把 `dep.js` 补进 `files` ⇒ **同一个夹具**立即 exit 0。
 *    只验"通过"不验"会红"，就等于没验 —— 本地绿 ≠ 闸门真的在拦。
 */

import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet')
const getArg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const REPO = path.resolve(getArg('--repo', process.cwd()))

const PKG = path.join(REPO, 'package.json')
if (!fs.existsSync(PKG)) { console.error('  ❌ 找不到 package.json：' + PKG); process.exit(1) }
// ⚠️ 必须去 BOM：Windows 上 `Set-Content -Encoding UTF8` 会写 BOM，
//    而 `JSON.parse` 遇到 BOM 直接抛 SyntaxError（负向测试实测踩到）。
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8').replace(/^\uFEFF/, ''))
const files = pkg.files || null
const say = (s) => { if (!quiet) console.log(s) }

say('  包：' + (pkg.name || '(无名)') + '@' + (pkg.version || '?'))
say('  仓库：' + REPO)

if (!files) {
  say('  ⚠️ package.json 没有 files 字段 ⇒ npm 会按 .npmignore / 默认规则打包，无法静态核对。')
  say('  ⇒ 建议显式声明 files，本闸门才有效。')
  process.exit(0)
}

// 入口：main + exports 里指向的文件
const entries = new Set()
if (pkg.main) entries.add(pkg.main)
const walkExports = (v) => {
  if (typeof v === 'string') { if (v.startsWith('./')) entries.add(v.slice(2)); return }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) walkExports(v[k]) }
}
if (pkg.exports) walkExports(pkg.exports)
entries.add('package.json')

// `files` 覆盖判定：精确命中，或落在某个列出的目录下
const coveredBy = (rel) => {
  for (const f of files) {
    const norm = String(f).replace(/\\/g, '/').replace(/\/+$/, '')
    if (rel === norm) return true
    if (rel.startsWith(norm + '/')) return true
  }
  return false
}

// ⚠️ 四种形态都要认（负向测试实测：只写 `from` 会漏掉裸 import）：
//    import x from './a.mjs'   /  import './a.mjs'（副作用导入）
//    import('./a.mjs')         /  require('./a.cjs')
const REL_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"](\.\.?\/[^'"]+)['"]/g
const seen = new Set()
const queue = [...entries]
const missing = []      // 相对 import 但不在 files
const absent = []       // files 里写了但文件不存在
const visited = new Set()

while (queue.length) {
  const rel = queue.shift().replace(/\\/g, '/').replace(/^\.\//, '')
  if (visited.has(rel)) continue
  visited.add(rel)
  const abs = path.join(REPO, rel)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue

  if (!coveredBy(rel) && rel !== 'package.json') missing.push(rel)

  const src = fs.readFileSync(abs, 'utf8')
  let m
  REL_RE.lastIndex = 0
  while ((m = REL_RE.exec(src))) {
    const spec = m[1]
    if (seen.has(spec)) continue
    seen.add(spec)
    // 只处理"能解析到具体文件"的（带扩展名或 index.*）
    const base = path.join(path.dirname(abs), spec)
    const cands = [base, base + '.js', base + '.cjs', base + '.mjs', path.join(base, 'index.js'), path.join(base, 'index.cjs'), path.join(base, 'index.mjs')]
    const hit = cands.find((p) => fs.existsSync(p) && fs.statSync(p).isFile())
    if (hit) queue.push(path.relative(REPO, hit).replace(/\\/g, '/'))
  }
}

for (const f of files) {
  const norm = String(f).replace(/\\/g, '/').replace(/\/+$/, '')
  if (!fs.existsSync(path.join(REPO, norm))) absent.push(norm)
}

say('')
say('  扫描入口：' + [...entries].join(', '))
say('  递归检查文件数：' + visited.size)
say('')

let bad = false
if (missing.length) {
  bad = true
  console.log('  ❌ 以下文件被【相对 import】引用，但 **不在 package.json 的 files 里**')
  console.log('     ⇒ npm publish 出来的包，用户装上会 `failed to import`：')
  for (const m of missing) console.log('       · ' + m)
} else {
  say('  ✅ 所有被相对 import 的文件都在 files 的白名单/目录内')
}
if (absent.length) {
  bad = true
  console.log('  ⚠️ files 里写了、但仓库里不存在的条目（拼写或路径问题）：')
  for (const a of absent) console.log('       · ' + a)
}
if (!bad) say('  ✅ files 里列出的条目都真实存在')

console.log('')
console.log(bad ? '  打包完整性：❌ 未通过' : '  打包完整性：✅ 通过')
process.exit(bad ? 1 : 0)
