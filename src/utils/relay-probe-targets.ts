import { Settings } from '../@types/settings'
import { parseProbeTarget } from './relay-probe'

export const resolveProbeTargets = (settings: Settings): string[] => {
  const configured = settings.nip66?.targets?.map((target) => target.trim()).filter(Boolean) ?? []

  if (configured.length > 0) {
    return configured
  }

  const relayUrl = settings.info?.relay_url?.trim()
  return relayUrl ? [relayUrl] : []
}

export const filterValidProbeTargets = (targets: string[]): { valid: string[]; invalid: string[] } => {
  const valid: string[] = []
  const invalid: string[] = []

  for (const target of targets) {
    try {
      parseProbeTarget(target)
      valid.push(target)
    } catch {
      invalid.push(target)
    }
  }

  return { valid, invalid }
}
