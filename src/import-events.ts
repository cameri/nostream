import { extname, resolve } from 'path'

import fs from 'fs'

import dotenv from 'dotenv'

dotenv.config()

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

const DEFAULT_BATCH_SIZE = 1000
const MAX_ERROR_LOGS = 20

const formatNumber = (value: number): string => value.toLocaleString('en-US')

const formatProgress = (stats: EventImportStats): string => {
  return `[Processed: ${formatNumber(stats.processed)} | Inserted: ${formatNumber(stats.inserted)} | Skipped: ${formatNumber(stats.skipped)} | Errors: ${formatNumber(stats.errors)}]`
}

const printUsage = (): void => {
  console.log('Usage: npm run import -- <file.jsonl> [--batch-size <number>]')
  console.log('Example: npm run import -- ./events.jsonl --batch-size 1000')
}

const parseBatchSize = (value: string): number => {
  const parsedValue = Number(value)

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Invalid --batch-size value: ${value}`)
  }

  return parsedValue
}

const parseCliArgs = (args: string[]): CliOptions => {
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

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`)
    }

    if (filePath) {
      throw new Error(`Unexpected extra argument: ${arg}`)
    }

    filePath = arg
  }

  if (!filePath) {
    throw new Error('Missing path to .jsonl file')
  }

  return {
    batchSize,
    filePath,
    showHelp: false,
  }
}

const ensureValidInputFile = (filePath: string): string => {
  const absolutePath = resolve(process.cwd(), filePath)

  if (extname(absolutePath).toLowerCase() !== '.jsonl') {
    throw new Error('Input file must have a .jsonl extension')
  }

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Input file does not exist: ${absolutePath}`)
  }

  const stats = fs.statSync(absolutePath)
  if (!stats.isFile()) {
    throw new Error(`Input path is not a file: ${absolutePath}`)
  }

  return absolutePath
}

const run = async (): Promise<void> => {
  const options = parseCliArgs(process.argv.slice(2))

  if (options.showHelp) {
    printUsage()
    return
  }

  const absoluteFilePath = ensureValidInputFile(options.filePath)

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
    const stats = await importer.importFromJsonl(absoluteFilePath, {
      batchSize: options.batchSize,
      onLineError,
      onProgress,
    })

    if (suppressedErrors > 0) {
      console.warn(`Suppressed ${formatNumber(suppressedErrors)} additional line errors`)
    }

    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(2)

    console.log(`Import completed in ${elapsedSeconds}s`)
    console.log(formatProgress(stats))
  } finally {
    await dbClient.destroy()
  }
}

if (require.main === module) {
  run().catch((error: unknown) => {
    if (error instanceof Error) {
      console.error(`Import failed: ${error.message}`)
    } else {
      console.error('Import failed with unknown error')
    }

    process.exit(1)
  })
}
