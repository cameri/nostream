import {
  Given,
  Then,
  World,
} from '@cucumber/cucumber'
import chai from 'chai'
import sinonChai from 'sinon-chai'

import { createEvent, sendEvent, waitForAuth } from '../helpers'
import { EventKinds } from '../../../../src/constants/base'
import { SettingsStatic } from '../../../../src/utils/settings'
import { WebSocket } from 'ws'

chai.use(sinonChai)
const { expect } = chai

Given(/the relay requires the client to authenticate/, async function (this: World<Record<string, any>>) {
  const settings = SettingsStatic.createSettings()
  settings.authentication.enabled = true
})

Then(/(\w+) receives an authentication challenge/, async function (name: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const outgoingAuthMessage = await waitForAuth(ws)
  const challenge = outgoingAuthMessage[1]
  expect(challenge).to.be.a.string
  this.parameters.challenges[name].push(challenge)
})

Then(/(\w+) sends a signed_challenge_event/, async function (name: string) {
  const challenge = this.parameters.challenges[name].pop()
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]

  const event: any = await createEvent({ pubkey, kind: EventKinds.AUTH, content: challenge }, privkey)
  await sendEvent(ws, event, true)
  this.parameters.events[name].push(event)
})
