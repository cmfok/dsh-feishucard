// DSH 飞书卡片：折叠必须无损 + 表格配额必须生效（2026-09-16 与 Hermes 同步的两个修复）
// 离线纯函数级验证：不需要飞书凭据、不联网。
// 跑法: node scripts/test-fold-tables.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8')

// 从源码里抽出三个纯函数来跑（保持"测的就是线上那份逻辑"）
function grab(name) {
  const i = src.indexOf('function ' + name + '(')
  if (i < 0) throw new Error('找不到函数: ' + name)
  let depth = 0, started = false
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1) }
  }
  throw new Error('函数未闭合: ' + name)
}
const FOLD_CHUNK_CHARS = 3000
const CARD_MAX_TABLES = 5
const mod = new Function(
  'const FOLD_CHUNK_CHARS=' + FOLD_CHUNK_CHARS + ';const CARD_MAX_TABLES=' + CARD_MAX_TABLES + ';' +
  grab('chunkText') + grab('countMarkdownTables') + grab('splitTableRow') + grab('demoteTableToLines') +
  grab('demoteTablesInText') + grab('demoteOverflowTables') +
  'return { chunkText, countMarkdownTables, splitTableRow, demoteTableToLines, demoteTablesInText, demoteOverflowTables };'
)()

let fails = 0
const check = (label, cond, detail) => {
  if (cond) console.log('  PASS  ' + label)
  else { fails += 1; console.log('  FAIL  ' + label + (detail ? '  [' + detail + ']' : '')) }
}
const textOf = (els) => els.map((el) => {
  if (el.tag === 'markdown') return el.content || ''
  if (el.tag === 'collapsible_panel') return (el.elements || []).map((c) => c.content || '').join('\n')
  return ''
}).join('\n')

console.log('[fold] 折叠必须无损')
const many = Array.from({ length: 50 }, (_, i) => ({
  tag: 'markdown', content: '第 ' + i + ' 段过程：' + '中文说明文字'.repeat(40),
}))
const chunks = mod.chunkText(many.map((e) => e.content).join('\n\n'), FOLD_CHUNK_CHARS)
const rejoined = chunks.join('\n')
const missing = many.filter((e) => !rejoined.includes(e.content.slice(0, 12)))
check('切成多块（而非截断）', chunks.length >= 2, String(chunks.length))
check('每块 ≤ 单元素上限', chunks.every((c) => c.length <= FOLD_CHUNK_CHARS),
      String(Math.max(...chunks.map((c) => c.length))))
check('50 段一段都没丢', missing.length === 0, '丢了 ' + missing.length)
check('无『已省略』丢弃标记', !rejoined.includes('已省略'))

console.log('[tables] 表格配额：第 6 张起降级成可读清单（2026-09-16 改：不再用代码块），内容不丢')
const mkTable = (i) => '| 维度' + i + ' | 值 |\n|---|---|\n| a | ' + i + ' |'
const elements = [{ tag: 'markdown', content: Array.from({ length: 8 }, (_, i) => mkTable(i)).join('\n\n') }]
const before = mod.countMarkdownTables(elements[0].content)
check('构造出 8 张表', before === 8, String(before))
mod.demoteOverflowTables(elements, CARD_MAX_TABLES)
const after = mod.countMarkdownTables(elements[0].content)
check('降级后 markdown 表格数 = 上限 5', after === CARD_MAX_TABLES, String(after))
const text = elements[0].content
// 2026-09-16 起：超出部分不再是 ``` 代码块（代码块里就是原始竖线，等于把问题换个地方展示），
// 改成 `- **列名**：值 ｜ **列名**：值` 可读清单。
check('超出部分不再用代码块', (text.match(/```/g) || []).length === 0,
      '``` 出现 ' + (text.match(/```/g) || []).length + ' 次')
check('超出部分是"列名：值"清单', text.includes('**维度6**') && text.includes('**维度7**'))
check('降级位置有说明（不静默）', text.includes('表格超出飞书单卡上限'))
check('内容一个字符都没丢：8 张表的标记都在',
      Array.from({ length: 8 }, (_, i) => text.includes('维度' + i)).every(Boolean))
check('降级后的表格不再被计入', mod.countMarkdownTables(text) === CARD_MAX_TABLES, String(after))
check('未超限时原样返回', (() => {
  const one = [{ tag: 'markdown', content: mkTable(1) }]
  mod.demoteOverflowTables(one, CARD_MAX_TABLES)
  return one[0].content === mkTable(1)
})())
// 边界：单行/畸形表格不能把内容吃掉
check('畸形表格（只有表头）不丢内容', mod.demoteTableToLines(['| 只有一个头 |']).join('\n').includes('只有一个头'))
check('空数组安全', mod.demoteTableToLines([]).length === 0)

console.log('[clip] 截断过程话语不得把表格切断（2026-09-16）')
{
  // 背景：appendNote 原实现 `slice(0,500)+'…'`，截断点落在表格中间时，
  // 可能只剩表头没有分隔行 → 飞书判定不是表格 → 原样显示竖线（CM 看到的现象之一）。
  const clipNoteText = new Function('return ' + grab('clipNoteText'))()
  check('短文本原样返回', clipNoteText('一句话', 500) === '一句话', JSON.stringify(clipNoteText('一句话', 500)))
  const rows = Array.from({ length: 40 }, (_, i) => '| 行' + i + ' | 内容' + i + ' |')
  const tbl = ['前面一段说明。', '| 列A | 列B |', '|---|---|', ...rows].join('\n')
  const cut = clipNoteText(tbl, 500)
  check('截断有省略号标记', cut.endsWith('…'), JSON.stringify(cut.slice(-12)))
  const cutLines = cut.split('\n')
  const tableLines = cutLines.filter((l) => /^\s*\|.*\|\s*$/.test(l))
  if (tableLines.length > 0) {
    check('残留表格行仍是合法表格（含分隔行）',
          tableLines.some((l) => /^\s*\|[\s:|-]+\|\s*$/.test(l)),
          tableLines.length + ' 行表格残片')
  } else {
    check('不完整表格被整块丢弃（不留半张表）', true)
  }
  check('未超长时不受影响（含表格）', clipNoteText(tbl.slice(0, 200), 500).startsWith('前面一段说明。'))
}

console.log('[status] 状态行必须真实（2026-09-16 与 Hermes 对齐）')
const STATUS_CHECKS = [
  [{ status: 'running' }, '_运行中…_', '进行中：普通文案'],
  [{ status: 'running', idleMinutes: 5 }, '无新动作', '进行中但久无动静：说清多久没动'],
  [{ status: 'sealed' }, '✅ 已完成', '封口：**必须显示**已完成（旧实现直接删掉状态行）'],
  [{ status: 'completed' }, '已完成', 'completed 分支（历史死状态）文案正常'],
  [{ status: 'error' }, '失败', '失败文案'],
]
const statusTextFor = new Function('return ' + grab('statusTextFor'))()
let statusFails = 0
for (const [card, must, label] of STATUS_CHECKS) {
  const got = statusTextFor(card)
  if (got.includes(must)) console.log('  PASS  ' + label)
  else { statusFails += 1; console.log('  FAIL  ' + label + '  [' + got + ']') }
}
const idleText = statusTextFor({ status: 'running', idleMinutes: 7 })
if (!idleText.includes('完成')) console.log('  PASS  空闲文案不宣称完成')
else { statusFails += 1; console.log('  FAIL  空闲文案不宣称完成  [' + idleText + ']') }
if (statusFails) { console.log(''); console.log('FAILED(status): ' + statusFails); process.exit(1) }

console.log('')
console.log(fails === 0 ? 'ALL PASS' : 'FAILED: ' + fails)
process.exit(fails === 0 ? 0 : 1)
