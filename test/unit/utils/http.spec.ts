import { expect } from 'chai'
import { IncomingMessage } from 'http'

import { getRemoteAddress } from '../../../src/utils/http'

describe('getRemoteAddress', () => {
  const header = 'x-forwarded-for'
  const socketAddress = 'socket-address'
  const address = 'address'

  let request: IncomingMessage

  beforeEach(() => {
    request = {
      headers: {
        [header]: address,
      },
      socket: {
        remoteAddress: socketAddress,
      },
    } as any
  })

  it('returns address using network.remote_ip_address when set', () => {
    expect(
      getRemoteAddress(
        request,
        { network: { 'remote_ip_header': header } } as any,
      )
    ).to.equal(address)
  })

  it('returns address using network.remoteIpAddress when set', () => {
    expect(
      getRemoteAddress(
        request,
        { network: { remoteIpHeader: header } } as any,
      )
    ).to.equal(address)
  })

  it('returns address from socket when header is unset', () => {
    expect(
      getRemoteAddress(
        request,
        { network: { } } as any,
      )
    ).to.equal(socketAddress)
  })
})
