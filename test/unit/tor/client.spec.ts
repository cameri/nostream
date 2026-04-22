import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import { EventEmitter } from 'events'
import net from 'net'
import Sinon from 'sinon'

chai.use(chaiAsPromised)

const { expect } = chai

import { TorClient } from '../../../src/tor/client'

// Capture real implementations before onion.spec.ts (loaded later) overrides the prototype
const realConnect = TorClient.prototype.connect

type MockSocket = EventEmitter & { write: Sinon.SinonStub; destroy: Sinon.SinonStub }

function createMockSocket(): MockSocket {
  return Object.assign(new EventEmitter(), {
    write: Sinon.stub(),
    destroy: Sinon.stub(),
  })
}

describe('TorClient', () => {
  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('isCompleteTorReply', () => {
    let client: TorClient
    let isComplete: (buf: string) => boolean

    beforeEach(() => {
      client = new TorClient()
      isComplete = (buf: string) => (client as any).isCompleteTorReply(buf)
    })

    it('returns false for empty string', () => {
      expect(isComplete('')).to.be.false
    })

    it('returns false for partial reply without trailing CRLF', () => {
      expect(isComplete('250 OK')).to.be.false
    })

    it('returns true for a complete single-line 250 OK reply', () => {
      expect(isComplete('250 OK\r\n')).to.be.true
    })

    it('returns true for a complete single-line error reply', () => {
      expect(isComplete('551 Error\r\n')).to.be.true
    })

    it('returns true for a complete multi-line reply ending with 250 OK', () => {
      expect(isComplete('250-ServiceID=abc\r\n250 OK\r\n')).to.be.true
    })

    it('returns true for a multi-line ADD_ONION reply with PrivateKey', () => {
      const response = '250-ServiceID=abcdefghij\r\n250-PrivateKey=RSA:xxx\r\n250 OK\r\n'
      expect(isComplete(response)).to.be.true
    })

    it('returns false for incomplete multi-line reply (continuation only)', () => {
      expect(isComplete('250-ServiceID=abc\r\n')).to.be.false
    })

    it('returns false for buffer ending mid-line', () => {
      expect(isComplete('250-ServiceID=abc\r\n250 OK')).to.be.false
    })

    it('handles data block (250+) terminated by . then final 250 OK', () => {
      const response = '250+data=\r\nsome content\r\n.\r\n250 OK\r\n'
      expect(isComplete(response)).to.be.true
    })

    it('returns false for data block without terminating 250 OK', () => {
      expect(isComplete('250+data=\r\nsome content\r\n.\r\n')).to.be.false
    })
  })

  describe('sendCommand', () => {
    let client: TorClient
    let mockSocket: MockSocket

    beforeEach(() => {
      client = new TorClient()
      mockSocket = createMockSocket()
      ;(client as any).socket = mockSocket
    })

    it('resolves with full response on successful single-line 250 reply', async () => {
      const p = (client as any).sendCommand('GETINFO version')
      mockSocket.emit('data', Buffer.from('250 version=0.4\r\n'))
      const result = await p
      expect(result).to.equal('250 version=0.4\r\n')
    })

    it('rejects when socket is not connected', async () => {
      ;(client as any).socket = undefined
      await expect((client as any).sendCommand('GETINFO version')).to.be.rejectedWith('Not connected')
    })

    it('rejects on non-250 reply', async () => {
      const p = (client as any).sendCommand('GETINFO unknown')
      mockSocket.emit('data', Buffer.from('552 Unrecognized option\r\n'))
      await expect(p).to.be.rejectedWith('552')
    })

    it('rejects on socket error during command', async () => {
      const p = (client as any).sendCommand('GETINFO version')
      mockSocket.emit('error', new Error('Connection reset'))
      await expect(p).to.be.rejectedWith('Connection reset')
    })

    it('buffers fragmented TCP chunks until multi-line reply is complete', async () => {
      const p = (client as any).sendCommand('ADD_ONION NEW:BEST Port=80')
      mockSocket.emit('data', Buffer.from('250-ServiceID=abc\r\n'))
      // not yet complete — continuation line only
      mockSocket.emit('data', Buffer.from('250 PrivateKey=RSA:xxx\r\n'))
      const result = await p
      expect(result).to.include('ServiceID=abc')
      expect(result).to.include('PrivateKey=RSA:xxx')
    })

    it('writes the command with CRLF to the socket', async () => {
      const p = (client as any).sendCommand('QUIT')
      mockSocket.emit('data', Buffer.from('250 OK\r\n'))
      await p
      expect(mockSocket.write.calledOnceWith('QUIT\r\n')).to.be.true
    })

    it('removes data and error listeners after resolution', async () => {
      const p = (client as any).sendCommand('GETINFO version')
      mockSocket.emit('data', Buffer.from('250 version=0.4\r\n'))
      await p
      expect(mockSocket.listenerCount('data')).to.equal(0)
      expect(mockSocket.listenerCount('error')).to.equal(0)
    })

    it('removes data and error listeners after rejection', async () => {
      const p = (client as any).sendCommand('GETINFO unknown')
      mockSocket.emit('data', Buffer.from('552 Unrecognized option\r\n'))
      await p.catch(() => undefined)
      expect(mockSocket.listenerCount('data')).to.equal(0)
      expect(mockSocket.listenerCount('error')).to.equal(0)
    })
  })

  describe('connect', () => {
    let mockSocket: MockSocket
    let savedConnect: typeof TorClient.prototype.connect

    beforeEach(() => {
      // Temporarily restore the real connect for these tests (onion.spec.ts overrides the prototype)
      savedConnect = TorClient.prototype.connect
      TorClient.prototype.connect = realConnect

      mockSocket = createMockSocket()
      sandbox.stub(net, 'connect').returns(mockSocket as any)
    })

    afterEach(() => {
      TorClient.prototype.connect = savedConnect
    })

    it('resolves when control port responds with 250', async () => {
      const client = new TorClient({ host: 'localhost', port: 9051, password: 'test' })
      const p = client.connect()
      mockSocket.emit('data', Buffer.from('250 OK\r\n'))
      await expect(p).to.be.fulfilled
    })

    it('rejects when control port responds with non-250', async () => {
      const client = new TorClient({ host: 'localhost', port: 9051, password: 'wrong' })
      const p = client.connect()
      mockSocket.emit('data', Buffer.from('515 Authentication failed\r\n'))
      await expect(p).to.be.rejectedWith('Tor auth failed')
    })

    it('rejects on socket error during connect', async () => {
      const client = new TorClient({ host: 'localhost', port: 9051, password: 'test' })
      const p = client.connect()
      mockSocket.emit('error', new Error('ECONNREFUSED'))
      await expect(p).to.be.rejectedWith('ECONNREFUSED')
    })

    it('sends AUTHENTICATE command with the configured password', async () => {
      const client = new TorClient({ host: 'localhost', port: 9051, password: 'secret' })
      const p = client.connect()
      mockSocket.emit('data', Buffer.from('250 OK\r\n'))
      await p
      expect(mockSocket.write.calledOnceWith('AUTHENTICATE "secret"\r\n')).to.be.true
    })
  })
})
