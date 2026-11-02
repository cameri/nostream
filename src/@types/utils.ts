export interface IRateLimiterOptions {
  period: number
  rate: number
}

/**
 * The outcome of one limiter hit.
 *
 * `retryAfterMs` is an estimate of how long the caller must wait before its
 * next attempt can be accepted, and it is absent when the strategy cannot say
 * so. Absence means "limited, no estimate" — it must never be read as "retry
 * immediately", and the caller decides what to send instead.
 */
export interface IRateLimiterResult {
  limited: boolean
  retryAfterMs?: number
}

export interface IRateLimiter {
  hit(key: string, step: number, options: IRateLimiterOptions): Promise<IRateLimiterResult>
}
