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

// Every write-protected value in a settings document, by its path. A request names the path it writes, but a path
// above a protected value (replacing `admin`, which holds `admin.passwordHash`) writes it too, so what is protected
// has to be compared in the document as it would be saved, not only in the paths of the request.
export const collectWriteProtectedSettings = (settings: unknown, path = ''): Record<string, unknown> => {
  const found: Record<string, unknown> = {}

  if (Array.isArray(settings)) {
    settings.forEach((entry, index) => {
      Object.assign(found, collectWriteProtectedSettings(entry, `${path}[${index}]`))
    })
    return found
  }

  if (!isPlainObject(settings)) {
    return found
  }

  for (const [key, value] of Object.entries(settings)) {
    const childPath = path ? `${path}.${key}` : key
    if (isWriteProtectedSettingsPath(childPath)) {
      found[childPath] = value
    } else {
      Object.assign(found, collectWriteProtectedSettings(value, childPath))
    }
  }

  return found
}

/** The write-protected paths whose value differs between two settings documents, added or removed ones included. */
export const changedWriteProtectedSettingsPaths = (before: unknown, after: unknown): string[] => {
  const protectedBefore = collectWriteProtectedSettings(before)
  const protectedAfter = collectWriteProtectedSettings(after)
  const paths = new Set([...Object.keys(protectedBefore), ...Object.keys(protectedAfter)])

  return [...paths].filter((path) => protectedBefore[path] !== protectedAfter[path]).sort()
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
