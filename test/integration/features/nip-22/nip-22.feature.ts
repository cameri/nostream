import { After, Before, Given, Then, When } from '@cucumber/cucumber'
import { assocPath, pipe } from 'ramda'

import { CommandResult, MessageType } from '../../../../src/@types/messages'
import { createEvent, sendEvent } from '../helpers'

import { Event } from '../../../../src/@types/event'
import { expect } from 'chai'
import { isDraft } from '../shared'
import { SettingsStatic } from '../../../../src/utils/settings'
import WebSocket from 'ws'

const previousSettingsSnapshot = Symbol('nip22PreviousSettingsSnapshot')
const draftOffsetSeconds = Symbol('nip22DraftOffsetSeconds')

const setCreatedAtLimits = (maxPositiveDelta: number, maxNegativeDelta: number) => {
  const settings = SettingsStatic._settings ?? SettingsStatic.createSettings()

  SettingsStatic._settings = pipe(
    assocPath(['limits', 'event', 'createdAt', 'maxPositiveDelta'], maxPositiveDelta),
    assocPath(['limits', 'event', 'createdAt', 'maxNegativeDelta'], maxNegativeDelta),
  )(settings) as any
}

Before({ tags: '@nip-22' }, function(this: any) {
  this[previousSettingsSnapshot] = SettingsStatic._settings
})

After({ tags: '@nip-22' }, function(this: any) {
  SettingsStatic._settings = this[previousSettingsSnapshot]
  delete this[previousSettingsSnapshot]
})

Given(/^created_at limits are set to maxPositiveDelta (\d+) and maxNegativeDelta (\d+)$/, function(
  maxPositiveDelta: string,
  maxNegativeDelta: string,
) {
  setCreatedAtLimits(Number(maxPositiveDelta), Number(maxNegativeDelta))
})

When(/^(\w+) drafts a text_note event with content "([^"]+)" and created_at (-?\d+) seconds from now$/, async function(
  name: string,
  content: string,
  offsetSeconds: string,
) {
  const { pubkey, privkey } = this.parameters.identities[name]
  const createdAt = Math.floor(Date.now() / 1000) + Number(offsetSeconds)

  const event: Event = await createEvent(
    {
      pubkey,
      kind: 1,
      content,
      created_at: createdAt,
    },
    privkey,
  )

  const draftEvent = event as any
  draftEvent[isDraft] = true
  draftEvent[draftOffsetSeconds] = Number(offsetSeconds)

  this.parameters.events[name].push(event)
})

Then(/^(\w+) sends their last draft event unsuccessfully with reason containing "([^"]+)"$/, async function(
  name: string,
  expectedReason: string,
) {
  const ws = this.parameters.clients[name] as WebSocket

  const event = this.parameters.events[name].findLast((lastEvent: Event) => (lastEvent as any)[isDraft])
  if (!event) {
    throw new Error(`No draft event found for ${name}`)
  }

  const draftEvent = event as any
  const offsetSeconds = draftEvent[draftOffsetSeconds]

  let eventToSend = event
  if (typeof offsetSeconds === 'number') {
    const { pubkey, privkey } = this.parameters.identities[name]
    const createdAt = Math.floor(Date.now() / 1000) + offsetSeconds

    eventToSend = await createEvent(
      {
        pubkey,
        kind: event.kind,
        content: event.content,
        created_at: createdAt,
      },
      privkey,
    )
  }

  delete draftEvent[isDraft]
  delete draftEvent[draftOffsetSeconds]

  const command = await sendEvent(ws, eventToSend, false) as CommandResult

  expect(command[0]).to.equal(MessageType.OK)
  expect(command[2]).to.equal(false)
  expect(command[3].toLowerCase()).to.contain(expectedReason.toLowerCase())
})
