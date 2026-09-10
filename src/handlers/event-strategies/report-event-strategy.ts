import { createEventCommandResult } from '../../telemetry/event-metrics'
import { createLogger } from '../../factories/logger-factory'
import { calculateReportWeight } from '../../utils/report-scoring'
import { Event } from '../../@types/event'
import { extractReportTarget } from '../../utils/nip56'
import { IEventRepository, IReportRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { IWotGraphService } from '../../@types/services'
import { Settings } from '../../@types/settings'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const logger = createLogger('report-event-strategy')

export class ReportEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
    private readonly reportRepository: IReportRepository,
    private readonly wotGraphService: IWotGraphService,
    private readonly settings: () => Settings,
  ) {}

  public async execute(event: Event): Promise<void> {
    logger('received report event: %o', event)

    const count = await this.eventRepository.create(event)
    this.webSocket.emit(
      WebSocketAdapterEvent.Message,
      createEventCommandResult(event.id, true, count ? '' : 'duplicate:'),
    )

    if (!count) {
      return
    }

    this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)

    try {
      const nip56 = this.settings().nip56
      if (!nip56?.enabled) {
        return
      }

      const { reportedPubkey, reportedEventId, reportType } = extractReportTarget(event.tags)
      const trustedModerators = nip56.trustedModerators ?? []
      const isTrustedModerator = trustedModerators.includes(event.pubkey)
      const distance = await this.wotGraphService.getDistance(event.pubkey)
      const weight = calculateReportWeight(distance, isTrustedModerator)

      await this.reportRepository.create({
        id: event.id,
        reporterPubkey: event.pubkey,
        reportedPubkey,
        reportedEventId,
        reportType,
        weight,
        actionable: isTrustedModerator,
      })
    } catch (error) {
      // Report scoring/recording is best-effort: the report event itself is
      // already stored and broadcast correctly, so a failure here must not
      // surface as a rejection of a valid event.
      logger.error('unable to record report for event %s: %o', event.id, error)
    }
  }
}
