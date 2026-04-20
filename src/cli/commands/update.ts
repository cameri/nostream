import ora from 'ora'

import { runCommand, runCommandWithOutput } from '../utils/process'
import { runStart } from './start'
import { runStop } from './stop'

const wasStashCreated = (output: string): boolean => {
  return !output.includes('No local changes to save')
}

export const runUpdate = async (passthrough: string[]): Promise<number> => {
  const spinner = ora('Updating relay...').start()

  let code = await runStop({ all: true }, [])
  if (code !== 0) {
    spinner.fail('Update failed while stopping relay')
    return code
  }

  const stashResult = await runCommandWithOutput('git', ['stash', 'push', '-u', '-m', 'nostream-cli-update'])
  if (stashResult.code !== 0) {
    spinner.fail('Update failed while stashing local changes')
    return stashResult.code
  }

  const stashOutput = `${stashResult.stdout}\n${stashResult.stderr}`
  const stashCreated = wasStashCreated(stashOutput)

  code = await runCommand('git', ['pull'])
  if (code !== 0) {
    if (stashCreated) {
      const restoreCode = await runCommand('git', ['stash', 'pop'])
      if (restoreCode === 0) {
        spinner.fail('Update failed while pulling latest changes. Restored stashed local changes.')
        return code
      }

      spinner.fail(
        'Update failed while pulling latest changes, and restoring stashed local changes also failed. Run `git stash list` then `git stash pop` manually.',
      )
      return restoreCode
    }

    spinner.fail('Update failed while pulling latest changes.')
    return code
  }

  if (stashCreated) {
    code = await runCommand('git', ['stash', 'pop'])
    if (code !== 0) {
      spinner.fail('Update pulled latest changes, but reapplying stashed changes failed')
      return code
    }
  }

  code = await runStart({}, passthrough)
  if (code !== 0) {
    spinner.fail('Update finished pull, but restart failed')
    return code
  }

  spinner.succeed('Relay updated and restarted')
  return 0
}
