import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Same source of truth as the website (`package.json` → `supportedNips`). */
export const readSupportedNipCount = (): number => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    supportedNips: number[]
  }
  return pkg.supportedNips.length
}

export const REPO_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json')
