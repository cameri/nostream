import fs from 'fs'
import { intro, outro, confirm, text, isCancel, cancel } from '@clack/prompts'

import { ensureConfigBootstrap } from '../utils/bootstrap'
import { getProjectPath } from '../utils/paths'
import { runStart } from './start'

type SetupOptions = {
  yes?: boolean
  start?: boolean
}

const ensureEnvFile = async (assumeYes: boolean): Promise<void> => {
  const envPath = getProjectPath('.env')
  const envExamplePath = getProjectPath('.env.example')

  if (fs.existsSync(envPath)) {
    return
  }

  if (fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath)
  } else {
    fs.writeFileSync(envPath, '', 'utf-8')
  }

  const current = fs.readFileSync(envPath, 'utf-8')
  if (current.includes('SECRET=')) {
    return
  }

  let secret = process.env.SECRET

  if (!assumeYes && process.stdin.isTTY) {
    const value = await text({
      message: 'SECRET env var value (hex recommended)',
      placeholder: 'openssl rand -hex 128',
      defaultValue: secret,
      validate: (input) => (input.trim() ? undefined : 'SECRET is required'),
    })

    if (isCancel(value)) {
      cancel('Setup cancelled')
      process.exitCode = 1
      return
    }

    secret = value
  }

  if (!secret) {
    throw new Error('SECRET is required. Set SECRET env var or run setup interactively.')
  }

  fs.appendFileSync(envPath, `\nSECRET=${secret}\n`, 'utf-8')
}

export const runSetup = async (options: SetupOptions): Promise<number> => {
  intro('Nostream setup')

  ensureConfigBootstrap()
  await ensureEnvFile(Boolean(options.yes))

  let shouldStart = Boolean(options.start)

  if (!options.yes && !options.start && process.stdin.isTTY) {
    const answer = await confirm({ message: 'Start relay now?', initialValue: true })
    if (isCancel(answer)) {
      cancel('Setup cancelled')
      return 1
    }

    shouldStart = answer
  }

  if (shouldStart) {
    const code = await runStart({}, [])
    outro(code === 0 ? 'Setup complete' : 'Setup finished with errors')
    return code
  }

  outro('Setup complete')
  return 0
}
