import { After, Before, Given, Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import { assocPath } from 'ramda'
import { filter, firstValueFrom, map, Observable, throwError, timeout } from 'rxjs'
import WebSocket from 'ws'

import { createEvent, publishEvent } from '../helpers'
import { streams } from '../shared'
import { CommandResult, MessageType, OutgoingMessage } from '../../../../src/@types/messages'
import { Event } from '../../../../src/@types/event'
import { Settings } from '../../../../src/@types/settings'
import { getMasterDbClient } from '../../../../src/database/client'
import { InviteCodeRepository } from '../../../../src/repositories/invite-code-repository'
import { SettingsStatic } from '../../../../src/utils/settings'

const JOIN_REQUEST_KIND = 28934
const AUTH_EVENT_KIND = 22242
const CHALLENGE_TIMEOUT_MS = 3000

const world = (context: World<Record<string, any>>) => context.parameters as Record<string, any>

const dbClient = () => getMasterDbClient()

let settingsBeforeNip43: Settings | undefined

// Enabling NIP-43 makes the admission gate apply to every published event
// (event-message-handler), and no other feature admits the identities it
// creates — so a relay-wide override would refuse their writes. Turn it on for
// these scenarios only, and put the shared settings back afterwards.
Before({ tags: '@nip43' }, function () {
  settingsBeforeNip43 = SettingsStatic._settings
  SettingsStatic._settings = assocPath(['nip43', 'enabled'], true)(SettingsStatic._settings) as Settings
})

After({ tags: '@nip43' }, function () {
  if (settingsBeforeNip43) {
    SettingsStatic._settings = settingsBeforeNip43
  }
})

// The relay sends `["AUTH", <challenge>]` the moment a socket opens and the
// socket's stream is a ReplaySubject, so this step usually sees the challenge
// replayed synchronously inside subscribe(). firstValueFrom owns the teardown,
// which keeps the replayed path from racing a subscription that does not exist
// yet.
const waitForChallenge = (ws: WebSocket): Promise<string> =>
  firstValueFrom(
    (streams.get(ws) as Observable<OutgoingMessage>).pipe(
      filter((message) => message[0] === MessageType.AUTH),
      map((message) => message[1] as string),
      timeout({
        first: CHALLENGE_TIMEOUT_MS,
        with: () => throwError(() => new Error('relay did not send an AUTH challenge')),
      }),
    ),
  )

// The auth event travels as an AUTH message; sending it as an EVENT is refused
// with 'invalid: auth events must be sent using the AUTH message type'. The
// subscription is made before the send, so no replayed message can arrive
// before it exists.
const sendAuth = (ws: WebSocket, event: Event): Promise<CommandResult> =>
  new Promise<CommandResult>((resolve, reject) => {
    const observable = streams.get(ws) as Observable<OutgoingMessage>

    const subscription = observable.subscribe((message: OutgoingMessage) => {
      if (message[0] === MessageType.OK && message[1] === event.id) {
        subscription.unsubscribe()
        resolve(message as CommandResult)
      } else if (message[0] === MessageType.NOTICE) {
        subscription.unsubscribe()
        reject(new Error(message[1] as string))
      }
    })

    ws.send(JSON.stringify(['AUTH', event]), (error?: Error) => {
      if (error) {
        subscription.unsubscribe()
        reject(error)
      }
    })
  })

const authenticate = async (context: World<Record<string, any>>, name: string): Promise<CommandResult> => {
  const ws = world(context).clients[name] as WebSocket
  const { pubkey, privkey } = world(context).identities[name]

  const challenge = await waitForChallenge(ws)
  const relayUrl = SettingsStatic._settings?.info?.relay_url as string

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

  return sendAuth(ws, event)
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
