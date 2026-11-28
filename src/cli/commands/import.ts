import { runImportEvents } from '../../import-events'
import { escapeForTerminal } from '../utils/output'

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

  try {
    return await runImportEvents([...args, ...rawArgs])
  } catch (error) {
    // The message can quote the input path or the input file; the CLI error
    // boundary prints it as it is.
    if (error instanceof Error) {
      error.message = escapeForTerminal(error.message)
    }

    throw error
  }
}
