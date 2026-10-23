export class RelayBroadcastDeduplicator {
  private readonly seen = new Map<string, number>()

  public constructor(private readonly ttlMs = 120_000) {}

  public has(eventId: string): boolean {
    this.prune()
    const expiresAt = this.seen.get(eventId)
    return expiresAt !== undefined && expiresAt > Date.now()
  }

  public mark(eventId: string): void {
    this.prune()
    this.seen.set(eventId, Date.now() + this.ttlMs)
  }

  private prune(): void {
    const now = Date.now()
    for (const [eventId, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(eventId)
      }
    }
  }
}
