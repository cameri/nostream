import { extname, resolve } from 'path'

import fs from 'fs'

import { CompressionFormat, createDecompressionStream, detectCompressionFormat } from './utils/compression'
import {
  createEventBatchPersister,
  EventImportLineError,
  EventImportService,
  EventImportStats,
} from './services/event-import-service'
import { EventRepository } from './repositories/event-repository'
import { getMasterDbClient } from './database/client'

interface CliOptions {
  batchSize: number
  filePath: string
  showHelp: boolean
}

type ImportFileFormat = 'jsonl' | 'json'

type RunImportOptions = {
  json?: boolean
}

type InputFileSpec = {
  absolutePath: string
  compressionFormat?: CompressionFormat
  format: ImportFileFormat
}

const DEFAULT_BATCH_SIZE = 1000
const MAX_ERROR_LOGS = 20

const formatNumber = (value: number): string => value.toLocaleString('en-US')

const formatProgress = (stats: EventImportStats): string => {
  return `[Processed: ${formatNumber(stats.processed)} | Inserted: ${formatNumber(stats.inserted)} | Skipped: ${formatNumber(stats.skipped)} | Errors: ${formatNumber(stats.errors)}]`
}

const printUsage = (): void => {
  console.log('Usage: nostream import <file.jsonl|file.json> [--batch-size <number>]')
  console.log('Example: nostream import ./events.jsonl --batch-size 1000')
  console.log('Example: nostream import ./events.json --batch-size 1000')
  console.log('Example: nostream import ./events.jsonl.gz --batch-size 1000')
  console.log('Example: nostream import ./events.jsonl.xz --batch-size 1000')
}

const parseBatchSize = (value: string): number => {
  const parsedValue = Number(value)

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Invalid --batch-size value: ${value}`)
  }

  return parsedValue
}

export const parseCliArgs = (args: string[]): CliOptions => {
  let batchSize = DEFAULT_BATCH_SIZE
  let filePath: string | undefined

  if (args.includes('--help') || args.includes('-h')) {
    return {
      batchSize,
      filePath: '',
      showHelp: true,
    }
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--batch-size') {
      const nextArg = args[i + 1]
      if (typeof nextArg !== 'string') {
        throw new Error('Missing value for --batch-size')
      }

      batchSize = parseBatchSize(nextArg)
      i += 1
      continue
    }

    if (arg.startsWith('--batch-size=')) {
      batchSize = parseBatchSize(arg.split('=', 2)[1])
      continue
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }

    if (filePath) {
      throw new Error(`Unexpected extra argument: ${arg}`)
    }

    filePath = arg
  }

  if (!filePath) {
    throw new Error('Missing path to .jsonl or .json file')
  }

  return {
    batchSize,
    filePath,
    showHelp: false,
  }
}

const inferCompressedFormat = (absolutePath: string): ImportFileFormat | undefined => {
  const normalized = absolutePath.toLowerCase()

  if (normalized.endsWith('.jsonl.gz') || normalized.endsWith('.jsonl.xz')) {
    return 'jsonl'
  }

  if (normalized.endsWith('.json.gz') || normalized.endsWith('.json.xz')) {
    return 'json'
  }

  return undefined
}

const ensureValidInputFile = async (filePath: string): Promise<InputFileSpec> => {
  const absolutePath = resolve(process.cwd(), filePath)

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Input file does not exist: ${absolutePath}`)
  }

  const stats = fs.statSync(absolutePath)
  if (!stats.isFile()) {
    throw new Error(`Input path is not a file: ${absolutePath}`)
  }

  const compressionFormat = await detectCompressionFormat(absolutePath)

  if (compressionFormat) {
    const format = inferCompressedFormat(absolutePath)
    if (!format) {
      throw new Error('Compressed input filename must end with .jsonl.gz, .jsonl.xz, .json.gz, or .json.xz')
    }

    return {
      absolutePath,
      compressionFormat,
      format,
    }
  }

  const extension = extname(absolutePath).toLowerCase()

  if (extension === '.jsonl') {
    return {
      absolutePath,
      format: 'jsonl',
    }
  }

  if (extension === '.json') {
    return {
      absolutePath,
      format: 'json',
    }
  }

  throw new Error('Input file must have a .jsonl or .json extension')
}

const createImportStream = (inputFile: InputFileSpec): NodeJS.ReadableStream => {
  const source = fs.createReadStream(inputFile.absolutePath)

  if (!inputFile.compressionFormat) {
    return source
  }

  const decompressor = createDecompressionStream(inputFile.compressionFormat)

  source.on('error', (error) => {
    if (!decompressor.destroyed) {
      decompressor.destroy(error)
    }
  })

  decompressor.on('close', () => {
    if (!source.destroyed) {
      source.destroy()
    }
  })

  decompressor.on('error', () => {
    if (!source.destroyed) {
      source.destroy()
    }
  })

  return source.pipe(decompressor)
}

export const runImportEvents = async (
  args: string[] = process.argv.slice(2),
  runOptions: RunImportOptions = {},
): Promise<number> => {
  const options = parseCliArgs(args)

  if (options.showHelp) {
    printUsage()
    return 0
  }

  const inputFile = await ensureValidInputFile(options.filePath)

  if (inputFile.compressionFormat && inputFile.format === 'json') {
    throw new Error('Compressed JSON array import is not supported. Use .json (uncompressed) or .jsonl.gz/.jsonl.xz.')
  }

  const dbClient = getMasterDbClient()
  const eventRepository = new EventRepository(dbClient, dbClient)
  const importer = new EventImportService(createEventBatchPersister(eventRepository))

  let loggedErrors = 0
  let suppressedErrors = 0

  const onLineError = ({ lineNumber, reason }: EventImportLineError) => {
    if (loggedErrors < MAX_ERROR_LOGS) {
      console.warn(`[line ${lineNumber}] ${reason}`)
      loggedErrors += 1
      return
    }

    suppressedErrors += 1
  }

  const onProgress = (stats: EventImportStats) => {
    console.log(formatProgress(stats))
  }

  const startedAt = Date.now()

  try {
    if (inputFile.compressionFormat) {
      console.log(`Detected ${inputFile.compressionFormat} compression. Decompressing on-the-fly...`)
    }

    const stats =
      inputFile.format === 'json'
        ? await importer.importFromJsonArray(inputFile.absolutePath, {
            batchSize: options.batchSize,
            onLineError,
            onProgress,
          })
        : await importer.importFromReadable(createImportStream(inputFile), {
            batchSize: options.batchSize,
            onLineError,
            onProgress,
          })

    if (suppressedErrors > 0) {
      console.warn(`Suppressed ${formatNumber(suppressedErrors)} additional line errors`)
    }

    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(2)

    if (runOptions.json) {
      console.log(
        JSON.stringify(
          {
            elapsedSeconds: Number(elapsedSeconds),
            ...stats,
            suppressedErrors,
          },
          null,
          2,
        ),
      )
    } else {
      console.log(`Import completed in ${elapsedSeconds}s`)
      console.log(formatProgress(stats))
    }

    return 0
  } finally {
    await dbClient.destroy()
  }
}

if (require.main === module) {
  runImportEvents()
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error: unknown) => {
      if (error instanceof Error) {
        console.error(`Import failed: ${error.message}`)
      } else {
        console.error('Import failed with unknown error')
      }

      process.exit(1)
    })
}
