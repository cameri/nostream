import { ProbeTarget, WsRttResult } from './types'

export interface WebSocketConnector {
  measureOpenRtt(address: string, timeoutMs: number): Promise<number>
}

export const createNodeWebSocketConnector = (): WebSocketConnector => {
  const { WebSocket } = require('ws') as typeof import('ws')

  return {
    measureOpenRtt: (address, timeoutMs) =>
      new Promise<number>((resolve, reject) => {
        const startedAt = Date.now()
        const socket = new WebSocket(address, { handshakeTimeout: timeoutMs })
        let settled = false

        const finish = (error?: Error, rttOpenMs?: number) => {
          if (settled) {
            return
          }

          settled = true
          socket.removeAllListeners()

          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.terminate()
          }

          if (error) {
            reject(error)
            return
          }

          resolve(rttOpenMs as number)
        }

        socket.once('open', () => {
          finish(undefined, Date.now() - startedAt)
        })

        socket.once('error', (error) => {
          finish(error instanceof Error ? error : new Error(String(error)))
        })

        setTimeout(() => {
          finish(new Error(`WebSocket probe timed out after ${timeoutMs}ms`))
        }, timeoutMs).unref()
      }),
  }
}

export const probeWebSocketRtt = async (
  connector: WebSocketConnector,
  target: ProbeTarget,
  timeoutMs: number,
): Promise<WsRttResult> => {
  const rttOpenMs = await connector.measureOpenRtt(target.wsUrl, timeoutMs)

  return {
    rttOpenMs,
    address: target.wsUrl,
  }
}
