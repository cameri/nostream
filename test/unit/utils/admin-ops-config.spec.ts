import { expect } from 'chai'

import { mergeMirrorRows, mergeWorkerRows } from '../../../src/utils/admin-ops-config'
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

  it('merges mirror heartbeats and stale state', () => {
    const freshUpdatedAt = new Date().toISOString()
    const rows = mergeMirrorRows([{ index: '0', targetUrl: 'wss://mirror', enabled: true }], [
      {
        index: '0',
        targetUrl: 'wss://mirror',
        connectionState: 'open',
        reconnectCount: 0,
        updatedAt: freshUpdatedAt,
      },
    ])

    expect(rows[0].stale).to.equal(false)
    expect(isAdminOpsHeartbeatStale(freshUpdatedAt, ADMIN_OPS_HEARTBEAT_TTL_SECONDS)).to.equal(false)
  })
})
