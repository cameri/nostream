

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
          'id': 'f6e771f7380374a4a8616dcc862925d0978ab646be54df6ae479a39228401d16',
          'pubkey': '47bae3a008414e24b4d91c8c170f7fce777dedc6780a462d010761dca6482327',
          'created_at': 1660371895,
          'kind': 3,
          'tags': [
            [
              'p',
              '3efdaebb1d8923ebd99c9e7ace3b4194ab45512e2be79c1b7d68d9243e0d2681'
            ],
            [
              'p',
              '47bae3a008414e24b4d91c8c170f7fce777dedc6780a462d010761dca6482327'
            ],
            [
              'p',
              '32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245'
            ],
            [
              'p',
              '80482e60178c2ce996da6d67577f56a2b2c47ccb1c84c81f2b7960637cb71b78'
            ],
            [
              'p',
              'd7f0e3917c466f1e2233e9624fbd6d4bd1392dbcfcaf3574f457569d496cb731'
            ],
            [
              'p',
              'b1dd5e8ed19644671e8693ca2445c68729249f6d4f2d2d8f072d5e1399ba7ecb'
            ],
            [
              'p',
              '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
              'wss://relay.damus.io'
            ],
            [
              'p',
              'c7eda660a6bc8270530e82b4a7712acdea2e31dc0a56f8dc955ac009efd97c86',
              'wss://relay.damus.io'
            ],
            [
              'p',
              'e4c47aedea8ea54255f5ba07a77053b24553e9b975435e56da343da19aec7881',
              'wss://nostr-pub.wellorder.net'
            ],
            [
              'p',
              '9211af4fe742043111e923a6235065b1df69acb34df4d894b50f10e5ba57de8b',
              'wss://relay.damus.io'
            ],
            [
              'p',
              '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'
            ],
            [
              'p',
              '2b5c634536c53974fcc39c9cb0fc598d7bb1900b00fe9d4745144ac79ddfb140'
            ],
            [
              'p',
              'f61abb9886e1f4cd5d20419c197d5d7f3649addab24b6a32a2367124ca3194b4',
              'wss://relay.damus.io'
            ],
            [
              'p',
              '8355095016fddbe31fcf1453b26f613553e9758cf2263e190eac8fd96a3d3de9',
              'wss://nostr-pub.wellorder.net'
            ],
            [
              'p',
              '489485b5d4254bf11c72abfff3f254e7275e109516a4adf021426c0adc00df5a',
              'wss://nostr-pub.wellorder.net'
            ],
            [
              'p',
              'cdb55b719d18e264364d53b7826422daf05cf11af0ef6fa4076a7e2724b722a8',
              'wss://nostr.onsats.org'
            ],
            [
              'p',
              '38b07a31f3b23dbeb9f59deb7bec5b993173fb4022206980f3809d0b68abf959'
            ],
            [
              'p',
              '6398e15e3416de093b963ca38783d2a66a9657cb08cbba4f02546cdd55b6f1a4'
            ],
            [
              'p',
              'ac4e18391f45932c0067e28203d5083a356ce301ab60867de094c94b98358666',
              'wss://nostr.onsats.org'
            ],
            [
              'p',
              '40e162e0a8d139c9ef1d1bcba5265d1953be1381fb4acd227d8f3c391f9b9486'
            ],
            [
              'p',
              '4d5ce768123563bc583697db5e84841fb528f7b708d966f2e546286ce3c72077'
            ],
            [
              'p',
              '8bc3c8faf56ef7fea539c3e53192723633c1e6e586194c328bd7ef341da89574'
            ],
            [
              'p',
              'd987084c48390a290f5d2a34603ae64f55137d9b4affced8c0eae030eb222a25'
            ],
            [
              'p',
              '52b4a076bcbbbdc3a1aefa3735816cf74993b1b8db202b01c883c58be7fad8bd'
            ],
            [
              'p',
              '7927bc6e25892729a9c02a1332c409a69b285e143b9d845c54fd9c1fe829e25e'
            ],
            [
              'p',
              '1221fd0054a6c8ebd07b39c5eeea388f7f0244409f8cd8649ac22fcd668d02f6'
            ],
            [
              'p',
              '9ec7a778167afb1d30c4833de9322da0c08ba71a69e1911d5578d3144bb56437'
            ],
            [
              'p',
              '234d39919c1bd120766c4d874e8f34df4c80981236d76cdd95e246b1d01ae10b'
            ],
            [
              'p',
              'b2d670de53b27691c0c3400225b65c35a26d06093bcc41f48ffc71e0907f9d4a'
            ],
            [
              'p',
              'd72af1d47e5ab48a9ff112c1ca348c06d11623d9ddb07f19581a37e1c3147fe4'
            ],
            [
              'p',
              '9aeb3bb495f09be3799048c3ef76649917efc46a8c8a69fefc31a7d012f6eccb'
            ],
            [
              'p',
              'c5072866b41d6b88ab2ffee16ad7cb648f940867371a7808aaa94cf7d01f4188'
            ],
            [
              'p',
              'c765522880ce949f2529f7cd090daa007e7a013d72472c085fd4db9355fa8eab'
            ],
            [
              'p',
              '2ae8e03d89cb52861a0089a2f34c861dfd7f896a87b26fdaa8d84049029f5e56'
            ],
            [
              'p',
              'cbc5ef6b01cbd1ffa2cb95a954f04c385a936c1a86e1bb9ccdf2cf0f4ebeaccb'
            ],
            [
              'p',
              '5408e58979e6772bd7dd2830011eaaf4c346ce22650acec1939a7a4d33407a75'
            ],
            [
              'p',
              'b1576eb99a4774158a32fc5e190afa3ded4da19f51fbfa0b1a1bf6421ea5733a'
            ],
            [
              'p',
              '6f1a30b7951cab01c7217b673cac807f0195b05b1ab36ad4e6c7a5ee5b05c1ab'
            ],
            [
              'p',
              '2b36fb6ae1022d0d4eac2a9f13fc2638f3350acc9b07bdca1de43a7c63429644'
            ],
            [
              'p',
              '42a0825e980b9f97943d2501d99c3a3859d4e68cd6028c02afe58f96ba661a9d'
            ],
            [
              'p',
              'e37d948a0eee45e6cd113faaad934fcf17a97de2236c655b70650d4252daa9d3'
            ],
            [
              'p',
              'd3646691ba5b1d796c1e1b3430df00fe1189ec9c232877adde18c8f656af18f0'
            ],
            [
              'p',
              '146bda4ec6932830503ee4f8e8b626bd7b3a5784232b8240ba15c8cbff9a07cd'
            ],
            [
              'p',
              'c5cfda98d01f152b3493d995eed4cdb4d9e55a973925f6f9ea24769a5a21e778'
            ],
            [
              'p',
              'f58708031143f54b521dc4b008533e72fbbbc74b0950b0e268e9143d3945e578'
            ],
            [
              'p',
              '1f5cd0b7618dcd0b4040e0daa1e6719ae9e4b5c0822fc5f47ed55725e08b6564'
            ],
            [
              'p',
              '2ef93f01cd2493e04235a6b87b10d3c4a74e2a7eb7c3caf168268f6af73314b5'
            ],
            [
              'p',
              '4d960b819ff5c4f417431e73e7bf70ad41f181136d1baef47c25d1c8b23b4de2'
            ],
            [
              'p',
              '4b12f6132a5ba813bdf55bcbf9d1acfefb02dabf67191dad71b455668c429b36'
            ],
            [
              'p',
              'f43c1f9bff677b8f27b602725ea0ad51af221344f69a6b352a74991a4479bac3'
            ],
            [
              'p',
              'd7e747f60a16bf0081c0a88184a34086cc13e6edb0662d4e55202531b47be026'
            ],
            [
              'p',
              '8c0da4862130283ff9e67d889df264177a508974e2feb96de139804ea66d6168'
            ],
            [
              'p',
              '9f376635bfcc2021daa2ddf5b93420e0a8a468ba35ccf613587948697bc42976'
            ],
            [
              'p',
              '60d53675f07dee9e7d77910efa44682d87cb532313ba66b8f4449d649172296b'
            ],
            [
              'p',
              'b9e76546ba06456ed301d9e52bc49fa48e70a6bf2282be7a1ae72947612023dc'
            ],
            [
              'p',
              '7dbf37fb6692b6c5f792edad1972b5ae5616235622d92cb977ad3d8d71a1da2f'
            ],
            [
              'p',
              '83f514b1e8c9beb71627094fc387ad141bd7b3a7ef75c52722bdf1d429265f54'
            ],
            [
              'p',
              'fb019155556a54696af5e5625fc0283fbe519d1dec8b7059e01e8585c2a21798'
            ],
            [
              'p',
              '16fa0fe9d13191a4349d154356941731db6dfffc4341386eb13818f5a69f0627'
            ]
          ],
          'content': '{"wss:\\/\\/nostr-pub.wellorder.net\\t":{"write":true,"read":true},"wss:\\/\\/relay.damus.io":{"write":true,"read":true},"wss:\\/\\/nostr.rocks":{"write":true,"read":true},"wss:\\/\\/nostr.onsats.org":{"write":true,"read":true},"wss:\\/\\/relay.nostr.info\\/":{"write":true,"read":true},"wss:\\/\\/rsslay.fiatjaf.com":{"write":true,"read":true},"wss:\\/\\/relayer.fiatjaf.com":{"write":true,"read":true},"ws:\\/\\/192.168.1.103:8889":{"write":true,"read":true}}',
          'sig': '4653bc7fd43b76abcbad92ebb105c34d4612deafcdac4820ed97e0ea62ca0afa996bd700988b3971a3590bf4ab40f5e5360c101c638c924782cc803edf1534b2'
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
