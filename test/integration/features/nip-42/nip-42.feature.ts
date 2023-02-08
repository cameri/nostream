import {
  Given,
  Then,
  World,
} from '@cucumber/cucumber'
import chai from 'chai'
import { EventKinds } from '../../../../src/constants/base'
import { SettingsStatic } from '../../../../src/utils/settings'
import sinonChai from 'sinon-chai'
import { waitForAuth } from '../helpers'
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
  const event = outgoingAuthMessage[1]
  expect(event.kind).to.equal(EventKinds.AUTH)
})

