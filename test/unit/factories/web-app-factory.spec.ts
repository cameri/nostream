import { expect } from 'chai'

import { getWebProtocolForRelay } from '../../../src/factories/web-app-factory'

describe('getWebProtocolForRelay', () => {
  it('maps wss: to https:', () => {
    expect(getWebProtocolForRelay('wss:')).to.equal('https:')
  })

  it('maps ws: to http: (regression: previously mapped to the invalid scheme ":")', () => {
    expect(getWebProtocolForRelay('ws:')).to.equal('http:')
  })
})
