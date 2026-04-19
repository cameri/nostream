import 'pg-query-stream'

import fs from 'fs'
import path, { extname } from 'path'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'

import {
  CompressionFormat,
  createCompressionStream,
  getCompressionFormatFromExtension,
  parseCompressionFormat,
} from '../utils/compression'
import { getMasterDbClient } from '../database/client'

type ExportCliOptions = {
  compress: boolean
  format?: CompressionFormat
  outputFilePath: string
  showHelp: boolean
}

type ExportOptions = {
  json?: boolean
  format?: 'jsonl' | 'json'
}

const DEFAULT_OUTPUT_FILE_PATH = 'events.jsonl'
const MIN_ELAPSED_SECONDS = 0.001

export const formatBytes = (bytes: number): string => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']

  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  let unitIndex = 0
  let value = bytes

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const rounded = Math.round(value * 100) / 100
  const formatted = String(rounded)

  return `${formatted} ${units[unitIndex]}`
}

export const formatCompressionDelta = (rawBytes: number, outputBytes: number): string | undefined => {
  if (rawBytes <= 0) {
    return undefined
  }

  const deltaPercent = ((rawBytes - outputBytes) / rawBytes) * 100
  const rounded = Math.round(Math.abs(deltaPercent) * 100) / 100
  const formattedPercent = String(rounded)

  if (deltaPercent >= 0) {
    return `${formattedPercent}% smaller`
  }

  return `${formattedPercent}% larger`
}

export const getRatePerSecond = (value: number, elapsedMs: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return 0
  }

  const elapsedSeconds = Math.max(elapsedMs / 1000, MIN_ELAPSED_SECONDS)

  return value / elapsedSeconds
}

const formatCount = (value: number): string => {
  const rounded = Math.round(value * 100) / 100

  return Number.isInteger(rounded)
    ? rounded.toLocaleString('en-US')
    : rounded.toLocaleString('en-US', {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      })
}

const getOptionValue = (option: string, args: string[], index: number): [string, number] => {
  const inlineSeparator = `${option}=`
  if (args[index].startsWith(inlineSeparator)) {
    const value = args[index].slice(inlineSeparator.length)
    if (!value) {
      throw new Error(`Missing value for ${option}`)
    }

    return [value, index]
  }

  const nextIndex = index + 1
  const nextArg = args[nextIndex]
  if (typeof nextArg !== 'string' || nextArg.startsWith('-')) {
    throw new Error(`Missing value for ${option}`)
  }

  return [nextArg, nextIndex]
}

const printUsage = (): void => {
  console.log('Usage: npm run export -- [output-file] [--compress|-z] [--format gzip|gz|xz]')
  console.log('Example: npm run export -- ./events.jsonl')
  console.log('Example: npm run export -- ./events.jsonl.gz --compress --format gzip')
  console.log('Example: npm run export -- ./events.jsonl.xz -z --format xz')
}

const getCompressionLabel = (format: CompressionFormat): string => {
  switch (format) {
    case CompressionFormat.GZIP:
      return 'gzip'
    case CompressionFormat.XZ:
      return 'xz'
    default:
      return String(format)
  }
}

export const parseCliArgs = (args: string[]): ExportCliOptions => {
  let compress = false
  let format: CompressionFormat | undefined
  let outputFilePath: string | undefined

  if (args.includes('--help') || args.includes('-h')) {
    return {
      compress,
      format,
      outputFilePath: DEFAULT_OUTPUT_FILE_PATH,
      showHelp: true,
    }
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === '--compress' || arg === '-z') {
      compress = true
      continue
    }

    if (arg === '--format' || arg.startsWith('--format=')) {
      const [rawFormat, nextIndex] = getOptionValue('--format', args, index)
      format = parseCompressionFormat(rawFormat)
      index = nextIndex
      continue
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }

    if (outputFilePath) {
      throw new Error(`Unexpected extra argument: ${arg}`)
    }

    outputFilePath = arg
  }

  if (!compress && format) {
    throw new Error('--format requires --compress')
  }

  outputFilePath = outputFilePath ?? DEFAULT_OUTPUT_FILE_PATH

  if (compress && !format) {
    format = getCompressionFormatFromExtension(outputFilePath) ?? CompressionFormat.GZIP
  }

  return {
    compress,
    format,
    outputFilePath,
    showHelp: false,
  }
}

type EventRow = {
  event_id: Buffer
  event_pubkey: Buffer
  event_kind: number
  event_created_at: number
  event_content: string
  event_tags: unknown[] | null
  event_signature: Buffer
}

const resolveExportFormat = (format?: string): 'jsonl' | 'json' => {
  if (!format) {
    return 'jsonl'
  }

  if (format === 'jsonl' || format === 'json') {
    return format
  }

  throw new Error(`Unsupported format: ${format}. Supported values: json, jsonl`)
}

const resolveOutputPath = (filename: string | undefined, format: 'jsonl' | 'json'): string => {
  const fallback = format === 'json' ? 'events.json' : 'events.jsonl'
  const outputPath = path.resolve(filename || fallback)
  const expectedExtension = format === 'json' ? '.json' : '.jsonl'

  if (extname(outputPath).toLowerCase() !== expectedExtension) {
    throw new Error(`Output file extension must be ${expectedExtension} when using --format ${format}`)
  }

  return outputPath
}

const toEvent = (row: EventRow) => ({
  id: row.event_id.toString('hex'),
  pubkey: row.event_pubkey.toString('hex'),
  created_at: row.event_created_at,
  kind: row.event_kind,
  tags: Array.isArray(row.event_tags) ? row.event_tags : [],
  content: row.event_content,
  sig: row.event_signature.toString('hex'),
})

const createFormatterTransform = (
  format: 'jsonl' | 'json',
  onExported: () => void,
): Transform => {
  if (format === 'jsonl') {
    return new Transform({
      objectMode: true,
      transform(row: EventRow, _encoding, callback) {
        onExported()
        callback(null, JSON.stringify(toEvent(row)) + '\n')
      },
    })
  }

  let hasRows = false
  return new Transform({
    objectMode: true,
    transform(row: EventRow, _encoding, callback) {
      const prefix = hasRows ? ',\n' : '[\n'
      hasRows = true
      onExported()
      callback(null, prefix + JSON.stringify(toEvent(row)))
    },
    flush(callback) {
      callback(null, hasRows ? '\n]\n' : '[]\n')
    },
  })
}

export async function runExportEvents(args: string[] = process.argv.slice(2), options: ExportOptions = {}): Promise<number> {
  const useStructuredFormat = Boolean(options.format)
  const structuredFormat = resolveExportFormat(options.format)
  const cliOptions = useStructuredFormat ? undefined : parseCliArgs(args)

  if (!useStructuredFormat && cliOptions?.showHelp) {
    printUsage()
    return 0
  }

  const outputPath = useStructuredFormat
    ? resolveOutputPath(args[0], structuredFormat)
    : path.resolve(cliOptions?.outputFilePath ?? DEFAULT_OUTPUT_FILE_PATH)

  const db = getMasterDbClient()
  const abortController = new AbortController()
  let interruptedBySignal: NodeJS.Signals | undefined

  const onSignal = (signal: NodeJS.Signals) => {
    if (abortController.signal.aborted) {
      return
    }

    interruptedBySignal = signal
    process.exitCode = 130
    console.log(`${signal} received. Stopping export...`)
    abortController.abort()
  }

  process.on('SIGINT', onSignal).on('SIGTERM', onSignal)

  try {
    const firstEvent = await db('events').select('event_id').whereNull('deleted_at').first()

    if (abortController.signal.aborted) {
      return 130
    }

    if (!firstEvent) {
      if (options.json) {
        console.log(JSON.stringify({ exported: 0, outputPath, empty: true }, null, 2))
      } else {
        console.log('No events to export.')
      }
      return 0
    }

    if (useStructuredFormat) {
      console.log(`Exporting events to ${outputPath}`)
    } else if (cliOptions?.format) {
      console.log(`Exporting events to ${outputPath} using ${getCompressionLabel(cliOptions.format)} compression`)
    } else {
      console.log(`Exporting events to ${outputPath}`)
    }

    const startedAt = Date.now()
    const output = fs.createWriteStream(outputPath)

    const dbStream = db('events')
      .select(
        'event_id',
        'event_pubkey',
        'event_kind',
        'event_created_at',
        'event_content',
        'event_tags',
        'event_signature',
      )
      .whereNull('deleted_at')
      .orderBy('event_created_at', 'asc')
      .orderBy('event_id', 'asc')
      .stream()

    let exported = 0

    if (useStructuredFormat) {
      const formatter = createFormatterTransform(structuredFormat, () => {
        exported += 1
        if (exported % 10000 === 0) {
          console.log(`Exported ${exported} events...`)
        }
      })

      await pipeline(dbStream, formatter, output, {
        signal: abortController.signal,
      })

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              exported,
              outputPath,
              format: structuredFormat,
            },
            null,
            2,
          ),
        )
      } else {
        console.log(`Export complete: ${exported} events written to ${outputPath} (${structuredFormat})`)
      }

      return 0
    }

    const compressionFormat = cliOptions?.format
    const compressionStream = createCompressionStream(compressionFormat)
    let rawBytes = 0

    const toJsonLine = new Transform({
      objectMode: true,
      transform(row: EventRow, _encoding, callback) {
        exported += 1
        if (exported % 10000 === 0) {
          console.log(`Exported ${exported} events...`)
        }

        const line = JSON.stringify(toEvent(row)) + '\n'
        rawBytes += Buffer.byteLength(line)
        callback(null, line)
      },
    })

    await pipeline(dbStream, toJsonLine, compressionStream, output, {
      signal: abortController.signal,
    })

    const elapsedMs = Date.now() - startedAt
    const outputBytes = output.bytesWritten
    const compressionDelta = formatCompressionDelta(rawBytes, outputBytes)
    const eventRate = getRatePerSecond(exported, elapsedMs)
    const rawRate = getRatePerSecond(rawBytes, elapsedMs)
    const outputRate = getRatePerSecond(outputBytes, elapsedMs)

    console.log(`Export complete: ${exported} events written to ${outputPath}`)
    if (compressionDelta) {
      console.log(`Size: ${formatBytes(rawBytes)} raw -> ${formatBytes(outputBytes)} on disk (${compressionDelta})`)
    } else {
      console.log(`Size: ${formatBytes(outputBytes)} on disk`)
    }

    console.log(
      `Throughput: ${formatCount(eventRate)} events/s | ${formatBytes(rawRate)}/s raw | ${formatBytes(outputRate)}/s output`,
    )

    return 0
  } catch (error) {
    if (abortController.signal.aborted) {
      console.log(`Export interrupted by ${interruptedBySignal ?? 'signal'}.`)
      process.exitCode = 130
      return 130
    }

    throw error
  } finally {
    process.off('SIGINT', onSignal).off('SIGTERM', onSignal)

    await db.destroy()
  }
}

if (require.main === module) {
  runExportEvents().catch((error) => {
    console.error('Export failed:', error.message)
    process.exit(1)
  })
}
