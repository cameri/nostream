import { runDevDbClean, runDevDbReset, runDevDockerClean, runDevSeedRelay } from '../../commands/dev'
import { tuiPrompts } from '../prompts'
import ora from 'ora'

const confirmDanger = async (message: string): Promise<boolean> => {
  const answer = await tuiPrompts.confirm({
    message: `Destructive action: ${message}`,
    initialValue: false,
  })

  if (tuiPrompts.isCancel(answer) || !answer) {
    tuiPrompts.cancel('Cancelled')
    return false
  }

  return true
}

export const runDevMenu = async (): Promise<number> => {
  const action = await tuiPrompts.select({
    message: 'Development utilities',
    options: [
      { value: 'db:clean', label: 'Clean DB (events)' },
      { value: 'db:reset', label: 'Reset DB (rollback+migrate)' },
      { value: 'seed:relay', label: 'Seed relay data' },
      { value: 'docker:clean', label: 'Docker system/volume clean' },
      { value: 'back', label: 'Back' },
    ],
  })

  if (tuiPrompts.isCancel(action)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }
  if (action === 'back') {
    return 0
  }

  switch (action) {
    case 'db:clean': {
      const confirmed = await confirmDanger('delete events from the database')
      if (!confirmed) {
        return 1
      }

      const spinner = ora('Cleaning database...').start()
      const code = await runDevDbClean(['--all', '--force'])
      if (code === 0) {
        spinner.succeed('Database clean completed')
      } else {
        spinner.fail('Database clean failed')
      }
      return code
    }
    case 'db:reset': {
      const confirmed = await confirmDanger('reset database and rerun migrations')
      if (!confirmed) {
        return 1
      }

      const spinner = ora('Resetting database...').start()
      const code = await runDevDbReset({ yes: true })
      if (code === 0) {
        spinner.succeed('Database reset completed')
      } else {
        spinner.fail('Database reset failed')
      }
      return code
    }
    case 'seed:relay': {
      const spinner = ora('Seeding relay...').start()
      const code = await runDevSeedRelay()
      if (code === 0) {
        spinner.succeed('Relay seed completed')
      } else {
        spinner.fail('Relay seed failed')
      }
      return code
    }
    case 'docker:clean': {
      const confirmed = await confirmDanger('remove unused Docker images and volumes')
      if (!confirmed) {
        return 1
      }

      const spinner = ora('Cleaning Docker resources...').start()
      const code = await runDevDockerClean({ yes: true })
      if (code === 0) {
        spinner.succeed('Docker clean completed')
      } else {
        spinner.fail('Docker clean failed')
      }
      return code
    }
    default:
      return 1
  }
}
