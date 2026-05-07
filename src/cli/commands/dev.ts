import { confirm, isCancel, cancel } from '@clack/prompts'
import ora from 'ora'

import { runCleanDb } from '../../clean-db'
import { runCommand } from '../utils/process'
import { runStop } from './stop'

type DevOptions = {
  yes?: boolean
}

const ensureConfirmed = async (message: string, yes?: boolean): Promise<boolean> => {
  if (yes) {
    return true
  }

  if (!process.stdin.isTTY) {
    throw new Error('Interactive confirmation is unavailable. Re-run with --yes.')
  }

  const answer = await confirm({ message, initialValue: false })
  if (isCancel(answer)) {
    cancel('Operation cancelled')
    return false
  }

  return answer
}

const runWithSpinner = async (
  loadingText: string,
  successText: string,
  failureText: string,
  action: () => Promise<number>,
): Promise<number> => {
  const spinner = ora(loadingText).start()

  try {
    const code = await action()
    if (code === 0) {
      spinner.succeed(successText)
    } else {
      spinner.fail(failureText)
    }

    return code
  } catch (error) {
    spinner.fail(failureText)
    throw error
  }
}

export const runDevDbClean = async (rawArgs: string[], options: DevOptions = {}): Promise<number> => {
  if (rawArgs.length === 0) {
    const confirmed = await ensureConfirmed('Delete all events from the database?', options.yes)
    if (!confirmed) {
      return 1
    }

    return runWithSpinner('Cleaning database...', 'Database clean completed', 'Database clean failed', () =>
      runCleanDb(['--all', '--force']),
    )
  }

  return runWithSpinner('Cleaning database...', 'Database clean completed', 'Database clean failed', () =>
    runCleanDb(rawArgs),
  )
}

export const runDevDbReset = async (options: DevOptions): Promise<number> => {
  const confirmed = await ensureConfirmed('Reset database and rerun migrations?', options.yes)
  if (!confirmed) {
    return 1
  }

  const spinner = ora('Resetting database (rollback)...').start()

  let code = await runCommand('pnpm', ['run', 'db:migrate:rollback', '--', '--all'])
  if (code !== 0) {
    spinner.fail('Database reset failed during rollback')
    return code
  }

  spinner.text = 'Resetting database (migrate)...'
  code = await runCommand('pnpm', ['run', 'db:migrate'])
  if (code === 0) {
    spinner.succeed('Database reset completed')
  } else {
    spinner.fail('Database reset failed during migrate')
  }

  return code
}

export const runDevSeedRelay = async (): Promise<number> => {
  return runWithSpinner('Seeding relay data...', 'Relay seed completed', 'Relay seed failed', () =>
    runCommand('pnpm', ['run', 'db:seed']),
  )
}

export const runDevDockerClean = async (options: DevOptions): Promise<number> => {
  const confirmed = await ensureConfirmed('Run docker system prune and docker volume prune?', options.yes)
  if (!confirmed) {
    return 1
  }

  let code = await runStop({ all: true }, [])
  if (code !== 0) {
    return code
  }

  code = await runCommand('docker', ['system', 'prune', '-a', '-f'])
  if (code !== 0) {
    return code
  }

  return runCommand('docker', ['volume', 'prune', '-f'])
}

export const runDevTestUnit = async (): Promise<number> => {
  return runWithSpinner('Running unit tests...', 'Unit tests completed', 'Unit tests failed', () =>
    runCommand('pnpm', ['run', 'test:unit']),
  )
}

export const runDevTestCli = async (): Promise<number> => {
  return runWithSpinner('Running CLI tests...', 'CLI tests completed', 'CLI tests failed', () =>
    runCommand('pnpm', ['run', 'test:cli']),
  )
}

export const runDevTestIntegration = async (): Promise<number> => {
  return runWithSpinner(
    'Running integration tests...',
    'Integration tests completed',
    'Integration tests failed',
    () => runCommand('pnpm', ['run', 'test:integration']),
  )
}

export const runDevTestPerfConnection = async (): Promise<number> => {
  return runWithSpinner(
    'Running connection rate limit performance test...',
    'Connection rate limit test completed',
    'Connection rate limit test failed',
    () => runCommand('k6', ['run', 'test/performance/connection-limiting-k6.ts']),
  )
}

export const runDevTestPerfMessage = async (): Promise<number> => {
  return runWithSpinner(
    'Running message rate limit performance test...',
    'Message rate limit test completed',
    'Message rate limit test failed',
    () => runCommand('k6', ['run', 'test/performance/message-limiting-k6.ts']),
  )
}
