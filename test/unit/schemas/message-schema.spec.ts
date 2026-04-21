import { expect } from 'chai'
import { range } from 'ramda'

import { Event } from '../../../src/@types/event'
import { getEvents } from '../data/events'
import { IncomingMessage } from '../../../src/@types/messages'
import { messageSchema } from '../../../src/schemas/message-schema'
import { validateSchema } from '../../../src/utils/validation'

describe('NIP-01', () => {
  let message: IncomingMessage
  describe('validateSchema', () => {
    describe('EVENT', () => {
      let events: Event[]
      beforeEach(() => {
        events = getEvents()
      })

      it('returns same message if valid', () => {
        events.forEach((event) => {
          message = ['EVENT', event] as any

          const result = validateSchema(messageSchema)(message)

          expect(result.error).to.be.undefined
          expect(result).to.have.deep.property('value', message)
        })
      })
    })

    describe('CLOSE', () => {
      it('returns same message if valid', () => {
        message = ['CLOSE', 'id'] as any

        const result = validateSchema(messageSchema)(message)

        expect(result.error).to.be.undefined
        expect(validateSchema(messageSchema)(message)).to.have.deep.property('value', message)
      })

      it('returns error if subscription ID is missing', () => {
        message = ['CLOSE'] as any

        const result = validateSchema(messageSchema)(message)

        expect(result).to.have.property('error').that.is.not.undefined
      })
    })

    describe('REQ', () => {
      beforeEach(() => {
        message = [
          'REQ',
          'id',
          {
            ids: ['aaaa', 'bbbb', 'cccc'],
            authors: ['aaaa', 'bbbb', 'cccc'],
            kinds: [0, 1, 2, 3],
            since: 1000,
            until: 1000,
            limit: 100,
            '#e': ['aa', 'bb', 'cc'],
            '#p': ['dd', 'ee', 'ff'],
            '#r': ['00', '11', '22'],
          },
          {
            ids: ['aaaa', 'bbbb', 'cccc'],
            authors: ['aaaa', 'bbbb', 'cccc'],
            kinds: [0, 1, 2, 3],
            since: 1000,
            until: 1000,
            limit: 100,
            '#e': ['aa', 'bb', 'cc'],
            '#p': ['dd', 'ee', 'ff'],
            '#r': ['00', '11', '22'],
          },
        ] as any
      })

      it('returns same message if valid', () => {
        const result = validateSchema(messageSchema)(message)
        expect(result.error).to.be.undefined
        expect(result).to.have.deep.property('value', message)
      })

      it('returns error if subscription Id is missing', () => {
        message[1] = null

        const result = validateSchema(messageSchema)(message)
        expect(result).to.have.property('error').that.is.not.undefined
      })

      it('returns error if filter is not an object', () => {
        message[2] = null

        const result = validateSchema(messageSchema)(message)
        expect(result).to.have.property('error').that.is.not.undefined
      })

      it('returns error if filter is missing', () => {
        ;(message as any[]).splice(2, 2)

        const result = validateSchema(messageSchema)(message)
        expect(result).to.have.property('error').that.is.not.undefined
      })

      it('returns error if there are too many filters', () => {
        ;(message as any[]).splice(2, 2)
        ;(message as any[]).push(...range(0, 11).map(() => ({})))

        const result = validateSchema(messageSchema)(message)
        expect(result).to.have.property('error').that.is.not.undefined
      })
    })

    describe('COUNT', () => {
      beforeEach(() => {
        message = [
          'COUNT',
          'id',
          {
            ids: ['aaaa', 'bbbb', 'cccc'],
            authors: ['aaaa', 'bbbb', 'cccc'],
            kinds: [0, 1, 2, 3],
            since: 1000,
            until: 1000,
            limit: 100,
            '#e': ['aa', 'bb', 'cc'],
            '#p': ['dd', 'ee', 'ff'],
            '#r': ['00', '11', '22'],
          },
        ] as any
      })

      it('returns same message if valid', () => {
        const result = validateSchema(messageSchema)(message)
        expect(result.error).to.be.undefined
        expect(result).to.have.deep.property('value', message)
      })

      it('returns error if query ID is missing', () => {
        message[1] = null

        const result = validateSchema(messageSchema)(message)
        expect(result).to.have.property('error').that.is.not.undefined
      })

      it('returns error if filter is missing', () => {
        ;(message as any[]).splice(2, 1)

        const result = validateSchema(messageSchema)(message)
        expect(result).to.have.property('error').that.is.not.undefined
      })

      it('returns error if filter is not an object', () => {
        message[2] = null

        const result = validateSchema(messageSchema)(message)
        expect(result).to.have.property('error').that.is.not.undefined
      })

      it('returns error if there are too many filters', () => {
        ;(message as any[]).splice(2, 1)
        ;(message as any[]).push(...range(0, 11).map(() => ({})))

        const result = validateSchema(messageSchema)(message)
        expect(result).to.have.property('error').that.is.not.undefined
      })
    })
  })
})
