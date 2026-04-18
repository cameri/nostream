#!/usr/bin/env node
/**
 * Validates docker-compose.yml merged with Tor / I2P overlays (config -q).
 * Requires Docker Desktop / Engine. Does not start containers.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

function resolveDockerExe() {
  if (process.env.DOCKER_EXE && existsSync(process.env.DOCKER_EXE)) {
    return process.env.DOCKER_EXE
  }
  if (process.platform === 'win32' && process.env.ProgramFiles) {
    const candidate = join(
      process.env.ProgramFiles,
      'Docker',
      'Docker',
      'resources',
      'bin',
      'docker.exe',
    )
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return 'docker'
}

const dockerExe = resolveDockerExe()

const dockerCheck = spawnSync(dockerExe, ['compose', 'version'], { encoding: 'utf8' })
if (dockerCheck.error || dockerCheck.status !== 0) {
  process.stderr.write(
    'docker is not installed or not on PATH. Install Docker Desktop / Engine, then run:\n' +
      '  npm run compose:validate\n' +
      'On Windows, ensure Docker Desktop is running, or set DOCKER_EXE to the full path to docker.exe.\n',
  )
  process.exit(1)
}

if (!process.env.SECRET || process.env.SECRET.length < 16) {
  process.env.SECRET =
    'ci_placeholder_not_for_production_use_repeat_to_64chars_aaaaaaaa'
}

const runs = [
  ['docker-compose.yml', 'docker-compose.i2p.yml'],
  ['docker-compose.yml', 'docker-compose.tor.yml'],
  ['docker-compose.yml', 'docker-compose.tor.yml', 'docker-compose.i2p.yml'],
]

for (const files of runs) {
  const args = ['compose']
  for (const f of files) {
    args.push('-f', f)
  }
  args.push('config', '-q')
  const label = files.join(' + ')
  process.stdout.write(`== ${label} ==\n`)
  const r = spawnSync(dockerExe, args, { stdio: 'inherit' })
  if (r.status !== 0) {
    process.stderr.write(`compose validation failed for: ${label}\n`)
    process.exit(r.status ?? 1)
  }
  process.stdout.write('OK\n')
}

process.stdout.write('All compose overlay merges validate successfully.\n')
