import { createHmac } from 'crypto'

export function deriveFromSecret(purpose: string | Buffer): Buffer {
    return hmacSha256(process.env.SECRET ?? 'changeme', purpose)
}

export function hmacSha256(secret: string | Buffer, data: string | Buffer): Buffer {
    return createHmac('sha256', secret)
        .update(data)
        .digest()
}
