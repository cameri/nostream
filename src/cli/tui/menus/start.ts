import { runStart } from '../../commands/start'
import { tuiPrompts } from '../prompts'
import ora from 'ora'

export const runStartMenu = async (): Promise<number> => {
  const action = await tuiPrompts.select({
    message: 'Start relay',
    options: [
      { value: 'continue', label: 'Continue' },
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

  const tor = await tuiPrompts.confirm({ message: 'Enable Tor?', initialValue: false })
  if (tuiPrompts.isCancel(tor)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }

  const i2p = await tuiPrompts.confirm({ message: 'Enable I2P?', initialValue: false })
  if (tuiPrompts.isCancel(i2p)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }

  const debug = await tuiPrompts.confirm({ message: 'Enable debug logs?', initialValue: false })
  if (tuiPrompts.isCancel(debug)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }

  const useCustomPort = await tuiPrompts.confirm({ message: 'Override relay port?', initialValue: false })
  if (tuiPrompts.isCancel(useCustomPort)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }

  let port: number | undefined
  if (useCustomPort) {
    const portInput = await tuiPrompts.text({
      message: 'Relay port (1-65535)',
      defaultValue: '8008',
      validate: (input) => {
        const parsed = Number(input)
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
          return 'Port must be a safe integer between 1 and 65535'
        }
        return undefined
      },
    })
    if (tuiPrompts.isCancel(portInput)) {
      tuiPrompts.cancel('Cancelled')
      return 1
    }

    port = Number(portInput)
  }

  const confirmed = await tuiPrompts.confirm({
    message: `Start relay${tor ? ' with Tor' : ''}${i2p ? `${tor ? ' + ' : ' with '}I2P` : ''}${debug ? ' (debug)' : ''}${port ? ` on port ${port}` : ''}?`,
    initialValue: true,
  })
  if (tuiPrompts.isCancel(confirmed) || !confirmed) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }

  const spinner = ora('Starting relay...').start()
  const code = await runStart({ tor, i2p, debug, port }, [])
  if (code === 0) {
    spinner.succeed('Relay start command completed')
  } else {
    spinner.fail('Relay start command failed')
  }

  return code
}
