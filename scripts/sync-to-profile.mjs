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
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
console.log('[sync] restart dsh web to load the new code (HMR does NOT cover the copy).')
process.exit(bad === 0 ? 0 : 1)
