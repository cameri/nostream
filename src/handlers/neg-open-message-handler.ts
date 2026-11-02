import { IWebSocketAdapter } from '../@types/adapters'
import { createNegErrMessage, createNegMsgMessage } from '../utils/messages'
import { getNip77Limits, isNip77Active, NEGENTROPY_FRAME_SIZE_LIMIT } from '../utils/nip77'
import { INegentropySessions } from '../@types/negentropy'
import { Negentropy, NegentropyStorageVector } from '../utils/negentropy'
import { IEventRepository, ReconciliationItem } from '../@types/repositories'
import { IMessageHandler } from '../@types/message-handlers'
import { NegOpenMessage, OutgoingMessage } from '../@types/messages'
import { Settings } from '../@types/settings'
import { SubscriptionFilter, SubscriptionId } from '../@types/subscription'
import { WebSocketAdapterEvent } from '../constants/adapter'
import { countFilterValues } from '../utils/filter'
import { createLogger } from '../factories/logger-factory'
import { isReconciliationAuthorized } from '../utils/nip42'

const logger = createLogger('neg-open-message-handler')

// Negentropy protocol versions are 0x60-0x6f; anything else is not a negentropy message at all.
const isNegentropyVersionByte = (byte: number | undefined): boolean =>
  byte !== undefined && byte >= 0x60 && byte <= 0x6f

export class NegOpenMessageHandler implements IMessageHandler {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
    private readonly settings: () => Settings,
  ) {}

  public async handleMessage(message: NegOpenMessage): Promise<void> {
    const subscriptionId = message[1]
    const filter = message[2]
    const initialMessage = Buffer.from(message[3], 'hex')

    const settings = this.settings()
    const sessions = this.webSocket.getNegentropySessions()

    if (!isNip77Active(settings)) {
      this.reject(sessions, subscriptionId, 'blocked: NIP-77 is disabled by relay configuration')
      return
    }

    const rejection = this.getRejection(subscriptionId, filter, initialMessage)
    if (rejection) {
      logger('NEG-OPEN %s with %o rejected: %s', subscriptionId, filter, rejection)
      this.reject(sessions, subscriptionId, rejection)
      return
    }

    const { maxEventsPerSession, maxSessionsPerConnection, sessionIdleTimeoutMs } = getNip77Limits(settings)

    const token = sessions.reserve(subscriptionId, maxSessionsPerConnection)
    if (!token) {
      this.reject(
        sessions,
        subscriptionId,
        `blocked: too many negentropy sessions or reads in progress on this connection (max ${maxSessionsPerConnection})`,
      )
      return
    }

    let items: ReconciliationItem[]
    try {
      // One row past the limit tells us the set is too big without loading all of it.
      items = await this.eventRepository.findReconciliationItems(filter, maxEventsPerSession + 1)
    } catch (error) {
      if (sessions.isCurrent(subscriptionId, token)) {
        sessions.release(subscriptionId, token)
        logger('NEG-OPEN %s failed: %o', subscriptionId, error)
        // Keep this generic so internal errors are not leaked to clients.
        this.reply(createNegErrMessage(subscriptionId, 'error: unable to process negentropy request'))
      }
      return
    } finally {
      sessions.endRead(token)
    }

    // The client may have closed or replaced this NEG-OPEN while events were being read. Then the
    // newer request owns the id: say nothing, since an error here would tell the client to drop it.
    if (!sessions.isCurrent(subscriptionId, token)) {
      return
    }

    // Nothing below awaits, so ownership cannot change before the reply.
    if (items.length > maxEventsPerSession) {
      sessions.release(subscriptionId, token)
      this.reply(createNegErrMessage(subscriptionId, 'blocked: this query is too big', maxEventsPerSession))
      return
    }

    try {
      const storage = new NegentropyStorageVector()
      for (const item of items) {
        storage.insert(item.event_created_at, item.event_id)
      }
      storage.seal()

      const negentropy = new Negentropy(storage, NEGENTROPY_FRAME_SIZE_LIMIT)

      let output: Uint8Array
      try {
        output = negentropy.reconcile(initialMessage).output as Uint8Array
      } catch (error) {
        // The only input from the client here is the initial message, so this is its fault.
        sessions.release(subscriptionId, token)
        logger('NEG-OPEN %s sent a malformed negentropy message: %o', subscriptionId, error)
        this.reply(createNegErrMessage(subscriptionId, 'invalid: malformed negentropy message'))
        return
      }

      sessions.activate(subscriptionId, token, { negentropy, filter }, sessionIdleTimeoutMs)
      this.reply(createNegMsgMessage(subscriptionId, Buffer.from(output).toString('hex')))
    } catch (error) {
      sessions.release(subscriptionId, token)
      logger('NEG-OPEN %s failed: %o', subscriptionId, error)
      this.reply(createNegErrMessage(subscriptionId, 'error: unable to process negentropy request'))
    }
  }

  private getRejection(
    subscriptionId: SubscriptionId,
    filter: SubscriptionFilter,
    initialMessage: Buffer,
  ): string | undefined {
    const settings = this.settings()
    const subscriptionLimits = settings.limits?.client?.subscription

    const maxFilterValues = subscriptionLimits?.maxFilterValues ?? 0
    if (maxFilterValues > 0 && countFilterValues(filter) > maxFilterValues) {
      return `blocked: too many filter values (max ${maxFilterValues})`
    }

    if (
      typeof subscriptionLimits?.maxSubscriptionIdLength === 'number' &&
      subscriptionId.length > subscriptionLimits.maxSubscriptionIdLength
    ) {
      return `invalid: subscription id too long (max ${subscriptionLimits.maxSubscriptionIdLength})`
    }

    if (!isNegentropyVersionByte(initialMessage[0])) {
      return 'invalid: malformed negentropy message'
    }

    // NIP-42: reconciling reveals the id of every event the filter matches, so a filter that could
    // match a restricted kind must be scoped to the client's own pubkeys.
    if (!isReconciliationAuthorized(settings, filter, () => this.webSocket.getAuthenticatedPubkeys())) {
      return 'auth-required: authentication is required to sync these event kinds'
    }
  }

  // NIP-77: after a NEG-ERR the subscription is closed, so a rejected NEG-OPEN must also end any
  // session the client already had under that id; otherwise it keeps serving, and holding a slot.
  private reject(sessions: INegentropySessions, subscriptionId: SubscriptionId, reason: string): void {
    sessions.close(subscriptionId)
    this.reply(createNegErrMessage(subscriptionId, reason))
  }

  private reply(message: OutgoingMessage): void {
    this.webSocket.emit(WebSocketAdapterEvent.Message, message)
  }
}
