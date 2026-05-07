#!/usr/bin/env node
const { cac } = require('cac')

import packageJson from '../../package.json'
import { runStart } from './commands/start'
import { runStop } from './commands/stop'
import { runInfo } from './commands/info'
import { runImport } from './commands/import'
import { runExport } from './commands/export'
import { runSetup } from './commands/setup'
import { runSeed } from './commands/seed'
import { runUpdate } from './commands/update'
import {
  runConfigEnvGet,
  runConfigEnvList,
  runConfigEnvSet,
  runConfigEnvValidate,
  runConfigGet,
  runConfigList,
  runConfigSet,
  runConfigValidate,
} from './commands/config'
import {
  runDevDbClean,
  runDevDbReset,
  runDevDockerClean,
  runDevSeedRelay,
  runDevTestCli,
  runDevTestIntegration,
  runDevTestUnit,
  runDevTestPerfConnection,
  runDevTestPerfMessage
} from './commands/dev'
import { runTui } from './tui/main'
import { logError, logInfo } from './utils/output'

class CliUsageError extends Error {}

const printHandledError = (message: string): void => {
  logError(`Error: ${message}`)
}

const isStructuredExportFormat = (value: string): value is 'json' | 'jsonl' => {
  return value === 'json' || value === 'jsonl'
}

const isCompressionExportFormat = (value: string): value is 'gzip' | 'gz' | 'xz' => {
  return value === 'gzip' || value === 'gz' || value === 'xz'
}

const extractFormatValues = (args: string[]): string[] => {
  const formats: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--format') {
      const value = args[index + 1]
      if (typeof value === 'string') {
        formats.push(value)
      }
      index += 1
      continue
    }

    if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length)
      if (value.length) {
        formats.push(value)
      }
    }
  }

  return formats
}

const cli = cac('nostream')

const configSubHelp: Record<string, string> = {
  list: 'Usage: nostream config list',
  get: 'Usage: nostream config get <path>',
  set: 'Usage: nostream config set <path> <value> [--type inferred|json] [--validate|--no-validate] [--restart]',
  validate: 'Usage: nostream config validate',
  env: 'Usage: nostream config env <list|get|set|validate> [args] [--show-secrets]',
}

const configEnvSubHelp: Record<string, string> = {
  list: 'Usage: nostream config env list [--show-secrets]',
  get: 'Usage: nostream config env get <key> [--show-secrets]',
  set: 'Usage: nostream config env set <key> <value>',
  validate: 'Usage: nostream config env validate',
}

const devSubHelp: Record<string, string> = {
  'db:clean': 'Usage: nostream dev db:clean [--all|--older-than=<days>|--kinds=1,7,4] [--dry-run] [--force]',
  'db:reset': 'Usage: nostream dev db:reset [--yes]',
  'seed:relay': 'Usage: nostream dev seed:relay',
  'docker:clean': 'Usage: nostream dev docker:clean [--yes]',
  'test:unit': 'Usage: nostream dev test:unit',
  'test:cli': 'Usage: nostream dev test:cli',
  'test:integration': 'Usage: nostream dev test:integration',
  'test:perf:connection': 'Usage: nostream dev test:perf:connection',
  'test:perf:message': 'Usage: nostream dev test:perf:message',
}

const withErrorBoundary =
  <T extends unknown[]>(handler: (...args: T) => Promise<number> | number) =>
  async (...args: T) => {
    try {
      const code = await handler(...args)
      if (typeof code === 'number' && code !== 0) {
        process.exitCode = code
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const usageError = error instanceof CliUsageError
      const lastArg = args[args.length - 1]
      const jsonMode =
        Boolean(lastArg) &&
        typeof lastArg === 'object' &&
        !Array.isArray(lastArg) &&
        (lastArg as Record<string, unknown>).json === true

      if (jsonMode) {
        process.stderr.write(`${JSON.stringify({ error: { message, code: usageError ? 2 : 1 } })}\n`)
      } else {
        printHandledError(message)
      }
      process.exitCode = usageError ? 2 : 1
    }
  }

cli
  .command('start [...args]', 'Start Nostream (Docker Compose)')
  .option('--tor', 'Enable Tor compose overlay')
  .option('--i2p', 'Enable I2P compose overlay')
  .option('--nginx', 'Enable Nginx reverse proxy overlay')
  .option('--debug', 'Enable DEBUG logging')
  .option('-d, --detach', 'Start in detached mode')
  .option('--port <port>', 'Override exposed relay port', { type: [Number] })
  .action(
    withErrorBoundary(async (args: unknown, options: unknown) => {
      const resolved = options as Record<string, unknown>
      const normalizedPort = Array.isArray(resolved.port) ? resolved.port[0] : resolved.port
      return runStart({ ...(resolved as any), port: normalizedPort as number | undefined }, args as string[])
    }),
  )

cli
  .command('stop [...args]', 'Stop Nostream')
  .option('--tor', 'Include Tor overlay')
  .option('--i2p', 'Include I2P overlay')
  .option('--nginx', 'Include Nginx overlay')
  .option('--local', 'Include local dev overlay')
  .option('--all', 'Include all known overlays')
  .action(
    withErrorBoundary(async (args: unknown, options: unknown) => {
      return runStop(options as any, args as string[])
    }),
  )

cli
  .command('info', 'Show relay/runtime info')
  .option('--tor-hostname', 'Print Tor hostname only')
  .option('--i2p-hostname', 'Print I2P hostname(s) when available')
  .option('--json', 'Print machine-readable JSON')
  .action(
    withErrorBoundary(async (options: unknown) => {
      return runInfo(options as any)
    }),
  )

cli
  .command('update [...args]', 'Pull latest git changes and restart relay')
  .action(
    withErrorBoundary(async (args: unknown) => {
      return runUpdate(args as string[])
    }),
  )

cli
  .command('clean', 'Clean Docker resources (legacy script replacement)')
  .action(
    withErrorBoundary(async () => {
      return runDevDockerClean({ yes: true })
    }),
  )

cli
  .command('import [file] [...args]', 'Import events from .jsonl or .json')
  .option('--file <file>', 'Path to .jsonl/.json file (alias to positional arg)')
  .option('--batch-size <size>', 'Batch size', { type: [Number] })
  .action(
    withErrorBoundary(async (file: unknown, args: unknown, options: unknown) => {
      const passthrough = (args as string[]) ?? []
      const unsupportedFlag = passthrough.find((arg) => arg.startsWith('-'))
      if (unsupportedFlag) {
        throw new CliUsageError(`Unknown option: ${unsupportedFlag}`)
      }

      const resolved = options as Record<string, unknown>
      const rawBatchSize = Array.isArray(resolved.batchSize) ? resolved.batchSize[0] : resolved.batchSize
      const normalizedBatchSize =
        typeof rawBatchSize === 'number' && Number.isFinite(rawBatchSize) ? rawBatchSize : undefined
      const normalizedFile = (resolved.file as string | undefined) ?? (file as string | undefined)
      if (normalizedFile && normalizedFile.startsWith('-')) {
        throw new CliUsageError(`Unknown option: ${normalizedFile}`)
      }

      return runImport(
        {
          ...(resolved as any),
          file: normalizedFile,
          batchSize: normalizedBatchSize as number | undefined,
        },
        passthrough,
      )
    }),
  )

cli
  .command('export [output] [...args]', 'Export events to file')
  .option('--output <output>', 'Output path (alias to positional arg)')
  .option('-z, --compress', 'Enable compression (legacy compatibility)')
  .option('--format <format>', 'Export format (jsonl|json|gzip|gz|xz)')
  .action(
    withErrorBoundary(async (output: unknown, args: unknown, options: unknown) => {
      const passthrough = (args as string[]) ?? []
      const resolved = options as Record<string, unknown>

      const formatCandidates = new Set<string>(extractFormatValues(passthrough))
      if (typeof resolved.format === 'string' && resolved.format.length > 0) {
        formatCandidates.add(resolved.format)
      }

      const unknownFormats = [...formatCandidates].filter(
        (format) => !isStructuredExportFormat(format) && !isCompressionExportFormat(format),
      )
      if (unknownFormats.length > 0) {
        throw new CliUsageError(
          `Unsupported format: ${unknownFormats[0]}. Supported values: json, jsonl, gzip, gz, xz`,
        )
      }

      const structuredFormats = [...formatCandidates].filter(isStructuredExportFormat)
      const compressionFormats = [...formatCandidates].filter(isCompressionExportFormat)

      if (structuredFormats.length > 1) {
        throw new CliUsageError('Conflicting structured export formats were provided. Use only one of: json, jsonl')
      }

      const compressionFamilies = new Set(compressionFormats.map((format) => (format === 'xz' ? 'xz' : 'gzip')))
      if (compressionFamilies.size > 1) {
        throw new CliUsageError(
          'Conflicting compression formats were provided. Use only one of: gzip/gz or xz',
        )
      }

      if (structuredFormats.length > 0 && compressionFormats.length > 0) {
        throw new CliUsageError('Cannot combine structured export format (json/jsonl) with compression format (gzip/gz/xz).')
      }

      const compress =
        Boolean(resolved.compress) || passthrough.includes('--compress') || passthrough.includes('-z')
      if (structuredFormats.length > 0 && compress) {
        throw new CliUsageError('Cannot combine --compress with --format json/jsonl.')
      }

      return runExport(
        {
          ...(resolved as any),
          output: (resolved.output as string | undefined) ?? (output as string | undefined),
          format: structuredFormats[0] as 'json' | 'jsonl' | undefined,
          compress,
          compressionFormat: compressionFormats[0] as 'gzip' | 'gz' | 'xz' | undefined,
        },
        passthrough,
      )
    }),
  )

cli
  .command('seed', 'Seed relay with test data')
  .option('--count <count>', 'Number of events to seed', { type: [Number] })
  .action(
    withErrorBoundary(async (options: unknown) => {
      const resolved = options as Record<string, unknown>
      const normalizedCount = Array.isArray(resolved.count) ? resolved.count[0] : resolved.count
      return runSeed({ ...(resolved as any), count: normalizedCount as number | undefined })
    }),
  )

cli
  .command('setup', 'Initial interactive setup')
  .option('-y, --yes', 'Non-interactive defaults')
  .option('--start', 'Start relay after setup')
  .action(withErrorBoundary(async (options: unknown) => runSetup(options as any)))

cli
  .command('config [...args]', 'Manage settings')
  .option('--restart', 'Restart relay after setting update')
  .option('--validate', 'Validate merged settings before write')
  .option('--no-validate', 'Skip validation before write')
  .option('--type <type>', 'Value parser: inferred|json')
  .option('--show-secrets', 'Show secret values for env commands')
  .option('--json', 'Print machine-readable JSON for read commands')
  .action(
    withErrorBoundary(async (args: unknown, options: unknown) => {
      const positional = (args as string[]) ?? []
      const command = positional[0]
      const resolved = options as Record<string, unknown>
      const json = Boolean(resolved.json)

      if (resolved.help && command === 'env') {
        const envCommand = positional[1]
        if (envCommand && configEnvSubHelp[envCommand]) {
          logInfo(configEnvSubHelp[envCommand])
          return 0
        }

        logInfo(configSubHelp.env)
        return 0
      }

      if (resolved.help && command && configSubHelp[command]) {
        logInfo(configSubHelp[command])
        return 0
      }

      if (command === 'env') {
        const envCommand = positional[1]
        const showSecrets = Boolean(resolved.showSecrets)

        switch (envCommand) {
          case 'list':
            return runConfigEnvList({ showSecrets })
          case 'get':
            if (!positional[2]) {
              throw new CliUsageError(configEnvSubHelp.get)
            }
            return runConfigEnvGet(positional[2], { showSecrets })
          case 'set':
            if (!positional[2] || positional[3] === undefined) {
              throw new CliUsageError(configEnvSubHelp.set)
            }
            return runConfigEnvSet(positional[2], positional[3])
          case 'validate':
            return runConfigEnvValidate()
          default:
            logInfo(configSubHelp.env)
            return 2
        }
      }

      switch (command) {
        case 'list':
          return runConfigList({ json })
        case 'get':
          if (!positional[1]) {
            throw new CliUsageError(configSubHelp.get)
          }
          return runConfigGet(positional[1], { json })
        case 'set': {
          if (!positional[1] || positional[2] === undefined) {
            throw new CliUsageError(configSubHelp.set)
          }

          const valueType = ((resolved.type as string | undefined) ?? 'inferred') as 'inferred' | 'json'
          if (valueType !== 'inferred' && valueType !== 'json') {
            throw new CliUsageError(`Unsupported type: ${valueType}. Supported values: inferred, json`)
          }

          return runConfigSet(positional[1], positional[2], {
            restart: Boolean(resolved.restart),
            validate: resolved.validate !== false,
            valueType,
          })
        }
        case 'validate':
          return runConfigValidate()
        default:
          logInfo('Usage: nostream config <list|get|set|validate|env> [args]')
          return 2
      }
    }),
  )

cli
  .command('dev [...args]', 'Development utilities')
  .option('-y, --yes', 'Skip confirmation')
  .action(
    withErrorBoundary(async (args: unknown, options: unknown) => {
      const positional = (args as string[]) ?? []
      const command = positional[0]
      const resolved = options as Record<string, unknown>

      if (resolved.help && command && devSubHelp[command]) {
        logInfo(devSubHelp[command])
        return 0
      }

      switch (command) {
        case 'db:clean':
          return runDevDbClean(positional.slice(1), resolved as any)
        case 'db:reset':
          return runDevDbReset(resolved as any)
        case 'seed:relay':
          return runDevSeedRelay()
        case 'docker:clean':
          return runDevDockerClean(resolved as any)
        case 'test:unit':
          return runDevTestUnit()
        case 'test:cli':
          return runDevTestCli()
        case 'test:integration':
          return runDevTestIntegration()
        case 'test:perf:connection':
          return runDevTestPerfConnection()
        case 'test:perf:message':
          return runDevTestPerfMessage()
        default:
          logInfo(
            'Usage: nostream dev <db:clean|db:reset|seed:relay|docker:clean|test:unit|test:cli|test:integration> [args]',
          )
          return 2
      }
    }),
  )

cli.help()
cli.version(packageJson.version)

withErrorBoundary(async () => {
  const userArgs = process.argv.slice(2)
  const knownTopLevel = new Set([
    'start',
    'stop',
    'info',
    'import',
    'export',
    'seed',
    'setup',
    'config',
    'dev',
    'update',
    'clean',
  ])

  if (userArgs.length >= 2 && userArgs.includes('--help')) {
    if (userArgs[0] === 'config' && userArgs[1] === 'env') {
      if (userArgs[2] && configEnvSubHelp[userArgs[2]]) {
        logInfo(configEnvSubHelp[userArgs[2]])
        return 0
      }

      logInfo(configSubHelp.env)
      return 0
    }

    if (userArgs[0] === 'config' && configSubHelp[userArgs[1]]) {
      logInfo(configSubHelp[userArgs[1]])
      return 0
    }

    if (userArgs[0] === 'dev' && devSubHelp[userArgs[1]]) {
      logInfo(devSubHelp[userArgs[1]])
      return 0
    }
  }

  if (userArgs.length > 0 && !userArgs[0].startsWith('-') && !knownTopLevel.has(userArgs[0])) {
    logError(`Unknown command: ${userArgs[0]}`)
    cli.outputHelp()
    return 2
  }

  if (userArgs.length === 0) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      cli.outputHelp()
      return 0
    }

    return runTui()
  }

  await cli.parse(process.argv)
  return typeof process.exitCode === 'number' ? process.exitCode : 0
})()
