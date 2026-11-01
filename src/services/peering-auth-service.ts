import WebSocket, { RawData } from 'ws'

import { Event } from '../@types/event'
import { buildPeeringAuthEvent } from '../utils/peering-identity'

export const PEERING_AUTH_TIMEOUT_MS = 10_000

export interface AuthenticatePeerOptions {
  relayUrl: string
  privateKey: string
  timeoutMs?: number
  createdAt?: number
}

export interface AuthenticatedPeerConnection {
  /** Open and authenticated socket; the caller owns it from here. */
  socket: WebSocket
  challenge: string
  authEvent: Event
}

const closeQuietly = (socket: WebSocket): void => {
  try {
    socket.close()
  } catch {
    // The socket may already be closed; there is nothing left to clean up.
  }
}

/**
 * Connects to a peer relay and performs NIP-42 AUTH with this relay's own
 * keypair. Resolves only after the peer answers `OK true` for the AUTH event,
 * leaving the socket open for the caller (a live feed, negentropy session, ...).
 */
export const authenticateToPeeringRelay = (options: AuthenticatePeerOptions): Promise<AuthenticatedPeerConnection> => {
  const { relayUrl, privateKey, timeoutMs = PEERING_AUTH_TIMEOUT_MS, createdAt } = options

  return new Promise<AuthenticatedPeerConnection>((resolve, reject) => {
    let socket: WebSocket
    try {
      socket = new WebSocket(relayUrl)
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Unable to open the peering socket'))
      return
    }

    let challenge: string | undefined
    let authEvent: Event | undefined
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      socket.off('message', onMessage)
      socket.off('close', onClose)
      socket.off('error', onError)

      if (error) {
        // A close during the handshake can still emit an `error` later; keep a
        // no-op listener so an abandoned connect cannot crash the process.
        socket.on('error', () => {})
        closeQuietly(socket)
        reject(error)
        return
      }

      resolve({ socket, challenge: challenge as string, authEvent: authEvent as Event })
    }

    const onMessage = (data: RawData): void => {
      let message: unknown
      try {
        message = JSON.parse(data.toString())
      } catch {
        return
      }

      if (!Array.isArray(message)) {
        return
      }

      // The relay sends its challenge as soon as the socket opens.
      if (message[0] === 'AUTH' && typeof message[1] === 'string' && challenge === undefined) {
        challenge = message[1]
        void buildPeeringAuthEvent({ relayUrl, challenge, privateKey, createdAt }).then(
          (event) => {
            if (settled) {
              return
            }
            authEvent = event
            socket.send(JSON.stringify(['AUTH', event]))
          },
          (error) => finish(error instanceof Error ? error : new Error('Unable to sign peering AUTH event')),
        )
        return
      }

      if (message[0] === 'OK' && authEvent !== undefined && message[1] === authEvent.id) {
        if (message[2] === true) {
          finish()
          return
        }

        const reason = typeof message[3] === 'string' && message[3] ? `: ${message[3]}` : ''
        finish(new Error(`peering AUTH rejected${reason}`))
      }
    }

    const onClose = (): void => {
      finish(new Error('connection closed before peering AUTH completed'))
    }

    const onError = (error: Error): void => {
      finish(error)
    }

    timer = setTimeout(() => {
      finish(new Error('timed out waiting for peering AUTH'))
    }, timeoutMs)
    timer.unref()

    socket.on('message', onMessage)
    socket.on('close', onClose)
    socket.on('error', onError)
  })
}
