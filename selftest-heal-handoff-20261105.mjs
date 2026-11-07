// 空回复自愈「上下文交接」selftest（2026-11-05）—— 只依赖 Node 内建模块，不启桥本体。
// 背景故障：长会话 fs-main-mw0o5n0p 因「本轮无产出」被旧自愈逻辑 splice 出绑定、新建空会话，
//   整条上下文断线（维护者 判「桥必须改」）。本自测钉住三条改动各自的判据：
//   A 就地恢复腿存在（先 resume/活句柄重试，再谈重建）；B 重建必须注入**正文**交接摘要（不是 id）；
//   C 旧条目必须保留（不再 splice）＋ 重建有额度（防无限重建）。
//
// 跑法：node selftest-heal-handoff-20261105.mjs   （全绿 exit 0；任一失败 exit 1）
// 注：这里测的是**纯逻辑模块** heal-handoff.mjs ＋ index.js 的源码级钉子；
//     端到端行为（真机空回复触发一次自愈）由 lead 在主区跑 npm run smoke 覆盖。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  buildHealHandoff, collectDialogTail, tailWithinBudget,
  HEAL_HANDOFF_ROUNDS, HEAL_ENTRY_MAX_CHARS, HEAL_TOTAL_MAX_CHARS,
} from './heal-handoff.mjs'

// 与 index.js 同一份明细行剥离正则（同口径，便于断言"摘要不带 kind=/open_id="）
const FOOTER_STRIP_RE = new RegExp('\\s*(?:【发送方】|【本条 @ 的对象】)[\\s\\S]*?(?=\\s*（你在引用这条消息|$)')

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('[PASS] ' + name) }
  else { fail += 1; console.log('[FAIL] ' + name + (detail ? ' —— ' + detail : '')) }
}

const root = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(root, 'index.js'), 'utf8')

// ---- 建样本事件的构件（形状照宿主真实事件：user/message 正文在 data.content，
//      assistant/message 正文在 data.message.content 的 text 块里）--------------------
const userEv = (text, extra) => ({
  type: 'user/message',
  data: Object.assign({ content: [{ type: 'text', text }], source: { kind: 'user' } }, extra || {}),
})
const asstEv = (text) => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } },
})

// ---- S0：源码级钉子（三处改动必须同时在场）----------------------------------------
const healStart = src.indexOf("} else if (!turn.hadOutput && (sessionReused || sessionCorruptFailure)) {")
const healEnd = src.indexOf('    if (turn.waitError) {', healStart)
const healBlock = healStart >= 0 && healEnd > healStart ? src.slice(healStart, healEnd) : ''
ok('S0a 找到自愈块（抽取区间非空）', healBlock.length > 500, 'len=' + healBlock.length)

// C：旧条目不再 splice，且新建时旧条目标记为已交接
ok('S0b [C] 自愈块内不再 splice 掉旧会话条目',
  healBlock.length > 0 && !/chat\.sessions\.splice\s*\(/.test(healBlock))
ok('S0c [C] 自愈块内 push 新条目并显式保留旧条目（打「已交接」标记）',
  /chat\.sessions\.push\(/.test(healBlock) && /HEAL_OLD_LABEL/.test(healBlock))
ok('S0d [C] 重建有额度（防无限重建）',
  /canRebuildAfterHeal\(/.test(healBlock) && /const HEAL_REBUILD_MAX\s*=\s*\d+/.test(src))
// A：先就地恢复再重试（恢复腿必须在重建之前出现）
const resumeAt = healBlock.indexOf('reviveSessionForRetry(')
const rebuildAt = healBlock.indexOf('createDedicated(')
ok('S0e [A] 自愈块内有「就地恢复」调用，且排在重建之前',
  resumeAt > 0 && rebuildAt > resumeAt, 'resumeAt=' + resumeAt + ' rebuildAt=' + rebuildAt)
ok('S0f [A] 恢复腿只重试一次、不循环（无 while/for 包裹重试）',
  /async function reviveSessionForRetry/.test(src) && !/while\s*\([^)]*hadOutput/.test(healBlock))
// B：重建重跑时带交接前缀，且摘要是「正文构造器」产出的
ok('S0g [B] 重建重跑时传入交接前缀（runTurn(handle.agent, { prefix: digest })）',
  /runTurn\(handle\.agent,\s*\{\s*prefix:\s*digest\s*\}\)/.test(healBlock))
ok('S0h [B] 交接摘要由 heal-handoff 构造（不是只拼一个会话 id）',
  /import \{ buildHealHandoff \} from '\.\/heal-handoff\.mjs'/.test(src)
  && /buildHealHandoff\(\{\s*events, oldSessionId, reason/.test(src))
ok('S0i [B] runTurn 的消息正文里接了 opts.prefix 通道（与日期锚同一拼接点）',
  /dateAnchor \+ \(opts && opts\.prefix \? opts\.prefix : ''\) \+ label \+ text/.test(src))

// ---- 1. 正常对话流：id / 正文 / 原因 三样都在 -------------------------------------
const normalEvents = [
  userEv('先说说你对我这个项目的理解'),
  asstEv('我的理解是：你想把飞书桥做成可热加载的插件。'),
  userEv('对，那设计讨论继续：多 bot 的会话如何隔离？'),
  asstEv('每个 chat 一条 dedicated 会话，按 chatId 绑定。'),
  userEv('最后确认一下 13 万字那版设计稿的落点'),
]
const normal = buildHealHandoff({
  events: normalEvents,
  oldSessionId: 'fs-main-mw0o5n0p',
  reason: '本轮没有产出（回合被重启打断）',
  footerStripRe: FOOTER_STRIP_RE,
})
ok('1a 摘要带旧会话 id', normal.includes('fs-main-mw0o5n0p'))
ok('1b 摘要带「重建原因」', normal.includes('重建原因') && normal.includes('回合被重启打断'))
ok('1c 摘要带用户正文（前几轮）', normal.includes('多 bot 的会话如何隔离'))
ok('1d 摘要带助手正文', normal.includes('每个 chat 一条 dedicated 会话'))
ok('1e 摘要带「不是新指令」的边界声明', normal.includes('不是用户的新指令'))
ok('1f 摘要提示可 /switch 切回旧会话', normal.includes('/switch'))
ok('1g 末尾未获回答的用户消息（＝本轮那条）不进摘要',
  !normal.includes('最后确认一下 13 万字那版设计稿的落点'))

// ---- 2. 跳过 reasoning 与工具明细 -------------------------------------------------
const reasoningEvents = [
  userEv('这条要有正文'),
  {
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: '这里是思考过程，绝不能进摘要' },
          { type: 'text', text: '这是要进摘要的正文' },
          { type: 'tool-call', name: 'read', arguments: '{"path":"x"}' },
        ],
      },
    },
  },
  { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"path":"secret.txt"}' } },
  { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '工具返回明细' }] } } },
]
const noTool = buildHealHandoff({
  events: reasoningEvents, oldSessionId: 'fs-main-abc', reason: 'x', footerStripRe: FOOTER_STRIP_RE,
})
// 注意：表头本身就写着「已跳过思考过程与工具明细」⇒ 断言必须挑**样本独有**的词，不能挑这两个通用词
ok('2a reasoning 块不进摘要', !noTool.includes('绝不能进摘要'))
ok('2b 工具调用/返回明细不进摘要',
  !noTool.includes('secret.txt') && !noTool.includes('工具返回明细'))
ok('2c 同一条 assistant 里的 text 正文照样进摘要', noTool.includes('这是要进摘要的正文'))

// ---- 3. 剥掉桥自己加的投递前缀（日期锚 / [飞书 x] / 【发送方】明细行）----------------
const envelopeEvents = [
  userEv('【日期锚】2026-11-03 星期一\n[飞书 维护者] 帮我看下热加载为什么没生效\n【发送方】kind=user name=维护者 open_id=ou_123\n'),
  asstEv('查了日志，是 HMR 静默未载。'),
]
const stripped = buildHealHandoff({
  events: envelopeEvents, oldSessionId: 'fs-main-env', reason: 'x', footerStripRe: FOOTER_STRIP_RE,
})
ok('3a 日期锚不占摘要', !stripped.includes('【日期锚】'))
ok('3b [飞书 姓名] 前缀不占摘要', !stripped.includes('[飞书 维护者]'))
ok('3c 【发送方】明细行（含 open_id）不占摘要',
  !stripped.includes('【发送方】') && !stripped.includes('ou_123'))
ok('3d 正文本身保留', stripped.includes('帮我看下热加载为什么没生效'))

// ---- 4. 纯 🎯 旁白不算正文 --------------------------------------------------------
const narration = collectDialogTail([
  userEv('问一句'),
  asstEv('🎯 查一下配置'),
  asstEv('🎯 再查一下日志'),
], { footerStripRe: FOOTER_STRIP_RE })
ok('4a 纯目的行旁白的 assistant 不进对话尾部',
  narration.every((one) => one.role !== '助手'), JSON.stringify(narration))

// ---- 5. 空/异常事件流：骨架仍带 id + 原因，绝不抛 --------------------------------
let skeleton = ''
try {
  skeleton = buildHealHandoff({ events: undefined, oldSessionId: 'fs-main-dead', reason: '会话格式损坏' })
} catch (error) {
  skeleton = 'THREW: ' + String(error && error.message || error)
}
ok('5a events 为 undefined 不抛，返回骨架', skeleton.startsWith('【上一会话交接'))
ok('5b 骨架仍带旧会话 id 与原因', skeleton.includes('fs-main-dead') && skeleton.includes('会话格式损坏'))
ok('5c 骨架明说正文没取到（不编造兜底正文）', skeleton.includes('没能取到'))
ok('5d 非数组事件同样不抛', (() => {
  try { return buildHealHandoff({ events: 'not-an-array', oldSessionId: 'x', reason: 'y' }).includes('x') } catch { return false }
})())

// ---- 6. 长度受控（单段裁剪 + 总量预算）--------------------------------------------
const longEvents = []
for (let i = 0; i < 30; i++) {
  longEvents.push(userEv('#u' + i + ' 问 ' + 'x'.repeat(600)))
  longEvents.push(asstEv('#a' + i + ' 答 ' + 'y'.repeat(1200)))
}
const longOut = buildHealHandoff({
  events: longEvents, oldSessionId: 'fs-main-long', reason: 'z', footerStripRe: FOOTER_STRIP_RE,
})
const bodyLines = longOut.split('\n').filter((line) => /^\[(用户|助手)\] /.test(line))
ok('6a 段数不超过默认轮数上限', bodyLines.length <= HEAL_HANDOFF_ROUNDS, 'lines=' + bodyLines.length)
ok('6b 单段正文不超过上限（含省略号）',
  bodyLines.every((line) => line.length <= HEAL_ENTRY_MAX_CHARS + 12),
  'max=' + Math.max(0, ...bodyLines.map((line) => line.length)))
const bodyChars = bodyLines.reduce((sum, line) => sum + line.length, 0)
ok('6c 正文总量受预算约束', bodyChars <= HEAL_TOTAL_MAX_CHARS + bodyLines.length * 8, 'chars=' + bodyChars)
ok('6d 只保留尾部（最新那段在、最早那段不在）',
  longOut.includes('#u29') && longOut.includes('#a29') && !longOut.includes('#u0 '))

// ---- 7. rounds / 预算参数可覆盖 ---------------------------------------------------
const three = tailWithinBudget(
  [1, 2, 3, 4, 5].map((n) => ({ role: '用户', text: '第' + n + '句' })),
  { rounds: 3 })
ok('7a rounds 参数生效（只取尾部 N 段）',
  three.length === 3 && three[2].text === '第5句' && three[0].text === '第3句', JSON.stringify(three))

// ---- 8. 「别人（插件/goal）注入的 user/message」不冒充对话正文 ---------------------
// 注意：会话尾部若停在 user/message（＝本轮这条没得到回答），摘要会**整段剔除尾部用户消息**
//   （见 1g）；所以这条样本必须让助手正文收尾，才测得到"kind 过滤"本身。
const injected = collectDialogTail([
  userEv('真实用户说话'),
  asstEv('助手回答'),
  { type: 'user/message', data: { content: [{ type: 'text', text: 'goal 轮内部提示词' }], source: { kind: 'goal' } } },
], { footerStripRe: FOOTER_STRIP_RE })
ok('8a source.kind !== user 的注入正文不进摘要',
  injected.length === 2 && injected[0].text === '真实用户说话' && injected[1].text === '助手回答',
  JSON.stringify(injected))

// ---- 9. keptInBinding：话术必须与实际状态一致（2026-11-05 扩腿·维护者 判「新会话要附上一次会话 id」）
// 背景：交接原来只挂「空回复自愈」一条腿；「重启后旧会话不可恢复 ⇒ 自动新建」那条腿不注入，
//   新会话连"有个前任"都不知道。扩到该腿后，legacy 丢弃腿的旧条目**真的不在绑定里**了，
//   若还照抄「/switch 可切回」就是骗人（A18 禁编造兜底）。
const notKept = buildHealHandoff({
  events: [], oldSessionId: 'fs-main-legacy', reason: '上一代格式被丢弃', keptInBinding: false,
})
ok('9a keptInBinding=false 不谎称旧会话仍保留在绑定里',
  !notKept.includes('仍保留在绑定里') && notKept.includes('没有保留在绑定里'), notKept)
ok('9b keptInBinding=false 仍交代旧会话 id（"上一次是谁"不丢）', notKept.includes('fs-main-legacy'))
const keptHandoff = buildHealHandoff({ events: [], oldSessionId: 'fs-main-old', reason: '重启后不可恢复' })
ok('9c 默认（未传 keptInBinding）仍提示 /switch 可切回',
  keptHandoff.includes('/switch 切回'))

// ---- 10. index.js 接线钉子：两条「自动新建会话」腿都必须注入交接 ---------------------
// 变异测试口径：把下面任一处改回旧实现（不赋值 autoHandoff / 不传 leadOpts），对应断言必红。
ok('10a 旧会话不可恢复（fallback）腿把交接赋给 autoHandoff',
  /autoHandoff = healHandoffText\(\s*\n?\s*prevEntry && prevEntry\.handle && prevEntry\.handle\.agent, prevId,/.test(src))
ok('10b legacy 丢弃腿以 keptInBinding:false 注入（不谎称可切回）',
  /autoHandoff = healHandoffText\(null, droppedId,[\s\S]{0,240}?keptInBinding: false/.test(src))
ok('10c 首轮 runTurn 经 leadOpts.prefix 把交接拼进消息正文',
  /const leadOpts = Object\.assign\(/.test(src)
  && /autoHandoff \? \{ prefix: autoHandoff \}/.test(src)
  && /runTurn\(commandHold && commandHold\.agent \? commandHold\.agent : agent, leadOpts\)/.test(src))
ok('10d loadChats 记下被丢弃的 legacy id（交接才有东西可交代）',
  /bot\.droppedLegacyIds\.set\(chatId/.test(src))

// ---- 11. 会话归属工作区（cwd）落盘与继承 --------------------------------------------
// 背景（2026-11-05 维护者 报障）：bot 的 workspace 改过（P:\Qoder\work → P:\work）后，桥重建会话
//   只按当前 cfg.workspace 落，新会话进了另一个 GUI 工作区分组 ⇒ 旧会话在列表里"消失"。
//   修法＝把生效 cwd 跟条目一起落盘，重建时继承旧条目的 cwd。
ok('11a persistChats 把会话 cwd 落盘',
  /cwd: s\.cwd,/.test(src))
ok('11b createDedicated 与实际落盘共用同一个 cwd 计算（effectiveSessionCwd）',
  /meta: \{ cwd: effectiveSessionCwd\(bot, cwdOverride\) \}/.test(src))
ok('11c 旧会话不可恢复腿：用 prevCwd 建会话并把它记进条目',
  /createDedicated\(bot, sessionId, prevCwd \|\| undefined\)/.test(src)
  && /cwd: prevCwd \|\| effectiveSessionCwd\(bot\)/.test(src))
ok('11d 自愈重建腿：继承 staleCwd（不换工作区分组）',
  /const staleCwd = stale && stale\.cwd \? String\(stale\.cwd\) : ''/.test(src)
  && /createDedicated\(bot, sessionId, staleCwd \|\| undefined\)/.test(src)
  && /cwd: staleCwd \|\| effectiveSessionCwd\(bot\)/.test(src))
ok('11e 新会话（无前任）也记下 cwd（供下次重建继承）',
  /cwd: effectiveSessionCwd\(bot\),\r?\n\s*\}\],?/.test(src))

console.log('==== selftest-heal-handoff-20261105 结果：PASS ' + pass + ' / FAIL ' + fail + ' ====')
process.exit(fail === 0 ? 0 : 1)
