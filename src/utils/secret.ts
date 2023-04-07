import { createHmac } from 'crypto'

export function deriveFromSecret(purpose: string | Buffer): Buffer {
  if (!process.env.SECRET) {
    throw new Error('SECRET environment variable not set')
  }

  return hmacSha256(process.env.SECRET, purpose)
}

export function hmacSha256(secret: string | Buffer, data: string | Buffer): Buffer {
  return createHmac('sha256', secret)
    .update(data)
    .digest()
}
