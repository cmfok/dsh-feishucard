// dsh-feishucard helper: keeps the Feishu (Lark) official-SDK WebSocket
// long connection alive and streams events to the host plugin over stdout.
//
// Protocol: one JSON object per line on stdout.
//   {"type":"starting"}                     helper booting
//   {"type":"ready"}                        WS connected (also after reconnect)
//   {"type":"reconnecting"}                 WS dropped, retrying
//   {"type":"status","status":{...}}        periodic connection snapshot
//   {"type":"event","eventType":"im.message.receive_v1","data":{...}}
//   {"type":"error","message":"..."}        non-fatal error
//
// Usage: node helper.cjs --cred <credFile>
//   凭证来源顺序：--cred 文件（生产路径，index.js 写 0600 文件）> 裸 argv（仅兼容旧版
//   index.js，会打警告）> 环境变量 DSH_FEISHU_APP_ID / DSH_FEISHU_APP_SECRET。
//   argv 排在 env 之前：多 bot 机器上 env 优先会让某个 bot 用 env 里那套凭据连错应用。
//   为什么不用 argv：命令行参数会被同机任何账号 `ps aux` 看到原文，而服务器上有
//   7 个 agt* 账号（2026-10-05 交接清单#5 安全项）。
'use strict'

const fs = require('node:fs')
const lark = require('@larksuiteoapi/node-sdk')

function emit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n')
  } catch {
    /* stdout closed; the host will restart us */
  }
}

// 致命退出前**同步**写：emit 走 process.stdout.write，在管道上是异步的，紧跟
// process.exit() 可能把这一行丢掉 ⇒ 宿主只看到 helper 消失、拿不到原因。
function emitFatal(obj) {
  try {
    fs.writeSync(1, JSON.stringify(obj) + '\n')
  } catch {
    /* stdout closed */
  }
  process.exit(1)
}

const credAt = process.argv.indexOf('--cred')
const credRequested = credAt >= 0
const credPath = credRequested ? String(process.argv[credAt + 1] || '') : ''
let credFile = null
if (credRequested) {
  let problem = credPath ? '' : 'no path after --cred'
  if (!problem) {
    try {
      credFile = JSON.parse(fs.readFileSync(credPath, 'utf8'))
    } catch (error) {
      problem = 'unreadable: ' + String((error && error.message) || error)
    }
  }
  if (!problem && (!credFile || !credFile.appId || !credFile.appSecret)) {
    problem = 'no usable appId/appSecret fields'
    credFile = null
  }
  // 明确要了 --cred 却拿不到凭证 ⇒ 绝不退回 argv（实测踩过的坑：argv[2] 恰是字面量
  // `--cred`，会被当成 appId 去连飞书，报错信息还指着这个假 id，排查时完全跑偏）。
  // 一条消息带**路径 + 原因**，运维不用猜是哪一个字段坏了。
  if (problem) {
    emitFatal({ type: 'error', message: 'helper aborting: --cred ' + problem + ' (' + (credPath || 'no path') + ')' })
  }
}

// 取用顺序：凭证文件 → argv → env。
// argv 排在 env **之前**（0.7.22 独立审查 LOW）：多 bot 机器上若全局导出过
// DSH_FEISHU_APP_ID/_APP_SECRET，env 优先会让某个 bot 用 env 里那套凭据连上去
// ⇒ 连错的应用，比失败更难查。走 argv 时明确告警（这条通道就是本次要消灭的明文暴露）。
const argvAppId = String(process.argv[2] || '').trim()
const argvAppSecret = String(process.argv[3] || '').trim()
if (!credFile && argvAppId && argvAppSecret) {
  // 这是**劝告**不是故障：发 type:'error' 会被宿主打成 `[fs] helper error:`，
  // 运维当成真错误追查，还会淹没真正的 helper 故障 ⇒ 走独立的 warn 通道。
  emit({ type: 'warn', message: 'helper credentials from argv (appSecret visible in ps) — host should pass --cred: app=' + argvAppId })
}
const appId = String((credFile && credFile.appId) || argvAppId || process.env.DSH_FEISHU_APP_ID || '').trim()
const appSecret = String((credFile && credFile.appSecret) || argvAppSecret || process.env.DSH_FEISHU_APP_SECRET || '').trim()

if (!appId || !appSecret) {
  emitFatal({ type: 'error', message: 'helper got no credentials (need --cred file, argv, or env)' })
}

const dispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': (data) => {
    emit({ type: 'event', eventType: 'im.message.receive_v1', data })
    return {}
  },
  'card.action.trigger': (data) => {
    emit({ type: 'event', eventType: 'card.action.trigger', data })
    return {}
  },
})

// Debug: surface ANY event the long connection delivers (including unknown
// event types) so we can tell whether callbacks arrive over the WS at all.
const origInvoke = dispatcher.invoke.bind(dispatcher)
dispatcher.invoke = (data, opts) => {
  const t = data && (data.type || (data.header && data.header.event_type)) || 'unknown'
  emit({ type: 'event', eventType: String(t), data, raw: true })
  return origInvoke(data, opts)
}

const client = new lark.WSClient({
  appId,
  appSecret,
  loggerLevel: lark.LoggerLevel.info,
  onReady: () => emit({ type: 'ready' }),
  onReconnecting: () => emit({ type: 'reconnecting' }),
  onReconnected: () => emit({ type: 'ready' }),
  onError: (e) => emit({ type: 'error', message: String((e && e.message) || e) }),
})

emit({ type: 'starting' })

// Periodic connection snapshot so the host can observe retry loops that never
// reach onReady/onError (e.g. bad credentials or no network).
setInterval(() => {
  try {
    emit({ type: 'status', status: client.getConnectionStatus() })
  } catch {
    /* best effort */
  }
}, 10000)

client.start({ eventDispatcher: dispatcher }).catch((e) => {
  emitFatal({ type: 'error', message: 'start failed: ' + String((e && e.message) || e) })
})
