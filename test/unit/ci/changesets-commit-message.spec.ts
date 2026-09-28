import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'

import chai from 'chai'

const { expect } = chai

type CommitModule = {
  getAddMessage: (changeset: { summary: string }, options: unknown) => string
  getVersionMessage: (releasePlan: { releases: unknown[] }, options: unknown) => string
}

describe('changesets commit message', () => {
  const config = JSON.parse(readFileSync(join(process.cwd(), '.changeset', 'config.json'), 'utf-8')) as {
    commit: unknown
  }

  // createRequire works whether mocha loads this spec as CommonJS or as an ES
  // module, which `require` itself does not.
  const loadFromRepo = createRequire(join(process.cwd(), 'index.js'))

  // Changesets resolves the specifier in the `commit` tuple as if it were
  // imported from `<repo>/.changeset/x.mjs`, so that is the base used here too.
  const commitModule = (): CommitModule => {
    expect(config.commit, '`commit` in .changeset/config.json must be a [module, options] tuple').to.be.an('array')
    const specifier = (config.commit as unknown[])[0]
    expect(specifier, 'that tuple must name a module').to.be.a('string')

    return loadFromRepo(join(process.cwd(), '.changeset', specifier as string)) as CommitModule
  }

  // The options Changesets actually passes to the module, so a change to them
  // (say `skipCI: true`) cannot quietly put `[skip ci]` back on the version
  // commit without failing these assertions.
  const configuredOptions = (config.commit as unknown[])[1] ?? null

  const releasePlan = {
    releases: [
      { name: 'nostream', type: 'minor', oldVersion: '3.0.0', newVersion: '3.1.0' },
      { name: 'nostream-extra', type: 'none', oldVersion: '1.0.0', newVersion: '1.0.0' },
    ],
  }

  // The stock message is `RELEASING: Releasing N package(s)`, which commitlint
  // rejects for type-case and type-enum.
  it('writes a conventional subject', () => {
    expect(commitModule().getVersionMessage(releasePlan, configuredOptions)).to.equal('chore: release nostream@3.1.0')
  })

  // `[skip ci]` makes GitHub skip both push and pull_request runs for the
  // commit, which is why the version PR's required checks never reported.
  it('writes no [skip ci]', () => {
    expect(commitModule().getVersionMessage(releasePlan, configuredOptions)).not.to.include('skip ci')
  })

  it('names only the packages that are actually released', () => {
    expect(commitModule().getVersionMessage(releasePlan, configuredOptions)).not.to.include('nostream-extra')
  })

  it('still honours skipCI when it is asked for', () => {
    expect(commitModule().getVersionMessage(releasePlan, { skipCI: true })).to.include('[skip ci]')
  })

  it('keeps changeset add conventional', () => {
    expect(commitModule().getAddMessage({ summary: 'a summary' }, { skipCI: false })).to.equal(
      'docs(changeset): a summary',
    )
  })
})
