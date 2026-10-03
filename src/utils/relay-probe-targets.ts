import { Settings } from '../@types/settings'
import { parseProbeTarget } from './relay-probe'
import { normalizeRelayUrlForDTag } from './nip66-events'

const addUniqueTarget = (targets: string[], seen: Set<string>, candidate: string | undefined): void => {
  const trimmed = candidate?.trim()

  if (!trimmed) {
    return
  }

  let dedupeKey: string

  try {
    dedupeKey = normalizeRelayUrlForDTag(trimmed)
  } catch {
    dedupeKey = trimmed.toLowerCase()
  }

  if (seen.has(dedupeKey)) {
    return
  }

  seen.add(dedupeKey)
  targets.push(trimmed)
}

export const resolveProbeTargets = (settings: Settings): string[] => {
  const targets: string[] = []
  const seen = new Set<string>()
  const configured = settings.nip66?.targets?.map((target) => target.trim()).filter(Boolean) ?? []

  if (configured.length > 0) {
    for (const target of configured) {
      addUniqueTarget(targets, seen, target)
    }
  } else {
    addUniqueTarget(targets, seen, settings.info?.relay_url)
  }

  for (const mirror of settings.mirroring?.static ?? []) {
    addUniqueTarget(targets, seen, mirror.address)
  }

  return targets
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
