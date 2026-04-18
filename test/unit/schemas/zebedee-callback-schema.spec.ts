import { expect } from 'chai'
import { validateSchema } from '../../../src/utils/validation'
import { zebedeeCallbackBodySchema } from '../../../src/schemas/zebedee-callback-schema'

describe('Zebedee Callback Schema', () => {
  describe('zebedeeCallbackBodySchema', () => {
    const validBody = {
      id: 'some-id',
      status: 'completed',
      internalId: 'edfa27d49d2af37ee331e1225bb6ed1912c6d999281b36d8018ad99bc3573c29',
      amount: '1000',
      description: 'Test payment',
      unit: 'msats',
      invoice: {
        request: 'lnbc1...',
      },
    }

    it('returns no error if body is valid', () => {
      const result = validateSchema(zebedeeCallbackBodySchema)(validBody)
      expect(result.error).to.be.undefined
    })

    it('returns no error if body contains unknown additional fields', () => {
      const body = {
        ...validBody,
        extraProperty: true,
      }
      const result = validateSchema(zebedeeCallbackBodySchema)(body)
      expect(result.error).to.be.undefined
    })

    it('returns error if internalId is not a valid pubkey', () => {
      const body = { ...validBody, internalId: 'deadbeef' }
      const result = validateSchema(zebedeeCallbackBodySchema)(body)
      expect(result.error).to.exist
      expect(result.error?.issues[0].path).to.deep.equal(['internalId'])
    })
  })
})
