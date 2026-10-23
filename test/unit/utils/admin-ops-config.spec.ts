import { expect } from 'chai'

import { listConfiguredWorkers, mergeWorkerRows } from '../../../src/utils/admin-ops-config'
import { Settings } from '../../../src/@types/settings'
import { ADMIN_OPS_HEARTBEAT_TTL_SECONDS, isAdminOpsHeartbeatStale } from '../../../src/utils/admin-ops-store'

describe('admin-ops-config', () => {
  it('marks unmonitored workers as not stale without a heartbeat', () => {
    const rows = mergeWorkerRows(
      [{ type: 'worker', index: '0', enabled: true, label: 'Client worker 0' }],
      [],
    )

    expect(rows[0].monitored).to.equal(false)
    expect(rows[0].stale).to.equal(false)
  })

  it('marks monitored workers stale when heartbeat is expired', () => {
    const staleUpdatedAt = new Date(Date.now() - (ADMIN_OPS_HEARTBEAT_TTL_SECONDS + 5) * 1000).toISOString()
    const rows = mergeWorkerRows(
      [{ type: 'maintenance', enabled: true, label: 'Maintenance' }],
      [{ type: 'maintenance', updatedAt: staleUpdatedAt }],
    )

    expect(rows[0].monitored).to.equal(true)
    expect(rows[0].stale).to.equal(true)
  })

  it('decides when a heartbeat is stale from the time it was last updated', () => {
    const freshUpdatedAt = new Date().toISOString()

    expect(isAdminOpsHeartbeatStale(freshUpdatedAt, ADMIN_OPS_HEARTBEAT_TTL_SECONDS)).to.equal(false)
  })

  it('no longer lists mirroring workers, even for a mirroring.static that is still configured', () => {
    const workers = listConfiguredWorkers({
      workers: { count: 1 },
      mirroring: { static: [{ address: 'wss://mirror.example' }] },
    } as unknown as Settings)

    expect(workers.map((worker) => worker.type)).to.deep.equal(['worker', 'maintenance'])
  })
})
