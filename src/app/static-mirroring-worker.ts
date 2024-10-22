import { anyPass, map, mergeDeepRight, path } from 'ramda'
import { RawData, WebSocket } from 'ws'
import cluster from 'cluster'
import { randomUUID } from 'crypto'

import { createRelayedEventMessage, createSubscriptionMessage } from '../utils/messages'
import { EventLimits, FeeSchedule, Mirror, Settings } from '../@types/settings'
import { getEventExpiration, getEventProofOfWork, getPubkeyProofOfWork, getPublicKey, getRelayPrivateKey, isEventIdValid, isEventKindOrRangeMatch, isEventMatchingFilter, isEventSignatureValid, isExpiredEvent } from '../utils/event'
import { IEventRepository, IUserRepository } from '../@types/repositories'
import { createLogger } from '../factories/logger-factory'
import { Event } from '../@types/event'
import { EventExpirationTimeMetadataKey } from '../constants/base'
import { IRunnable } from '../@types/base'
import { OutgoingEventMessage } from '../@types/messages'
import { RelayedEvent } from '../@types/event'
import { WebSocketServerAdapterEvent } from '../constants/adapter'

const debug = createLogger('static-mirror-worker')

export class StaticMirroringWorker implements IRunnable {
  private client: WebSocket | undefined
  private config: Mirror

  public constructor(
    private readonly eventRepository: IEventRepository,
    private readonly userRepository: IUserRepository,
    private readonly process: NodeJS.Process,
    private readonly settings: () => Settings,
  ) {
    this.process
      .on('message', this.onMessage.bind(this))
      .on('SIGINT', this.onExit.bind(this))
      .on('SIGHUP', this.onExit.bind(this))
      .on('SIGTERM', this.onExit.bind(this))
      .on('uncaughtException', this.onError.bind(this))
      .on('unhandledRejection', this.onError.bind(this))
  }

  public run(): void {
    const currentSettings = this.settings()

    console.log('mirroring', currentSettings.mirroring)

    this.config = path(['mirroring', 'static', process.env.MIRROR_INDEX], currentSettings) as Mirror

    let since = Math.floor(Date.now() / 1000) - 60*10

    const createMirror = (config: Mirror) => {
      const subscriptionId = `mirror-${randomUUID()}`

      debug('connecting to %s', config.address)

      return new WebSocket(config.address, { timeout: 5000 })
        .on('open', function () {
          debug('connected to %s', config.address)

          if (Array.isArray(config.filters) && config.filters?.length) {
            const filters = config.filters.map((filter) => ({ ...filter, since }))

            debug('subscribing with %s: %o', subscriptionId, filters)

            this.send(JSON.stringify(createSubscriptionMessage(subscriptionId, filters)))
          }
        })
        .on('message', async (raw: RawData) => {
          try {
            const message = JSON.parse(raw.toString('utf8')) as OutgoingEventMessage

            if (!Array.isArray(message)) {
              return
            }

            if (message[0] !== 'EVENT' || message[1] !== subscriptionId) {
              debug('%s >> local: %o', config.address, message)
              return
            }

            let event = message[2]

            if (!anyPass(map(isEventMatchingFilter, config.filters))(event)) {
              return
            }

            if (!await isEventIdValid(event) || !await isEventSignatureValid(event)) {
              return
            }

            if (isExpiredEvent(event)) {
              return
            }

            const eventExpiration = getEventExpiration(event)
            if (eventExpiration) {
              event = {
                ...event,
                [EventExpirationTimeMetadataKey]: eventExpiration,
              } as any
            }

            if (!this.canAcceptEvent(event)) {
              return
            }

            if (!await this.isUserAdmitted(event)) {
              return
            }

            since = Math.floor(Date.now() / 1000) - 30

            debug('%s >> local: %s', config.address, event.id)

            const inserted = await this.eventRepository.create(event)

            if (inserted && cluster.isWorker && typeof process.send === 'function') {

              process.send({
                eventName: WebSocketServerAdapterEvent.Broadcast,
                event,
                source: config.address,
              })
            }
          } catch (error) {
            debug('unable to process message: %o', error)
          }
        })
        .on('close', (code, reason) => {
          debug(`disconnected (${code}): ${reason.toString()}`)

          setTimeout(() => {
            this.client.removeAllListeners()
            this.client = createMirror(config)
          }, 5000)
        })
        .on('error', function (error) {
          debug('connection error: %o', error)
        })
    }

    this.client = createMirror(this.config)
  }

  private getRelayPublicKey(): string {
    const relayPrivkey = getRelayPrivateKey(this.settings().info.relay_url)
    return getPublicKey(relayPrivkey)
  }

  private canAcceptEvent(event: Event): boolean {
    if (this.getRelayPublicKey() === event.pubkey) {
      debug(`event ${event.id} not accepted: pubkey is relay pubkey`)
      return false
    }

    const now = Math.floor(Date.now() / 1000)

    const eventLimits = this.settings().limits?.event ?? {}

    const eventLimitOverrides = this.config.limits.event ?? {}

    const limits = mergeDeepRight(eventLimits, eventLimitOverrides) as EventLimits

    if (Array.isArray(limits.content)) {
      for (const limit of limits.content) {
        if (
          typeof limit.maxLength !== 'undefined'
          && limit.maxLength > 0
          && event.content.length > limit.maxLength
          && (
            !Array.isArray(limit.kinds)
            || limit.kinds.some(isEventKindOrRangeMatch(event))
          )
        ) {
          debug(`event ${event.id} not accepted: content is longer than ${limit.maxLength} bytes`)
          return false
        }
      }
    } else if (
      typeof limits.content?.maxLength !== 'undefined'
      && limits.content?.maxLength > 0
      && event.content.length > limits.content.maxLength
      && (
        !Array.isArray(limits.content.kinds)
        || limits.content.kinds.some(isEventKindOrRangeMatch(event))
      )
    ) {
      debug(`event ${event.id} not accepted: content is longer than ${limits.content.maxLength} bytes`)
      return false
    }

    if (
      typeof limits.createdAt?.maxPositiveDelta !== 'undefined'
      && limits.createdAt.maxPositiveDelta > 0
      && event.created_at > now + limits.createdAt.maxPositiveDelta) {
      debug(`event ${event.id} not accepted: created_at is more than ${limits.createdAt.maxPositiveDelta} seconds in the future`)
      return false
    }

    if (
      typeof limits.createdAt?.maxNegativeDelta !== 'undefined'
      && limits.createdAt.maxNegativeDelta > 0
      && event.created_at < now - limits.createdAt.maxNegativeDelta) {
      debug(`event ${event.id} not accepted: created_at is more than ${limits.createdAt.maxNegativeDelta} seconds in the past`)
      return false
    }

    if (
      typeof limits.eventId?.minLeadingZeroBits !== 'undefined'
      && limits.eventId.minLeadingZeroBits > 0
    ) {
      const pow = getEventProofOfWork(event.id)
      if (pow < limits.eventId.minLeadingZeroBits) {
        debug(`event ${event.id} not accepted: pow difficulty ${pow}<${limits.eventId.minLeadingZeroBits}`)
        return false
      }
    }

    if (
      typeof limits.pubkey?.minLeadingZeroBits !== 'undefined'
      && limits.pubkey.minLeadingZeroBits > 0
    ) {
      const pow = getPubkeyProofOfWork(event.pubkey)
      if (pow < limits.pubkey.minLeadingZeroBits) {
        debug(`event ${event.id} not accepted: pow pubkey difficulty ${pow}<${limits.pubkey.minLeadingZeroBits}`)
        return false
      }
    }

    if (
      typeof limits.pubkey?.whitelist !== 'undefined'
      && limits.pubkey.whitelist.length > 0
      && !limits.pubkey.whitelist.some((prefix) => event.pubkey.startsWith(prefix))
    ) {
      debug(`event ${event.id} not accepted: pubkey not allowed: ${event.pubkey}`)
      return false
    }

    if (
      typeof limits.pubkey?.blacklist !== 'undefined'
      && limits.pubkey.blacklist.length > 0
      && limits.pubkey.blacklist.some((prefix) => event.pubkey.startsWith(prefix))
    ) {
      debug(`event ${event.id} not accepted: pubkey not allowed: ${event.pubkey}`)
      return false
    }

    if (
      typeof limits.kind?.whitelist !== 'undefined'
      && limits.kind.whitelist.length > 0
      && !limits.kind.whitelist.some(isEventKindOrRangeMatch(event))) {
      debug(`blocked: event kind ${event.kind} not allowed`)
      return false
    }

    if (
      typeof limits.kind?.blacklist !== 'undefined'
      && limits.kind.blacklist.length > 0
      && limits.kind.blacklist.some(isEventKindOrRangeMatch(event))) {
      debug(`blocked: event kind ${event.kind} not allowed`)
      return false
    }

    return true
  }

  protected async isUserAdmitted(event: Event): Promise<boolean> {
    const currentSettings = this.settings()

    if (this.config.skipAdmissionCheck === true) {
      return true
    }

    if (currentSettings.payments?.enabled !== true) {
      return true
    }

    const isApplicableFee = (feeSchedule: FeeSchedule) =>
      feeSchedule.enabled
      && !feeSchedule.whitelists?.pubkeys?.some((prefix) => event.pubkey.startsWith(prefix))
      && !feeSchedule.whitelists?.event_kinds?.some(isEventKindOrRangeMatch(event))

    const feeSchedules = currentSettings.payments?.feeSchedules?.admission?.filter(isApplicableFee)

    if (!Array.isArray(feeSchedules) || !feeSchedules.length) {
      return true
    }

    const user = await this.userRepository.findByPubkey(event.pubkey)
    if (user?.isAdmitted !== true) {
      debug(`user not admitted: ${event.pubkey}`)
      return false
    }

    const minBalance = currentSettings.limits?.event?.pubkey?.minBalance
    if (minBalance && user.balance < minBalance) {
      debug(`user not admitted: user balance ${user.balance} < ${minBalance}`)
      return false
    }

    return true
  }

  private onMessage(message: { eventName: string, event: unknown, source: string }): void {
    if (
      message.eventName !== WebSocketServerAdapterEvent.Broadcast
      || message.source === this.config.address
      || !this.client
      || this.client.readyState !== WebSocket.OPEN
    ) {
      return
    }

    const event = message.event as RelayedEvent

    const eventToRelay = createRelayedEventMessage(event, this.config.secret)
    const outboundMessage = JSON.stringify(eventToRelay)
    debug('%s >> %s: %s', message.source ?? 'local', this.config.address, outboundMessage)
    this.client.send(outboundMessage)
  }

  private onError(error: Error) {
    debug('error: %o', error)
    throw error
  }

  private onExit() {
    debug('exiting')
    this.close(() => {
      this.process.exit(0)
    })
  }

  public close(callback?: () => void) {
    debug('closing')
    if (this.client) {
      this.client.terminate()
    }
    if (typeof callback === 'function') {
      callback()
    }
  }
}
