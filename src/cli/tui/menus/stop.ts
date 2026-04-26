import ora from 'ora'

import { runStop } from '../../commands/stop'
import { tuiPrompts } from '../prompts'

export const runStopMenu = async (): Promise<number> => {
  const nginx = await tuiPrompts.confirm({
    message: 'Include Nginx stack while stopping?',
    initialValue: false,
  })

  if (tuiPrompts.isCancel(nginx)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }

  const spinner = ora('Stopping relay...').start()
  const code = await runStop({ tor: true, i2p: true, local: true, nginx }, [])

  if (code === 0) {
    spinner.succeed('Relay stop command completed')
  } else {
    spinner.fail('Relay stop command failed')
  }

  return code
}
