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

export const setupPrompts = {
  intro,
  outro,
  confirm,
  text,
  isCancel,
  cancel,
}

class SetupCancelledError extends Error {
  constructor() {
    super('Setup cancelled')
    this.name = 'SetupCancelledError'
  }
}

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
    const value = await setupPrompts.text({
      message: 'SECRET env var value (hex recommended)',
      placeholder: 'openssl rand -hex 128',
      validate: (input) => (input.trim() ? undefined : 'SECRET is required'),
    })

    if (setupPrompts.isCancel(value)) {
      setupPrompts.cancel('Setup cancelled')
      throw new SetupCancelledError()
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

const ensureEnvFile = async (assumeYes: boolean): Promise<boolean> => {
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
    return true
  }

  let secret: string
  try {
    secret = await resolveSecret(assumeYes)
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      return false
    }
    throw error
  }

  fs.writeFileSync(envPath, upsertSecret(current, secret), 'utf-8')
  return true
}

export const runSetup = async (options: SetupOptions): Promise<number> => {
  setupPrompts.intro('Nostream setup')

  ensureConfigBootstrap()
  const shouldContinue = await ensureEnvFile(Boolean(options.yes))
  if (!shouldContinue) {
    return 1
  }

  let shouldStart = Boolean(options.start)

  if (!options.yes && !options.start && process.stdin.isTTY) {
    const answer = await setupPrompts.confirm({ message: 'Start relay now?', initialValue: true })
    if (setupPrompts.isCancel(answer)) {
      setupPrompts.cancel('Setup cancelled')
      return 1
    }

    shouldStart = answer
  }

  if (shouldStart) {
    const code = await runStart({}, [])
    setupPrompts.outro(code === 0 ? 'Setup complete' : 'Setup finished with errors')
    return code
  }

  setupPrompts.outro('Setup complete')
  return 0
}
