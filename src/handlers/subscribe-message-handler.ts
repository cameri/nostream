import { anyPass, equals, isNil, map, omit, propSatisfies, uniqWith } from 'ramda'
import { addAbortSignal } from 'stream'
import { pipeline } from 'stream/promises'

import {
  createClosedMessage,
  createEndOfStoredEventsNoticeMessage,
  createNoticeMessage,
  createOutgoingEventMessage,
} from '../utils/messages'
import { createReadAuthorizationGuard, isSubscriptionAuthRequired } from '../utils/nip42'
import { getPublicKey, getRelayPrivateKey, isEventMatchingFilter, isExpiredEvent, toNostrEvent } from '../utils/event'
import { IAbortable, IMessageHandler } from '../@types/message-handlers'
import { IEventRepository, IInviteCodeRepository } from '../@types/repositories'
import { isNip43InviteRequestFilter, isRelaySelfConsistent } from '../utils/nip43'
import { buildInviteCodeEvent, issueInviteCode } from '../utils/nip43-invites'
import { streamEach, streamEnd, streamFilter, streamMap } from '../utils/stream'
import { SubscriptionFilter, SubscriptionId } from '../@types/subscription'
import { createLogger } from '../factories/logger-factory'
import { Event } from '../@types/event'
import { Factory, Pubkey } from '../@types/base'
import { IRateLimiter } from '../@types/utils'
import { IWebSocketAdapter } from '../@types/adapters'
import { Settings } from '../@types/settings'
import { SubscribeMessage } from '../@types/messages'
import { WebSocketAdapterEvent } from '../constants/adapter'

const logger = createLogger('subscribe-message-handler')

export class SubscribeMessageHandler implements IMessageHandler, IAbortable {
  private readonly abortController: AbortController

  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
    private readonly settings: () => Settings,
    private readonly inviteCodeRepository: IInviteCodeRepository,
    private readonly rateLimiter: Factory<IRateLimiter>,
  ) {
    this.abortController = new AbortController()
  }

  public abort(): void {
    this.abortController.abort()
  }

  public async handleMessage(message: SubscribeMessage): Promise<void> {
    const subscriptionId = message[1]
    const rawFilters = uniqWith(equals, message.slice(2)) as SubscriptionFilter[]

    // NIP-50: strip search from filters when disabled so isEventMatchingFilter ignores it
    const nip50Enabled = this.settings()?.nip50?.enabled ?? false
    const filters = nip50Enabled ? rawFilters : rawFilters.map(omit(['search'])) as SubscriptionFilter[]

    const reason = this.canSubscribe(subscriptionId, filters)
    if (reason) {
      logger('subscription %s with %o rejected: %s', subscriptionId, filters, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createNoticeMessage(`Subscription rejected: ${reason}`))
      return
    }

    // NIP-42: close restricted-only subs from unauthenticated clients.
    if (isSubscriptionAuthRequired(this.settings(), filters, () => this.webSocket.getAuthenticatedPubkeys())) {
      logger('subscription %s with %o rejected: auth required', subscriptionId, filters)
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createClosedMessage(subscriptionId, 'auth-required: authentication is required to request these event kinds'),
      )
      return
    }

    this.webSocket.emit(WebSocketAdapterEvent.Subscribe, subscriptionId, filters)

    await this.maybeIssueInviteCode(subscriptionId, filters)

    await this.fetchAndSend(subscriptionId, filters)
  }

  // NIP-43: kind 28935 is never published by a client and never stored. A REQ for
  // it asks the relay to mint an invite code, which we answer with a relay-signed
  // ephemeral event on this socket only. fetchAndSend still runs afterwards: its
  // query returns nothing for 28935 and its EOSE correctly marks the end of
  // *stored* events.
  private async maybeIssueInviteCode(subscriptionId: SubscriptionId, filters: SubscriptionFilter[]): Promise<void> {
    // uniqWith(equals) upstream only collapses identical filters, so
    // [{kinds:[28935]},{kinds:[28935],limit:1}] survives as two. Mint once per REQ.
    if (!filters.some(isNip43InviteRequestFilter)) {
      return
    }

    let event: Event | undefined
    try {
      event = await this.mintInviteCode()
    } catch (error) {
      // A failed mint must not abort the subscription: fall through to EOSE.
      logger('unable to mint an invite code for subscription %s: %o', subscriptionId, error)
      return
    }

    if (!event) {
      return
    }

    // The claim tag is a bearer secret. Emit it on the requesting socket only —
    // never Broadcast, never persisted.
    this.webSocket.emit(WebSocketAdapterEvent.Message, createOutgoingEventMessage(subscriptionId, event))
  }

  private async mintInviteCode(): Promise<Event | undefined> {
    const settings = this.settings()

    if (settings.nip43?.enabled !== true) {
      return
    }

    // NIP-43: relays "must explicitly opt-in to this behavior by generating
    // claims on the fly when requested".
    if (settings.nip43.allowInviteRequests !== true) {
      return
    }

    // Checked after the feature flags so a relay with NIP-43 off cannot be made to
    // log on every probe. Order is irrelevant otherwise: every guard must pass.
    let selfConsistent: boolean | undefined
    try {
      selfConsistent = isRelaySelfConsistent(settings)
    } catch (error) {
      logger('info.self is not a valid pubkey, refusing to issue invite codes: %o', error)
      return
    }

    if (selfConsistent === false) {
      logger('info.self does not match the relay signing pubkey, refusing to issue invite codes')
      return
    }

    // Anonymous clients could otherwise farm codes, so NIP-42 auth is required.
    const authenticatedPubkeys = [...this.webSocket.getAuthenticatedPubkeys()]
    if (!authenticatedPubkeys.length) {
      logger('ignoring invite request from an unauthenticated client')
      return
    }

    // An empty whitelist means "any authenticated pubkey may mint", not "nobody":
    // allowInviteRequests already defaults to false, so an operator who turns the
    // feature on without a whitelist plainly means self-serve invites.
    const whitelist = settings.nip43.inviteRequestWhitelist
    const isWhitelisted = Array.isArray(whitelist) && whitelist.length > 0
    const requester = isWhitelisted
      ? authenticatedPubkeys.find((pubkey) => whitelist.includes(pubkey))
      : authenticatedPubkeys[0]

    if (!requester) {
      logger('ignoring invite request: no authenticated pubkey is on inviteRequestWhitelist')
      return
    }

    if (await this.isInviteRequestRateLimited(requester)) {
      return
    }

    const relayPrivkey = getRelayPrivateKey(settings.info?.relay_url)

    // createdBy is the requester, for an audit trail of who minted what. Note this
    // differs from `nostream invite create`, which records info.self.
    const invite = await issueInviteCode(this.inviteCodeRepository, settings.nip43, { createdBy: requester })

    return buildInviteCodeEvent(relayPrivkey, getPublicKey(relayPrivkey), invite)
  }

  // Each mint writes a row to invite_codes, so this is scoped per pubkey. The
  // generic per-IP message limiter is tuned for ordinary message volume and is
  // not a substitute.
  private async isInviteRequestRateLimited(pubkey: Pubkey): Promise<boolean> {
    const rateLimits = this.settings().limits?.invite?.rateLimits

    if (!Array.isArray(rateLimits) || !rateLimits.length) {
      return false
    }

    const rateLimiter = this.rateLimiter()

    for (const { period, rate } of rateLimits) {
      let isRateLimited: boolean
      try {
        isRateLimited = await rateLimiter.hit(`${pubkey}:invites:${period}`, 1, { period, rate })
      } catch (error) {
        // Fail closed: minting writes to the database, so an unavailable limiter
        // must not leave the gate open.
        logger('rate limiter unavailable for %s (%d/%d): %o', pubkey, rate, period, error)
        return true
      }

      if (isRateLimited) {
        logger('rate limited %s: %d invite requests / %d ms exceeded', pubkey, rate, period)
        return true
      }
    }

    return false
  }

  private async fetchAndSend(subscriptionId: string, filters: SubscriptionFilter[]): Promise<void> {
    logger('fetching events for subscription %s with filters %o', subscriptionId, filters)
    const sendEvent = (event: Event) =>
      this.webSocket.emit(WebSocketAdapterEvent.Message, createOutgoingEventMessage(subscriptionId, event))
    const sendEOSE = () =>
      this.webSocket.emit(WebSocketAdapterEvent.Message, createEndOfStoredEventsNoticeMessage(subscriptionId))
    const isSubscribedToEvent = SubscribeMessageHandler.isClientSubscribedToEvent(filters)
    const isTagUnexpired = (event: Event) => {
      if (isExpiredEvent(event)) {
        return false
      }
      return true
    }

    // NIP-42: drop restricted-kind events the client isn't authorized to read.
    const isReadAuthorized = createReadAuthorizationGuard(
      this.settings(),
      () => this.webSocket.getAuthenticatedPubkeys(),
    )

    const findEvents = this.eventRepository.findByFilters(filters).stream()

    const abortableFindEvents = addAbortSignal(this.abortController.signal, findEvents)

    try {
      await pipeline(
        abortableFindEvents,
        streamFilter(propSatisfies(isNil, 'deleted_at')),
        streamMap(toNostrEvent),
        streamFilter(isTagUnexpired),
        streamFilter(isReadAuthorized),
        streamFilter(isSubscribedToEvent),
        streamEach(sendEvent),
        streamEnd(sendEOSE),
      )
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger('subscription %s aborted: %o', subscriptionId, error)
        findEvents.destroy()
      } else {
        logger('error streaming events: %o', error)
      }
      throw error
    }
  }

  private static isClientSubscribedToEvent(filters: SubscriptionFilter[]): (event: Event) => boolean {
    return anyPass(map(isEventMatchingFilter)(filters))
  }

  private canSubscribe(subscriptionId: SubscriptionId, filters: SubscriptionFilter[]): string | undefined {
    const subscriptions = this.webSocket.getSubscriptions()
    const existingSubscription = subscriptions.get(subscriptionId)
    const subscriptionLimits = this.settings().limits?.client?.subscription

    if (existingSubscription?.length && equals(filters, existingSubscription)) {
      return `Duplicate subscription ${subscriptionId}: Ignoring`
    }

    const maxSubscriptions = subscriptionLimits?.maxSubscriptions ?? 0
    if (maxSubscriptions > 0 && !existingSubscription?.length && subscriptions.size + 1 > maxSubscriptions) {
      return `Too many subscriptions: Number of subscriptions must be less than or equal to ${maxSubscriptions}`
    }

    const maxFilters = subscriptionLimits?.maxFilters ?? 0
    if (maxFilters > 0) {
      if (filters.length > maxFilters) {
        return `Too many filters: Number of filters per susbscription must be less then or equal to ${maxFilters}`
      }
    }

    const maxLimit = subscriptionLimits?.maxLimit ?? 0
    if (maxLimit > 0) {
      const hasExcessiveLimit = filters.some((filter) => filter.limit !== undefined && filter.limit > maxLimit)
      if (hasExcessiveLimit) {
        return `Limit too high: Filter limit must be less than or equal to ${maxLimit}`
      }
    }

    if (
      typeof subscriptionLimits?.maxSubscriptionIdLength === 'number' &&
      subscriptionId.length > subscriptionLimits.maxSubscriptionIdLength
    ) {
      return `Subscription ID too long: Subscription ID must be less or equal to ${subscriptionLimits.maxSubscriptionIdLength}`
    }
  }
}
