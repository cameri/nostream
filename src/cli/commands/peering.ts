import WebSocket, { RawData } from 'ws'

import type { Event } from '../../@types/event'
import type { PeeringAcceptancePayload, PeeringAdvertisement } from '../../@types/peering'
import type { Settings } from '../../@types/settings'
import { getPublicKey, getRelayPrivateKey } from '../../utils/event'
import { buildPeeringRequestEvent, verifyPeeringAcceptanceEvent } from '../../utils/peering-attestation'
import { fetchPeeringAdvertisement } from '../../utils/peering-advertisement'
import { authenticateToPeeringRelay } from '../../utils/peering-auth'
import { loadMergedSettings } from '../utils/config'
import { logError, logInfo } from '../utils/output'

export interface PeeringRequestReply {
  ok: boolean
  message: string
  acceptance?: { event: Event; acceptance: PeeringAcceptancePayload }
}

/**
 * Sends the owner-signed request over an already authenticated peer socket and
 * waits for the relay's OK and optional acceptance event.
 */
export const sendPeeringRequest = (
  socket: WebSocket,
  request: Event,
  timeoutMs = 15_000,
): Promise<PeeringRequestReply> =>
  new Promise((resolve) => {
    let settled = false
    let acknowledged = false
    let acceptance: Event | undefined
    let finishTimer: NodeJS.Timeout | undefined

    const finish = (reply: PeeringRequestReply): void => {
      if (settled) {
        return
      }
      settled = true
      if (finishTimer) {
        clearTimeout(finishTimer)
      }
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      socket.off('error', onError)
      resolve(reply)
    }

    const accept = (): PeeringRequestReply => ({
      ok: true,
      message: acceptance ? 'accepted with a signed acceptance' : 'accepted',
      ...(acceptance
        ? { acceptance: { event: acceptance, acceptance: acceptancePayload(acceptance) as PeeringAcceptancePayload } }
        : {}),
    })

    const succeedOrWait = (): void => {
      if (acceptance) {
        finish(accept())
        return
      }
      // The acceptance may follow the OK; give the relay one frame of grace.
      finishTimer = setTimeout(() => finish(accept()), 500)
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

      if (message[0] === 'OK' && message[1] === request.id) {
        if (message[2] !== true) {
          finish({ ok: false, message: typeof message[3] === 'string' ? message[3] : 'request rejected' })
          return
        }
        acknowledged = true
        succeedOrWait()
        return
      }

      if (message[0] === 'EVENT' && typeof message[2] === 'object' && message[2] !== null) {
        const event = message[2] as Event
        if (event.kind === 28938) {
          acceptance = event
          if (acknowledged) {
            finish(accept())
          }
        }
      }
    }

    const onClose = (): void =>
      finish(acknowledged ? accept() : { ok: false, message: 'connection closed before the reply' })
    const onError = (error: Error): void =>
      finish(
        acknowledged ? accept() : { ok: false, message: error instanceof Error ? error.message : 'connection failed' },
      )
    const timer = setTimeout(
      () => finish(acknowledged ? accept() : { ok: false, message: 'timed out waiting for the peer' }),
      timeoutMs,
    )

    socket.on('message', onMessage)
    socket.on('close', onClose)
    socket.on('error', onError)
    socket.send(JSON.stringify(['EVENT', request]))
  })

const acceptancePayload = (event: Event): PeeringAcceptancePayload | undefined => {
  try {
    return JSON.parse(event.content) as PeeringAcceptancePayload
  } catch {
    return undefined
  }
}

export interface RunPeeringRequestOptions {
  relayUrl: string
  ownerKey?: string
  powDifficulty?: number
  json?: boolean
  timeoutMs?: number
}

export interface PeeringRequestDependencies {
  loadSettings?: () => Settings
  fetchAdvertisement?: typeof fetchPeeringAdvertisement
  authenticate?: typeof authenticateToPeeringRelay
  relayPrivateKey?: () => string
  send?: typeof sendPeeringRequest
}

/**
 * Produces and presents the one establishment request. The owner key is only
 * used here; invoices, renewals and event requests never ask for it.
 */
export const runPeeringRequest = async (
  options: RunPeeringRequestOptions,
  dependencies: PeeringRequestDependencies = {},
): Promise<number> => {
  const loadSettings = dependencies.loadSettings ?? loadMergedSettings
  const fetchAdvertisement = dependencies.fetchAdvertisement ?? fetchPeeringAdvertisement
  const authenticate = dependencies.authenticate ?? authenticateToPeeringRelay
  const send = dependencies.send ?? sendPeeringRequest

  const ownerKey = options.ownerKey ?? process.env.PEERING_OWNER_PRIVATE_KEY
  if (!ownerKey || !/^[0-9a-fA-F]{64}$/.test(ownerKey)) {
    throw new Error('set PEERING_OWNER_PRIVATE_KEY or pass --owner-key with a 32-byte hex key')
  }

  const settings = loadSettings()
  if (!settings.info?.relay_url) {
    throw new Error('info.relay_url is required to identify this relay')
  }
  const relayPrivateKey = dependencies.relayPrivateKey ?? (() => getRelayPrivateKey(settings.info.relay_url))

  const advertisement: PeeringAdvertisement = await fetchAdvertisement(options.relayUrl)
  if (!advertisement.enabled) {
    throw new Error('peer does not advertise peering')
  }
  if (!advertisement.self) {
    throw new Error('peer does not advertise its relay pubkey in NIP-11 `self`')
  }

  const relayKey = relayPrivateKey()
  const request = await buildPeeringRequestEvent({
    ownerPrivateKey: ownerKey,
    relayPubkey: getPublicKey(relayKey),
    relayUrl: settings.info.relay_url,
    receiverPubkey: advertisement.self,
    scopes: advertisement.scopes,
    terms: advertisement.terms,
    powDifficulty: options.powDifficulty ?? advertisement.minPowDifficulty ?? 0,
    maxPowAttempts: 50_000_000,
  })

  const connection = await authenticate({
    relayUrl: options.relayUrl,
    privateKey: relayKey,
    timeoutMs: options.timeoutMs,
  })

  let reply: PeeringRequestReply
  try {
    reply = await send(connection.socket, request, options.timeoutMs)
  } finally {
    try {
      connection.socket.close()
    } catch {
      // Already closed by the peer.
    }
  }

  const fail = (message: string): number => {
    if (options.json) {
      process.stderr.write(`${JSON.stringify({ error: { message, code: 1 } })}\n`)
    } else {
      logError(message)
    }
    return 1
  }

  if (!reply.ok) {
    return fail(`peer rejected the peering request: ${reply.message}`)
  }

  if (reply.acceptance) {
    const verified = await verifyPeeringAcceptanceEvent(reply.acceptance.event, request)
    if (verified.ok === false) {
      return fail(`peer returned an invalid acceptance: ${verified.reason}`)
    }
    if (reply.acceptance.event.pubkey.toLowerCase() !== advertisement.self.toLowerCase()) {
      return fail('peer returned an acceptance signed by a different relay key')
    }
  }

  if (options.json) {
    logInfo(
      JSON.stringify(
        {
          request: {
            id: request.id,
            owner_pubkey: request.pubkey,
            relay_pubkey: getPublicKey(relayKey),
            terms_hash: JSON.parse(request.content).terms_hash,
          },
          acceptance: reply.acceptance?.event ?? null,
        },
        null,
        2,
      ),
    )
    return 0
  }

  logInfo(`request:     ${request.id}`)
  logInfo(`owner:       ${request.pubkey}`)
  logInfo(`relay:       ${getPublicKey(relayKey)}`)
  logInfo(
    reply.acceptance
      ? `acceptance:  ${reply.acceptance.event.id}`
      : 'acceptance:  not returned (the request was accepted)',
  )
  return 0
}
