import { runExportEvents } from '../../scripts/export-events'

type ExportFormat = 'jsonl' | 'json'
type CompressionFormat = 'gzip' | 'gz' | 'xz'

type ExportOptions = {
  output?: string
  format?: ExportFormat
  compress?: boolean
  compressionFormat?: CompressionFormat
}

export const runExport = async (options: ExportOptions, rawArgs: string[]): Promise<number> => {
  const args: string[] = []

  if (options.output) {
    args.push(options.output)
  }

  if (options.compress) {
    args.push('--compress')
  }

  if (options.compressionFormat) {
    args.push('--format', options.compressionFormat)
  }

  let skipNext = false
  for (const arg of rawArgs) {
    if (skipNext) {
      skipNext = false
      continue
    }

    if (arg === '--format') {
      skipNext = true
      continue
    }

    if (arg.startsWith('--format=')) {
      continue
    }

    if (arg === '--compress' || arg === '-z') {
      continue
    }

    args.push(arg)
  }

  return runExportEvents(args, {
    format: options.format,
  })
}
