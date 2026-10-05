// DSH 飞书卡片：折叠必须无损 + 表格配额必须生效（2026-09-16 与 Hermes 同步的两个修复）
// 离线纯函数级验证：不需要飞书凭据、不联网。
// 跑法: node scripts/test-fold-tables.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8')

// 从 index.js 里抽出纯函数来跑（保持"测的就是线上那份逻辑"）。
// ⚠️ 必须按**依赖闭包**抽，不能手工列清单：入口函数内部调用的别的函数/常量要一起带上。
//    历史上这里踩过三次——demoteOverflowTables 要用 walkContentHolders、
//    clipNoteText 要用 purposeLinesOf、statusTextFor 要用 modeLabelFor，
//    每漏一个就是 ReferenceError 把整个离线闸门炸掉（而不是测出真问题）。
// 🔴 花括号计数是**朴素**的（不认识字符串/注释/正则里的花括号）。这里不自己造词法器
//   —— 上一版加了"跳过字符串"，被 `countMarkdownTables` 里的 `/^\s*```/`（正则里三个
//   反引号）当场带偏，比原来更脆。改为**只抽 entry 真正引用得到的函数**（见下面 `fnOf`
//   的懒抽取）＋**三道校验**，任何一道不过就点名报错（第八/九轮门槛 MEDIUM 的正解）：
//     ① 切片里不许出现另一个缩进两格的 `function`（＝深度算少、扫穿了函数末尾）；
//     ② 切片必须以「两空格 + `}`」独占一行收尾（index.js 顶层函数的固定写法）；
//     ③ 切片必须能单独编译（`new Function`）—— 算多了会在此暴露。
//   已知代价：`salvageTextFromRich`（体内有 `s.startsWith('{')`）这类**够不着的**函数
//   永远不被抽取，所以它的字符串花括号与本闸门无关；若哪天它成了依赖闭包的一员，
//   这里会打出「函数切片越界: salvageTextFromRich」这种点名错误，而不是无关行的 SyntaxError。
function grab(name) {
  // 定位按**整行形状**匹配，不用 `indexOf('function NAME(')`（第十三轮 MEDIUM#1 的正身）：
  //   indexOf 只会停在 `function` 关键字上 ⇒ 切 `async function foo(...)` 时**丢掉 async**，
  //   得到一段"体内含 await 的非 async 函数" ⇒ `new Function` 当场 SyntaxError（报错看着像
  //   切片编译问题，根因其实是切片不完整）。按行匹配才能把 `async` / `function*` 一起纳入。
  const mm = new RegExp('^ {2}(async\\s+)?function\\s*\\*?\\s*' + name + '\\s*\\(', 'm').exec(src)
  if (!mm) throw new Error('找不到函数: ' + name)
  const kw = mm[1] ? 'async ' : ''      // 生成器的 `*` 紧跟 `function`，切片天然带上
  const i = mm.index + mm[0].indexOf('function')
  let depth = 0, started = false
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true }
    else if (src[j] === '}') {
      depth--
      if (started && depth === 0) {
        const body = kw + src.slice(i, j + 1)
        if (/^ {2}(?:async\s+)?function\s/m.test(body)) throw new Error('函数切片越界（花括号计数被带偏）: ' + name)
        if (!/\n {2}\}$/.test(body)) throw new Error('函数收尾不是「两空格 + }」，切片不可信: ' + name)
        // 信任边界（第十二轮门槛 LOW 要求写明）：本文件的 `new Function` **只**吃本地
        //   `../index.js` 里切出来的源码片段，输入不出仓库、永不接受外部文本。
        //   若哪天改成从网络/配置取输入，这里就是注入面，必须换成静态求值。
        try { new Function(body) } catch (error) {
          throw new Error('函数切片编译失败: ' + name + ' —— ' + String(error && error.message || error))
        }
        return body
      }
    }
  }
  throw new Error('函数未闭合: ' + name)
}

// apply 闭包内的顶层定义（缩进两格）：函数体 + 单行常量
// 函数改**懒抽取**：先只记名字清单，`bundle` 真引用到才 grab ——
// 一个与断言无关的顶层函数写得再怪，也不该把离线闸门炸掉。
const fnNames = new Set()
const fnSrc = new Map()
const constSrc = new Map()
// 🔴 清单必须覆盖**所有**两格缩进的函数声明形状（第十三轮 MEDIUM#1）：`async function`
//   在 index.js 里有 20 多个（readConfig/httpJson/sendInteractive…），只匹配 `function`
//   的话——它既不进 fnNames（`bundle` 抽不到），下面的 `unresolved` 守卫同样看不见它
//   （守卫正则也是 `^ {2}(?:const|let|var|function|class)`）⇒ 双盲：断言一旦依赖某个 async
//   顶层函数，就退化成裸 `ReferenceError: X is not defined`，正是本文件承诺要避免的失败模式。
for (const m of src.matchAll(/^ {2}(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)) fnNames.add(m[1])
function fnOf(name) {
  if (!fnSrc.has(name)) fnSrc.set(name, grab(name))
  return fnSrc.get(name)
}
for (const m of src.matchAll(/^ {2}const ([A-Za-z_$][\w$]*) = ([^\r\n]+)$/gm)) {
  const val = m[2].trim()
  // 只收**单行自洽**的常量：跨行对象/数组（值以 `{`、`,`、`(` 等收尾）或括号不配平的，
  // 抽进独立命名空间会变成语法错误 —— 宁可当"不可用"，也别拼出一段坏代码。
  // 🔴 悬挂运算符要**全类**覆盖（第十三轮门槛 LOW#1）：箭头函数换行（`... =>`）、逻辑或
  //   （`... ||`、`&&`）、三元换行（`... ?`）、乘/取余续行（`*`、`%`）都会让"首行"被当成
  //   完整值拼成 `const x=(a) =>;` ⇒ 最终 `new Function` 抛裸 SyntaxError，绕过本文件的
  //   点名契约（函数有编译校验③，常量此前没有等价闸门）。
  const bal = (ch) => (val.match(new RegExp('\\' + ch, 'g')) || []).length
  if (/[[({+,?:+\-=*>&|%,]/.test(val.slice(-1))) continue
  if (bal('{') !== bal('}') || bal('(') !== bal(')') || bal('[') !== bal(']')) continue
  if (!constSrc.has(m[1])) constSrc.set(m[1], val)
}

// 抽出 entries 及其全部传递依赖，返回 { 名字: 函数 } 的独立命名空间
function bundle(...entries) {
  const fns = []
  const consts = []
  const got = new Set()
  const queue = entries.slice()
  // 🔴 门槛（第十二轮 LOW）：依赖若既不在 `fnNames` 也不在 `constSrc`，原来一律 `continue`
  //   静默跳过。跳过"根本不是顶层定义"的名字是对的，但反过来——**index.js 里确实有它的
  //   两格缩进顶层定义、只是形状不属于可抽的两种**（跨行 const、箭头函数、缩进变了）——
  //   就变成"闭包算少了"：直到断言真去调用才炸成裸 `ReferenceError: X is not defined`，
  //   与本文件「任何一道不过就点名报错」的契约相反。这里把这类名字收下来点名。
  const unresolved = new Map()   // 依赖名 -> 第一次引用它的那段源码（函数体或常量值）
  while (queue.length) {
    const name = queue.shift()
    if (got.has(name)) continue
    const isFn = fnNames.has(name)
    if (!isFn && !constSrc.has(name)) {
      // 断言的**入口**抽不出来时必须喊：静默跳过的结果是 `scope[入口]` 是 undefined，
      //   断言拿着 undefined 去比，红在看不懂的下游。
      if (entries.includes(name)) {
        throw new Error('断言入口抽不出来: ' + name + '（index.js 里它的定义形状不再是'
          + '「两格缩进 function 声明」或「两格缩进单行 const」⇒ 离线闸门无法引用它）')
      }
      continue
    }
    got.add(name)
    const body = isFn ? fnOf(name) : constSrc.get(name)
    if (isFn) fns.push(body); else consts.unshift('const ' + name + '=' + body + ';')
    // 依赖识别要看**两种形状**：调用点 `foo(`（前面不是 `.` ⇒ 排除 obj.method()），
    // 以及常量引用（`PURPOSE_LINE_RE.test(` 里被引用的是常量本身，正则匹配不到）。
    // 🔴 常量与函数**双向**都要跟：常量值里也可能写成 `const X = someTopLevelFn(...)`，
    //   漏掉函数就会让抽出的命名空间在调用时 `ReferenceError`（正是本文件要避免的"炸离线闸门"）。
    // 🔴 负向后顾 `(?<![\w$.])` 才真的实现上面那句「前面不是 `.` ⇒ 排除 obj.method()」
    //   （第八/九轮门槛 LOW：原来没写，注释与代码不一致）。不挡掉的话 `obj.method`
    //   会连 `method` 一起交出来，**方法名/属性名撞上某个顶层定义名**时就把无关定义
    //   拖进命名空间。字符串里的同名 token 仍会命中 —— 那只会多带一个定义进来，
    //   不会漏依赖，所以不再为它加复杂度。
    for (const t of body.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) {
      const dep = t[0]
      if (got.has(dep)) continue
      if (fnNames.has(dep) || constSrc.has(dep)) { queue.push(dep); continue }
      if (!unresolved.has(dep)) unresolved.set(dep, body)
    }
  }
  // 只报"**index.js 里有两格缩进的顶层定义**、却没被抽进闭包"的那批：
  //   形参、局部量、全局对象（JSON/Math…）都不满足这个条件 ⇒ 不会误报。
  //   同名局部量（引用它的那段代码自己声明过）也跳过——那是遮蔽，不是漏抽。
  for (const [dep, body] of unresolved) {
    if (got.has(dep)) continue
    if (new RegExp('(?:const|let|var|function|class)\\s+' + dep + '\\b').test(body)) continue
    if (!new RegExp('^ {2}(?:async\\s+function|const|let|var|function|class) ' + dep + '\\b', 'm').test(src)) continue
    throw new Error('依赖闭包抽不到定义: ' + dep + '（index.js 里有它的两格缩进顶层定义，'
      + '但形状不属于「单行 const」/「function 声明」⇒ 静默跳过会留下难归因的 ReferenceError；'
      + '请把定义改成可抽的形状，或在断言里显式内联）')
  }
  // 🔴 逐条**换行**拼接（第十一轮门槛 LOW#7）：常量值的切片规则是「取到行尾」，
  //   所以 `const bots = new Map()   // appId -> Bot runtime` 这种**带行尾注释**的定义，
  //   注释会一起进闭包源码。用 '' 拼接时后面每一条都落在同一行的注释里 ⇒
  //   `new Function` 抛裸 SyntaxError，本文件"点名报错"的三道绊线一个都碰不到。
  //   换行后注释只吞掉自己那个 `;`，声明语句由 ASI 正常收尾。
  // 信任边界同 `grab()`：`new Function` 只吃本地 ../index.js 切出的片段，输入永不出仓库、
  //   不接外部文本。改成吃外部输入时这里就是注入面。
  const make = new Function(consts.join('\n') + fns.join('\n') + 'return {' + entries.join(',') + '}')
  // 编译**一次**取用（原来在循环里逐 entry 调 make() ⇒ 同一段 new Function 被重复实例化 N 次，
  // 每个 entry 一份互相独立的闭包，断言读的其实是 N 份不同实例）。
  const made = make()
  const scope = {}
  for (const key of entries) scope[key] = made[key]
  return scope
}

// 断言里要用的上限，直接取 index.js 的真实值（原来在这里抄了一份字面量，会漂移）
// 🔴 取不到就**点名**（第十一轮门槛 LOW#8）：`Number(undefined)` 是 NaN，下游断言会报
//   「长度 5000 > undefined」这类看不出根因的失败，与本文件"异常必须指向切片/闭包"的
//   契约相反。常量定义改成多行、或缩进不是两格时，这里就是唯一能喊出来的地方。
const numConst = (name) => {
  const raw = constSrc.get(name)
  if (raw === undefined || raw === '') {
    throw new Error('未抽取到常量 ' + name + '（index.js 里的定义形状变了：需要两格缩进的单行 const）')
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new Error('常量 ' + name + ' 抽到了但不是数字：' + JSON.stringify(String(raw).slice(0, 80)))
  }
  return n
}
const FOLD_CHUNK_CHARS = numConst('FOLD_CHUNK_CHARS')
const CARD_MAX_TABLES = numConst('CARD_MAX_TABLES')

const mod = bundle('chunkText', 'countMarkdownTables', 'splitTableRow', 'demoteTableToLines',
  'demoteTablesInText', 'demoteOverflowTables')

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
  const clipNoteText = bundle('clipNoteText').clipNoteText
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
// 期望值直接写「状态行全文」，而不是抄一个词——0.8.0 起状态行统一带模式前缀
// （statusTextFor 里 mode + ' · ' + 文案），抄单词的历史断言（'_运行中…_'、「无新动作」）
// 早就和实现对不上了：「无新动作」是**工具在跑**分支的措辞，纯空闲分支写的是
// 「上游已 N 分钟没有回包」。这里按真实分支逐条钉死，改文案就会红（可证伪）。
const STATUS_CHECKS = [
  [{ status: 'running' }, '_🧭 普通模式 · 运行中…_', '进行中：普通文案（带模式前缀）'],
  [{ status: 'running', idleMinutes: 5 }, '_🧭 普通模式 · ⏳ 上游已 5 分钟', '进行中但久无动静：说清多久没回包，不谎称完成'],
  [{ status: 'running', idleMinutes: 5, idleKind: 'tools' }, '_🧭 普通模式 · 🔧 工具', '工具还在跑的分支：甩锅给工具而不是卡片'],
  [{ status: 'sealed' }, '_🧭 普通模式 · ✅ 已完成_', '封口：**必须显示**已完成（旧实现直接删掉状态行）'],
  [{ status: 'completed' }, '_🧭 普通模式 · 已完成_', 'completed 分支（历史死状态）文案正常'],
  [{ status: 'error' }, '_🧭 普通模式 · 失败_', '失败文案'],
  [{ status: 'running', planActive: true }, '_📋 计划模式 · 运行中…_', '模式前缀跟着卡片模式走（计划模式）'],
]
const statusTextFor = bundle('statusTextFor').statusTextFor
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
