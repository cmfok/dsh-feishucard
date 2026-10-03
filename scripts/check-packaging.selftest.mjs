#!/usr/bin/env node
// check-packaging.selftest.mjs —— **打包闸门自己的自证**
//
// 为什么需要它：**不会红的闸门，等于没有闸门**（本项目在检查器上已经栽过一次：
// 一个"永远报 0"的未读检查器空转了一整晚）。所以打包闸门也必须能证明
// 「在该拦的时候真的拦得住」，而不是只会打印一行 ✅。
//
// 做法：造一个最小夹具 —— `index.js` 相对 import 了 `dep.js`，而 `package.json` 的 `files`
// **故意只写 index.js** ⇒ 闸门**必须 exit 1 且点名 dep.js**；再把 dep.js 补进 files ⇒ 同一夹具**必须 exit 0**。
//
// 用 Node 写而不是 shell：CI 里一行 `node scripts/check-packaging.selftest.mjs` 即可，
// 不必在 YAML 里和引号/反斜杠搏斗（那种东西出错的方式很不明显）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const gate = path.join(here, 'check-packaging.mjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-selftest-'))
const w = (name, text) => fs.writeFileSync(path.join(dir, name), text)
const pkg = (files) => JSON.stringify({ name: 'pk-selftest', version: '0.0.1', main: 'index.js', files })
const run = () => spawnSync(process.execPath, [gate, '--repo', dir, '--quiet'], { encoding: 'utf8' })

w('index.js', "import './dep.js'\nexport const a = 1\n")
w('dep.js', 'export const b = 2\n')

let bad = 0

// ① 漏文件 ⇒ 必须红
w('package.json', pkg(['index.js']))
const r1 = run()
const out1 = String(r1.stdout || '') + String(r1.stderr || '')
if (r1.status !== 0) {
  console.log('✅ 漏文件时闸门变红（exit=' + r1.status + '）')
} else {
  console.log('❌ 漏文件时闸门**没有**变红 —— 这个闸门拦不住事故')
  bad++
}
// ② 红的时候必须**点名是哪个文件**，否则报错不可用
if (r1.status !== 0 && out1.includes('dep.js')) {
  console.log('✅ 报错点名了缺的文件（dep.js）')
} else if (r1.status !== 0) {
  console.log('❌ 变红了但没点名 dep.js ⇒ 拿到报错也不知道该补哪个文件')
  bad++
}

// ③ 补齐 files ⇒ 必须放行（防"一律报红"的假闸门）
w('package.json', pkg(['index.js', 'dep.js']))
const r2 = run()
if (r2.status === 0) {
  console.log('✅ 补齐 files 后放行（exit=0）')
} else {
  console.log('❌ 补齐后仍然报红 ⇒ 闸门只会一味拦，会被人绕过')
  bad++
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(bad === 0 ? 'PACKAGING GATE SELF-TEST PASS' : ('PACKAGING GATE SELF-TEST FAIL: ' + bad + ' 项'))
process.exit(bad === 0 ? 0 : 1)
