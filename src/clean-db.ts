import { createInterface } from 'readline'
import { Knex } from 'knex'

import { getMasterDbClient } from './database/client'

type CleanDbOptions = {
  all: boolean
  dryRun: boolean
  force: boolean
  help: boolean
  kinds: number[]
  olderThanDays?: number
}

const HELP_TEXT = [
  'Usage: nostream dev db:clean [options]',
  '',
  'Options:',
  '  --all                  Delete all events.',
  '  --older-than=<days>    Delete events older than the given number of days.',
  '  --kinds=<1,7,4>        Delete events for specific kinds.',
  '  --dry-run              Show how many rows would be deleted without deleting them.',
  '  --force                Skip interactive confirmation prompt.',
  '  --help                 Show this help message.',
  '',
  'Examples:',
  '  nostream dev db:clean --all --dry-run',
  '  nostream dev db:clean --all --force',
  '  nostream dev db:clean --older-than=30 --force',
  '  nostream dev db:clean --older-than=30 --kinds=1,7,4 --dry-run',
].join('\n')

const getOptionValue = (arg: string, args: string[], index: number): [string, number] => {
  const [option, inlineValue] = arg.split('=')

  if (inlineValue !== undefined) {
    if (!inlineValue.trim()) {
      throw new Error(`Missing value for ${option}`)
    }

    return [inlineValue, index]
  }

  const nextIndex = index + 1
  const nextArg = args[nextIndex]

  if (!nextArg || nextArg.startsWith('--')) {
    throw new Error(`Missing value for ${option}`)
  }

  return [nextArg, nextIndex]
}

const parseOlderThanDays = (value: string): number => {
  if (!/^\d+$/.test(value)) {
    throw new Error('--older-than must be a positive integer')
  }

  const days = Number(value)
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new Error('--older-than must be a positive integer')
  }

  return days
}

const parseKinds = (value: string): number[] => {
  const parts = value
    .split(',')
    .map((kind) => kind.trim())
    .filter(Boolean)

  if (!parts.length) {
    throw new Error('--kinds requires at least one kind')
  }

  const kinds = parts.map((kind) => {
    if (!/^\d+$/.test(kind)) {
      throw new Error('--kinds must be a comma-separated list of non-negative integers')
    }

    const parsed = Number(kind)
    if (!Number.isSafeInteger(parsed)) {
      throw new Error('--kinds must contain valid integers')
    }

    return parsed
  })

  return Array.from(new Set(kinds))
}

const matchesOption = (arg: string, option: string): boolean => {
  return arg === option || arg.startsWith(`${option}=`)
}

export const parseCleanDbOptions = (args: string[]): CleanDbOptions => {
  const options: CleanDbOptions = {
    all: false,
    dryRun: false,
    force: false,
    help: false,
    kinds: [],
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === '--all') {
      options.all = true
      continue
    }

    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (arg === '--force') {
      options.force = true
      continue
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }

    if (matchesOption(arg, '--older-than')) {
      const [value, nextIndex] = getOptionValue(arg, args, index)
      options.olderThanDays = parseOlderThanDays(value)
      index = nextIndex
      continue
    }

    if (matchesOption(arg, '--kinds')) {
      const [value, nextIndex] = getOptionValue(arg, args, index)
      options.kinds = parseKinds(value)
      index = nextIndex
      continue
    }

    throw new Error(`Unknown option: ${arg}`)
  }

  if (options.help) {
    return options
  }

  if (!options.all && options.olderThanDays === undefined && !options.kinds.length) {
    throw new Error('Select a target with --all, --older-than, or --kinds')
  }

  if (options.all && (options.olderThanDays !== undefined || options.kinds.length)) {
    throw new Error('--all cannot be combined with --older-than or --kinds')
  }

  return options
}

const applySelectiveFilters = (query: Knex.QueryBuilder, options: CleanDbOptions): Knex.QueryBuilder => {
  if (options.olderThanDays !== undefined) {
    const olderThanSeconds = options.olderThanDays * 24 * 60 * 60
    const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds
    query.where('event_created_at', '<', cutoff)
  }

  if (options.kinds.length) {
    query.whereIn('event_kind', options.kinds)
  }

  return query
}

const getMatchingEventsCount = async (dbClient: Knex, options: CleanDbOptions): Promise<number> => {
  const query = dbClient('events')

  if (!options.all) {
    applySelectiveFilters(query, options)
  }

  const result = await query.count<{ count: string | number }>('* as count').first()
  return Number(result?.count ?? 0)
}

const askForConfirmation = async (): Promise<boolean> => {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const answer = await new Promise<string>((resolve) => {
    readline.question("Type 'DELETE' to confirm: ", (input) => resolve(input))
  })

  readline.close()
  return answer.trim() === 'DELETE'
}

const runAllDelete = async (dbClient: Knex): Promise<boolean> => {
  const hasEventTagsTable = await dbClient.schema.hasTable('event_tags')
  if (hasEventTagsTable) {
    await dbClient.raw('TRUNCATE TABLE events, event_tags RESTART IDENTITY CASCADE;')
    return true
  }

  await dbClient.raw('TRUNCATE TABLE events RESTART IDENTITY CASCADE;')
  return false
}

const runSelectiveDelete = async (dbClient: Knex, options: CleanDbOptions): Promise<number> => {
  const deleteQuery = applySelectiveFilters(dbClient('events'), options)
  const deletedRows = await deleteQuery.del()
  await dbClient.raw('VACUUM ANALYZE events;')
  return Number(deletedRows)
}

export const runCleanDb = async (args: string[] = process.argv.slice(2)): Promise<number> => {
  const options = parseCleanDbOptions(args)

  if (options.help) {
    console.log(HELP_TEXT)
    return 0
  }

  if (process.env.NODE_ENV === 'production') {
    console.warn('WARNING: NODE_ENV=production detected. This operation permanently deletes data.')
  }

  const dbClient = getMasterDbClient()

  try {
    if (options.dryRun) {
      const matchingEvents = await getMatchingEventsCount(dbClient, options)
      console.log(`Dry run: ${matchingEvents} events would be deleted.`)
      return 0
    }

    if (!options.force) {
      if (!process.stdin.isTTY) {
        throw new Error('Interactive confirmation is unavailable. Re-run with --force.')
      }

      const confirmed = await askForConfirmation()
      if (!confirmed) {
        console.log('Aborted. Confirmation text did not match DELETE.')
        return 1
      }
    }

    if (options.all) {
      const deletedEventTags = await runAllDelete(dbClient)
      if (deletedEventTags) {
        console.log('Deleted all rows from events and event_tags with TRUNCATE.')
      } else {
        console.log('Deleted all events with TRUNCATE.')
      }
      return 0
    }

    const deletedRows = await runSelectiveDelete(dbClient, options)
    console.log(`Deleted ${deletedRows} events. VACUUM ANALYZE completed.`)
    return 0
  } finally {
    await dbClient.destroy()
  }
}

if (require.main === module) {
  runCleanDb()
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(message)
      process.exitCode = 1
    })
}
