export enum CacheAdmissionState {
  ADMITTED = 'admitted',
  BLOCKED_NOT_ADMITTED = 'blocked_not_admitted',
  BLOCKED_INSUFFICIENT_BALANCE = 'blocked_insufficient_balance',
}

export const admissionCacheKey = (pubkey: string): string => `${pubkey}:is-admitted`
