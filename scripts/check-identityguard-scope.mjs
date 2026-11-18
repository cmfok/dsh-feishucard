#!/usr/bin/env node
/**
 * identityGuard 机器开关矩阵合规检测（2026-10-30 裁决的回归检测）
 *
 * 用法：
 *   node scripts/check-identityguard-scope.mjs <scope> <config.json> [config2.json ...]
 *
 * scope（环境类别，对应 decisions/2026-10-30-identityGuard机器开关矩阵.md）：
 *   github      公开仓库 example / 文档默认值 —— 任何 bot 写 identityGuard:true 即违规
 *   dev         开发电脑（HOME / 维护者-OFFICE）—— 同上，禁止开启
 *   server-web  测试/生产服务器的 web gui 侧配置 —— 同上，禁止开启
 *   server-bot  测试服务器测试 bot / 生产服务器生产 bot —— 每个 bot 必须 identityGuard === true
 *
 * 退出码：0 = 全部合规；1 = 违规（禁开处开了）；2 = 该开未开（server-bot scope）
 */
import { readFileSync } from 'node:fs'

const FORBIDDEN_SCOPES = new Set(['github', 'dev', 'server-web'])
const scope = process.argv[2]
const files = process.argv.slice(3)

if (!scope || !files.length || (!FORBIDDEN_SCOPES.has(scope) && scope !== 'server-bot')) {
  console.error('用法: node scripts/check-identityguard-scope.mjs <github|dev|server-web|server-bot> <config.json...>')
  process.exit(3)
}

let violations = 0
let missing = 0

for (const f of files) {
  let cfg
  try {
    cfg = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    console.error(`✗ ${f}: 读不了/解析失败 ${e.message}`)
    violations++
    continue
  }
  const bots = Array.isArray(cfg.bots) ? cfg.bots : []
  for (const b of bots) {
    const name = b && b.name ? b.name : '<无名 bot>'
    const guard = b ? b.identityGuard : undefined
    if (FORBIDDEN_SCOPES.has(scope)) {
      if (guard === true) {
        console.error(`✗ ${f} [${name}]: 禁开环境开了 identityGuard（矩阵裁决 ${scope}）`)
        violations++
      } else {
        console.log(`✓ ${f} [${name}]: identityGuard=${String(guard)}（未开/关，合规）`)
      }
    } else {
      if (guard === true) {
        console.log(`✓ ${f} [${name}]: identityGuard=true（bot 侧开启，合规）`)
      } else {
        console.error(`✗ ${f} [${name}]: bot 侧应开未开 identityGuard（矩阵裁决 server-bot）`)
        missing++
      }
    }
  }
}

if (violations) { console.error(`结果: ${violations} 条违规（禁开环境开着闸）`); process.exit(1) }
if (missing) { console.error(`结果: ${missing} 条该开未开`); process.exit(2) }
console.log('结果: 全部合规（identityGuard 机器开关矩阵）')
