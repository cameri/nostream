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

console.log(`Verified CLI build entrypoint: ${relBin}`)
