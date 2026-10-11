import fs from 'fs'
import readline from 'readline'
import { resolve } from 'path'
import { Readable } from 'stream'

import { Event } from '../@types/event'
import { isEventIdValid, isEventSignatureValid } from '../utils/event'
import { PackedEventFields, PackedEventView, serializePackedEvent, toPackedEventFields } from '../utils/strfry'

type VerifyCliOptions = {
  filePath: string
  checkSignatures: boolean
  showHelp: boolean
}

export type VerifyStats = {
  checked: number
  failed: number
}

const MAX_REPORTED_FAILURES = 20
const PROGRESS_INTERVAL = 100_000

const printUsage = (): void => {
  console.log(`Usage: pnpm strfry:verify-export <file|-> [--skip-signatures]

Checks every event in a \`strfry export --fried\` dump against nostream's packed event
decoder, plus its id and signature. Use - to read from stdin.`)
}

export const parseCliArgs = (args: string[]): VerifyCliOptions => {
  if (args.includes('--help') || args.includes('-h')) {
    return { filePath: '', checkSignatures: true, showHelp: true }
  }

  let filePath: string | undefined
  let checkSignatures = true

  for (const arg of args) {
    if (arg === '--skip-signatures') {
      checkSignatures = false
      continue
    }

    if (arg.startsWith('-') && arg !== '-') {
      throw new Error(`Unknown option: ${arg}`)
    }

    if (filePath) {
      throw new Error(`Unexpected extra argument: ${arg}`)
    }

    filePath = arg
  }

  if (!filePath) {
    throw new Error('Missing path to a strfry export (use - to read stdin)')
  }

  return { filePath, checkSignatures, showHelp: false }
}

const findFirstDifference = (a: Buffer, b: Buffer): number => {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) {
      return i
    }
  }

  return length
}

const describeTagMismatch = (decoded: PackedEventView, expected: PackedEventFields): string | undefined => {
  const tags = decoded.tags()
  if (tags.length !== expected.tags.length) {
    return `Decoded ${tags.length} tags, expected ${expected.tags.length}`
  }

  const index = tags.findIndex(
    (tag, i) => tag.name !== expected.tags[i].name || !tag.value.equals(expected.tags[i].value),
  )

  return index === -1 ? undefined : `Decoded tag ${index} differs`
}

// Returns why the line fails, or undefined if it passes.
export const verifyFriedLine = async (line: string, checkSignatures: boolean): Promise<string | undefined> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return 'Not valid JSON'
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'Not a JSON object'
  }

  const { fried, ...rest } = parsed as Record<string, unknown>
  if (typeof fried !== 'string') {
    return 'No "fried" field, export with strfry export --fried'
  }

  if (fried.length % 2 !== 0 || !/^[0-9a-f]*$/.test(fried)) {
    return 'The "fried" field is not lowercase hex'
  }

  const event = rest as unknown as Event
  const record = Buffer.from(fried, 'hex')

  try {
    const expected = toPackedEventFields(event)
    const built = serializePackedEvent(expected)
    if (!built.equals(record)) {
      return `Packed record differs from strfry's at byte ${findFirstDifference(built, record)}`
    }

    const decoded = new PackedEventView(record)
    if (!decoded.id.equals(expected.id)) {
      return 'Decoded id differs'
    }
    if (!decoded.pubkey.equals(expected.pubkey)) {
      return 'Decoded pubkey differs'
    }
    if (decoded.createdAt !== expected.createdAt) {
      return 'Decoded created_at differs'
    }
    if (decoded.kind !== expected.kind) {
      return 'Decoded kind differs'
    }
    if (decoded.expiration !== Number(expected.expiration)) {
      return 'Decoded expiration differs'
    }

    const tagMismatch = describeTagMismatch(decoded, expected)
    if (tagMismatch) {
      return tagMismatch
    }

    if (!(await isEventIdValid(event))) {
      return 'Id does not match the event hash'
    }
    if (checkSignatures && !(await isEventSignatureValid(event))) {
      return 'Invalid signature'
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  return undefined
}

export const verifyFriedExport = async (
  input: Readable,
  checkSignatures: boolean,
  onFailure: (lineNumber: number, reason: string) => void,
  onProgress?: (stats: VerifyStats) => void,
): Promise<VerifyStats> => {
  const stats: VerifyStats = { checked: 0, failed: 0 }
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  let lineNumber = 0

  for await (const line of lines) {
    lineNumber++
    if (!line.trim()) {
      continue
    }

    stats.checked++
    const reason = await verifyFriedLine(line, checkSignatures)
    if (reason) {
      stats.failed++
      onFailure(lineNumber, reason)
    }

    if (onProgress && stats.checked % PROGRESS_INTERVAL === 0) {
      onProgress(stats)
    }
  }

  return stats
}

export const runVerifyStrfryExport = async (args: string[] = process.argv.slice(2)): Promise<number> => {
  const options = parseCliArgs(args)
  if (options.showHelp) {
    printUsage()
    return 0
  }

  const input = options.filePath === '-' ? process.stdin : fs.createReadStream(resolve(options.filePath))
  let reported = 0

  const stats = await verifyFriedExport(
    input,
    options.checkSignatures,
    (lineNumber, reason) => {
      if (reported < MAX_REPORTED_FAILURES) {
        reported++
        console.error(`line ${lineNumber}: ${reason}`)
      }
    },
    (progress) => console.log(`Checked ${progress.checked.toLocaleString('en-US')} events...`),
  )

  if (stats.checked === 0) {
    console.error('No events found in the export.')
    return 1
  }

  const notes = [
    ...(options.checkSignatures ? [] : ['signatures skipped']),
    ...(stats.failed > MAX_REPORTED_FAILURES ? [`first ${MAX_REPORTED_FAILURES} failures listed`] : []),
  ]
  const suffix = notes.length ? ` (${notes.join(', ')})` : ''
  console.log(
    `Checked ${stats.checked.toLocaleString('en-US')} events, ${stats.failed.toLocaleString('en-US')} failed${suffix}.`,
  )

  return stats.failed === 0 ? 0 : 1
}

if (require.main === module) {
  runVerifyStrfryExport()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error('Verification failed:', error.message)
      process.exit(1)
    })
}
