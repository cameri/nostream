import { createLogger } from '../factories/logger-factory'
import { IEventRepository } from '../@types/repositories'
import { IMaintenanceService } from '../@types/services'
import { Settings } from '../@types/settings'

const logger = createLogger('maintenance-service')

export class MaintenanceService implements IMaintenanceService {
  public constructor(
    private readonly eventRepository: IEventRepository,
    private readonly settings: () => Settings,
  ) {}

  public async clearOldEvents(): Promise<void> {
    const currentSettings = this.settings()
    const retention = currentSettings.limits?.event?.retention
    const maxDays = retention?.maxDays

    if (typeof maxDays !== 'number' || isNaN(maxDays) || maxDays <= 0) {
      return
    }

    try {
      logger('purging deleted, expired and old events')
      const deletedCounts = await this.eventRepository.deleteExpiredAndRetained({
        maxDays,
        kindWhitelist: retention?.kind?.whitelist,
        pubkeyWhitelist: retention?.pubkey?.whitelist,
      })
      const totalDeleted = deletedCounts.deleted + deletedCounts.expired + deletedCounts.retained
      if (totalDeleted > 0) {
        logger.info(
          `[Maintenance] Deleted events: deleted=${deletedCounts.deleted}, expired=${deletedCounts.expired}, retained=${deletedCounts.retained}.`,
        )
      }
    } catch (error) {
      logger.error('Unable to purge events. Reason:', error)
    }
  }
}
