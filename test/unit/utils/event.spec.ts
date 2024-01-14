import { expect } from 'chai'

import { CanonicalEvent, Event } from '../../../src/@types/event'
import {
  getEventExpiration,
  isDelegatedEvent,
  isDelegatedEventValid,
  isDeleteEvent,
  isEphemeralEvent,
  isEventIdValid,
  isEventMatchingFilter,
  isEventSignatureValid,
  isExpiredEvent,
  isParameterizedReplaceableEvent,
  isReplaceableEvent,
  serializeEvent,
} from '../../../src/utils/event'
import { EventKinds } from '../../../src/constants/base'

describe('NIP-01', () => {
  describe('serializeEvent', () => {
    it('returns serialized event given a Nostr event', () => {
      const event: Event = {
        pubkey: 'pubkey',
        created_at: 1000,
        kind: EventKinds.TEXT_NOTE,
        tags: [['tag name', 'tag content']],
        content: 'content',
      } as any

      const expected: CanonicalEvent = [
        0,
        'pubkey',
        1000,
        EventKinds.TEXT_NOTE,
        [['tag name', 'tag content']],
        'content',
      ]

      expect(serializeEvent(event)).to.eqls(expected)
    })
  })

  describe('isEventMatchingFilter', () => {
    let event: Event

    beforeEach(() => {
      event = {
        id: '6b3cdd0302ded8068ad3f0269c74423ca4fee460f800f3d90103b63f14400407',
        pubkey:
          '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793',
        created_at: 1648351380,
        kind: 1,
        tags: [
          [
            'p',
            '8355095016fddbe31fcf1453b26f613553e9758cf2263e190eac8fd96a3d3de9',
            'wss://nostr-pub.wellorder.net',
          ],
          [
            'e',
            '7377fa81fc6c7ae7f7f4ef8938d4a603f7bf98183b35ab128235cc92d4bebf96',
            'wss://nostr-relay.untethr.me',
          ],
        ],
        content:
          "I've set up mirroring between relays: https://i.imgur.com/HxCDipB.png",
        sig: 'b37adfed0e6398546d623536f9ddc92b95b7dc71927e1123266332659253ecd0ffa91ddf2c0a82a8426c5b363139d28534d6cac893b8a810149557a3f6d36768',
      }
    })

    it('returns true if filter is empty', () => {
      expect(isEventMatchingFilter({})(event)).to.be.true
    })

    describe('ids filter', () => {
      it('returns false if ids filter is empty', () => {
        expect(isEventMatchingFilter({ ids: [] })(event)).to.be.false
      })

      it('returns true if ids filter contains event id', () => {
        expect(isEventMatchingFilter({ ids: [event.id] })(event)).to.be.true
      })

      it('returns false if ids filter does not contains event id', () => {
        expect(isEventMatchingFilter({ ids: ['something else'] })(event)).to.be
          .false
      })

      it('returns true if ids with prefix matches event', () => {
        const event: Event = {
          id: '7377fa81fc6c7ae7f7f4ef8938d4a603f7bf98183b35ab128235cc92d4bebf96',
          tags: [],
        } as any
        const prefix = '7377fa81fc6c'

        expect(isEventMatchingFilter({ ids: [prefix] })(event)).to.be
          .true
      })

      it('returns false if ids with prefix does not matches event', () => {
        const event: Event = {
          id: '7377fa81fc6c7ae7f7f4ef8938d4a603f7bf98183b35ab128235cc92d4bebf96',
          tags: [],
        } as any
        const prefix = '001122'

        expect(isEventMatchingFilter({ ids: [prefix] })(event)).to.be
          .false
      })
    })

    describe('authors filter', () => {
      it('returns false if authors filter is empty', () => {
        expect(isEventMatchingFilter({ authors: [] })(event)).to.be.false
      })

      it('returns true if authors filter contains event id', () => {
        expect(isEventMatchingFilter({ authors: [event.pubkey] })(event)).to.be
          .true
      })

      it('returns false if authors filter does not contains event id', () => {
        expect(isEventMatchingFilter({ authors: ['something else'] })(event)).to
          .be.false
      })

      it('returns true if authors with prefix matches event', () => {
        const event: Event = {
          pubkey: '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793',
          tags: [],
        } as any
        const prefix = '22e804d'

        expect(isEventMatchingFilter({ authors: [prefix] })(event)).to.be
          .true
      })

      it('returns false if authors with prefix does not matches event', () => {
        const event: Event = {
          pubkey: '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793',
          tags: [],
        } as any
        const prefix = '001122'

        expect(isEventMatchingFilter({ authors: [prefix] })(event)).to.be
          .false
      })
    })

    describe('kinds filter', () => {
      it('returns false if kinds filter is empty', () => {
        expect(isEventMatchingFilter({ kinds: [] })(event)).to.be.false
      })

      it('returns true if kinds filter contains event id', () => {
        expect(isEventMatchingFilter({ kinds: [event.kind] })(event)).to.be.true
      })

      it('returns false if kinds filter does not contains event id', () => {
        expect(isEventMatchingFilter({ kinds: [666] })(event)).to.be.false
      })
    })

    describe('since filter', () => {
      it('returns true if since < event created at', () => {
        expect(isEventMatchingFilter({ since: event.created_at - 1 })(event)).to
          .be.true
      })

      it('returns true if since = event created at', () => {
        expect(isEventMatchingFilter({ since: event.created_at })(event)).to.be
          .true
      })

      it('returns false if since > event created at', () => {
        expect(isEventMatchingFilter({ since: event.created_at + 1 })(event)).to
          .be.false
      })
    })

    describe('until filter', () => {
      it('returns false if until < event created at', () => {
        expect(isEventMatchingFilter({ until: event.created_at - 1 })(event)).to
          .be.false
      })

      it('returns true if until = event created at', () => {
        expect(isEventMatchingFilter({ until: event.created_at })(event)).to.be
          .true
      })

      it('returns true if until > event created at', () => {
        expect(isEventMatchingFilter({ until: event.created_at + 1 })(event)).to
          .be.true
      })
    })

    describe('#e filter', () => {
      it('returns false if #e filter is empty', () => {
        expect(isEventMatchingFilter({ '#e': [] })(event)).to.be.false
      })

      it('returns true if #e filter contains e tag in event', () => {
        expect(isEventMatchingFilter({ '#e': [event.tags[1][1]] })(event)).to.be
          .true
      })

      it('returns false if #e filter does not contain tag in event', () => {
        expect(isEventMatchingFilter({ '#e': ['something else'] })(event)).to.be
          .false
      })
    })

    describe('#p filter', () => {
      it('returns false if #p filter is empty', () => {
        expect(isEventMatchingFilter({ '#p': [] })(event)).to.be.false
      })

      it('returns true if #p filter contains p tag in event', () => {
        expect(isEventMatchingFilter({ '#p': [event.tags[0][1]] })(event)).to.be
          .true
      })

      it('returns false if #p filter does not contain tag in event', () => {
        expect(isEventMatchingFilter({ '#p': ['something else'] })(event)).to.be
          .false
      })
    })
  })

  describe('isEventSignatureValid', () => {
    let event: Event

    beforeEach(() => {
      event = {
        'id': 'b1601d26958e6508b7b9df0af609c652346c09392b6534d93aead9819a51b4ef',
        'pubkey': '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793',
        'created_at': 1648339664,
        'kind': 1,
        'tags': [],
        'content': 'learning terraform rn!',
        'sig': 'ec8b2bc640c8c7e92fbc0e0a6f539da2635068a99809186f15106174d727456132977c78f3371d0ab01c108173df75750f33d8e04c4d7980bbb3fb70ba1e3848',
      }
    })

    it('resolves with true if event has a valid signature', async () => {
      expect(
        await isEventSignatureValid(event)
      ).to.be.true
    })

    it('resolves with false if event has a valid signature', async () => {
      event.id = '1234567890123456789012345678901234567890123456789012345678901234'

      expect(
        await isEventSignatureValid(event)
      ).to.be.false
    })
  })

  describe('isEventIdValid', () => {
    let event: Event

    beforeEach(() => {
      event = {
        'id': 'b1601d26958e6508b7b9df0af609c652346c09392b6534d93aead9819a51b4ef',
        'pubkey': '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793',
        'created_at': 1648339664,
        'kind': 1,
        'tags': [],
        'content': 'learning terraform rn!',
        'sig': 'ec8b2bc640c8c7e92fbc0e0a6f539da2635068a99809186f15106174d727456132977c78f3371d0ab01c108173df75750f33d8e04c4d7980bbb3fb70ba1e3848',
      }
    })

    it('resolves with true if event id is valid', async () => {
      expect(await isEventIdValid(event)).to.be.true
    })

    it('resolves with false if event id is not valid', async () => {
      event.content = 'changed'
      expect(await isEventIdValid(event)).to.be.false
    })
  })
})

describe('NIP-12', () => {
  let event: Event
  describe('#r filter', () => {
    beforeEach(() => {
      event = {
        id: 'cf8de9db67a1d7203512d1d81e6190f5e53abfdc0ac90275f67172b65a5b09a0',
        pubkey:
          'e8b487c079b0f67c695ae6c4c2552a47f38adfa2533cc5926bd2c102942fdcb7',
        created_at: 1645030752,
        kind: 1,
        tags: [['r', 'https://fiatjaf.com']],
        content: 'r',
        sig: '53d12018d036092794366283eca36df4e0cabd014b6e91bbf684c8bb9bbbe9dedafa77b6b928587e11e05e036227598dded8713e8da17d55076e12242b361542',
      }
    })

    it('returns false if #r filter is empty', () => {
      expect(isEventMatchingFilter({ '#r': [] })(event)).to.be.false
    })

    it('returns true if #r filter contains p tag in event', () => {
      expect(isEventMatchingFilter({ '#r': [event.tags[0][1]] })(event)).to.be
        .true
    })

    it('returns false if #r filter does not contain tag in event', () => {
      expect(isEventMatchingFilter({ '#r': ['something else'] })(event)).to.be
        .false
    })
  })
})

describe('NIP-16', () => {
  describe('isReplaceableEvent', () => {
    it('returns true if event is replaceable', () => {
      expect(isReplaceableEvent({ kind: EventKinds.REPLACEABLE_FIRST } as any)).to.be.true
    })

    it('returns true if event is set_metadata', () => {
      expect(isReplaceableEvent({ kind: EventKinds.SET_METADATA } as any)).to.be.true
    })

    it('returns true if event is contact_list', () => {
      expect(isReplaceableEvent({ kind: EventKinds.CONTACT_LIST } as any)).to.be.true
    })

    it('returns false if event is not replaceable', () => {
      expect(isReplaceableEvent({ kind: EventKinds.REPLACEABLE_LAST + 1 } as any)).to.be.false
    })
  })

  describe('isEphemeralEvent', () => {
    it('returns true if event is replaceable', () => {
      expect(isEphemeralEvent({ kind: 20000 } as any)).to.be.true
    })

    it('returns false if event is not replaceable', () => {
      expect(isEphemeralEvent({ kind: 30000 } as any)).to.be.false
    })
  })
})

// describe('NIP-27', () => {
//   describe('isEventMatchingFilter', () => {
//     describe('#m filter', () => {
//       let event: Event
//       beforeEach(() => {
//         event = {
//           tags: [
//             [
//               'm',
//               'group',
//             ],
//           ],
//         } as any
//       })

//       it('returns true given non-multicast event and there is no #m filter', () => {
//         event.tags = []
//         expect(isEventMatchingFilter({})(event)).to.be.true
//       })

//       it('returns true given multicast event and contained in #m filter', () => {
//         expect(isEventMatchingFilter({ '#m': ['group'] })(event)).to.be.true
//       })

//       it('returns true given multicast event and contained second in #m filter', () => {
//         expect(isEventMatchingFilter({ '#m': ['some group', 'group'] })(event)).to.be.true
//       })

//       it('returns false given multicast event and not contained in #m filter', () => {
//         expect(isEventMatchingFilter({ '#m': ['other group'] })(event)).to.be.false
//       })

//       it('returns false if given multicast event and there is no #m filter', () => {
//         expect(isEventMatchingFilter({})(event)).to.be.false
//       })

//       it('returns false if given multicast event and #m filter is empty', () => {
//         expect(isEventMatchingFilter({ '#m': [] })(event)).to.be.false
//       })

//       it('returns false given non-multicast event and filter contains some group', () => {
//         event.tags = []
//         expect(isEventMatchingFilter({ '#m': ['group'] })(event)).to.be.false
//       })

//       it('returns false given non-multicast event and filter is empty', () => {
//         event.tags = []
//         expect(isEventMatchingFilter({ '#m': [] })(event)).to.be.false
//       })
//     })
//   })
// })

describe('NIP-26', () => {
  let event: Event
  beforeEach(() => {
    event = {
      'id': 'a080fd288b60ac2225ff2e2d815291bd730911e583e177302cc949a15dc2b2dc',
      'pubkey': '62903b1ff41559daf9ee98ef1ae67cc52f301bb5ce26d14baba3052f649c3f49',
      'created_at': 1660896109,
      'kind': 1,
      'tags': [
        [
          'delegation',
          '86f0689bd48dcd19c67a19d994f938ee34f251d8c39976290955ff585f2db42e',
          'kind=1&created_at>1640995200',
          'c33c88ba78ec3c760e49db591ac5f7b129e3887c8af7729795e85a0588007e5ac89b46549232d8f918eefd73e726cb450135314bfda419c030d0b6affe401ec1',
        ],
      ],
      'content': 'Hello world',
      'sig': 'cd4a3cd20dc61dcbc98324de561a07fd23b3d9702115920c0814b5fb822cc5b7c5bcdaf3fa326d24ed50c5b9c8214d66c75bae34e3a84c25e4d122afccb66eb6',
    }
  })

  describe('isDelegatedEvent', () => {
    it('returns true if event contains delegation tag', () => {
      expect(isDelegatedEvent(event)).to.be.true
    })
  })

  describe('isDelegatedEventValid', () => {
    it('resolves with true if delegated event is valid', async () => {
      expect(await isDelegatedEventValid(event)).to.be.true
    })

    it('resolves with false if no delegation tag is found', async () => {
      event.tags = []
      expect(await isDelegatedEventValid(event)).to.be.false
    })

    it('resolves with false if delegation signature is invalid', async () => {
      event.tags[0][3] = 'f'
      expect(await isDelegatedEventValid(event)).to.be.false
    })

    it('resolves with false if delegation rule is not a valid rune', async () => {
      event.tags[0][2] = '@'
      expect(await isDelegatedEventValid(event)).to.be.false
    })


    it('resolves with false if no delegation rule does not match', async () => {
      event.tags[0][2] = 'a=1'
      expect(await isDelegatedEventValid(event)).to.be.false
    })
  })

  describe('isEventMatchingFilter', () => {
    it('returns true if author is delegator', () => {
      expect(
        isEventMatchingFilter({ authors: ['86f0689bd48dcd19c67a19d994f938ee34f251d8c39976290955ff585f2db42e'] })(event)
      ).to.be.true
    })

    it('returns false if author is not delegator', () => {
      expect(
        isEventMatchingFilter({ authors: ['e8b487c079b0f67c695ae6c4c2552a47f38adfa2533cc5926bd2c102942fdcb7'] })(event)
      ).to.be.false
    })
  })
})

describe('NIP-09', () => {
  describe('isDeleteEvent', () => {
    it('returns true if event is kind 5', () => {
      const event: Event = {
        kind: 5,
      } as any
      expect(isDeleteEvent(event)).to.be.true
    })

    it('returns false if event is not kind 5', () => {
      const event: Event = {
        kind: 5 * 100000,
      } as any
      expect(isDeleteEvent(event)).to.be.false
    })
  })
})

describe('NIP-33', () => {
  describe('isParameterizedReplaceableEvent', () => {
    it('returns true if event is a parameterized replaceable event', () => {
      expect(isParameterizedReplaceableEvent({ kind: 30000 } as any)).to.be.true
    })

    it('returns false if event is a parameterized replaceable event', () => {
      expect(isParameterizedReplaceableEvent({ kind: 40000 } as any)).to.be.false
    })
  })
})
describe('NIP-40', () => {
  let event: Event
  beforeEach(() => {
    event = {
      'id': 'a080fd288b60ac2225ff2e2d815291bd730911e583e177302cc949a15dc2b2dc',
      'pubkey': '62903b1ff41559daf9ee98ef1ae67cc52f301bb5ce26d14baba3052f649c3f49',
      'created_at': 1660896109,
      'kind': 1,
      'tags': [
        [
          'delegation',
          '86f0689bd48dcd19c67a19d994f938ee34f251d8c39976290955ff585f2db42e',
          'kind=1&created_at>1640995200',
          'c33c88ba78ec3c760e49db591ac5f7b129e3887c8af7729795e85a0588007e5ac89b46549232d8f918eefd73e726cb450135314bfda419c030d0b6affe401ec1',
        ],
      ],
      'content': 'Hello world',
      'sig': 'cd4a3cd20dc61dcbc98324de561a07fd23b3d9702115920c0814b5fb822cc5b7c5bcdaf3fa326d24ed50c5b9c8214d66c75bae34e3a84c25e4d122afccb66eb6',
    }
  })

  describe('getEventExpiration', () => {
    it('returns true if expiration is a safe integer', () => {
      event.tags = [
        ['expiration', '160000000'],
      ]
      expect(getEventExpiration(event)).to.equal(160000000)
    })

    it('returns false if event does not have expiration tag', () => {
      event.tags = []
      expect(getEventExpiration(event)).to.be.undefined
    })

    it('returns false if expiration is unsafe integer', () => {
      event.tags = [
        ['expiration', '160000000000000000000'],
      ]
      expect(getEventExpiration(event)).to.be.undefined
    })

    it('returns false if expiration is malformed data', () => {
      event.tags = [
        ['expiration', 'a'],
      ]
      expect(getEventExpiration(event)).to.be.undefined
    })
  })

  describe('isExpiredEvent', () => {
    it('returns false if event does not have tags', () => {
      event.tags = []
      expect(isExpiredEvent(event)).to.equal(false)
    })

    it('returns false if event does not have expiration tags', () => {
      expect(isExpiredEvent(event)).to.equal(false)
    })

    it('returns true if event is expired', () => {
      event.tags = [
        ['expiration', '100000'],
      ]
      expect(isExpiredEvent(event)).to.equal(true)
    })
  })
})