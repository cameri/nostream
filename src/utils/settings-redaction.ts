const SENSITIVE_SETTING_KEYS = new Set(['passwordHash', 'secret'])

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const isSensitiveSettingsPath = (path: string): boolean => {
  const segments = path.split('.')
  const lastSegment = segments[segments.length - 1] ?? ''
  const key = lastSegment.replace(/\[\d+\]$/, '')

  return SENSITIVE_SETTING_KEYS.has(key)
}

export const isWriteProtectedSettingsPath = (path: string): boolean => {
  return path === 'admin.passwordHash' || path.endsWith('.passwordHash')
}

export const redactSettingsValue = (path: string, value: unknown): unknown => {
  if (isSensitiveSettingsPath(path) && typeof value === 'string' && value.length > 0) {
    return '***'
  }

  return value
}

export const redactSettingsSecrets = <T>(settings: T): T => {
  const redactWalk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(redactWalk)
    }

    if (!isPlainObject(value)) {
      return value
    }

    const result: Record<string, unknown> = {}

    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_SETTING_KEYS.has(key) && typeof entry === 'string' && entry.length > 0) {
        result[key] = '***'
        continue
      }

      result[key] = redactWalk(entry)
    }

    return result
  }

  return redactWalk(settings) as T
}
