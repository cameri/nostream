

import { expect } from 'chai'
import { IncomingEventMessage } from '../../../src/@types/messages'
import { messageSchema } from '../../../src/schemas/message-schema'
import { validateSchema } from '../../../src/utils/validation'

describe('NIP-01', () => {
  let message: IncomingEventMessage
  describe('validate message schema', () => {
    it('returns message if EVENT message is valid', () => {
      message = [
        'EVENT',
        {
          'id': 'fa4dd948576fe182f5d0e3120b9df42c83dffa1c884754d5e4d3b0a2f98a01c5',
          'pubkey': 'edfa27d49d2af37ee331e1225bb6ed1912c6d999281b36d8018ad99bc3573c29',
          'created_at': 1660306803,
          'kind': 7,
          'tags': [
            [
              'e',
              'c58e83bb744e4c29642db7a5c3bd1519516ad5c51f6ba5f90c451d03c1961210',
              '',
              'root'
            ],
            [
              'e',
              'd0d78967b734628cec7bdfa2321c71c1f1c48e211b4b54333c3b0e94e7e99166',
              '',
              'reply'
            ],
            [
              'p',
              'edfa27d49d2af37ee331e1225bb6ed1912c6d999281b36d8018ad99bc3573c29'
            ],
            [
              'p',
              '32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245'
            ],
            [
              'e',
              '6fed2aae1e4f7d8b535774e4f7061c10e2ff20df1ef047da09462c7937925cd5'
            ],
            [
              'p',
              '2ef93f01cd2493e04235a6b87b10d3c4a74e2a7eb7c3caf168268f6af73314b5'
            ]
          ],
          'content': '',
          'sig': '313a9b8cd68267a51da84e292c0937d1f3686c6757c4584f50fcedad2b13fad755e6226924f79880fb5aa9de95c04231a4823981513ac9e7092bad7488282a96'
        }
      ] as any

      expect(validateSchema(messageSchema)(message)).to.have.deep.property('value', message)
    })

    it('returns message if CLOSE message is valid', () => {
      message = ['CLOSE', 'id'] as any

      expect(validateSchema(messageSchema)(message)).to.have.deep.property('value', message)
    })

    it('returns message if REQ message is valid', () => {
      message = [
        'REQ',
        'id',
        {
          ids: ['aa', 'bb', 'cc'],
          authors: ['aa', 'bb', 'cc'],
          kinds: [0, 1, 2, 3],
          since: 1000,
          until: 1000,
          limit: 100,
          '#e': ['aa', 'bb', 'cc'],
          '#p': ['dd', 'ee', 'ff'],
          '#r': ['00', '11', '22'],
        },
      ] as any

      expect(validateSchema(messageSchema)(message)).to.have.deep.property('value', message)
    })
  })
})
