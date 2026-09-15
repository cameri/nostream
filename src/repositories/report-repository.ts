import { DatabaseClient, EventId } from '../@types/base'
import { DBReport, Report } from '../@types/report'
import { IReportRepository } from '../@types/repositories'
import { createLogger } from '../factories/logger-factory'
import { fromBuffer, toBuffer } from '../utils/transform'

const logger = createLogger('report-repository')

function fromDBReport(row: DBReport): Report {
  return {
    id: row.id,
    eventId: fromBuffer(row.event_id),
    reporterPubkey: fromBuffer(row.reporter_pubkey),
    reportedPubkey: row.reported_pubkey ? fromBuffer(row.reported_pubkey) : null,
    reportedEventId: row.reported_event_id ? fromBuffer(row.reported_event_id) : null,
    reportType: row.report_type,
    weight: row.weight,
    actionable: row.actionable,
    createdAt: row.created_at,
  }
}

export class ReportRepository implements IReportRepository {
  public constructor(private readonly dbClient: DatabaseClient) {}

  public async create(
    report: Omit<Report, 'id' | 'createdAt'>,
    client: DatabaseClient = this.dbClient,
  ): Promise<Report> {
    logger(
      'create report for event %s from %s (weight %d, actionable %s)',
      report.eventId,
      report.reporterPubkey,
      report.weight,
      report.actionable,
    )

    const now = new Date()
    const row: Omit<DBReport, 'id'> = {
      event_id: toBuffer(report.eventId),
      reporter_pubkey: toBuffer(report.reporterPubkey),
      reported_pubkey: report.reportedPubkey ? toBuffer(report.reportedPubkey) : null,
      reported_event_id: report.reportedEventId ? toBuffer(report.reportedEventId) : null,
      report_type: report.reportType,
      weight: report.weight,
      actionable: report.actionable,
      created_at: now,
    }

    const [inserted] = await client<DBReport>('reports').insert(row).returning(['id'])

    return fromDBReport({ ...row, id: inserted.id })
  }

  public async findByEventId(eventId: EventId, client: DatabaseClient = this.dbClient): Promise<Report[]> {
    logger('find reports for event %s', eventId)

    const rows = await client<DBReport>('reports').where('event_id', toBuffer(eventId)).select()

    return rows.map(fromDBReport)
  }

  public async findActionable(limit = 100, client: DatabaseClient = this.dbClient): Promise<Report[]> {
    logger('find actionable reports (limit %d)', limit)

    const rows = await client<DBReport>('reports')
      .where('actionable', true)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .select()

    return rows.map(fromDBReport)
  }
}
