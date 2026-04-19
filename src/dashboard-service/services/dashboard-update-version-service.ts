import { createLogger } from '../../factories/logger-factory'
import { DatabaseClient } from '../../@types/base'

const debug = createLogger('dashboard-service:update-version')

interface IDashboardStateRow {
  revision: string | number
}

export class DashboardUpdateVersionService {
  private disabled = false

  public constructor(private readonly dbClient: DatabaseClient) { }

  public async getCurrentVersion(): Promise<string | undefined> {
    if (this.disabled) {
      return
    }

    try {
      const row = await this.dbClient<IDashboardStateRow>('dashboard_state')
        .select('revision')
        .where('id', 1)
        .first()

      return typeof row === 'undefined' ? '0' : String(row.revision)
    } catch (error) {
      this.disabled = true
      console.error('dashboard-service: dashboard revision lookup unavailable, falling back to full polling', error)
      debug('dashboard revision lookup disabled after query failure')
      return
    }
  }
}
