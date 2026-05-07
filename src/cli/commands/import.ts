import { runImportEvents } from '../../import-events'

type ImportOptions = {
  file?: string
  batchSize?: number
}

export const runImport = async (options: ImportOptions, rawArgs: string[]): Promise<number> => {
  const args: string[] = []

  if (options.file) {
    args.push(options.file)
  }

  if (typeof options.batchSize === 'number') {
    args.push('--batch-size', String(options.batchSize))
  }

  return runImportEvents([...args, ...rawArgs])
}
