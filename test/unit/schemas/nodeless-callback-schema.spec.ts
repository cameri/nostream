import { expect } from 'chai'
import { nodelessCallbackBodySchema } from '../../../src/schemas/nodeless-callback-schema'
import { validateSchema } from '../../../src/utils/validation'

describe('Nodeless Callback Schema', () => {
  describe('nodelessCallbackBodySchema', () => {
    const validBody = {
      uuid: 'some-uuid',
      status: 'paid',
      amount: 1000,
      metadata: {
        requestId: 'edfa27d49d2af37ee331e1225bb6ed1912c6d999281b36d8018ad99bc3573c29',
      },
    }

    it('returns no error if body is valid', () => {
      const result = validateSchema(nodelessCallbackBodySchema)(validBody)
      expect(result.error).to.be.undefined
    })

    it('returns no error if body contains additional metadata', () => {
      const body = {
        ...validBody,
        metadata: {
          ...validBody.metadata,
          createdAt: '2023-01-01T00:00:00Z',
          description: 'test payment',
          unit: 'sats',
        },
      }
      const result = validateSchema(nodelessCallbackBodySchema)(body)
      expect(result.error).to.be.undefined
    })

    it('returns error if uuid is missing', () => {
      const body = { ...validBody }
      delete (body as any).uuid
      const result = validateSchema(nodelessCallbackBodySchema)(body)
      expect(result.error).to.exist
      expect(result.error?.issues[0].path).to.deep.equal(['uuid'])
    })

    it('returns error if metadata.requestId is not a valid pubkey', () => {
      const body = { ...validBody, metadata: { requestId: 'deadbeef' } }
      const result = validateSchema(nodelessCallbackBodySchema)(body)
      expect(result.error).to.exist
      expect(result.error?.issues[0].path).to.deep.equal(['metadata', 'requestId'])
    })
  })
})
