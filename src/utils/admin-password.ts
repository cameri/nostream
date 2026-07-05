import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'

const SCRYPT_PREFIX = 'scrypt'

export const hashAdminPassword = (password: string): string => {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `${SCRYPT_PREFIX}:${salt.toString('base64')}:${hash.toString('base64')}`
}

export const verifyAdminPasswordHash = (password: string, storedHash: string): boolean => {
  const parts = storedHash.split(':')
  if (parts.length !== 3 || parts[0] !== SCRYPT_PREFIX) {
    return false
  }

  const [, saltB64, hashB64] = parts
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(hashB64, 'base64')
  const actual = scryptSync(password, salt, expected.length)

  if (expected.length !== actual.length) {
    return false
  }

  return timingSafeEqual(expected, actual)
}

export const verifyPlaintextPassword = (password: string, expectedPassword: string): boolean => {
  const expected = Buffer.from(expectedPassword, 'utf8')
  const actual = Buffer.from(password, 'utf8')

  if (expected.length !== actual.length) {
    return false
  }

  return timingSafeEqual(expected, actual)
}
