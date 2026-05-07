import ora from 'ora'

import { runCommand } from '../utils/process'

type SeedOptions = {
  count?: number
}

export const runSeed = async (options: SeedOptions): Promise<number> => {
  if (options.count !== undefined) {
    if (!Number.isSafeInteger(options.count) || options.count <= 0) {
      throw new Error('--count must be a positive integer')
    }
  }

  const spinner = ora('Seeding relay data...').start()

  const code = await runCommand('pnpm', ['run', 'db:seed'], {
    env: options.count ? { NOSTREAM_SEED_COUNT: String(options.count) } : undefined,
  })

  if (code === 0) {
    if (options.count) {
      spinner.succeed(`Seed completed with ${options.count} events requested`)
    } else {
      spinner.succeed('Seed completed')
    }
  } else {
    spinner.fail('Seed failed')
  }

  return code
}
