import chai from 'chai'
import { readFileSync, readdirSync } from 'fs'
import yaml from 'js-yaml'
import { join } from 'path'

const { expect } = chai

/**
 * One node base image, pinned by digest, everywhere this repo names one.
 *
 * #1005 pinned the build stages of `Dockerfile` while `Dockerfile.railwayapp`,
 * `Dockerfile.test` and both compose files still said `node:24-alpine`, so the
 * relay image, the CI image, the Railway image and the two migration containers
 * could each start from a different base. A floating tag also moves under a
 * release: the same commit built twice can run different node code. A tag alone
 * is not enough for the same reason, which is why the digest is required too.
 *
 * When the base moves, it moves in every file in the same commit — this test is
 * the thing that makes that true instead of hoped for.
 */

type Compose = { services?: Record<string, { image?: string }> }

const NODE_REF = /^node:/
const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/

const dockerfiles = (): string[] =>
  readdirSync(process.cwd())
    .filter((file) => /^Dockerfile(\.[\w-]+)?$/.test(file))
    .sort()

const composeFiles = (): string[] => {
  const roots = readdirSync(process.cwd()).filter((file) => /^docker-compose(\.[\w-]+)?\.ya?ml$/.test(file))
  const integration = readdirSync(join(process.cwd(), 'test/integration'))
    .filter((file) => /^docker-compose(\.[\w-]+)?\.ya?ml$/.test(file))
    .map((file) => join('test/integration', file))

  return [...roots, ...integration].sort()
}

/** Every `FROM node:…` and `image: node:…` in the repo, with where it came from. */
const references = (): Array<{ where: string; ref: string }> => [
  ...dockerfiles().flatMap((file) =>
    readFileSync(join(process.cwd(), file), 'utf-8')
      .split('\n')
      .map((line, index) => ({ line, where: `${file}:${index + 1}` }))
      .filter(({ line }) => /^FROM\s/.test(line))
      .map(({ line, where }) => ({ where, ref: line.split(/\s+/)[1] }))
      .filter(({ ref }) => NODE_REF.test(ref))
  ),
  ...composeFiles().flatMap((file) => {
    const services = (yaml.load(readFileSync(join(process.cwd(), file), 'utf-8')) as Compose).services ?? {}

    return Object.entries(services)
      .filter(([, service]) => NODE_REF.test(service.image ?? ''))
      .map(([name, service]) => ({ where: `${file}: ${name}`, ref: service.image as string }))
  })
]

describe('node base image pin', () => {
  const refs = references()

  it('finds the base image wherever it is named', () => {
    // A glob that silently matches nothing would make every check below pass.
    expect(refs.map(({ where }) => where)).to.include.members([
      'Dockerfile:3',
      'Dockerfile.railwayapp:4',
      'docker-compose.yml: nostream-migrate',
      'test/integration/docker-compose.yml: migrations-test'
    ])
  })

  it('pins each one by digest', () => {
    expect(refs.filter(({ ref }) => !DIGEST_PINNED.test(ref)).map(({ where, ref }) => `${where} -> ${ref}`)).to.deep.equal(
      []
    )
  })

  it('uses the same reference everywhere', () => {
    expect([...new Set(refs.map(({ ref }) => ref))]).to.have.length(1)
  })
})
