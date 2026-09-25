import { IWebSocketAdapter } from '../../@types/adapters'
import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { Report } from '../../@types/report'
import { IEventRepository, IReportRepository } from '../../@types/repositories'
import { IWotGraphService } from '../../@types/services'
import { Settings } from '../../@types/settings'
import { WebSocketAdapterEvent } from '../../constants/adapter'
import { createLogger } from '../../factories/logger-factory'
import { createEventCommandResult } from '../../telemetry/event-metrics'
import { extractReportTargets } from '../../utils/nip56'
import { calculateReportWeight } from '../../utils/report-scoring'

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

      const trustedModerators = nip56.trustedModerators ?? []
      const isTrustedModerator = trustedModerators.includes(event.pubkey)
      // A moderator's weight doesn't depend on distance at all (see
      // calculateReportWeight), so skip the graph lookup entirely for them --
      // it can trigger a full WoT rebuild (Redis/DB reads) for a value that
      // would just be discarded.
      const distance = isTrustedModerator ? undefined : await this.wotGraphService.getDistance(event.pubkey)
      const weight = calculateReportWeight(distance, isTrustedModerator)

      const reports: Omit<Report, 'id' | 'createdAt'>[] = []
      for (const target of extractReportTargets(event.tags)) {
        // A report naming no pubkey/event has nothing to act on -- store the
        // event itself (already done above) but skip the row instead of
        // persisting a dead reports entry.
        if (target.reportedPubkey === null && target.reportedEventId === null) {
          continue
        }

        reports.push({
          eventId: event.id,
          reporterPubkey: event.pubkey,
          reportedPubkey: target.reportedPubkey,
          reportedEventId: target.reportedEventId,
          reportType: target.reportType,
          weight,
          actionable: isTrustedModerator,
        })
      }

      if (reports.length) {
        // One transaction for every target on this event -- a report event
        // producing more than one row (see extractReportTargets) shouldn't be
        // able to leave a partial set behind on a mid-batch failure.
        await this.reportRepository.createMany(reports)
      }
    } catch (error) {
      // Report scoring/recording is best-effort: the report event itself is
      // already stored and broadcast correctly, so a failure here must not
      // surface as a rejection of a valid event.
      logger.error('unable to record report for event %s: %o', event.id, error)
    }
  }
}
