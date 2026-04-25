const dgram = require('node:dgram')
const crypto = require('node:crypto')

const MULTICAST_GROUP = process.env.MULTICAST_GROUP || '239.255.0.1'
const MULTICAST_PORT = Number(process.env.MULTICAST_PORT || 29999)
const RECEIVE_TIMEOUT_MS = Number(process.env.RECEIVE_TIMEOUT_MS || 5000)

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex')

const createDummyNostrEvent = () => {
  const createdAt = Math.floor(Date.now() / 1000)
  const nonce = randomHex(8)

  return {
    id: randomHex(32),
    pubkey: randomHex(32),
    created_at: createdAt,
    kind: 1,
    tags: [['nonce', nonce], ['client', 'nostream-competency-test']],
    content: `UDP multicast competency test @ ${createdAt}`,
    sig: randomHex(64),
  }
}

const isNostrEvent = (value) => {
  if (!value || typeof value !== 'object') {
    return false
  }

  return typeof value.id === 'string'
    && typeof value.pubkey === 'string'
    && typeof value.created_at === 'number'
    && typeof value.kind === 'number'
    && Array.isArray(value.tags)
    && typeof value.content === 'string'
    && typeof value.sig === 'string'
}

function solveTask3() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const event = createDummyNostrEvent()
    const payload = Buffer.from(JSON.stringify(event), 'utf8')

    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error(`timed out after ${RECEIVE_TIMEOUT_MS}ms without receiving multicast payload`))
    }, RECEIVE_TIMEOUT_MS)

    socket.on('error', (error) => {
      clearTimeout(timeout)
      socket.close()
      reject(error)
    })

    socket.on('message', (message, remoteInfo) => {
      let parsed
      try {
        parsed = JSON.parse(message.toString('utf8'))
      } catch (error) {
        clearTimeout(timeout)
        socket.close()
        reject(new Error(`received invalid JSON payload: ${error.message}`))
        return
      }

      if (!isNostrEvent(parsed)) {
        clearTimeout(timeout)
        socket.close()
        reject(new Error('received JSON but payload is not a valid Nostr event shape'))
        return
      }

      if (parsed.id !== event.id) {
        return
      }

      clearTimeout(timeout)
      console.log('SUCCESS: Received and parsed own multicast payload')
      console.log(`From ${remoteInfo.address}:${remoteInfo.port}`)
      console.log(parsed)
      socket.close()
      resolve()
    })

    socket.bind(MULTICAST_PORT, () => {
      socket.setMulticastTTL(1)
      socket.setMulticastLoopback(true)
      socket.addMembership(MULTICAST_GROUP)

      socket.send(payload, MULTICAST_PORT, MULTICAST_GROUP, (error) => {
        if (error) {
          clearTimeout(timeout)
          socket.close()
          reject(error)
          return
        }

        console.log(`Sent dummy Nostr event to ${MULTICAST_GROUP}:${MULTICAST_PORT}`)
      })
    })
  })
}

solveTask3()
  .then(() => {
    process.exitCode = 0
  })
  .catch((error) => {
    console.error('Task 3 failed:', error.message)
    process.exitCode = 1
  })
