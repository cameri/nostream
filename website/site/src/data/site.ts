import pkg from '../../../../package.json'

export const REPO = 'https://github.com/cameri/nostream'
/** Agent build spec for deploying nostream, added in cameri/schematics#99. */
export const SCHEMATIC = {
  name: 'run-a-decentralized-social-network-relay',
  version: '0.1.0',
  category: 'infrastructure',
  source: './schematics/run-a-decentralized-social-network-relay',
  description:
    'A production Nostr relay (nostream) on Docker — host prep, Postgres and Redis, GHCR image pinning, migrations-before-start, loopback HTTP, reverse-proxy sketches, NIP-11 and /readyz probes, optional settings and tailnet exposure.',
  spec: 'https://schemaformat.ai/schematics/run-a-decentralized-social-network-relay/SCHEMATIC.md',
  github: 'https://github.com/cameri/schematics/tree/main/schematics/run-a-decentralized-social-network-relay',
  catalog: 'https://schemaformat.ai/#catalog',
}
export const VERSION: string = pkg.version
export const SUPPORTED_NIPS: number[] = pkg.supportedNips
export const SUPPORTED_MIPS: number[] = pkg.supportedMips ?? []

export const NAV = [
  { href: '/docs', label: 'Docs' },
  { href: '/community', label: 'Community' },
  { href: '/changelog', label: 'Changelog' },
]

/** Repository markdown rendered under /docs/<slug>. Paths are relative to the repo root. */
export const DOCS = [
  {
    slug: 'setup',
    file: 'docs/SETUP.md',
    title: 'Production setup guide',
    group: 'Start here',
    blurb:
      'Step-by-step production setup: host requirements, bootstrap, compose, reverse proxy with TLS, and verification.',
  },
  {
    slug: 'quick-start',
    file: 'README.md',
    title: 'Quick start',
    group: 'Start here',
    blurb: 'Requirements, Docker Compose and standalone setup, payments and maintenance.',
  },
  {
    slug: 'cli',
    file: 'CLI.md',
    title: 'CLI reference',
    group: 'Start here',
    blurb: 'nostream start, info, config, import/export, invites and the interactive TUI.',
  },
  {
    slug: 'configuration',
    file: 'CONFIGURATION.md',
    title: 'Configuration',
    group: 'Operate',
    blurb: 'Every environment variable and settings.yaml key, with defaults.',
  },
  {
    slug: 'deploy',
    file: 'deploy/README.md',
    title: 'Production deployment',
    group: 'Deploy',
    blurb: 'Minimal Compose stack on a pre-built GHCR image. Bootstrap, settings, services.',
  },
  {
    slug: 'deploy-runbook',
    file: 'docs/DEPLOY-RUNBOOK.md',
    title: 'Deploy runbook & HAProxy',
    group: 'Deploy',
    blurb: 'Single-relay and blue/green rollouts, verification, rollback.',
  },
  {
    slug: 'container-publishing',
    file: 'docs/DEPLOYMENT.md',
    title: 'Container publishing',
    group: 'Deploy',
    blurb: 'How images are built and published from CI.',
  },
  {
    slug: 'redis',
    file: 'docs/REDIS.md',
    title: 'Redis',
    group: 'Operate',
    blurb: 'Cache, rate limiting and broadcast fan-out. ACL setup and troubleshooting.',
  },
  {
    slug: 'contributing',
    file: 'CONTRIBUTING.md',
    title: 'Contributing',
    group: 'Project',
    blurb: 'Local development, tests and the changeset workflow.',
  },
  {
    slug: 'security',
    file: 'SECURITY.md',
    title: 'Security policy',
    group: 'Project',
    blurb: 'Supported versions and how to report a vulnerability.',
  },
] as const

export const NIP_TITLES: Record<number, string> = {
  1: 'Basic protocol flow',
  2: 'Follow list',
  3: 'OpenTimestamps attestations',
  4: 'Encrypted direct messages',
  5: 'DNS-based identifiers',
  9: 'Event deletion',
  11: 'Relay information document',
  12: 'Generic tag queries',
  13: 'Proof of work',
  14: 'Subject tag',
  15: 'End of stored events',
  16: 'Event treatment',
  17: 'Private direct messages',
  20: 'Command results',
  22: 'created_at limits',
  25: 'Reactions',
  28: 'Public chat',
  33: 'Addressable events',
  40: 'Expiration timestamp',
  42: 'Client authentication',
  43: 'Relay access & invites',
  44: 'Encrypted payloads',
  45: 'Event counts',
  50: 'Search',
  62: 'Request to vanish',
  65: 'Relay list metadata',
  66: 'Relay discovery & monitoring',
}

export const nipUrl = (n: number) =>
  `https://github.com/nostr-protocol/nips/blob/master/${String(n).padStart(2, '0')}.md`
