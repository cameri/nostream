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
        { network: { 'remote_ip_header': header, trustedProxies: [socketAddress] } } as any,
      )
    ).to.equal(address)
  })

  it('returns address using network.remoteIpAddress when set', () => {
    expect(
      getRemoteAddress(
        request,
        { network: { remoteIpHeader: header, trustedProxies: [socketAddress] } } as any,
      )
    ).to.equal(address)
  })

  it('returns socket address when proxy is not trusted', () => {
    expect(
      getRemoteAddress(
        request,
        { network: { remoteIpHeader: header, trustedProxies: ['1.1.1.1'] } } as any,
      )
    ).to.equal(socketAddress)
  })

  it('normalizes ipv4-mapped trusted proxy addresses', () => {
    expect(
      getRemoteAddress(
        {
          headers: {
            [header]: address,
          },
          socket: {
            remoteAddress: '::ffff:127.0.0.1',
          },
        } as any,
        { network: { remoteIpHeader: header, trustedProxies: ['127.0.0.1'] } } as any,
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

  it('returns first address when forwarded header is an array', () => {
    const arrayRequest = {
      headers: { [header]: [address, 'other-address'] },
      socket: { remoteAddress: socketAddress },
    } as any
    expect(
      getRemoteAddress(
        arrayRequest,
        { network: { remoteIpHeader: header, trustedProxies: [socketAddress] } } as any,
      )
    ).to.equal(address)
  })
})
