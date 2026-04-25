import ora from 'ora'

import { StopOptions } from '../types'
import { runDockerCompose } from '../utils/docker'

export const runStop = async (options: StopOptions, passthrough: string[]): Promise<number> => {
  const composeFiles = ['docker-compose.yml']

  const includeAll = options.all || (!options.tor && !options.i2p && !options.nginx && !options.local)

  if (includeAll || options.tor) {
    composeFiles.push('docker-compose.tor.yml')
  }

  if (includeAll || options.i2p) {
    composeFiles.push('docker-compose.i2p.yml')
  }

  if (includeAll || options.nginx) {
    composeFiles.push('docker-compose.nginx.yml')
  }

  if (includeAll || options.local) {
    composeFiles.push('docker-compose.local.yml')
  }

  const spinner = ora('Stopping relay...').start()
  const code = await runDockerCompose({
    files: composeFiles,
    args: ['down', ...passthrough],
  })

  if (code === 0) {
    spinner.succeed('Relay stop command completed')
  } else {
    spinner.fail('Relay stop command failed')
  }

  return code
}
