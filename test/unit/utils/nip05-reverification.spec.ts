import { expect } from 'chai'
import Sinon from 'sinon'

import { Nip05Verification } from '../../../src/@types/nip05'
import * as nip05 from '../../../src/utils/nip05'
import { reverifyNip05Verification } from '../../../src/utils/nip05-reverification'

const baseVerification = (): Nip05Verification => ({
  pubkey: 'aa'.repeat(32),
  nip05: 'user@example.com',
  domain: 'example.com',
  isVerified: false,
  lastVerifiedAt: null,
  lastCheckedAt: new Date('2024-01-01T00:00:00.000Z'),
  failureCount: 1,
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
})

describe('reverifyNip05Verification', () => {
  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('does not upsert when the nip05 identity changed during verification', async () => {
    const verification = baseVerification()
    const repository = {
      findByPubkey: sandbox.stub().resolves({
        ...verification,
        nip05: 'other@example.com',
      }),
      upsert: sandbox.stub().resolves(1),
    }

    sandbox.stub(nip05, 'verifyNip05Identifier').resolves({ status: 'verified' })

    const result = await reverifyNip05Verification(verification, repository as any)

    expect(result.nip05).to.equal('other@example.com')
    expect(repository.upsert).to.not.have.been.called
  })

  it('upserts when the stored row still matches the requested nip05', async () => {
    const verification = baseVerification()
    const repository = {
      findByPubkey: sandbox.stub().resolves({ ...verification }),
      upsert: sandbox.stub().resolves(1),
    }

    sandbox.stub(nip05, 'verifyNip05Identifier').resolves({ status: 'verified' })

    await reverifyNip05Verification(verification, repository as any)

    expect(repository.upsert).to.have.been.calledOnce
  })
})
