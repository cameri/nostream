const SENSITIVE_SETTING_KEYS = new Set(['passwordHash', 'secret', 'botToken'])

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const isSensitiveSettingsPath = (path: string): boolean => {
  const segments = path.split('.')
  const lastSegment = segments[segments.length - 1] ?? ''
  const key = lastSegment.replace(/\[\d+\]$/, '')

  if (SENSITIVE_SETTING_KEYS.has(key)) {
    return true
  }

  // Webhook URLs embed secrets (Discord/Slack tokens, signed HTTP endpoints).
  if (key === 'url' && path.startsWith('admin.notifications.targets')) {
    return true
  }

  return false
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
  const redactWalk = (value: unknown, path = ''): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry, index) => redactWalk(entry, `${path}[${index}]`))
    }

    if (!isPlainObject(value)) {
      return value
    }

    const result: Record<string, unknown> = {}

    for (const [key, entry] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key
      if (isSensitiveSettingsPath(childPath) && typeof entry === 'string' && entry.length > 0) {
        result[key] = '***'
        continue
      }

      result[key] = redactWalk(entry, childPath)
    }

    return result
  }

  return redactWalk(settings) as T
}
