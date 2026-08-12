import { DatabaseClient, Pubkey } from '../@types/base'
import { DBDvmJob, DvmJob, DvmJobStatus } from '../@types/dvm'
import { IDvmJobRepository } from '../@types/repositories'
import { createLogger } from '../factories/logger-factory'
import { fromBuffer, toBuffer } from '../utils/transform'

const logger = createLogger('dvm-job-repository')

function fromDBDvmJob(row: DBDvmJob): DvmJob {
  return {
    id: fromBuffer(row.id),
    requesterPubkey: fromBuffer(row.requester_pubkey),
    kind: row.kind,
    workerIndex: row.worker_index,
    status: row.status,
    resultEventId: row.result_event_id ? fromBuffer(row.result_event_id) : null,
    error: row.error,
    pickedUpAt: row.picked_up_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function affectedRows(result: unknown): number {
  if (typeof result === 'number') {
    return result
  }
  if (result && typeof (result as any).rowCount === 'number') {
    return (result as any).rowCount
  }
  return 0
}

export class DvmJobRepository implements IDvmJobRepository {
  public constructor(private readonly dbClient: DatabaseClient) {}

  public async create(
    id: string,
    requesterPubkey: Pubkey,
    kind: number,
    client: DatabaseClient = this.dbClient,
  ): Promise<DvmJob> {
    logger('create dvm job %s (kind %d) for %s', id, kind, requesterPubkey)

    const now = new Date()
    const row: DBDvmJob = {
      id: toBuffer(id),
      requester_pubkey: toBuffer(requesterPubkey),
      kind,
      worker_index: null,
      status: DvmJobStatus.SUBMITTED,
      result_event_id: null,
      error: null,
      picked_up_at: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    }

    await client<DBDvmJob>('dvm_jobs').insert(row)

    return fromDBDvmJob(row)
  }

  public async findById(id: string, client: DatabaseClient = this.dbClient): Promise<DvmJob | undefined> {
    logger('find dvm job %s', id)

    const [row] = await client<DBDvmJob>('dvm_jobs').where('id', toBuffer(id)).select()

    if (!row) {
      return
    }

    return fromDBDvmJob(row)
  }

  // Atomic pickup: single conditional UPDATE ensures only one worker wins the job
  public async assignWorker(id: string, workerIndex: number, client: DatabaseClient = this.dbClient): Promise<boolean> {
    logger('assign dvm job %s to worker %d', id, workerIndex)

    const now = new Date()

    const result = await client<DBDvmJob>('dvm_jobs')
      .where('id', toBuffer(id))
      .where('status', DvmJobStatus.SUBMITTED)
      .update({
        worker_index: workerIndex,
        status: DvmJobStatus.PICKED_UP,
        picked_up_at: now,
        updated_at: now,
      })

    return affectedRows(result) > 0
  }

  public async updateStatus(
    job: Pick<DvmJob, 'id' | 'status'> & Partial<Pick<DvmJob, 'resultEventId' | 'error'>>,
    client: DatabaseClient = this.dbClient,
  ): Promise<DvmJob | undefined> {
    logger('update dvm job status: %o', job)

    const now = new Date()
    const isTerminal =
      job.status === DvmJobStatus.COMPLETED ||
      job.status === DvmJobStatus.FAILED ||
      job.status === DvmJobStatus.TIMED_OUT

    const update: Partial<DBDvmJob> = {
      status: job.status,
      updated_at: now,
      ...(isTerminal ? { completed_at: now } : {}),
      ...(job.resultEventId ? { result_event_id: toBuffer(job.resultEventId) } : {}),
      ...(job.error ? { error: job.error } : {}),
    }

    const [row] = await client<DBDvmJob>('dvm_jobs').where('id', toBuffer(job.id)).update(update).returning(['*'])

    return row ? fromDBDvmJob(row) : undefined
  }

  public async findPendingJobs(limit = 100, client: DatabaseClient = this.dbClient): Promise<DvmJob[]> {
    logger('find pending dvm jobs (limit %d)', limit)

    const rows = await client<DBDvmJob>('dvm_jobs')
      .whereIn('status', [DvmJobStatus.SUBMITTED, DvmJobStatus.PICKED_UP])
      .orderBy('created_at', 'asc')
      .limit(limit)
      .select()

    return rows.map(fromDBDvmJob)
  }
}
