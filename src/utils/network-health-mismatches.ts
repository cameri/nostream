import { StoredProbeResult } from '../@types/relay-probe-snapshot'
import { normalizeRelayUrlForDTag } from './nip66-events'

export type NetworkHealthMismatchSeverity = 'warning' | 'info'

export interface NetworkHealthMismatch {
  code: string
  severity: NetworkHealthMismatchSeverity
  message: string
}

export interface NetworkHealthMismatchContext {
  configuredRelayUrl?: string
  /** Normalized keys from resolvePublicProbeTargetKeys (publish/probe set). */
  publicTargetKeys?: Set<string>
}

const normalizeRelayUrlOrUndefined = (relayUrl: string | undefined): string | undefined => {
  if (!relayUrl?.trim()) {
    return undefined
  }

  try {
    return normalizeRelayUrlForDTag(relayUrl.trim())
  } catch {
    return undefined
  }
}

export const collectNetworkHealthMismatches = (
  result: StoredProbeResult,
  context: NetworkHealthMismatchContext = {},
): NetworkHealthMismatch[] => {
  const mismatches: NetworkHealthMismatch[] = []
  const nip11 = result.nip11.status === 'ok' ? result.nip11.data : undefined
  const ws = result.wsRtt.status === 'ok' ? result.wsRtt.data : undefined
  const limitation = nip11?.limitation

  if (nip11 && Array.isArray(nip11.supportedNips) && !nip11.supportedNips.includes(66)) {
    mismatches.push({
      code: 'nip66-not-advertised',
      severity: 'warning',
      message: 'NIP-11 supported_nips does not include 66 while this relay publishes NIP-66 monitor data.',
    })
  }

  const configuredKey = normalizeRelayUrlOrUndefined(context.configuredRelayUrl)
  const probedKey = normalizeRelayUrlOrUndefined(result.target.relayUrl)
  const singlePublicTarget =
    context.publicTargetKeys?.size === 1 && configuredKey && context.publicTargetKeys.has(configuredKey)

  if (singlePublicTarget && configuredKey && probedKey && probedKey !== configuredKey) {
    mismatches.push({
      code: 'public-url',
      severity: 'warning',
      message: `Probe target ${result.target.relayUrl} does not match info.relay_url (${context.configuredRelayUrl}).`,
    })
  }

  if (nip11 && ws) {
    const advertisesAuth = limitation?.authRequired === true
    const observedAuth = ws.nip42AuthRequired === true || ws.nip42ChallengeObserved === true

    if (advertisesAuth && !observedAuth) {
      mismatches.push({
        code: 'nip42-not-observed',
        severity: 'warning',
        message: 'NIP-11 advertises auth-required but the WebSocket probe did not observe NIP-42.',
      })
    }

    if (!advertisesAuth && observedAuth) {
      mismatches.push({
        code: 'nip42-not-advertised',
        severity: 'warning',
        message: 'WebSocket probe observed NIP-42 but NIP-11 does not advertise auth-required.',
      })
    }
  }

  if (nip11 && typeof limitation?.minPowDifficulty === 'number' && limitation.minPowDifficulty > 0) {
    mismatches.push({
      code: 'pow-advertised',
      severity: 'info',
      message: `NIP-11 advertises min PoW difficulty ${limitation.minPowDifficulty}; probes do not validate PoW on publish.`,
    })
  }

  if (nip11 && limitation?.paymentRequired === true) {
    mismatches.push({
      code: 'payment-advertised',
      severity: 'info',
      message: 'NIP-11 advertises payment-required; confirm fee/admission settings match operator expectations.',
    })
  }

  return mismatches
}

export const enrichSnapshotWithMismatches = <T extends { results: StoredProbeResult[] }>(
  snapshot: T,
  context: NetworkHealthMismatchContext,
): T & { results: Array<StoredProbeResult & { mismatches: NetworkHealthMismatch[] }> } => {
  return {
    ...snapshot,
    results: snapshot.results.map((result) => ({
      ...result,
      mismatches: collectNetworkHealthMismatches(result, context),
    })),
  }
}
