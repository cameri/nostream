import { expect } from 'chai'
import sinon from 'sinon'

import type { InviteCode } from '../../../src/@types/invite-code'
import type { IInviteCodeRepository } from '../../../src/@types/repositories'
import type { Settings } from '../../../src/@types/settings'
import {
  applyDbEnvFileDefaults,
  INVITE_CLI_DB_HINT,
  openInviteDbClient,
  runInviteCreate,
} from '../../../src/cli/commands/invite'
import * as envConfig from '../../../src/cli/utils/env-config'
import * as output from '../../../src/cli/utils/output'
import { toBech32 } from '../../../src/utils/transform'

describe('runInviteCreate', () => {
  const pubkey = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'
  const now = new Date('2026-08-15T12:00:00.000Z')

  const invite: InviteCode = {
    code: 'abc123deadbeef4567890000cafebabe',
    createdBy: pubkey,
    claimedBy: null,
    expiresAt: null,
    remainingUses: 1,
    createdAt: now,
    updatedAt: now,
  }

  let stdout = ''
  let issue: sinon.SinonStub
  let destroy: sinon.SinonStub
  let sandbox: sinon.SinonSandbox

  const settings = (overrides: Partial<Settings> = {}): Settings =>
    ({
      info: { self: pubkey, relay_url: 'wss://test.relay', name: 'test', pubkey: '', contact: '', description: '' },
      nip43: { enabled: false, defaultMaxUses: 1, inviteCodeExpiry: 0 },
      ...overrides,
    }) as Settings

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    stdout = ''
    sandbox.stub(output, 'logInfo').callsFake((message: string) => {
      stdout += `${message}\n`
    })
    issue = sandbox.stub().resolves(invite)
    destroy = sandbox.stub().resolves()
  })

  afterEach(() => {
    sandbox.restore()
  })

  const deps = (load: () => Settings = () => settings()) => ({
    loadSettings: load,
    issue,
    createDbClient: () => ({ destroy }) as any,
    createRepository: () => ({}) as IInviteCodeRepository,
    now: () => now.getTime(),
  })

  it('prints the code first so scripts can capture it', async () => {
    const code = await runInviteCreate({}, deps())

    expect(code).to.equal(0)
    expect(stdout.split('\n')[0]).to.equal(invite.code)
    expect(stdout).to.include('uses: 1')
    expect(stdout).to.include('expires: never')
    expect(destroy.calledOnce).to.equal(true)
  })

  it('prints JSON when requested', async () => {
    const code = await runInviteCreate({ json: true }, deps())

    expect(code).to.equal(0)
    expect(JSON.parse(stdout)).to.deep.equal({
      code: invite.code,
      createdBy: pubkey,
      claimedBy: null,
      expiresAt: null,
      remainingUses: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
  })

  it('passes CLI overrides and info.self as createdBy', async () => {
    await runInviteCreate({ uses: 4, expiresIn: 120 }, deps())

    expect(issue.calledOnce).to.equal(true)
    const [, nip43, overrides] = issue.firstCall.args
    expect(nip43).to.deep.equal({ enabled: false, defaultMaxUses: 1, inviteCodeExpiry: 0 })
    expect(overrides.remainingUses).to.equal(4)
    expect(overrides.expiresAt).to.deep.equal(new Date(now.getTime() + 120_000))
    expect(overrides.createdBy).to.equal(pubkey)
  })

  it('omits createdBy when info.self is the placeholder', async () => {
    await runInviteCreate(
      {},
      deps(() => settings({ info: { self: 'replace-with-your-relay-pubkey-in-hex' } } as any)),
    )

    expect(issue.firstCall.args[2].createdBy).to.equal(undefined)
  })

  it('decodes npub info.self into createdBy hex', async () => {
    await runInviteCreate(
      {},
      deps(() => settings({ info: { self: toBech32('npub')(pubkey) } } as any)),
    )

    expect(issue.firstCall.args[2].createdBy).to.equal(pubkey)
  })

  it('fails before minting when info.self is a malformed npub', async () => {
    try {
      await runInviteCreate(
        {},
        deps(() => settings({ info: { self: 'npub1invalid' } } as any)),
      )
      expect.fail('expected throw')
    } catch (error) {
      expect(issue.called).to.equal(false)
      expect((error as Error).message).to.not.include(INVITE_CLI_DB_HINT)
    }
  })

  it('still destroys the db client when issue throws', async () => {
    issue.rejects(new Error('insert failed'))

    try {
      await runInviteCreate({}, deps())
      expect.fail('expected throw')
    } catch (error) {
      expect((error as Error).message).to.equal('insert failed')
    }

    expect(destroy.calledOnce).to.equal(true)
  })

  it('appends the docker hint when postgres is unreachable', async () => {
    const connError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })
    issue.rejects(connError)

    try {
      await runInviteCreate({}, deps())
      expect.fail('expected throw')
    } catch (error) {
      expect((error as Error).message).to.include('ECONNREFUSED')
      expect((error as Error).message).to.include(INVITE_CLI_DB_HINT)
    }
  })

  it('appends the docker hint for knex acquire timeouts', async () => {
    issue.rejects(new Error('Knex: Timeout acquiring a connection. The pool is probably full.'))

    try {
      await runInviteCreate({}, deps())
      expect.fail('expected throw')
    } catch (error) {
      expect((error as Error).message).to.include(INVITE_CLI_DB_HINT)
    }
  })

  it('does not treat unrelated timeouts as unreachable postgres', async () => {
    issue.rejects(new Error('statement timeout'))

    try {
      await runInviteCreate({}, deps())
      expect.fail('expected throw')
    } catch (error) {
      expect((error as Error).message).to.equal('statement timeout')
    }
  })
})

describe('applyDbEnvFileDefaults', () => {
  let sandbox: sinon.SinonSandbox
  let previousHost: string | undefined
  let previousUri: string | undefined

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    previousHost = process.env.DB_HOST
    previousUri = process.env.DB_URI
    delete process.env.DB_HOST
    delete process.env.DB_URI
  })

  afterEach(() => {
    sandbox.restore()
    if (previousHost === undefined) {
      delete process.env.DB_HOST
    } else {
      process.env.DB_HOST = previousHost
    }
    if (previousUri === undefined) {
      delete process.env.DB_URI
    } else {
      process.env.DB_URI = previousUri
    }
  })

  it('fills missing DB_* from .env without overriding the process environment', () => {
    process.env.DB_HOST = 'from-process'
    sandbox.stub(envConfig, 'readEnvValues').returns({
      DB_HOST: 'from-file',
      DB_URI: '"postgresql://relay:relay@db:5432/relay"',
    })

    applyDbEnvFileDefaults()

    expect(process.env.DB_HOST).to.equal('from-process')
    expect(process.env.DB_URI).to.equal('postgresql://relay:relay@db:5432/relay')
  })

  it('fails loudly when PostgreSQL is not configured', () => {
    sandbox.stub(envConfig, 'readEnvValues').returns({})

    expect(() => openInviteDbClient()).to.throw('PostgreSQL is not configured')
    expect(() => openInviteDbClient()).to.throw(INVITE_CLI_DB_HINT)
  })
})
