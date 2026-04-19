import { After, Given, Then, When, World } from '@cucumber/cucumber'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import { join } from 'path'

import { getMasterDbClient } from '../../../../src/database/client'
import { EventRepository } from '../../../../src/repositories/event-repository'
import { createEvent, createIdentity } from '../helpers'

type ScriptResult = {
  exitCode: number
  stderr: string
  stdout: string
}

type CompressionRoundtripState = {
  expectedContents: string[]
  expectedIds: string[]
  identityName: string
  outputFilePath: string
  pubkey: string
  tempDir: string
}

const SCRIPT_TIMEOUT_MS = 60_000
const ROUNDTRIP_KEY = 'compressionRoundtrip'

const runCliScript = async (
  scriptPath: string,
  args: string[],
): Promise<ScriptResult> => {
  return new Promise<ScriptResult>((resolve, reject) => {
    const commandArgs = ['--env-file-if-exists=.env', '-r', 'ts-node/register', scriptPath, ...args]
    const child = spawn(process.execPath, commandArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Timed out while running ${scriptPath}`))
    }, SCRIPT_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      resolve({
        exitCode: code ?? 1,
        stderr,
        stdout,
      })
    })
  })
}

const assertCommandSuccess = (
  result: ScriptResult,
  label: string,
): void => {
  if (result.exitCode === 0) {
    return
  }

  throw new Error(
    `${label} failed with exit code ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
}

const getRoundtripState = (
  world: World<Record<string, unknown>>,
): CompressionRoundtripState => {
  const state = world.parameters[ROUNDTRIP_KEY]

  if (!state) {
    throw new Error('Compression roundtrip state is not initialized')
  }

  return state as CompressionRoundtripState
}

Given('a seeded compression roundtrip dataset', async function (this: World<Record<string, unknown>>) {
  const dbClient = getMasterDbClient()
  const repository = new EventRepository(dbClient, dbClient)

  const identityName = `RoundtripUser${Date.now()}`
  const identity = createIdentity(identityName)

  const identities = this.parameters.identities as Record<string, { privkey: string; pubkey: string }>
  identities[identityName] = identity

  const token = randomUUID()
  const firstContent = `compression-roundtrip-${token}-1`
  const secondContent = `compression-roundtrip-${token}-2`

  const firstEvent = await createEvent(
    {
      content: firstContent,
      kind: 1,
      pubkey: identity.pubkey,
      tags: [['t', 'compression-roundtrip']],
    },
    identity.privkey,
  )

  const secondEvent = await createEvent(
    {
      content: secondContent,
      kind: 1,
      pubkey: identity.pubkey,
      tags: [['t', 'compression-roundtrip']],
    },
    identity.privkey,
  )

  const inserted = await repository.createMany([firstEvent, secondEvent])
  expect(inserted).to.equal(2)

  const tempDir = fs.mkdtempSync(join(os.tmpdir(), 'nostream-compression-roundtrip-'))

  this.parameters[ROUNDTRIP_KEY] = {
    expectedContents: [firstContent, secondContent].sort(),
    expectedIds: [firstEvent.id, secondEvent.id].sort(),
    identityName,
    outputFilePath: '',
    pubkey: identity.pubkey,
    tempDir,
  } as CompressionRoundtripState
})

When(
  'I export events using {string} compression',
  async function (this: World<Record<string, unknown>>, format: string) {
    if (format !== 'gzip' && format !== 'xz') {
      throw new Error(`Unsupported test format: ${format}`)
    }

    const state = getRoundtripState(this)
    const extension = format === 'gzip' ? '.jsonl.gz' : '.jsonl.xz'
    const outputFilePath = join(state.tempDir, `events${extension}`)

    const result = await runCliScript('src/scripts/export-events.ts', [
      outputFilePath,
      '--compress',
      '--format',
      format,
    ])

    assertCommandSuccess(result, 'export script')

    expect(fs.existsSync(outputFilePath)).to.equal(true)
    expect(fs.statSync(outputFilePath).size).to.be.greaterThan(0)

    state.outputFilePath = outputFilePath
    this.parameters[ROUNDTRIP_KEY] = state
  },
)

When('I remove the seeded roundtrip events from the database', async function (this: World<Record<string, unknown>>) {
  const state = getRoundtripState(this)
  const dbClient = getMasterDbClient()

  await dbClient('events')
    .where('event_pubkey', Buffer.from(state.pubkey, 'hex'))
    .delete()
})

When('I import the compressed roundtrip file', async function (this: World<Record<string, unknown>>) {
  const state = getRoundtripState(this)

  const result = await runCliScript('src/import-events.ts', [
    state.outputFilePath,
    '--batch-size',
    '2',
  ])

  assertCommandSuccess(result, 'import script')
})

Then('the seeded roundtrip events are restored', async function (this: World<Record<string, unknown>>) {
  const state = getRoundtripState(this)
  const dbClient = getMasterDbClient()

  const rows = await dbClient('events')
    .select('event_id', 'event_content')
    .where('event_pubkey', Buffer.from(state.pubkey, 'hex'))

  const actualIds = rows
    .map((row: { event_id: Buffer }) => row.event_id.toString('hex'))
    .sort()

  const actualContents = rows
    .map((row: { event_content: string }) => row.event_content)
    .sort()

  expect(actualIds).to.deep.equal(state.expectedIds)
  expect(actualContents).to.deep.equal(state.expectedContents)
})

After({ tags: '@compression-roundtrip' }, async function (this: World<Record<string, unknown>>) {
  const state = this.parameters[ROUNDTRIP_KEY] as CompressionRoundtripState | undefined

  if (state?.tempDir) {
    fs.rmSync(state.tempDir, {
      force: true,
      recursive: true,
    })
  }

  this.parameters[ROUNDTRIP_KEY] = undefined
})