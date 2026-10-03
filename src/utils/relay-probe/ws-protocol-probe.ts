import { EventKinds, EventTags } from '../../constants/base'
import { Event, UnidentifiedEvent } from '../../@types/event'
import { getPublicKey, identifyEvent, signEvent } from '../event'
import { ProbeTarget, WsRttResult } from './types'

const PROBE_SUBSCRIPTION_ID = 'nip66-probe-read'
const PROBE_COUNT_FILTER = { kinds: [1] }

export interface WebSocketProtocolProbeOptions {
  monitorPrivateKey?: string
}

export interface WebSocketProtocolConnector {
  measureProtocol(
    target: ProbeTarget,
    timeoutMs: number,
    options?: WebSocketProtocolProbeOptions,
  ): Promise<WsRttResult>
}

type NostrWireMessage = unknown[]

const isAuthRequiredMessage = (message: string | undefined): boolean =>
  typeof message === 'string' && message.toLowerCase().includes('auth-required')

const parseWireMessage = (raw: unknown): NostrWireMessage | undefined => {
  if (typeof raw !== 'string') {
    return undefined
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const buildAuthEvent = async (
  privateKey: string,
  challenge: string,
  relayUrl: string,
): Promise<Event> => {
  const pubkey = getPublicKey(privateKey)
  const unsigned: UnidentifiedEvent = {
    kind: EventKinds.AUTH,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      [EventTags.AuthRelay, relayUrl],
      [EventTags.Challenge, challenge],
    ],
  }

  return signEvent(privateKey)(await identifyEvent(unsigned))
}

const buildWriteProbeEvent = async (privateKey: string): Promise<Event> => {
  const pubkey = getPublicKey(privateKey)
  const unsigned: UnidentifiedEvent = {
    kind: EventKinds.EPHEMERAL_FIRST,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content: 'nip66 write probe',
    tags: [[EventTags.Deduplication, 'nip66-write-probe']],
  }

  return signEvent(privateKey)(await identifyEvent(unsigned))
}

export const createNodeWebSocketProtocolConnector = (): WebSocketProtocolConnector => {
  const { WebSocket } = require('ws') as typeof import('ws')

  return {
    measureProtocol: (target, timeoutMs, options) =>
      new Promise<WsRttResult>((resolve, reject) => {
        const startedAt = Date.now()
        const socket = new WebSocket(target.wsUrl, { handshakeTimeout: timeoutMs })
        let settled = false
        let openAt: number | undefined
        let authChallenge: string | undefined
        let nip42AuthRequired = false

        const finish = (error?: Error, result?: WsRttResult) => {
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

          resolve(result as WsRttResult)
        }

        const observeAuthChallenge = (raw: unknown): void => {
          const message = parseWireMessage(raw)

          if (message?.[0] === 'AUTH' && typeof message[1] === 'string') {
            authChallenge = message[1]
            nip42AuthRequired = true
          }
        }

        const waitForMessage = (
          predicate: (message: NostrWireMessage) => boolean,
          remainingMs: number,
        ): Promise<NostrWireMessage> =>
          new Promise((messageResolve, messageReject) => {
            if (remainingMs <= 0) {
              messageReject(new Error('WebSocket probe timed out'))
              return
            }

            const deadline = Date.now() + remainingMs

            const onMessage = (raw: unknown) => {
              observeAuthChallenge(raw)
              const message = parseWireMessage(raw)

              if (!message) {
                return
              }

              if (predicate(message)) {
                cleanup()
                messageResolve(message)
              } else if (Date.now() >= deadline) {
                cleanup()
                messageReject(new Error('WebSocket probe timed out waiting for response'))
              }
            }

            const onError = (error: Error) => {
              cleanup()
              messageReject(error)
            }

            const onClose = () => {
              cleanup()
              messageReject(new Error('WebSocket closed before expected response'))
            }

            const cleanup = () => {
              socket.off('message', onMessage)
              socket.off('error', onError)
              socket.off('close', onClose)
            }

            socket.on('message', onMessage)
            socket.on('error', onError)
            socket.on('close', onClose)
          })

        const waitForOptionalAuthChallenge = (remainingMs: number): Promise<void> =>
          new Promise((resolve) => {
            const waitMs = Math.min(250, remainingMs)

            if (waitMs <= 0) {
              resolve()
              return
            }

            const onMessage = (raw: unknown) => {
              observeAuthChallenge(raw)

              if (authChallenge) {
                cleanup()
                resolve()
              }
            }

            const timer = setTimeout(() => {
              cleanup()
              resolve()
            }, waitMs)

            const cleanup = () => {
              clearTimeout(timer)
              socket.off('message', onMessage)
            }

            socket.on('message', onMessage)
          })

        const remainingTimeoutMs = (): number => Math.max(0, timeoutMs - (Date.now() - startedAt))

        const authenticateIfNeeded = async (): Promise<void> => {
          const privateKey = options?.monitorPrivateKey?.trim()

          if (!authChallenge || !privateKey) {
            return
          }

          const authEvent = await buildAuthEvent(privateKey, authChallenge, target.relayUrl)
          socket.send(JSON.stringify(['AUTH', authEvent]))

          const authResponse = await waitForMessage(
            (message) => message[0] === 'OK' && message[1] === authEvent.id,
            remainingTimeoutMs(),
          )

          if (authResponse[2] !== true) {
            throw new Error(`NIP-42 authentication failed: ${String(authResponse[3] ?? '')}`)
          }
        }

        const measureReadRtt = async (): Promise<number | undefined> => {
          const runCount = async (): Promise<number | undefined> => {
            const readStartedAt = Date.now()
            socket.send(JSON.stringify(['COUNT', PROBE_SUBSCRIPTION_ID, PROBE_COUNT_FILTER]))

            const response = await waitForMessage(
              (message) =>
                (message[0] === 'COUNT' && message[1] === PROBE_SUBSCRIPTION_ID) ||
                (message[0] === 'CLOSED' && message[1] === PROBE_SUBSCRIPTION_ID),
              remainingTimeoutMs(),
            )

            if (response[0] === 'CLOSED' && isAuthRequiredMessage(String(response[2] ?? ''))) {
              nip42AuthRequired = true
              return undefined
            }

            if (response[0] !== 'COUNT') {
              throw new Error(`Unexpected read probe response: ${JSON.stringify(response)}`)
            }

            return Date.now() - readStartedAt
          }

          let rtt = await runCount()

          if (rtt === undefined && nip42AuthRequired && options?.monitorPrivateKey?.trim()) {
            await authenticateIfNeeded()
            rtt = await runCount()
          }

          return rtt
        }

        const measureWriteRtt = async (): Promise<number | undefined> => {
          const privateKey = options?.monitorPrivateKey?.trim()

          if (!privateKey) {
            return undefined
          }

          const runWrite = async (): Promise<number | undefined> => {
            const writeEvent = await buildWriteProbeEvent(privateKey)
            const writeStartedAt = Date.now()
            socket.send(JSON.stringify(['EVENT', writeEvent]))

            const response = await waitForMessage(
              (message) => message[0] === 'OK' && message[1] === writeEvent.id,
              remainingTimeoutMs(),
            )

            if (response[2] !== true && isAuthRequiredMessage(String(response[3] ?? ''))) {
              nip42AuthRequired = true
              return undefined
            }

            if (response[2] !== true) {
              throw new Error(`Write probe rejected: ${String(response[3] ?? '')}`)
            }

            return Date.now() - writeStartedAt
          }

          let rtt = await runWrite()

          if (rtt === undefined && nip42AuthRequired) {
            await authenticateIfNeeded()
            rtt = await runWrite()
          }

          return rtt
        }

        socket.once('open', () => {
          openAt = Date.now()

          void (async () => {
            try {
              await waitForOptionalAuthChallenge(remainingTimeoutMs())

              const rttReadMs = await measureReadRtt()
              const rttWriteMs = await measureWriteRtt()

              finish(undefined, {
                rttOpenMs: openAt! - startedAt,
                rttReadMs,
                rttWriteMs,
                nip42AuthRequired: nip42AuthRequired || undefined,
                nip42ChallengeObserved: authChallenge ? true : undefined,
                address: target.wsUrl,
              })
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error)
              finish(new Error(message))
            }
          })()
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

export const probeWebSocketProtocol = async (
  connector: WebSocketProtocolConnector,
  target: ProbeTarget,
  timeoutMs: number,
  options?: WebSocketProtocolProbeOptions,
): Promise<WsRttResult> => connector.measureProtocol(target, timeoutMs, options)
