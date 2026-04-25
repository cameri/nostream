import fs from 'fs'
import { randomBytes } from 'crypto'
import { intro, outro, confirm, text, isCancel, cancel } from '@clack/prompts'

import { ensureConfigBootstrap } from '../utils/bootstrap'
import { getProjectPath } from '../utils/paths'
import { runStart } from './start'

type SetupOptions = {
  yes?: boolean
  start?: boolean
}

const SECRET_PLACEHOLDER = 'change_me_to_something_long_and_random'

const readEnvSecret = (content: string): string | undefined => {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.startsWith('SECRET=')) {
      continue
    }

    const [rawValue] = trimmed.slice('SECRET='.length).split('#', 1)
    return rawValue.trim()
  }

  return undefined
}

const needsSecretReplacement = (secret: string | undefined): boolean => {
  return !secret || secret === SECRET_PLACEHOLDER
}

const resolveSecret = async (assumeYes: boolean): Promise<string> => {
  if (process.env.SECRET?.trim()) {
    return process.env.SECRET.trim()
  }

  if (!assumeYes && process.stdin.isTTY) {
    const value = await text({
      message: 'SECRET env var value (hex recommended)',
      placeholder: 'openssl rand -hex 128',
      validate: (input) => (input.trim() ? undefined : 'SECRET is required'),
    })

    if (isCancel(value)) {
      cancel('Setup cancelled')
      throw new Error('SETUP_CANCELLED')
    }

    return value.trim()
  }

  return randomBytes(64).toString('hex')
}

const upsertSecret = (content: string, secret: string): string => {
  const normalized = content.length > 0 ? content : ''
  const lines = normalized.split(/\r?\n/)
  let replaced = false

  const nextLines = lines.map((line) => {
    if (replaced) {
      return line
    }

    const trimmed = line.trim()
    if (!trimmed.startsWith('SECRET=') || trimmed.startsWith('#')) {
      return line
    }

    replaced = true
    const commentIndex = line.indexOf('#')
    const commentSuffix = commentIndex >= 0 ? line.slice(commentIndex).trimEnd() : ''
    return commentSuffix ? `SECRET=${secret} ${commentSuffix}` : `SECRET=${secret}`
  })

  if (!replaced) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== '') {
      nextLines.push(`SECRET=${secret}`)
    } else if (nextLines.length === 0) {
      nextLines.push(`SECRET=${secret}`)
    } else {
      nextLines[nextLines.length - 1] = `SECRET=${secret}`
      nextLines.push('')
    }
  }

  return nextLines.join('\n')
}

const ensureEnvFile = async (assumeYes: boolean): Promise<void> => {
  const envPath = getProjectPath('.env')
  const envExamplePath = getProjectPath('.env.example')

  if (!fs.existsSync(envPath)) {
    if (fs.existsSync(envExamplePath)) {
      fs.copyFileSync(envExamplePath, envPath)
    } else {
      fs.writeFileSync(envPath, '', 'utf-8')
    }
  }

  const current = fs.readFileSync(envPath, 'utf-8')

  if (!needsSecretReplacement(readEnvSecret(current))) {
    return
  }

  let secret: string
  try {
    secret = await resolveSecret(assumeYes)
  } catch (error) {
    if (error instanceof Error && error.message === 'SETUP_CANCELLED') {
      process.exitCode = 1
      return
    }
    throw error
  }

  fs.writeFileSync(envPath, upsertSecret(current, secret), 'utf-8')
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
