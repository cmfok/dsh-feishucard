// selftest-evalchat-route-20261117.mjs —— [G5-F085] index.js 接线结构自钉（离线静态断言）。
// 模块逻辑三例由 `node evalchat-route.mjs --selftest` 承担；本文件钉住**挂点没被拆**：
//   ① import + 跨代表；② dispatchParsedInbound 里「待答问之后、steer 之前」的路由挂点；
//   ③ inject-context 的 route 登记与 route_registered 回执。任一被删＝此处必红。
// 运行：node selftest-evalchat-route-20261117.mjs（cwd 无要求）
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const idx = join(dirname(fileURLToPath(import.meta.url)), 'index.js')
const src = fs.readFileSync(idx, 'utf8')

let pass = 0; let fail = 0
const ok = (c, label) => { if (c) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label) } }

console.log('── 1) 模块 import 与跨代登记表 ——')
ok(src.includes("} from './evalchat-route.mjs'"), 'index.js import evalchat-route.mjs')
ok(src.includes('globalThis.__fsEvalRoutes'), '登记表挂 globalThis（热重载跨代，同 activeTurns 先例）')
ok(src.includes('function maybeRouteEvalChat(bot, evt, text)'), 'maybeRouteEvalChat 定义在册')

console.log('── 2) dispatchParsedInbound 挂点与优先级次序 ——')
const iPending = src.indexOf("sendPlainText(bot, chatId, '✅ 已收到你的回答。')")
const iHook = src.indexOf('if (maybeRouteEvalChat(bot, evt, text)) return')
const iSteer = src.indexOf('if (steerActiveTurn(bot, evt, text)) return')
ok(iHook > -1, '待答问之后调用 maybeRouteEvalChat 并按其返回短路')
ok(iPending > -1 && iHook > iPending, '优先级：待答问分支在路由之前（待答卡先消费）')
ok(iSteer > -1 && iSteer > iHook, '优先级：路由在 steer 之前（被追问回复优先于插话）')
ok(src.includes("String(evt.chat_type || '') !== 'p2p'") && src.includes("String(evt.message_type || '') !== 'text'")
  && src.includes('if (evt._internal) return false'), '三防误伤闸在册（仅 p2p／仅 text／合成消息不路由）')
ok(src.includes('evalRoutes.reinsert(entry)'), '失败降级放回登记在册（TTL 兜底）')
ok(src.includes('return handleInbound(bot, evt)'), '不劫持路径回原链 handleInbound 在册')

console.log('── 3) inject-context 登记面 ——')
const iReg = src.indexOf('evalRoutes.register({ appId: hit.bot.cfg.appId')
const iInjectCall = src.indexOf("void handleInbound(hit.bot, {")
ok(iReg > -1, 'inject-context 内 route 登记在册')
ok(iInjectCall > -1 && iReg < iInjectCall, '登记先于 handleInbound 注入（通道为主、注入为兜底）')
ok(src.includes('route_registered: routeRegistered'), '响应回执带 route_registered（可观测）')
ok(src.includes('isAllowedEndpoint(v.route.endpoint)'), '登记前过端点白名单（fail-closed）')

console.log('')
console.log('自测通过 ' + pass + ' ｜ 失败 ' + fail)
process.exit(fail === 0 ? 0 : 1)
