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
// Usage: node helper.cjs <appId> <appSecret>
'use strict'

const lark = require('@larksuiteoapi/node-sdk')

const appId = process.argv[2]
const appSecret = process.argv[3]

function emit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n')
  } catch {
    /* stdout closed; the host will restart us */
  }
}

if (!appId || !appSecret) {
  emit({ type: 'error', message: 'helper needs appId and appSecret arguments' })
  process.exit(1)
}

const dispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': (data) => {
    emit({ type: 'event', eventType: 'im.message.receive_v1', data })
    return {}
  },
})

const client = new lark.WSClient({
  appId,
  appSecret,
  loggerLevel: lark.LoggerLevel.error,
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
  emit({ type: 'error', message: 'start failed: ' + String((e && e.message) || e) })
  process.exit(1)
})
