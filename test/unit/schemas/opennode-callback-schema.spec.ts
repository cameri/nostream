import { opennodeCallbackBodySchema, opennodeWebhookCallbackBodySchema } from '../../../src/schemas/opennode-callback-schema'
import { expect } from 'chai'
import { validateSchema } from '../../../src/utils/validation'

describe('OpenNode Callback Schema', () => {
  describe('opennodeWebhookCallbackBodySchema', () => {
    const validWebhookBody = {
      hashed_order: 'a'.repeat(64),
      id: 'some-id',
      status: 'paid',
    }

    it('returns no error if webhook body is valid', () => {
      const result = validateSchema(opennodeWebhookCallbackBodySchema)(validWebhookBody)
      expect(result.error).to.be.undefined
    })

    it('returns error if hashed_order is missing', () => {
      const body = { ...validWebhookBody }
      delete (body as any).hashed_order
      const result = validateSchema(opennodeWebhookCallbackBodySchema)(body)
      expect(result.error).to.exist
      expect(result.error?.issues[0].path).to.deep.equal(['hashed_order'])
    })

    it('returns error if status is not in accepted values', () => {
      const body = {
        ...validWebhookBody,
        status: 'not-a-valid-status',
      }
      const result = validateSchema(opennodeWebhookCallbackBodySchema)(body)
      expect(result.error).to.exist
      expect(result.error?.issues[0].path).to.deep.equal(['status'])
    })
  })

  describe('opennodeCallbackBodySchema', () => {
    const validBody = {
      id: 'some-id',
      status: 'paid',
      order_id: 'edfa27d49d2af37ee331e1225bb6ed1912c6d999281b36d8018ad99bc3573c29',
    }

    it('returns no error if body is valid', () => {
      const result = validateSchema(opennodeCallbackBodySchema)(validBody)
      expect(result.error).to.be.undefined
    })

    it('returns no error if body contains additional expected fields', () => {
      const body = {
        ...validBody,
        amount: 1000,
        created_at: 1672531200,
        lightning_invoice: { payreq: 'lnbc1...' },
      }
      const result = validateSchema(opennodeCallbackBodySchema)(body)
      expect(result.error).to.be.undefined
    })

    it('returns error if order_id is missing', () => {
      const body = { ...validBody }
      delete (body as any).order_id
      const result = validateSchema(opennodeCallbackBodySchema)(body)
      expect(result.error).to.exist
      expect(result.error?.issues[0].path).to.deep.equal(['order_id'])
    })
  })
})
