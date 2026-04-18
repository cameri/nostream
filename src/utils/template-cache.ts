import { readFileSync } from 'fs'

const cache = new Map<string, string>()
const isProd = process.env.NODE_ENV === 'production'

/**
 * Return the raw content of a template file.
 *
 * In production (NODE_ENV=production) the file is read from disk once and
 * cached for the lifetime of the process — no per-request I/O. Operators who
 * edit files under resources/ must restart the process for changes to take
 * effect.
 *
 * Outside of production the cache is bypassed so template edits are reflected
 * immediately without a restart.
 */
export const getTemplate = (path: string): string => {
  if (isProd) {
    let template = cache.get(path)
    if (template === undefined) {
      template = readFileSync(path, 'utf8')
      cache.set(path, template)
    }
    return template
  }

  return readFileSync(path, 'utf8')
}
