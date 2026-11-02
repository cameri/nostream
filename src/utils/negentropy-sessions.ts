import { INegentropySessions, NegentropySession, NegentropySessionToken } from '../@types/negentropy'
import { SubscriptionId } from '../@types/subscription'

interface Entry {
  token: NegentropySessionToken
  session?: NegentropySession
  idleTimeoutMs?: number
  idleTimer?: NodeJS.Timeout
}

/** The NIP-77 sessions of one websocket connection. Ids are a separate namespace from REQ ids. */
export class NegentropySessions implements INegentropySessions {
  private readonly entries = new Map<SubscriptionId, Entry>()
  // Event reads still running. A replaced request's read is not cancelled, so it stays counted here
  // until it finishes; otherwise repeating NEG-OPEN on one id would stack up unbounded queries.
  private readonly pendingReads = new Set<NegentropySessionToken>()

  public constructor(private readonly onIdleTimeout: (subscriptionId: SubscriptionId) => void) {}

  public reserve(subscriptionId: SubscriptionId, maxLimit: number): NegentropySessionToken | undefined {
    // NIP-77: opening an id that is already open closes the old session first.
    this.close(subscriptionId)

    if (this.entries.size >= maxLimit || this.pendingReads.size >= maxLimit) {
      return undefined
    }

    const token = Symbol(subscriptionId)
    this.entries.set(subscriptionId, { token })
    this.pendingReads.add(token)

    return token
  }

  public endRead(token: NegentropySessionToken): void {
    this.pendingReads.delete(token)
  }

  public isCurrent(subscriptionId: SubscriptionId, token: NegentropySessionToken): boolean {
    return this.entries.get(subscriptionId)?.token === token
  }

  public activate(
    subscriptionId: SubscriptionId,
    token: NegentropySessionToken,
    session: NegentropySession,
    idleTimeoutMs: number,
  ): boolean {
    const entry = this.entries.get(subscriptionId)
    if (!entry || entry.token !== token) {
      return false
    }

    // Activating means the read is over.
    this.pendingReads.delete(token)
    entry.session = session
    entry.idleTimeoutMs = idleTimeoutMs
    this.startIdleTimer(subscriptionId, entry)

    return true
  }

  public touch(subscriptionId: SubscriptionId): NegentropySession | undefined {
    const entry = this.entries.get(subscriptionId)
    if (!entry?.session) {
      return undefined
    }

    this.startIdleTimer(subscriptionId, entry)

    return entry.session
  }

  public release(subscriptionId: SubscriptionId, token: NegentropySessionToken): void {
    if (this.entries.get(subscriptionId)?.token === token) {
      this.close(subscriptionId)
    }
  }

  public close(subscriptionId: SubscriptionId): boolean {
    const entry = this.entries.get(subscriptionId)
    if (!entry) {
      return false
    }

    clearTimeout(entry.idleTimer)
    this.entries.delete(subscriptionId)

    return true
  }

  public closeAll(): void {
    for (const subscriptionId of [...this.entries.keys()]) {
      this.close(subscriptionId)
    }
  }

  public getSessionIds(): SubscriptionId[] {
    return [...this.entries.entries()].filter(([, entry]) => entry.session).map(([subscriptionId]) => subscriptionId)
  }

  private startIdleTimer(subscriptionId: SubscriptionId, entry: Entry): void {
    clearTimeout(entry.idleTimer)
    if (!entry.idleTimeoutMs || entry.idleTimeoutMs <= 0) {
      return
    }

    entry.idleTimer = setTimeout(() => {
      if (this.entries.get(subscriptionId) === entry) {
        this.entries.delete(subscriptionId)
        this.onIdleTimeout(subscriptionId)
      }
    }, entry.idleTimeoutMs)
    // An idle session must never keep the process alive.
    entry.idleTimer.unref()
  }
}
