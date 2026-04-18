import * as secp256k1 from '@noble/secp256k1'
import { After, Given, Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import { createHash } from 'crypto'
import WebSocket from 'ws'

import { Event } from '../../../../src/@types/event'
import { SettingsStatic } from '../../../../src/utils/settings'
import { getEventProofOfWork, getPubkeyProofOfWork } from '../../../../src/utils/event'
import { createEvent, sendEvent } from '../helpers'

type PowMode = 'below' | 'at least'
type Identity = { name: string; privkey: string; pubkey: string }

const MAX_MINING_ATTEMPTS = 200_000

const ensureNip13State = (world: World<Record<string, any>>) => {
  world.parameters.nip13 = world.parameters.nip13 ?? {}
  world.parameters.nip13.results = world.parameters.nip13.results ?? {}
}

const snapshotSettingsIfNeeded = (world: World<Record<string, any>>) => {
  ensureNip13State(world)
  if (!world.parameters.nip13.previousSettings) {
    world.parameters.nip13.previousSettings = structuredClone(SettingsStatic._settings as any)
  }
}

const setPowLimit = (world: World<Record<string, any>>, type: 'eventId' | 'pubkey', bits: number) => {
  snapshotSettingsIfNeeded(world)

  const settings = structuredClone(SettingsStatic._settings as any)
  settings.limits = settings.limits ?? {}
  settings.limits.event = settings.limits.event ?? {}
  settings.limits.event[type] = {
    ...(settings.limits.event[type] ?? {}),
    minLeadingZeroBits: bits,
  }

  SettingsStatic._settings = settings as any
}

const getRequiredBits = (type: 'eventId' | 'pubkey') => {
  return ((SettingsStatic._settings as any)?.limits?.event?.[type]?.minLeadingZeroBits ?? 0) as number
}

const computePubkey = (privkey: string) => {
  return Buffer.from(secp256k1.getPublicKey(privkey, true)).toString('hex').substring(2)
}

const mineIdentityForPow = (name: string, minLeadingZeroBits: number, mode: PowMode): Identity => {
  for (let i = 0; i < MAX_MINING_ATTEMPTS; i++) {
    const privkey = createHash('sha256').update(`nip13:${name}:${mode}:${minLeadingZeroBits}:${i}`).digest('hex')

    try {
      const pubkey = computePubkey(privkey)
      const pow = getPubkeyProofOfWork(pubkey)
      if ((mode === 'below' && pow < minLeadingZeroBits) || (mode === 'at least' && pow >= minLeadingZeroBits)) {
        return { name, privkey, pubkey }
      }
    } catch {
      continue
    }
  }

  throw new Error(`Unable to mine pubkey PoW ${mode} ${minLeadingZeroBits}`)
}

const mineEventForPow = async (
  pubkey: string,
  privkey: string,
  baseContent: string,
  minLeadingZeroBits: number,
  mode: PowMode,
): Promise<{ event: Event; pow: number }> => {
  const createdAt = Math.floor(Date.now() / 1000)

  for (let i = 0; i < MAX_MINING_ATTEMPTS; i++) {
    const event: Event = await createEvent(
      {
        pubkey,
        kind: 1,
        content: baseContent,
        tags: [['nonce', String(i)]],
        created_at: createdAt,
      },
      privkey,
    )

    const pow = getEventProofOfWork(event.id)
    if ((mode === 'below' && pow < minLeadingZeroBits) || (mode === 'at least' && pow >= minLeadingZeroBits)) {
      return { event, pow }
    }
  }

  throw new Error(`Unable to mine event ID PoW ${mode} ${minLeadingZeroBits}`)
}

const storeResult = (world: World<Record<string, any>>, name: string, result: { success: boolean; error?: string }) => {
  ensureNip13State(world)
  world.parameters.nip13.results[name] = result
}

const sendEventExpectFailure = async (ws: WebSocket, event: Event): Promise<string> => {
  try {
    await sendEvent(ws, event, true)
  } catch (error) {
    return (error as Error).message
  }

  throw new Error('Expected event publication to fail, but it succeeded')
}

Given(/^NIP-13 event ID minimum leading zero bits is (\d+)$/, function (this: World<Record<string, any>>, bits: string) {
  setPowLimit(this, 'eventId', Number(bits))
})

Given(/^NIP-13 pubkey minimum leading zero bits is (\d+)$/, function (this: World<Record<string, any>>, bits: string) {
  setPowLimit(this, 'pubkey', Number(bits))
})

When(
  /^(\w+) sends a plain text_note event with content "([^"]+)" and records the command result$/,
  async function (this: World<Record<string, any>>, name: string, content: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const { pubkey, privkey } = this.parameters.identities[name]
    const event: Event = await createEvent({ pubkey, kind: 1, content }, privkey)

    await sendEvent(ws, event, true)
    storeResult(this, name, { success: true })
  },
)

When(
  /^(\w+) sends a text_note event with content "([^"]+)" and event ID PoW (below|at least) the required threshold$/,
  { timeout: 20_000 },
  async function (this: World<Record<string, any>>, name: string, content: string, mode: PowMode) {
    const ws = this.parameters.clients[name] as WebSocket
    const { pubkey, privkey } = this.parameters.identities[name]
    const requiredBits = getRequiredBits('eventId')

    const { event, pow } = await mineEventForPow(pubkey, privkey, content, requiredBits, mode)
    const expectedReason = `pow: difficulty ${pow}<${requiredBits}`
    this.parameters.nip13.expectedEventIdReason = expectedReason

    if (mode === 'below') {
      const error = await sendEventExpectFailure(ws, event)
      storeResult(this, name, { success: false, error })
      return
    }

    await sendEvent(ws, event, true)
    storeResult(this, name, { success: true })
  },
)

When(
  /^(\w+) sends a text_note event with content "([^"]+)" and pubkey PoW (below|at least) the required threshold$/,
  { timeout: 20_000 },
  async function (this: World<Record<string, any>>, name: string, content: string, mode: PowMode) {
    const ws = this.parameters.clients[name] as WebSocket
    const requiredBits = getRequiredBits('pubkey')

    const identity = mineIdentityForPow(name, requiredBits, mode)
    this.parameters.identities[name] = identity

    const event: Event = await createEvent({ pubkey: identity.pubkey, kind: 1, content }, identity.privkey)
    const pubkeyPow = getPubkeyProofOfWork(identity.pubkey)
    const expectedReason = `pow: pubkey difficulty ${pubkeyPow}<${requiredBits}`
    this.parameters.nip13.expectedPubkeyReason = expectedReason

    if (mode === 'below') {
      const error = await sendEventExpectFailure(ws, event)
      storeResult(this, name, { success: false, error })
      return
    }

    await sendEvent(ws, event, true)
    storeResult(this, name, { success: true })
  },
)

Then(/^(\w+) receives a successful NIP-13 command result$/, function (this: World<Record<string, any>>, name: string) {
  const result = this.parameters.nip13.results[name] as { success: boolean; error?: string }
  expect(result.success).to.equal(true)
  expect(result.error).to.be.undefined
})

Then(/^(\w+) receives an unsuccessful NIP-13 event ID PoW result$/, function (this: World<Record<string, any>>, name: string) {
  const result = this.parameters.nip13.results[name] as { success: boolean; error?: string }

  expect(result.success).to.equal(false)
  expect(result.error).to.equal(this.parameters.nip13.expectedEventIdReason)
})

Then(/^(\w+) receives an unsuccessful NIP-13 pubkey PoW result$/, function (this: World<Record<string, any>>, name: string) {
  const result = this.parameters.nip13.results[name] as { success: boolean; error?: string }

  expect(result.success).to.equal(false)
  expect(result.error).to.equal(this.parameters.nip13.expectedPubkeyReason)
})

After({ tags: '@nip13' }, function (this: World<Record<string, any>>) {
  const previousSettings = this.parameters.nip13?.previousSettings
  if (previousSettings) {
    SettingsStatic._settings = previousSettings
  }

  this.parameters.nip13 = undefined
})
