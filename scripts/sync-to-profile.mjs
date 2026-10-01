// Sync this package into the DSH profile's node_modules copy.
//
// Why this exists (2026-09-18): the profile installs this package as a `file:`
// dependency, and pnpm materialises it as a **real directory copy** — not a
// symlink. The runtime therefore loads `<profile>/node_modules/dsh-feishucard/
// index.js`, while the HMR plugin watches the *source* directory. Net effect:
// editing the source changes nothing until the copy is refreshed and dsh web is
// restarted. Doing that by hand is how the copy's package.json once sat at
// 0.2.0 while the source was at 0.3.0.
//
// Usage:
//   node scripts/sync-to-profile.mjs                 # sync into the default profile
//   node scripts/sync-to-profile.mjs --dry-run       # show what would change
//   node scripts/sync-to-profile.mjs --profile <dir>  # explicit profile directory
//
// Exit code 0 = copy is byte-identical to source for every shipped file.
// Exit code 3 = REFUSED: the target is already a link to the source (see below).
//
// ⚠️ 2026-10-01 守卫：若 profile 里的这个目录已被换成**指向源码的链接**
// （junction / symlink ＝ 免重启部署方案 A），那么 target 就是源码目录本身：
// 再跑本脚本会把 `.bak` 备份写进源码目录、并对自己做无意义拷贝 ⇒ 直接拒绝执行。
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_NAME = 'dsh-feishucard'

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : ''
}
const dryRun = process.argv.includes('--dry-run')

const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh')
const profileDir = resolve(argValue('--profile') || join(dshHome, 'profiles', 'web'))
const target = join(profileDir, 'node_modules', PKG_NAME)

const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
// `files` covers the shipped payload; package.json itself always ships.
const files = [...new Set([...(pkg.files || []), 'package.json'])]

console.log('[sync] source = ' + PKG_ROOT)
console.log('[sync] target = ' + target)
if (!existsSync(target)) {
  console.error('[sync] FAIL: target directory not found.')
  console.error('[sync]   install the package first: dsh plugin --profile web add ' + PKG_ROOT)
  process.exit(2)
}

// 守卫（见文件头）：target 已经是链接 ⇒ 它就是源码目录，绝不能往里面写备份/拷贝。
const isLink = (() => { try { return lstatSync(target).isSymbolicLink() } catch { return false } })()
const sameReal = (() => {
  try { return realpathSync(target).toLowerCase() === realpathSync(PKG_ROOT).toLowerCase() } catch { return false }
})()
if (isLink || sameReal) {
  console.error('[sync] REFUSED: target is a link to the source, not a real copy.')
  console.error('[sync]   target = ' + target)
  console.error('[sync]   real   = ' + (sameReal ? realpathSync(target) : '(link)'))
  console.error('[sync]   这种形态下运行时**直接加载源码**，改完即由 HMR 自动重载 —— 既不需要、也不要再跑 sync。')
  console.error('[sync]   若要退回实体副本：删掉该链接 → 重跑本脚本 → 经 CM 授权后重启 dsh web。')
  process.exit(3)
}

const md5 = (file) => createHash('md5').update(readFileSync(file)).digest('hex')
const rows = []
for (const rel of files) {
  const src = join(PKG_ROOT, rel)
  const dst = join(target, rel)
  if (!existsSync(src)) {
    rows.push({ rel, state: 'missing-in-source', same: false })
    continue
  }
  const same = existsSync(dst) && md5(src) === md5(dst)
  rows.push({ rel, src, dst, same, state: same ? 'same' : (existsSync(dst) ? 'differs' : 'not-deployed') })
}

const stale = rows.filter((r) => !r.same)
console.log('[sync] files=' + rows.length + ' up-to-date=' + (rows.length - stale.length) + ' stale=' + stale.length)
for (const r of rows) console.log('[sync]   ' + (r.same ? 'OK   ' : 'STALE') + ' ' + r.rel + (r.same ? '' : ' (' + r.state + ')'))

if (dryRun) {
  console.log('[sync] --dry-run: nothing written')
  process.exit(stale.length === 0 ? 0 : 1)
}
if (stale.length === 0) {
  console.log('[sync] nothing to do')
  process.exit(0)
}

// Backup the deployed entry point before overwriting it (repo convention:
// index.js.bak-<timestamp>-<reason> next to the deployed copy).
const deployedIndex = join(target, 'index.js')
if (existsSync(deployedIndex) && stale.some((r) => r.rel === 'index.js')) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = join(target, 'index.js.bak-' + stamp + '-pre-sync')
  copyFileSync(deployedIndex, backup)
  console.log('[sync] backup: ' + backup)
}

for (const r of stale) {
  if (r.state === 'missing-in-source') {
    console.error('[sync] SKIP (not in source): ' + r.rel)
    continue
  }
  copyFileSync(r.src, r.dst)
  console.log('[sync] copied ' + r.rel + ' (' + statSync(r.dst).size + ' bytes)')
}

// Verify by hash, not by hope.
let bad = 0
for (const r of rows) {
  if (r.state === 'missing-in-source') continue
  const same = md5(r.src) === md5(r.dst)
  if (!same) { bad += 1; console.error('[sync] MISMATCH after copy: ' + r.rel) }
}
console.log(bad === 0 ? '[sync] OK: deployed copy is byte-identical to source' : '[sync] FAIL: ' + bad + ' file(s) mismatch')
// 🔴 2026-10-01 CM 明令「禁止随意重启」：sync 之后改动是**待生效**，
// 只有 CM 明确授权才重启（见 ~/.dsh/AGENTS.md ①-补）。
console.log('[sync] 改动已进入「待生效」队列：需 CM 授权重启后才会生效（不许自行重启）。')
process.exit(bad === 0 ? 0 : 1)
