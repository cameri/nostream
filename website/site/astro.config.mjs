import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'

const SITE_ROOT = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SITE_ROOT, '..', '..')
const REPO_BLOB = 'https://github.com/cameri/nostream/blob/main'

// Keep in sync with DOCS in src/data/site.ts (config files cannot import TS).
const DOC_ROUTES = {
  'README.md': '/docs/quick-start',
  'CLI.md': '/docs/cli',
  'CONFIGURATION.md': '/docs/configuration',
  'deploy/README.md': '/docs/deploy',
  'docs/DEPLOY-RUNBOOK.md': '/docs/deploy-runbook',
  'docs/DEPLOYMENT.md': '/docs/container-publishing',
  'docs/REDIS.md': '/docs/redis',
  'CONTRIBUTING.md': '/docs/contributing',
  'SECURITY.md': '/docs/security',
  'CHANGELOG.md': '/changelog',
}

/** Rewrite relative links in repo markdown to site routes, or to GitHub when the target is not published here. */
function rehypeRepoLinks() {
  return (tree, file) => {
    const source = file.path ? path.relative(REPO_ROOT, file.path) : 'README.md'
    const dir = path.posix.dirname(source.split(path.sep).join('/'))

    const visit = (node) => {
      if (node.type === 'element' && node.tagName === 'a' && typeof node.properties?.href === 'string') {
        const href = node.properties.href
        if (!/^([a-z]+:|#|\/)/i.test(href)) {
          const [target, hash] = href.split('#')
          const resolved = path.posix.normalize(path.posix.join(dir, target))
          const route = DOC_ROUTES[resolved]
          node.properties.href = route
            ? `${route}${hash ? `#${hash}` : ''}`
            : `${REPO_BLOB}/${resolved}${hash ? `#${hash}` : ''}`
        }
        if (/^https?:/i.test(node.properties.href)) {
          node.properties.target = '_blank'
          node.properties.rel = 'noopener noreferrer'
        }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://nostream.dev',
  // PR previews build under /preview/<n>; empty when unset (production).
  base: process.env.SITE_BASE || undefined,
  markdown: {
    rehypePlugins: [rehypeRepoLinks],
    shikiConfig: { theme: 'github-dark-default', wrap: false },
  },
  vite: {
    server: { fs: { allow: [REPO_ROOT] } },
  },
})
