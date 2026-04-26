#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const pkgPath = path.resolve(__dirname, '..', 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
const relBin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.nostream

if (!relBin) {
  console.error('package.json is missing bin.nostream')
  process.exit(1)
}

const binPath = path.resolve(__dirname, '..', relBin)
if (!fs.existsSync(binPath)) {
  console.error(`Built CLI entrypoint not found: ${binPath}`)
  process.exit(1)
}

const requiredPackedFiles = [
  'package.json',
  relBin.replace(/^\.\//, ''),
  'resources/default-settings.yaml',
  'docker-compose.yml',
]

const parsePackJsonOutput = (output) => {
  const start = output.search(/^\s*[\[{]/m)
  if (start === -1) {
    throw new Error('No JSON payload found in pack output')
  }
  return JSON.parse(output.slice(start).trim())
}

const result = spawnSync('node', [binPath, '--help'], {
  cwd: path.resolve(__dirname, '..'),
  env: process.env,
  encoding: 'utf-8',
})

if (result.status !== 0) {
  console.error(`Built CLI help check failed (exit ${result.status ?? 1})`)
  if (result.stdout) {
    process.stderr.write(result.stdout)
  }
  if (result.stderr) {
    process.stderr.write(result.stderr)
  }
  process.exit(result.status ?? 1)
}

if (!result.stdout.includes('Usage:')) {
  console.error('Built CLI help output did not contain Usage:')
  process.exit(1)
}

const packResult = spawnSync('pnpm', ['pack', '--dry-run', '--json'], {
  cwd: path.resolve(__dirname, '..'),
  env: process.env,
  encoding: 'utf-8',
})

if (packResult.status !== 0) {
  console.error(`pnpm pack dry-run failed (exit ${packResult.status ?? 1})`)
  if (packResult.stdout) {
    process.stderr.write(packResult.stdout)
  }
  if (packResult.stderr) {
    process.stderr.write(packResult.stderr)
  }
  process.exit(packResult.status ?? 1)
}

let packed
try {
  packed = parsePackJsonOutput(packResult.stdout)
} catch (error) {
  console.error('Failed to parse pnpm pack --json output')
  process.stderr.write(String(error))
  process.exit(1)
}

const files = new Set((packed?.files ?? []).map((file) => file.path))
for (const requiredFile of requiredPackedFiles) {
  if (!files.has(requiredFile)) {
    console.error(`Packed artifact is missing required file: ${requiredFile}`)
    process.exit(1)
  }
}

console.log(`Verified CLI build entrypoint and package contents: ${relBin}`)
