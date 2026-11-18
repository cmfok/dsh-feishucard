#!/usr/bin/env node
// registry-exempt: 只读发布前扫描工具，不删任何文件；自测只删自己新建的临时目录
// pre-publish-scrub.mjs —— 发布前脱敏闸
//
// 为什么存在（2026-11-19）：
//   npm 包是「发出去就收不回」的载体，而 npm 强制包含 README，files 白名单拦不住它。
//   实测过的事故：已发布的包把内部会话 id、内部目录名、生产单元名带了出去。
//   本闸把「发什么」变成机器判据——扫的正是 npm 真正会打包的那批文件，不是整个仓库。
//
// 判据（不是「扫过就算」）：
//   1. --self-test 会造一个「必然违规」的样本，闸必须报红；再造一个干净样本，闸必须报绿。
//      两边都不对 = 闸本身坏了，此时不许发布（退出码 2）。
//   2. 正常跑：发现违规 → 退出码 1 并逐条列出 file:line；干净 → 退出码 0。
//
// 已知残留（有意放行，每条必须写理由，禁无理由 allow）：
//   identity-inject.mjs 的 JOBGRANTS_REL 是内部目录名，但它同时是「岗位授权表」的功能默认值，
//   改了会让未设 MAILBOX_JOB_GRANTS 的部署静默失效（开发标准 §10.2.4 禁止无回归改共享常量）。
//   正确修法＝改成环境变量驱动并跑回归，排在下一批；在那之前从这里显式放行，不许悄悄消失。

import { readFileSync, existsSync, statSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { tmpdir } from 'node:os'

// ── 规则表：id → 正则。命中即违规，除非落在 KNOWN_RESIDUALS 或占位符白名单里 ──────────
const RULES = [
  // 飞书标识：真实 id 一律不许出门；占位符（cli_xxxx…、ou_0000…、<redacted>）放行
  { id: 'feishu-chat-id', re: /\boc_(?!<redacted>|x{8,})[0-9a-f]{8,}/g },
  { id: 'feishu-open-id', re: /\bou_(?!<redacted>|x{8,}|0{8,})[0-9a-f]{8,}/g },
  { id: 'feishu-app-id', re: /\bcli_(?!x{8,})[a-z0-9]{12,}/g },
  // 内部绝对路径 / 生产面信息
  { id: 'internal-abs-path', re: /P:[\\/]{1,2}work|C:[\\/]{1,2}Users|\/srv\/aiad|\/home\/agt[a-z]+/g },
  { id: 'production-artifact', re: /OPS_CHANGELOG|dsh-feishu-aiad|systemctl\s+restart/gi },
  { id: 'private-repo', re: /cmfok\/Work\b/g },
]

// 有意放行的残留：key = `${相对路径}::${规则id}`
// 判定口径：注释/文档里的一律删（无行为变化）；功能行不能盲改——改了会静默改变运行时行为，
// 而这类默认值一坏就是「部署侧找不到表/指路消失」且不报错（开发标准 §10.2.4）。以下每条都
// 已复核为「功能默认值」，只泄露命名、不含凭证/会话 id，统一排下一批做环境变量化 + 回归。
const KNOWN_RESIDUALS = {
  'identity-inject.mjs::internal-dir-name':
    '岗位授权表默认相对路径（功能默认值），环境变量化需回归，排下一批',
  'identity-inject.mjs::internal-abs-path':
    'WORK_ROOT 未设时的历史盘符兜底候选（仅回落分支，已自带告警），改为纯 env 驱动会静默改变现网查找行为',
  'index.js::internal-dir-name':
    '运行时注入给 agent 的裁决同步指路文案（功能字符串），删掉会让内部闭环指路消失',
}

// 扫描面之外的规则（相对路径名）：内部目录/术语，单独一条规则以便精确放行
const INTERNAL_DIR_RULE = { id: 'internal-dir-name', re: /(?<![\w/])AIAD\/|信息中台/g }

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.txt', '.ts', '.toml'])

function listPublishFiles (root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  // npm 永远打包这几个，files 拦不住 ⇒ 必须一起扫
  const always = ['package.json', 'README.md', 'LICENSE']
  const declared = Array.isArray(pkg.files) ? pkg.files : []
  const out = new Set([...always, ...declared])

  // 声明的目录要展开
  for (const entry of [...out]) {
    const abs = join(root, entry)
    if (!existsSync(abs)) continue
    if (statSync(abs).isDirectory()) {
      for (const f of readdirSync(abs, { recursive: true })) {
        out.add(join(entry, f.toString()).replace(/\\/g, '/'))
      }
    }
  }
  return [...out].filter(f => existsSync(join(root, f)) && TEXT_EXT.has(extname(f).toLowerCase())).sort()
}

function scan (root) {
  const findings = []
  for (const rel of listPublishFiles(root)) {
    const abs = join(root, rel)
    let text
    try { text = readFileSync(abs, 'utf8') } catch { continue }
    const lines = text.split(/\r?\n/)
    for (const rule of [...RULES, INTERNAL_DIR_RULE]) {
      if (KNOWN_RESIDUALS[`${rel}::${rule.id}`]) continue
      for (let i = 0; i < lines.length; i++) {
        for (const m of lines[i].matchAll(rule.re)) {
          findings.push({ file: rel, line: i + 1, rule: rule.id, hit: m[0] })
        }
      }
    }
  }
  return findings
}

function report (findings) {
  if (findings.length === 0) {
    console.log('[scrub] 干净：发布面没有命中内部标识')
    return 0
  }
  console.error(`[scrub] 拦截：发布面命中 ${findings.length} 处内部标识`)
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.hit}`)
  console.error('[scrub] 要么删掉这些内容，要么在 KNOWN_RESIDUALS 里写明理由后放行')
  return 1
}

// ── 自测：先证闸会红，再证闸会绿（两边都成立才算闸活着）────────────────────────
function selfTest () {
  const leaky = mkdtempSync(join(tmpdir(), 'scrub-red-'))
  const clean = mkdtempSync(join(tmpdir(), 'scrub-green-'))
  const mk = (dir, body) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', files: ['a.js'] }))
    writeFileSync(join(dir, 'README.md'), '# x\n')
    writeFileSync(join(dir, 'LICENSE'), 'MIT\n')
    writeFileSync(join(dir, 'a.js'), body)
  }
  mk(leaky, 'const chat = "oc_36ed7c029a778c13f01823ba439a6ca6"\n')
  mk(clean, 'const chat = "oc_<redacted>"\nconst app = "cli_xxxxxxxxxxxxxxxx"\n')

  const red = scan(leaky).length > 0
  const green = scan(clean).length === 0
  rmSync(leaky, { recursive: true, force: true })
  rmSync(clean, { recursive: true, force: true })

  if (red && green) { console.log('[scrub] self-test 通过（违规必红 / 干净必绿）'); return 0 }
  console.error(`[scrub] self-test 失败：应当报红的样本 red=${red}，应当报绿的样本 green=${green}`)
  return 2
}

const args = process.argv.slice(2)
if (args.includes('--self-test')) process.exit(selfTest())
process.exit(report(scan(process.cwd())))