import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

const projectRoot = process.cwd()

type CliResult = {
  code: number
  stdout: string
  stderr: string
}

const runCli = (args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> => {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['dist/src/cli/index.js', ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...env,
      },
      stdio: 'pipe',
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      })
    })
  })
}

const runPnpmCli = (args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> => {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['run', 'cli', ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...env,
      },
      stdio: 'pipe',
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      })
    })
  })
}

const createShimCommand = (dir: string, name: string, scriptBody: string) => {
  const target = path.join(dir, name)
  fs.writeFileSync(
    target,
    ['#!/usr/bin/env bash', 'set -euo pipefail', scriptBody].join('\n'),
    'utf-8',
  )
  fs.chmodSync(target, 0o755)
}

const parsePackJsonOutput = <T>(output: string): T => {
  const start = output.search(/^\s*[\[{]/m)
  if (start === -1) {
    throw new Error(`No JSON payload found in pack output: ${output}`)
  }
  return JSON.parse(output.slice(start).trim()) as T
}

const runCommand = (command: string, args: string[]): Promise<CliResult> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: 'pipe',
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      })
    })
  })
}

describe('cli integration (spawn)', function () {
  this.timeout(30000)

  it('shows top-level help', async () => {
    const result = await runCli(['--help'])

    expect(result.code).to.equal(0)
    expect(result.stdout).to.include('Usage:')
    expect(result.stdout).to.include('config [...args]')
    expect(result.stdout).to.include('update [...args]')
    expect(result.stdout).to.include('clean')
  })

  it('supports pnpm run cli as the documented entry point', async () => {
    const result = await runPnpmCli(['--help'])

    expect(result.code).to.equal(0)
    expect(result.stdout).to.include('Usage:')
    expect(result.stdout).to.include('start [...args]')
  })

  it('keeps package bin mapping aligned with TypeScript build output path', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')) as {
      files?: string[]
      bin?: string | { nostream?: string }
    }
    const binPath = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.nostream
    expect(binPath).to.equal('./dist/src/cli/index.js')
    expect(pkg.files).to.include('dist')
  })

  it('packs the built CLI and runtime assets required for installation', async () => {
    const result = await runCommand('pnpm', ['pack', '--dry-run', '--json'])

    expect(result.code).to.equal(0)
    const packSummary = parsePackJsonOutput<{
      files: Array<{ path: string }>
    }>(result.stdout)
    const packedFiles = new Set(packSummary.files.map((file) => file.path))

    expect(packedFiles.has('package.json')).to.equal(true)
    expect(packedFiles.has('dist/src/cli/index.js')).to.equal(true)
    expect(packedFiles.has('resources/default-settings.yaml')).to.equal(true)
    expect(packedFiles.has('docker-compose.yml')).to.equal(true)
  })

  it('shows nested subcommand help', async () => {
    const configGet = await runCli(['config', 'get', '--help'])
    const devClean = await runCli(['dev', 'db:clean', '--help'])

    expect(configGet.code).to.equal(0)
    expect(configGet.stdout).to.include('Usage: nostream config get <path>')

    expect(devClean.code).to.equal(0)
    expect(devClean.stdout).to.include('Usage: nostream dev db:clean')
  })

  it('returns usage exit code for unknown command', async () => {
    const result = await runCli(['nope'])

    expect(result.code).to.equal(2)
    expect(result.stdout).to.include('Usage:')
  })

  it('prints help and exits 0 with no args in non-interactive mode', async () => {
    const result = await runCli([])

    expect(result.code).to.equal(0)
    expect(result.stdout).to.include('Usage:')
  })

  it('supports config set/get with indexed path and validation controls', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-cli-config-'))

    const setIndexed = await runCli(
      ['config', 'set', 'limits.event.content[0].maxLength', '2048'],
      { NOSTR_CONFIG_DIR: configDir },
    )
    expect(setIndexed.code).to.equal(0)

    const getIndexed = await runCli(
      ['config', 'get', 'limits.event.content[0].maxLength'],
      { NOSTR_CONFIG_DIR: configDir },
    )
    expect(getIndexed.code).to.equal(0)
    expect(getIndexed.stdout).to.include('2048')

    const setInvalidValidated = await runCli(
      ['config', 'set', 'limits.rateLimiter.strategy', 'broken-strategy'],
      { NOSTR_CONFIG_DIR: configDir },
    )
    expect(setInvalidValidated.code).to.equal(1)

    const getStrategyAfterReject = await runCli(
      ['config', 'get', 'limits.rateLimiter.strategy'],
      { NOSTR_CONFIG_DIR: configDir },
    )
    expect(getStrategyAfterReject.code).to.equal(0)
    expect(getStrategyAfterReject.stdout).to.include('ewma')

    const setInvalidNoValidate = await runCli(
      ['config', 'set', 'limits.rateLimiter.strategy', 'broken-strategy', '--no-validate'],
      { NOSTR_CONFIG_DIR: configDir },
    )
    expect(setInvalidNoValidate.code).to.equal(0)

    const getStrategyAfterNoValidate = await runCli(
      ['config', 'get', 'limits.rateLimiter.strategy'],
      { NOSTR_CONFIG_DIR: configDir },
    )
    expect(getStrategyAfterNoValidate.code).to.equal(0)
    expect(getStrategyAfterNoValidate.stdout).to.include('broken-strategy')
  })

  it('supports config set JSON mode', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-cli-json-'))

    const setResult = await runCli(
      ['config', 'set', 'nip05.domainWhitelist', '["example.com","relay.io"]', '--type', 'json'],
      { NOSTR_CONFIG_DIR: configDir },
    )

    expect(setResult.code).to.equal(0)

    const getResult = await runCli(
      ['config', 'get', 'nip05.domainWhitelist'],
      { NOSTR_CONFIG_DIR: configDir },
    )

    expect(getResult.code).to.equal(0)
    expect(getResult.stdout).to.include('example.com')
  })

  it('supports import/export aliases and format flags in help', async () => {
    const importHelp = await runCli(['import', '--help'])
    const exportHelp = await runCli(['export', '--help'])
    const startHelp = await runCli(['start', '--help'])
    const infoHelp = await runCli(['info', '--help'])

    expect(importHelp.code).to.equal(0)
    expect(importHelp.stdout).to.include('--file <file>')
    expect(importHelp.stdout).to.include('Path to .jsonl/.json file')

    expect(exportHelp.code).to.equal(0)
    expect(exportHelp.stdout).to.include('--output <output>')
    expect(exportHelp.stdout).to.include('--compress')
    expect(exportHelp.stdout).to.include('--format <format>')
    expect(exportHelp.stdout).to.include('jsonl|json|gzip|gz|xz')

    expect(startHelp.code).to.equal(0)
    expect(startHelp.stdout).to.include('--nginx')

    expect(infoHelp.code).to.equal(0)
    expect(infoHelp.stdout).to.include('--i2p-hostname')
    expect(infoHelp.stdout).to.include('--json')
  })

  it('supports json output for info and config reads', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-cli-json-read-'))

    const infoResult = await runCli(['info', '--json'], { NOSTR_CONFIG_DIR: configDir })
    expect(infoResult.code).to.equal(0)
    expect(() => JSON.parse(infoResult.stdout)).to.not.throw()
    expect(JSON.parse(infoResult.stdout)).to.have.property('relay')

    const configListResult = await runCli(['config', 'list', '--json'], { NOSTR_CONFIG_DIR: configDir })
    expect(configListResult.code).to.equal(0)
    expect(() => JSON.parse(configListResult.stdout)).to.not.throw()
    expect(JSON.parse(configListResult.stdout)).to.have.property('payments')

    const configGetResult = await runCli(['config', 'get', 'payments.enabled', '--json'], {
      NOSTR_CONFIG_DIR: configDir,
    })
    expect(configGetResult.code).to.equal(0)
    expect(JSON.parse(configGetResult.stdout)).to.equal(false)
  })

  it('prints json errors for read failures in json mode', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-cli-json-error-'))

    const configGetResult = await runCli(['config', 'get', 'payments.fakeField', '--json'], {
      NOSTR_CONFIG_DIR: configDir,
    })
    expect(configGetResult.code).to.equal(1)
    expect(JSON.parse(configGetResult.stderr)).to.deep.equal({
      error: {
        message: 'Path not found: payments.fakeField',
        code: 1,
      },
    })
  })

  it('validates nginx start requirements', async () => {
    const result = await runCli(['start', '--nginx'])

    expect(result.code).to.equal(1)
    expect(result.stderr).to.include('RELAY_DOMAIN environment variable is required when using --nginx')
  })

  it('returns usage exit code for unsupported/unknown format flags', async () => {
    const importResult = await runCli(['import', '--format', 'yaml'])
    const exportResult = await runCli(['export', '--format', 'yaml'])
    const conflictingExportResult = await runCli(['export', '--format', 'json', '--compress'])

    expect(importResult.code).to.equal(1)
    expect(importResult.stderr).to.include('Unknown option `--format`')

    expect(exportResult.code).to.equal(2)
    expect(exportResult.stderr).to.include('Error: Unsupported format: yaml. Supported values: json, jsonl, gzip, gz, xz')
    expect(exportResult.stderr).to.include('Unsupported format: yaml')

    expect(conflictingExportResult.code).to.equal(2)
    expect(conflictingExportResult.stderr).to.include('Cannot combine --compress with --format json/jsonl')
  })

  it('rejects out-of-range start port values', async () => {
    const result = await runCli(['start', '--port', '70000'])

    expect(result.code).to.equal(1)
    expect(result.stderr).to.include('Port must be a safe integer between 1 and 65535')
  })

  it('invokes docker compose stack through start command using shims', async () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-cli-shim-docker-'))
    const logPath = path.join(shimDir, 'docker.log')
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-cli-shim-config-'))

    createShimCommand(
      shimDir,
      'docker',
      [
        `echo "$*" >> "${logPath}"`,
        'exit 0',
      ].join('\n'),
    )

    const result = await runCli(['start', '--tor', '--i2p', '--debug'], {
      PATH: `${shimDir}:${process.env.PATH}`,
      NOSTR_CONFIG_DIR: configDir,
    })

    expect(result.code).to.equal(0)

    const logs = fs.readFileSync(logPath, 'utf-8')
    expect(logs).to.include('compose')
    expect(logs).to.include('docker-compose.tor.yml')
    expect(logs).to.include('docker-compose.i2p.yml')
    expect(logs).to.include('up --build --remove-orphans')
  })

  it('cleans temporary port override compose files after start', async () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-cli-shim-port-'))
    const logPath = path.join(shimDir, 'docker.log')
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-cli-shim-port-config-'))

    createShimCommand(
      shimDir,
      'docker',
      [
        `echo "$*" >> "${logPath}"`,
        'exit 0',
      ].join('\n'),
    )

    const before = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('nostream-port-override-') && name.endsWith('.yml')).length

    const result = await runCli(['start', '--port', '9999'], {
      PATH: `${shimDir}:${process.env.PATH}`,
      NOSTR_CONFIG_DIR: configDir,
    })

    const after = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('nostream-port-override-') && name.endsWith('.yml')).length

    expect(result.code).to.equal(0)
    expect(after).to.equal(before)
  })

  it('supports config env subcommand help', async () => {
    const result = await runCli(['config', 'env', '--help'])

    expect(result.code).to.equal(0)
    expect(result.stdout).to.include('Usage: nostream config env <list|get|set|validate>')
  })

  it('runs legacy clean replacement command', async () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-cli-shim-clean-'))
    const logPath = path.join(shimDir, 'docker.log')
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-cli-shim-clean-config-'))

    createShimCommand(
      shimDir,
      'docker',
      [
        `echo "$*" >> "${logPath}"`,
        'exit 0',
      ].join('\n'),
    )

    const result = await runCli(['clean'], {
      PATH: `${shimDir}:${process.env.PATH}`,
      NOSTR_CONFIG_DIR: configDir,
    })

    expect(result.code).to.equal(0)

    const logs = fs.readFileSync(logPath, 'utf-8')
    expect(logs).to.include('compose')
    expect(logs).to.include('down')
    expect(logs).to.include('system prune -a -f')
    expect(logs).to.include('volume prune -f')
  })

  it('runs legacy update replacement command', async () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-cli-shim-update-'))
    const dockerLogPath = path.join(shimDir, 'docker.log')
    const gitLogPath = path.join(shimDir, 'git.log')
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-cli-shim-update-config-'))

    createShimCommand(
      shimDir,
      'docker',
      [
        `echo "$*" >> "${dockerLogPath}"`,
        'exit 0',
      ].join('\n'),
    )

    createShimCommand(
      shimDir,
      'git',
      [
        `echo "$*" >> "${gitLogPath}"`,
        'if [[ "$1" == "stash" && "$2" == "push" ]]; then',
        '  echo "No local changes to save"',
        'fi',
        'exit 0',
      ].join('\n'),
    )

    const result = await runCli(['update'], {
      PATH: `${shimDir}:${process.env.PATH}`,
      NOSTR_CONFIG_DIR: configDir,
    })

    expect(result.code).to.equal(0)

    const dockerLogs = fs.readFileSync(dockerLogPath, 'utf-8')
    expect(dockerLogs).to.include('compose')
    expect(dockerLogs).to.include('down')
    expect(dockerLogs).to.include('up --build --remove-orphans')

    const gitLogs = fs.readFileSync(gitLogPath, 'utf-8')
    expect(gitLogs).to.include('stash push -u -m nostream-cli-update')
    expect(gitLogs).to.include('pull')
  })
})
