import fs from 'fs'
import { join } from 'path'
import ora from 'ora'

import { StartOptions } from '../types'
import { ensureConfigBootstrap, ensureI2PDataDir, ensureNotRoot, ensureTorDataDir } from '../utils/bootstrap'
import { createPortOverrideComposeFile, runDockerCompose } from '../utils/docker'
import { logStep } from '../utils/output'
import { getProjectPath } from '../utils/paths'
import { runCommand } from '../utils/process'

const FQDN_REGEX =
  /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

const ensureNginxBootstrap = async (): Promise<void> => {
  const relayDomain = process.env.RELAY_DOMAIN?.trim()
  if (!relayDomain) {
    throw new Error(
      'RELAY_DOMAIN environment variable is required when using --nginx (example: RELAY_DOMAIN=relay.example.com).',
    )
  }

  if (!FQDN_REGEX.test(relayDomain)) {
    throw new Error('RELAY_DOMAIN must be a valid fully-qualified domain name when using --nginx.')
  }

  const certbotEmail = process.env.CERTBOT_EMAIL?.trim()
  if (!certbotEmail) {
    throw new Error(
      'CERTBOT_EMAIL environment variable is required when using --nginx (example: CERTBOT_EMAIL=you@example.com).',
    )
  }

  const nginxConfDir = getProjectPath('nginx', 'conf.d')
  const nginxTemplate = join(nginxConfDir, 'nostream.conf.template')
  const nginxConf = join(nginxConfDir, 'nostream.conf')

  const templateContent = fs.readFileSync(nginxTemplate, 'utf-8')
  const rendered = templateContent.replaceAll('${RELAY_DOMAIN}', relayDomain)
  fs.writeFileSync(nginxConf, rendered, { encoding: 'utf-8' })

  const sslCertDir = getProjectPath('nginx', 'ssl', 'live', relayDomain)
  const fullchainPath = join(sslCertDir, 'fullchain.pem')
  const privkeyPath = join(sslCertDir, 'privkey.pem')

  if (!fs.existsSync(fullchainPath) || !fs.existsSync(privkeyPath)) {
    fs.mkdirSync(sslCertDir, { recursive: true })

    const code = await runCommand('openssl', [
      'req',
      '-x509',
      '-nodes',
      '-newkey',
      'rsa:2048',
      '-days',
      '1',
      '-keyout',
      privkeyPath,
      '-out',
      fullchainPath,
      '-subj',
      `/CN=${relayDomain}`,
    ])

    if (code !== 0) {
      throw new Error('Failed to generate self-signed SSL certificate. Ensure openssl is installed and retry.')
    }
  }
}

export const runStart = async (options: StartOptions, passthrough: string[]): Promise<number> => {
  ensureNotRoot()

  const explicitPortFlag = process.argv.slice(2).some((arg) => arg === '--port' || arg.startsWith('--port='))
  const hasPort = typeof options.port === 'number' && Number.isFinite(options.port)
  if (explicitPortFlag && !hasPort) {
    throw new Error('Port must be a safe integer between 1 and 65535')
  }

  if (hasPort) {
    if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
      throw new Error('Port must be a safe integer between 1 and 65535')
    }
  }

  logStep('Preparing configuration')
  ensureConfigBootstrap()

  const composeFiles = ['docker-compose.yml']

  if (options.tor) {
    ensureTorDataDir()
    composeFiles.push('docker-compose.tor.yml')
  }

  if (options.i2p) {
    ensureI2PDataDir()
    composeFiles.push('docker-compose.i2p.yml')
  }

  if (options.nginx) {
    await ensureNginxBootstrap()
    composeFiles.push('docker-compose.nginx.yml')
  }

  let overrideFile: string | undefined
  if (hasPort) {
    overrideFile = createPortOverrideComposeFile(options.port)
    composeFiles.push(overrideFile)
  }

  const env: NodeJS.ProcessEnv = {}

  if (options.debug) {
    env.DEBUG = process.env.DEBUG || 'primary:*,worker:*,knex:*'
  }

  const spinner = ora('Starting relay...').start()
  const composePassthrough = passthrough.filter((arg) => arg !== '--')
  const upArgs = ['up', '--build', '--remove-orphans', ...(options.detach ? ['-d'] : []), ...composePassthrough]

  try {
    const code = await runDockerCompose({
      files: composeFiles,
      args: upArgs,
      env,
    })

    if (code === 0) {
      spinner.succeed('Relay start command completed')
    } else {
      spinner.fail('Relay start command failed')
    }

    return code
  } finally {
    if (overrideFile && fs.existsSync(overrideFile)) {
      fs.unlinkSync(overrideFile)
    }
  }
}
