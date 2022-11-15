export interface IRateLimiterOptions {
  period: number;
  rate: number;
}

export interface IRateLimiter {
  hit(key: string, step: number, options: IRateLimiterOptions): Promise<boolean>
}
