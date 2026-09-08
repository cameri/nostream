import { ICacheAdapter } from '../@types/adapters'
import { Event, ParameterizedReplaceableEvent, UnidentifiedEvent } from '../@types/event'
import { RelayProbeRunSnapshot } from '../@types/relay-probe-snapshot'
import { IEventRepository } from '../@types/repositories'
import { Settings } from '../@types/settings'
import { EventDeduplicationMetadataKey, EventTags } from '../constants/base'
import { createLogger } from '../factories/logger-factory'
import { broadcastEvent, getPublicKey, identifyEvent, isParameterizedReplaceableEvent, signEvent } from '../utils/event'
import { getMonitorPrivateKey } from '../utils/monitor-identity'
import {
  buildMonitorAnnouncementEvent,
  buildMonitorProfileEvent,
  buildMonitorRelayListEvent,
  buildRelayDiscoveryEvent,
} from '../utils/nip66-events'
import { resolveProbeTargets } from '../utils/relay-probe-targets'

const logger = createLogger('nip66-event-publisher')

export const NIP66_MONITOR_BOOTSTRAPPED_KEY = 'nip66:monitor:bootstrapped'
export const NIP66_MONITOR_BOOTSTRAP_TTL_SECONDS = 30 * 24 * 60 * 60

export interface INip66EventPublisher {
  publishAfterProbe(snapshot: RelayProbeRunSnapshot, settings: Settings): Promise<void>
}

export class Nip66EventPublisher implements INip66EventPublisher {
  public constructor(
    private readonly eventRepository: IEventRepository,
    private readonly cache: ICacheAdapter,
  ) {}

  public async publishAfterProbe(snapshot: RelayProbeRunSnapshot, settings: Settings): Promise<void> {
    const privkey = getMonitorPrivateKey()

    if (!privkey) {
      logger.warn('MONITOR_PRIVATE_KEY is not configured; skipping NIP-66 event publish')
      return
    }

    const monitorPubkey = getPublicKey(privkey)
    const createdAt = Math.floor(Date.now() / 1000)

    await this.ensureBootstrap(monitorPubkey, settings, privkey, createdAt)

    await this.persistSignedEvent(buildMonitorAnnouncementEvent(settings, monitorPubkey, createdAt), privkey)

    for (const result of snapshot.results) {
      await this.persistSignedEvent(buildRelayDiscoveryEvent(result, monitorPubkey, createdAt), privkey)
    }

    logger('published NIP-66 events for %d probe target(s)', snapshot.results.length)
  }

  private async ensureBootstrap(
    monitorPubkey: string,
    settings: Settings,
    privkey: string,
    createdAt: number,
  ): Promise<void> {
    const bootstrapped = await this.cache.getKey(NIP66_MONITOR_BOOTSTRAPPED_KEY)

    if (bootstrapped) {
      return
    }

    const relayUrl = settings.info?.relay_url?.trim() || resolveProbeTargets(settings)[0]

    if (!relayUrl) {
      logger.warn('no relay URL available for NIP-66 bootstrap relay list; skipping kind 10002 publish')
      return
    }

    await this.persistSignedEvent(buildMonitorProfileEvent(monitorPubkey, createdAt), privkey)
    await this.persistSignedEvent(buildMonitorRelayListEvent(relayUrl, monitorPubkey, createdAt), privkey)

    await this.cache.setKey(NIP66_MONITOR_BOOTSTRAPPED_KEY, monitorPubkey, NIP66_MONITOR_BOOTSTRAP_TTL_SECONDS)
    logger('bootstrapped NIP-66 monitor identity for pubkey %s', monitorPubkey)
  }

  private async persistSignedEvent(unsigned: UnidentifiedEvent, privkey: string): Promise<void> {
    const signed = await signEvent(privkey)(await identifyEvent(unsigned))
    let count: number

    if (isParameterizedReplaceableEvent(signed)) {
      const [, deduplication] = signed.tags.find((tag) => tag.length >= 2 && tag[0] === EventTags.Deduplication) ?? [
        null,
        '',
      ]

      count = await this.eventRepository.upsert({
        ...signed,
        [EventDeduplicationMetadataKey]: deduplication ? [deduplication] : [''],
      } as ParameterizedReplaceableEvent)
    } else {
      count = await this.eventRepository.upsert(signed as Event)
    }

    if (count) {
      await broadcastEvent(signed)
    }
  }
}
