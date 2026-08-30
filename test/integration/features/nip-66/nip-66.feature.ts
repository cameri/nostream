import EventEmitter from 'events'

import { After, Before, Given, Then, When } from '@cucumber/cucumber'
import { expect } from 'chai'
import { assocPath, mergeDeepRight, pipe } from 'ramda'

import { RelayProbeRunSnapshot } from '../../../../src/@types/relay-probe-snapshot'
import { RedisAdapter } from '../../../../src/adapters/redis-adapter'
import { RelayMonitorWorker } from '../../../../src/app/relay-monitor-worker'
import { getCacheClient } from '../../../../src/cache/client'
import { EventKinds } from '../../../../src/constants/base'
import { getMasterDbClient, getReadReplicaDbClient } from '../../../../src/database/client'
import { Settings } from '../../../../src/@types/settings'
import { EventRepository } from '../../../../src/repositories/event-repository'
import { Nip66EventPublisher, NIP66_MONITOR_BOOTSTRAPPED_KEY } from '../../../../src/services/nip66-event-publisher'
import { getPublicKey } from '../../../../src/utils/event'
import { resetMonitorPrivateKeyCache } from '../../../../src/utils/monitor-identity'
import { RELAY_PROBE_SNAPSHOT_KEY, RelayProbeSnapshotStore } from '../../../../src/utils/relay-probe-snapshot'
import { SettingsStatic } from '../../../../src/utils/settings'

const INTEGRATION_RELAY_URL = 'ws://localhost:18808'
const MONITOR_PRIVATE_KEY = '0000000000000000000000000000000000000000000000000000000000000001'
const MONITOR_PUBKEY = getPublicKey(MONITOR_PRIVATE_KEY)
const SNAPSHOT_WAIT_MS = 15_000
const SNAPSHOT_POLL_MS = 100
const DISABLED_PROBE_WAIT_MS = 500

const defaultNip66Settings = {
  enabled: true,
  probeIntervalSeconds: 60,
  targets: [INTEGRATION_RELAY_URL],
  timeouts: {
    dnsMs: 10_000,
    tlsMs: 10_000,
    wsRttMs: 10_000,
    nip11Ms: 10_000,
  },
  dnsCacheTtlSeconds: 300,
}

let monitorWorker: RelayMonitorWorker | undefined
let snapshotStore: RelayProbeSnapshotStore | undefined
let cacheAdapter: RedisAdapter | undefined
let eventPublisher: Nip66EventPublisher | undefined
let savedSettings: Settings | undefined
let savedMonitorPrivateKey: string | undefined

const waitForSnapshot = async (): Promise<RelayProbeRunSnapshot> => {
  const deadline = Date.now() + SNAPSHOT_WAIT_MS

  while (Date.now() < deadline) {
    const snapshot = await snapshotStore!.getLatest()

    if (snapshot) {
      return snapshot
    }

    await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_POLL_MS))
  }

  throw new Error(`Timed out waiting for probe snapshot at ${RELAY_PROBE_SNAPSHOT_KEY}`)
}

const createMonitorProcess = (): NodeJS.Process => new EventEmitter() as NodeJS.Process

const startMonitorWorker = (): RelayMonitorWorker => {
  const worker = new RelayMonitorWorker(
    createMonitorProcess(),
    () => SettingsStatic._settings!,
    snapshotStore!,
    undefined,
    eventPublisher,
  )

  worker.run()

  return worker
}

Before({ tags: '@nip-66' }, async function () {
  savedSettings = SettingsStatic._settings
  savedMonitorPrivateKey = process.env.MONITOR_PRIVATE_KEY
  cacheAdapter = new RedisAdapter(getCacheClient())
  snapshotStore = new RelayProbeSnapshotStore(cacheAdapter)
  eventPublisher = new Nip66EventPublisher(
    new EventRepository(getMasterDbClient(), getReadReplicaDbClient(), () => SettingsStatic._settings!),
    cacheAdapter,
  )
  await cacheAdapter.deleteKey(RELAY_PROBE_SNAPSHOT_KEY)
  await cacheAdapter.deleteKey(NIP66_MONITOR_BOOTSTRAPPED_KEY)
})

After({ tags: '@nip-66' }, async function () {
  monitorWorker?.close()
  monitorWorker = undefined

  if (cacheAdapter) {
    await cacheAdapter.deleteKey(RELAY_PROBE_SNAPSHOT_KEY)
    await cacheAdapter.deleteKey(NIP66_MONITOR_BOOTSTRAPPED_KEY)
  }

  await getMasterDbClient()('events')
    .where('event_pubkey', Buffer.from(MONITOR_PUBKEY, 'hex'))
    .delete()

  if (savedMonitorPrivateKey) {
    process.env.MONITOR_PRIVATE_KEY = savedMonitorPrivateKey
  } else {
    delete process.env.MONITOR_PRIVATE_KEY
  }
  resetMonitorPrivateKeyCache()

  SettingsStatic._settings = savedSettings
  savedSettings = undefined
  snapshotStore = undefined
  cacheAdapter = undefined
  eventPublisher = undefined
  savedMonitorPrivateKey = undefined
})

Given('NIP-66 relay monitoring is disabled', function () {
  SettingsStatic._settings = pipe(
    assocPath(['nip66'], mergeDeepRight(defaultNip66Settings, { enabled: false })),
    assocPath(['info', 'relay_url'], INTEGRATION_RELAY_URL),
  )(SettingsStatic._settings) as Settings
})

Given('NIP-66 relay monitoring is enabled', function () {
  SettingsStatic._settings = pipe(
    assocPath(['nip66'], defaultNip66Settings),
    assocPath(['info', 'relay_url'], INTEGRATION_RELAY_URL),
  )(SettingsStatic._settings) as Settings
})

Given('the NIP-66 monitor private key is configured', function () {
  process.env.MONITOR_PRIVATE_KEY = MONITOR_PRIVATE_KEY
  resetMonitorPrivateKeyCache()
})

Given('the probe target is {string}', function (target: string) {
  SettingsStatic._settings = assocPath(['nip66', 'targets'], [target], SettingsStatic._settings) as Settings
})

Given('no explicit NIP-66 probe targets are configured', function () {
  SettingsStatic._settings = assocPath(['nip66', 'targets'], [], SettingsStatic._settings) as Settings
})

Given('invalid and valid NIP-66 probe targets are configured', function () {
  SettingsStatic._settings = assocPath(
    ['nip66', 'targets'],
    ['not-a-url', INTEGRATION_RELAY_URL],
    SettingsStatic._settings,
  ) as Settings
})

When('the relay monitor worker completes a probe run', async function () {
  monitorWorker = startMonitorWorker()
  this.parameters.probeSnapshot = await waitForSnapshot()
  monitorWorker.close()
  monitorWorker = undefined
})

When('the relay monitor worker is started', function () {
  monitorWorker = startMonitorWorker()
})

Then('the relay monitor worker does not store a probe snapshot', async function () {
  await new Promise((resolve) => setTimeout(resolve, DISABLED_PROBE_WAIT_MS))

  const snapshot = await snapshotStore!.getLatest()
  expect(snapshot).to.equal(null)
})

Then('the latest probe snapshot in Redis has status {string}', function (status: string) {
  expect(this.parameters.probeSnapshot.status).to.equal(status)
})

Then('the snapshot includes probe results for {string}', function (target: string) {
  const snapshot = this.parameters.probeSnapshot as RelayProbeRunSnapshot

  expect(snapshot.targets).to.deep.equal([target])
  expect(snapshot.results).to.have.length(1)
  expect(snapshot.results[0].target.relayUrl).to.equal(target)
  expect(snapshot.results[0].checkedAt).to.be.a('string')
  expect(snapshot.results[0].wsRtt.status).to.equal('ok')
})

Then('the snapshot uses the configured relay URL as its probe target', function () {
  const snapshot = this.parameters.probeSnapshot as RelayProbeRunSnapshot

  expect(snapshot.targets).to.deep.equal([INTEGRATION_RELAY_URL])
})

Then('a kind 30166 event is stored for the monitor identity', async function () {
  const rows = await getMasterDbClient()('events')
    .where('event_kind', EventKinds.RELAY_DISCOVERY)
    .where('event_pubkey', Buffer.from(MONITOR_PUBKEY, 'hex'))

  expect(rows).to.have.length(1)

  const tags = JSON.parse(rows[0].event_tags)
  expect(tags).to.deep.include(['d', `${INTEGRATION_RELAY_URL}/`])
})
