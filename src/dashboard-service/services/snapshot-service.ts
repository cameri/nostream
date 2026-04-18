import { KPISnapshot } from '../types'

export class SnapshotService {
  private sequence = 0

  private snapshot: KPISnapshot = {
    sequence: this.sequence,
    generatedAt: new Date(0).toISOString(),
    status: 'placeholder',
    metrics: {
      eventsByKind: [],
      admittedUsers: null,
      satsPaid: null,
      topTalkers: [],
    },
  }

  public getSnapshot(): KPISnapshot {
    return this.snapshot
  }

  // Phase 1 placeholder: advances sequence/time so polling and websocket flow can be validated end-to-end.
  public refreshPlaceholder(): KPISnapshot {
    this.sequence += 1

    this.snapshot = {
      ...this.snapshot,
      sequence: this.sequence,
      generatedAt: new Date().toISOString(),
    }

    return this.snapshot
  }
}
