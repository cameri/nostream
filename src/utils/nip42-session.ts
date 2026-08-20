import { randomBytes } from 'crypto'

import { Pubkey } from '../@types/base'

export interface Nip42Session {
  pubkey: Pubkey
  authenticatedAt: number
}

/**
 * Per-connection NIP-42 session state.
 *
 * Auth is connection-scoped (per the NIP): one challenge per socket, successful
 * AUTH messages add pubkeys, and the session ends when the socket closes.
 * Optional TTL can force re-AUTH after a configured lifetime (off by default).
 *
 * Accepted AUTH event IDs are remembered for the connection so the same signed
 * AUTH event cannot be replayed to refresh sessionExpirySeconds.
 */
export class Nip42SessionManager {
  private challenge: string
  private readonly sessions = new Map<string, Nip42Session>()
  private readonly acceptedAuthEventIds = new Set<string>()

  public constructor(private readonly getSessionTtlSeconds: () => number | undefined = () => undefined) {
    this.challenge = Nip42SessionManager.createChallenge()
  }

  public static createChallenge(): string {
    return randomBytes(32).toString('base64url')
  }

  public getChallenge(): string {
    return this.challenge
  }

  /** Replace the active challenge. Only call when intentionally issuing a new AUTH. */
  public rotateChallenge(): string {
    this.challenge = Nip42SessionManager.createChallenge()
    return this.challenge
  }

  /**
   * Record a successful AUTH. Returns false if this AUTH event id was already
   * accepted on this socket (replay).
   */
  public authenticate(pubkey: Pubkey, authEventId: string, now = Math.floor(Date.now() / 1000)): boolean {
    if (this.acceptedAuthEventIds.has(authEventId)) {
      return false
    }

    this.acceptedAuthEventIds.add(authEventId)
    this.sessions.set(pubkey, { pubkey, authenticatedAt: now })
    return true
  }

  public clear(pubkey?: Pubkey): void {
    if (typeof pubkey === 'undefined') {
      this.sessions.clear()
      this.acceptedAuthEventIds.clear()
      return
    }
    this.sessions.delete(pubkey)
  }

  public getSession(pubkey: Pubkey, now = Math.floor(Date.now() / 1000)): Nip42Session | undefined {
    this.pruneExpired(now)
    return this.sessions.get(pubkey)
  }

  public getAuthenticatedPubkeys(now = Math.floor(Date.now() / 1000)): ReadonlySet<Pubkey> {
    this.pruneExpired(now)
    return new Set(this.sessions.keys())
  }

  public isAuthenticated(pubkey: Pubkey, now = Math.floor(Date.now() / 1000)): boolean {
    return typeof this.getSession(pubkey, now) !== 'undefined'
  }

  private pruneExpired(now: number): void {
    const ttl = this.getSessionTtlSeconds()
    if (!ttl || ttl <= 0) {
      return
    }

    for (const [pubkey, session] of this.sessions) {
      if (now - session.authenticatedAt >= ttl) {
        this.sessions.delete(pubkey)
      }
    }
  }
}
