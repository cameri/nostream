import { readFileSync } from 'fs'

const cache = new Map<string, string>()

/**
 * Return the raw content of a template file.
 * The file is read from disk exactly once; subsequent calls return the cached
 * string without any I/O, keeping template reads off the hot request path.
 */
export const getTemplate = (path: string): string => {
  let template = cache.get(path)
  if (template === undefined) {
    template = readFileSync(path, 'utf8')
    cache.set(path, template)
  }
  return template
}
