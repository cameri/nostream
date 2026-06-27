import os from 'os'

export interface AdminMetricsSnapshot {
  timestamp: number
  eventsPerSecond: number
  acceptedEvents: number
  rejectedEvents: number
  activeConnections: number
  cpuLoadPercent: number
  memoryUsedMb: number
}

export class AdminMetricsCollector {
  private acceptedEvents = 0
  private rejectedEvents = 0
  private readonly activeConnections = new Set<string>()
  private readonly eventTimestamps: number[] = []
  private previousCpuUsage = process.cpuUsage()
  private previousCpuTimeMs = Date.now()

  public recordAcceptedEvent(timestamp: number = Date.now()): void {
    this.acceptedEvents += 1
    this.eventTimestamps.push(timestamp)
    this.pruneEventWindow(timestamp)
  }

  public recordRejectedEvent(timestamp: number = Date.now()): void {
    this.rejectedEvents += 1
    this.eventTimestamps.push(timestamp)
    this.pruneEventWindow(timestamp)
  }

  public openConnection(connectionId: string): void {
    this.activeConnections.add(connectionId)
  }

  public closeConnection(connectionId: string): void {
    this.activeConnections.delete(connectionId)
  }

  public getSnapshot(timestamp: number = Date.now()): AdminMetricsSnapshot {
    this.pruneEventWindow(timestamp)

    return {
      timestamp,
      eventsPerSecond: this.eventTimestamps.length,
      acceptedEvents: this.acceptedEvents,
      rejectedEvents: this.rejectedEvents,
      activeConnections: this.activeConnections.size,
      cpuLoadPercent: this.getCpuLoadPercent(timestamp),
      memoryUsedMb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100,
    }
  }

  private pruneEventWindow(timestamp: number): void {
    const minTimestamp = timestamp - 1000

    while (this.eventTimestamps.length > 0 && this.eventTimestamps[0] <= minTimestamp) {
      this.eventTimestamps.shift()
    }
  }

  private getCpuLoadPercent(timestamp: number): number {
    const elapsedMs = timestamp - this.previousCpuTimeMs
    if (elapsedMs <= 0) {
      return 0
    }

    const cpuDiff = process.cpuUsage(this.previousCpuUsage)
    this.previousCpuUsage = process.cpuUsage()
    this.previousCpuTimeMs = timestamp

    const cpuTotalMs = (cpuDiff.user + cpuDiff.system) / 1000
    const cores = Math.max(os.cpus().length, 1)
    const loadPercent = (cpuTotalMs / (elapsedMs * cores)) * 100

    return Math.round(Math.max(0, Math.min(loadPercent, 100)) * 100) / 100
  }
}
