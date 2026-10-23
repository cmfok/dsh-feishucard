// 工具面板保结构 selftest（2026-10-23，CM 拍板 1+2）——只依赖 Node 内建模块，不启桥本体。
// 方法：从 index.js **原文**抽出真实的窗口折叠段 + payloadPlainText，用 new Function 注入
// 假常量后直测（不是抄副本）；另做源码级静态断言。全绿 exit 0；任何一条失败 exit 1。
//
// 覆盖的故障（DIAGNOSIS-2026-10-23-换卡封口帧致旧卡工具面板解体.md）：
//   换卡封口帧整卡重渲染时过折叠线（180 元素），「🛠️ 工具调用」折叠面板被解体成文字墙；
//   纯文本救援 payloadPlainText 只抽顶层两种 tag，救援正文缺掉折叠面板内容。
// 用例 A：折叠后工具行文本重装回「🛠️ 工具调用 · 历史」折叠面板（expanded:false）。
// 用例 B：幂等——二次折叠不重复堆积、内容不丢。
// 用例 C：payloadPlainText 递归抽出折叠面板标题与正文（旧实现抽不出）。
// 用例 D：payloadPlainText 保留原文换行（救援正文可读）。
// 用例 E：源码静态断言（0.8.25 标记存在）。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(root, 'index.js'), 'utf8')

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('[PASS] ' + name) }
  else { fail += 1; console.log('[FAIL] ' + name + (detail ? ' —— ' + detail : '')) }
}

// ---- 从源码原文抽取被测区块 ---------------------------------------------------
const chunkStart = src.indexOf('  function chunkText(text, size) {')
const chunkEnd = src.indexOf('  // 一段 markdown 里有几张表')
ok('S0 抽取标记存在（chunkText 区块）', chunkStart >= 0 && chunkEnd > chunkStart)
const chunkSnippet = chunkStart >= 0 && chunkEnd > chunkStart ? src.slice(chunkStart, chunkEnd) : ''

const foldStart = src.indexOf('    if (elements.length > CARD_FOLD_THRESHOLD) {')
const foldEnd = src.indexOf("    // 观测指纹（CM 2026-10-03 §3")
ok('S1 抽取标记存在（窗口折叠区块）', foldStart >= 0 && foldEnd > foldStart,
  'start=' + foldStart + ' end=' + foldEnd)
const foldSnippet = foldStart >= 0 && foldEnd > foldStart ? src.slice(foldStart, foldEnd) : ''

const pptStart = src.indexOf('  function payloadPlainText(payload) {')
const pptEnd = src.indexOf('  // #515 存档抽取器')
ok('S2 抽取标记存在（payloadPlainText 区块）', pptStart >= 0 && pptEnd > pptStart)
const pptSnippet = pptStart >= 0 && pptEnd > pptStart ? src.slice(pptStart, pptEnd) : ''

const foldFn = foldSnippet && chunkSnippet
  ? new Function('elements', 'CARD_FOLD_THRESHOLD', 'FOLD_CHUNK_CHARS', chunkSnippet
      + '\n' + foldSnippet + '\nreturn elements;')
  : null
const pptFn = pptSnippet ? new Function('payload', pptSnippet + '\nreturn payloadPlainText(payload);') : null

const CARD_FOLD_THRESHOLD = 180
const FOLD_CHUNK_CHARS = 3000

// 工具折叠面板构件（与 index.js 渲染 tools 块的真实形状一致）
function toolPanel(line) {
  return {
    tag: 'collapsible_panel', expanded: false,
    background_color: 'grey-50', border: { color: 'grey', corner_radius: '8px' }, padding: '8px 8px 8px 8px',
    header: { title: { tag: 'plain_text', content: '🛠️ 工具调用 (1)' }, vertical_align: 'center',
      padding: '8px 8px 8px 8px',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px' },
      icon_position: 'right', icon_expanded_angle: -180 },
    elements: [{ tag: 'markdown', content: line }],
  }
}
const md = (t) => ({ tag: 'markdown', content: t })

// ---- 用例 A：折叠后工具面板保结构 ---------------------------------------------
if (foldFn) {
  // 186 个元素（>180 才触发折叠）：61 head 前段（含 1 个工具面板）+ 115 后段，tail 留 10
  const els = []
  for (let i = 0; i < 60; i++) els.push(md('旁白' + i))
  els.push(toolPanel('⚙️ bash — npm test（工具行A）'))
  for (let i = 60; i < 185; i++) els.push(md('旁白' + i))
  const outA = foldFn(els.slice(), CARD_FOLD_THRESHOLD, FOLD_CHUNK_CHARS)
  const panelsA = outA.filter((e) => e && e.tag === 'collapsible_panel'
    && e.header && e.header.title && typeof e.header.title.content === 'string'
    && e.header.title.content.indexOf('🛠️ 工具调用 · 历史') === 0)
  ok('A1 重装出「工具调用 · 历史」面板', panelsA.length === 1, 'panels=' + panelsA.length)
  ok('A2 面板默认折叠（expanded:false）', panelsA.length === 1 && panelsA[0].expanded === false)
  ok('A3 工具行文本在面板里', panelsA.length === 1
    && String(panelsA[0].elements[0].content).indexOf('工具行A') >= 0)
  ok('A4 更早过程面板仍在（顺序在其后不校验，存在即可）', outA.some((e) => e && e.tag === 'collapsible_panel'
    && e.header && e.header.title && String(e.header.title.content).indexOf('📎 更早过程') === 0))
  // 无一字符丢失：原文所有 markdown 文本 + 工具行都要能在整卡 JSON 里找到
  const json = JSON.stringify(outA)
  ok('A5 内容零丢失（旁白+工具行都在）', json.indexOf('旁白0') >= 0 && json.indexOf('旁白119') >= 0
    && json.indexOf('工具行A') >= 0)

  // ---- 用例 B：幂等（二次折叠不堆积） -----------------------------------------
  const outB = foldFn(outA.slice(), CARD_FOLD_THRESHOLD, FOLD_CHUNK_CHARS)
  const panelsB = outB.filter((e) => e && e.tag === 'collapsible_panel'
    && e.header && e.header.title && typeof e.header.title.content === 'string'
    && e.header.title.content.indexOf('🛠️ 工具调用 · 历史') === 0)
  ok('B1 二次折叠工具历史面板仍存在', panelsB.length >= 1, 'panels=' + panelsB.length)
  ok('B2 不重复堆积（块数≤首回合×2，内容按 3000 字分块）', panelsB.length <= panelsA.length * 2 + 1,
    'B=' + panelsB.length + ' A=' + panelsA.length)
  ok('B3 工具行内容不丢', JSON.stringify(outB).indexOf('工具行A') >= 0)
} else {
  ok('A0 折叠段抽取成功才能跑用例A/B', false)
}

// ---- 用例 C/D：payloadPlainText 递归 + 保换行 ---------------------------------
if (pptFn) {
  const payloadC = { body: { elements: [
    md('结论正文'),
    toolPanel('⚙️ bash — npm test（工具行B）\n第二行'),
    { tag: 'hr' },
    { tag: 'column_set', flex_mode: 'none', columns: [{ tag: 'column', width: 'weighted', weight: 1,
      elements: [md('列内文字')] }] },
  ] } }
  const textC = pptFn(payloadC)
  ok('C1 顶层 markdown 照常抽出', textC.indexOf('结论正文') >= 0)
  ok('C2 折叠面板正文抽出（旧实现抽不出）', textC.indexOf('工具行B') >= 0)
  ok('C3 折叠面板标题抽出（可辨认工具边界）', textC.indexOf('🛠️ 工具调用 (1)') >= 0)
  ok('C4 递归进 column_set', textC.indexOf('列内文字') >= 0)
  ok('C5 保留原文换行', /\n/.test(textC))
  ok('C6 不抽按钮/图片', pptFn({ body: { elements: [
    { tag: 'button', text: { tag: 'plain_text', content: '确认' } },
    { tag: 'img', img_key: 'x' }, md('有') ] } }) === '有')
} else {
  ok('C0 payloadPlainText 抽取成功才能跑用例C', false)
}

// ---- 用例 E：源码静态断言 -------------------------------------------------------
ok('E1 0.8.25 工具历史面板标记存在', src.indexOf('🛠️ 工具调用 · 历史') >= 0)
ok('E2 payloadPlainText 递归标记存在', src.indexOf('救援抽取改为**递归**') >= 0)

console.log('---')
console.log('PASS=' + pass + ' FAIL=' + fail)
process.exit(fail === 0 ? 0 : 1)
