import { expect } from 'chai'
import { IncomingMessage } from 'http'

import { getPublicPathPrefix, getRemoteAddress, joinPathPrefix } from '../../../src/utils/http'

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

describe('getPublicPathPrefix', () => {
  it('returns the relay_url path prefix by default', () => {
    expect(
      getPublicPathPrefix({ headers: {}, socket: { remoteAddress: 'client' } } as any, {
        info: { relay_url: 'wss://relay.example.com/nostream/' },
        network: {},
      } as any),
    ).to.equal('/nostream')
  })

  it('uses trusted x-forwarded-prefix over relay_url', () => {
    expect(
      getPublicPathPrefix(
        {
          headers: { 'x-forwarded-prefix': '/relay, /other' },
          socket: { remoteAddress: '127.0.0.1' },
        } as any,
        {
          info: { relay_url: 'wss://relay.example.com/nostream' },
          network: { trustedProxies: ['127.0.0.1'] },
        } as any,
      ),
    ).to.equal('/relay')
  })

  it('ignores untrusted x-forwarded-prefix', () => {
    expect(
      getPublicPathPrefix(
        {
          headers: { 'x-forwarded-prefix': '/evil' },
          socket: { remoteAddress: 'client' },
        } as any,
        {
          info: { relay_url: 'wss://relay.example.com/nostream' },
          network: { trustedProxies: ['127.0.0.1'] },
        } as any,
      ),
    ).to.equal('/nostream')
  })

  it('ignores x-forwarded-prefix when trustedProxies is unset', () => {
    expect(
      getPublicPathPrefix(
        {
          headers: { 'x-forwarded-prefix': '/nostream' },
          socket: { remoteAddress: '127.0.0.1' },
        } as any,
        {
          info: { relay_url: 'wss://relay.example.com' },
          network: {},
        } as any,
      ),
    ).to.equal('')
  })

  it('rejects absolute or protocol-relative trusted prefixes', () => {
    const settings = {
      info: { relay_url: 'wss://relay.example.com/nostream' },
      network: { trustedProxies: ['127.0.0.1'] },
    } as any

    expect(
      getPublicPathPrefix(
        {
          headers: { 'x-forwarded-prefix': 'https://example.com/other' },
          socket: { remoteAddress: '127.0.0.1' },
        } as any,
        settings,
      ),
    ).to.equal('/nostream')
    expect(
      getPublicPathPrefix(
        {
          headers: { 'x-forwarded-prefix': '//example.com/other' },
          socket: { remoteAddress: '127.0.0.1' },
        } as any,
        settings,
      ),
    ).to.equal('/nostream')
  })
})

describe('joinPathPrefix', () => {
  it('joins an empty prefix with an absolute path', () => {
    expect(joinPathPrefix('', '/invoices')).to.equal('/invoices')
  })

  it('joins a forwarded prefix with an absolute path', () => {
    expect(joinPathPrefix('/nostream', '/invoices')).to.equal('/nostream/invoices')
  })
})
