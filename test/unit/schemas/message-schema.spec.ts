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

    describe('AUTH', () => {
      let events: Event[]
      beforeEach(() => {
        events = getEvents()
      })

      it('returns same message if valid', () => {
        const event = events[0]
        message = ['AUTH', event] as any

        const result = validateSchema(messageSchema)(message)
        expect(result.error).to.be.undefined
        expect(result).to.have.deep.property('value', message)
      })

      it('returns error if event is missing', () => {
        message = ['AUTH'] as any

        const result = validateSchema(messageSchema)(message)
        expect(result).to.have.property('error').that.is.not.undefined
      })

      it('returns error if event is not an object', () => {
        message = ['AUTH', 'not-an-event'] as any

        const result = validateSchema(messageSchema)(message)
        expect(result).to.have.property('error').that.is.not.undefined
      })

      it('returns error if event is null', () => {
        message = ['AUTH', null] as any

        const result = validateSchema(messageSchema)(message)
        expect(result).to.have.property('error').that.is.not.undefined
      })
    })
  })
})

describe('NIP-77', () => {
  const valid = {
    open: ['NEG-OPEN', 'sync1', { kinds: [1], since: 1000 }, '61000002'],
    msg: ['NEG-MSG', 'sync1', '6100000200'],
    close: ['NEG-CLOSE', 'sync1'],
  }
  const check = (message: unknown) => validateSchema(messageSchema)(message as any)

  describe('NEG-OPEN', () => {
    it('returns same message if valid', () => {
      const result = check(valid.open)

      expect(result.error).to.be.undefined
      expect(result).to.have.deep.property('value', valid.open)
    })

    it('accepts uppercase hex', () => {
      expect(check(['NEG-OPEN', 'sync1', {}, 'ABCDEF01']).error).to.be.undefined
    })

    for (const [name, mutate] of [
      ['subscription id is missing', (m: any[]) => m.splice(1, 1)],
      ['subscription id is empty', (m: any[]) => (m[1] = '')],
      ['subscription id is longer than 256 characters', (m: any[]) => (m[1] = 'a'.repeat(257))],
      ['filter is missing', (m: any[]) => m.splice(2, 1)],
      ['filter is an array of filters', (m: any[]) => (m[2] = [{}])],
      ['filter is not an object', (m: any[]) => (m[2] = null)],
      ['initial message is missing', (m: any[]) => m.splice(3, 1)],
      ['initial message is empty', (m: any[]) => (m[3] = '')],
      ['initial message is not hex', (m: any[]) => (m[3] = 'zz')],
      ['initial message has an odd number of hex digits', (m: any[]) => (m[3] = '610')],
      ['there are extra elements', (m: any[]) => m.push('extra')],
    ] as [string, (m: any[]) => void][]) {
      it(`returns error if ${name}`, () => {
        const message = JSON.parse(JSON.stringify(valid.open))
        mutate(message)

        expect(check(message)).to.have.property('error').that.is.not.undefined
      })
    }
  })

  describe('NEG-MSG', () => {
    it('returns same message if valid', () => {
      const result = check(valid.msg)

      expect(result.error).to.be.undefined
      expect(result).to.have.deep.property('value', valid.msg)
    })

    for (const [name, message] of [
      ['subscription id is empty', ['NEG-MSG', '', '6100']],
      ['payload is not hex', ['NEG-MSG', 'sync1', 'not hex']],
      ['payload is empty', ['NEG-MSG', 'sync1', '']],
      ['payload is missing', ['NEG-MSG', 'sync1']],
    ] as [string, unknown[]][]) {
      it(`returns error if ${name}`, () => {
        expect(check(message)).to.have.property('error').that.is.not.undefined
      })
    }
  })

  describe('NEG-CLOSE', () => {
    it('returns same message if valid', () => {
      const result = check(valid.close)

      expect(result.error).to.be.undefined
      expect(result).to.have.deep.property('value', valid.close)
    })

    it('returns error if subscription id is missing or empty', () => {
      expect(check(['NEG-CLOSE'])).to.have.property('error').that.is.not.undefined
      expect(check(['NEG-CLOSE', ''])).to.have.property('error').that.is.not.undefined
    })
  })

  it('does not accept NEG-ERR from a client', () => {
    expect(check(['NEG-ERR', 'sync1', 'blocked: no'])).to.have.property('error').that.is.not.undefined
  })
})
