import { Tag } from '../@types/base'
import { StoredProbeResult } from '../@types/relay-probe-snapshot'
import { Nip11Limitation } from './relay-probe/types'

const requirementTag = (name: string, required: boolean | undefined): Tag | undefined => {
  if (required === undefined) {
    return undefined
  }

  return ['R', required ? name : `!${name}`]
}

export const appendNip11DiscoveryTags = (tags: Tag[], result: StoredProbeResult): void => {
  const nip11 = result.nip11.status === 'ok' ? result.nip11.data : undefined

  if (!nip11) {
    return
  }

  for (const nip of nip11.supportedNips ?? []) {
    tags.push(['N', String(nip)])
  }

  const limitation: Nip11Limitation | undefined = nip11.limitation

  const requirementTags = [
    requirementTag('auth', limitation?.authRequired),
    requirementTag('writes', limitation?.restrictedWrites),
    requirementTag('payment', limitation?.paymentRequired),
    requirementTag(
      'pow',
      limitation?.minPowDifficulty === undefined ? undefined : limitation.minPowDifficulty > 0,
    ),
  ].filter((tag): tag is Tag => tag !== undefined)

  tags.push(...requirementTags)

  for (const kind of nip11.acceptedKinds ?? []) {
    tags.push(['k', String(kind)])
  }
}

export const appendWsProbeDiscoveryTags = (tags: Tag[], result: StoredProbeResult): void => {
  const ws = result.wsRtt.status === 'ok' ? result.wsRtt.data : undefined

  if (!ws) {
    return
  }

  if (typeof ws.rttOpenMs === 'number') {
    tags.push(['rtt-open', String(ws.rttOpenMs)])
  }

  if (typeof ws.rttReadMs === 'number') {
    tags.push(['rtt-read', String(ws.rttReadMs)])
  }

  if (typeof ws.rttWriteMs === 'number') {
    tags.push(['rtt-write', String(ws.rttWriteMs)])
  }

  if (ws.nip42AuthRequired === true) {
    tags.push(['R', 'auth'])
  }
}
