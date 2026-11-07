import { Given, Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import { Observable } from 'rxjs'
import WebSocket from 'ws'

import { createEvent, publishEvent } from '../helpers'
import { streams } from '../shared'
import { CommandResult, OutgoingMessage } from '../../../../src/@types/messages'
import { getMasterDbClient } from '../../../../src/database/client'
import { InviteCodeRepository } from '../../../../src/repositories/invite-code-repository'
import { SettingsStatic } from '../../../../src/utils/settings'

const JOIN_REQUEST_KIND = 28934
const AUTH_EVENT_KIND = 22242
const CHALLENGE_TIMEOUT_MS = 3000

const world = (context: World<Record<string, any>>) => context.parameters as Record<string, any>

const dbClient = () => getMasterDbClient()

// The relay sends `["AUTH", <challenge>]` the moment a socket opens, and the
// socket's message stream is a ReplaySubject, so a subscription made inside the
// same scenario still sees it. The timeout turns a missed challenge into a
// failure that names the cause rather than a hung step.
const waitForChallenge = (ws: WebSocket): Promise<string> =>
  new Promise((resolve, reject) => {
    const observable = streams.get(ws) as Observable<OutgoingMessage>
    const timer = setTimeout(() => {
      subscription.unsubscribe()
      reject(new Error('relay did not send an AUTH challenge'))
    }, CHALLENGE_TIMEOUT_MS)

    const subscription = observable.subscribe((message: OutgoingMessage) => {
      if (message[0] === 'AUTH') {
        clearTimeout(timer)
        subscription.unsubscribe()
        resolve(message[1] as string)
      }
    })
  })

const authenticate = async (context: World<Record<string, any>>, name: string): Promise<CommandResult> => {
  const ws = world(context).clients[name] as WebSocket
  const { pubkey, privkey } = world(context).identities[name]

  const challenge = await waitForChallenge(ws)
  const relayUrl = SettingsStatic._settings.info.relay_url

  const event = await createEvent(
    {
      pubkey,
      kind: AUTH_EVENT_KIND,
      tags: [
        ['challenge', challenge],
        ['relay', relayUrl],
      ],
    },
    privkey,
  )

  return publishEvent(ws, event)
}

const sendJoinRequest = async (
  context: World<Record<string, any>>,
  name: string,
  claimCode: string,
): Promise<CommandResult> => {
  const ws = world(context).clients[name] as WebSocket
  const { pubkey, privkey } = world(context).identities[name]

  const event = await createEvent(
    {
      pubkey,
      kind: JOIN_REQUEST_KIND,
      tags: [['claim', claimCode]],
      content: '',
    },
    privkey,
  )

  world(context).events[name].push(event)

  return publishEvent(ws, event)
}

const isAdmitted = async (pubkey: string): Promise<boolean | undefined> => {
  const [row] = await dbClient()('users').where('pubkey', Buffer.from(pubkey, 'hex')).select('is_admitted')

  return row?.is_admitted
}

Given(/an invite code "([^"]+)" with one use/, async (code: string) => {
  const repository = new InviteCodeRepository(dbClient())
  await repository.create(code, { remainingUses: 1 })
})

// The relay answers AUTH with an OK carrying the auth event's id; a failure
// here means the challenge, relay tag or signature was rejected, and the
// message says which.
When(/(\w+) authenticates with the relay/, async function (this: World<Record<string, any>>, name: string) {
  const result = await authenticate(this, name)

  if (result[2] !== true) {
    throw new Error(`authentication failed: ${result[3]}`)
  }
})

When(
  /(\w+) sends a join request claiming "([^"]+)"/,
  async function (this: World<Record<string, any>>, name: string, claimCode: string) {
    world(this).joinRequestResults = world(this).joinRequestResults ?? {}
    world(this).joinRequestResults[name] = await sendJoinRequest(this, name, claimCode)
  },
)

Then(/(\w+) is admitted/, async function (this: World<Record<string, any>>, name: string) {
  const { pubkey } = world(this).identities[name]
  expect(await isAdmitted(pubkey)).to.equal(true)
})

Then(/(\w+) is not admitted/, async function (this: World<Record<string, any>>, name: string) {
  const { pubkey } = world(this).identities[name]
  expect(await isAdmitted(pubkey)).to.not.equal(true)
})

Then(/the join request is accepted/, function (this: World<Record<string, any>>) {
  const [result] = Object.values(world(this).joinRequestResults ?? {}) as CommandResult[]
  expect(result?.[2], result?.[3]).to.equal(true)
})

Then(/the join request is refused with "([^"]+)"/, function (this: World<Record<string, any>>, reason: string) {
  const [result] = Object.values(world(this).joinRequestResults ?? {}) as CommandResult[]
  expect(result?.[2]).to.equal(false)
  expect(result?.[3]).to.equal(reason)
})
