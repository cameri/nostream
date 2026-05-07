/* eslint-disable @typescript-eslint/no-var-requires */

const secp256k1 = require('@noble/secp256k1')

const NAMESPACE = 'c646b451-db73-47fb-9a70-ea24ce8a225a'
const SYNTHETIC_SEED_PRIVATE_KEY = '1'.repeat(64)

function isReplaceableEvent(kind) {
  return kind === 0 || kind === 3 || kind === 41 || (kind >= 10000 && kind < 20000)
}

function isParameterizedReplaceableEvent(kind) {
  return kind >= 30000 && kind < 40000
}

function getEventDeduplication(event) {
  if (isReplaceableEvent(event.kind)) {
    return JSON.stringify([event.pubkey, event.kind])
  }

  if (isParameterizedReplaceableEvent(event.kind)) {
    const dTag = event.tags.find((tag) => tag.length >= 2 && tag[0] === 'd')
    const [, ...deduplication] = dTag ?? [null, '']
    return JSON.stringify(deduplication)
  }

  return null
}

function getRequestedSeedCount() {
  const rawValue = process.env.NOSTREAM_SEED_COUNT

  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return undefined
  }

  if (!/^\d+$/.test(rawValue.trim())) {
    throw new Error(`Invalid NOSTREAM_SEED_COUNT: ${rawValue}. Expected a positive integer.`)
  }

  const parsed = Number(rawValue)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid NOSTREAM_SEED_COUNT: ${rawValue}. Expected a positive integer.`)
  }

  return parsed
}

function serializeEvent(event) {
  return [0, event.pubkey, event.created_at, event.kind, event.tags, event.content]
}

async function identifyEvent(event) {
  const idBytes = await secp256k1.utils.sha256(Buffer.from(JSON.stringify(serializeEvent(event))))
  return {
    ...event,
    id: Buffer.from(idBytes).toString('hex'),
  }
}

async function signEvent(event, privateKey) {
  const signature = await secp256k1.schnorr.sign(event.id, privateKey)

  return {
    ...event,
    sig: Buffer.from(signature).toString('hex'),
  }
}

const syntheticSeedPubkey = secp256k1.utils.bytesToHex(secp256k1.getPublicKey(SYNTHETIC_SEED_PRIVATE_KEY, true).subarray(1))

async function createSyntheticEvent(baseEvent, index) {
  const unsignedEvent = {
    pubkey: syntheticSeedPubkey,
    created_at: baseEvent.created_at + index,
    kind: baseEvent.kind,
    tags: baseEvent.tags,
    content: `${baseEvent.content} [seed:${index + 1}]`,
  }

  const identifiedEvent = await identifyEvent(unsignedEvent)
  return signEvent(identifiedEvent, SYNTHETIC_SEED_PRIVATE_KEY)
}

async function expandSeedEvents(events, count) {
  if (!count) {
    return events
  }

  const expanded = []
  for (let index = 0; index < count; index += 1) {
    const baseEvent = events[index % events.length]
    expanded.push(await createSyntheticEvent(baseEvent, index))
  }

  return expanded
}

exports.seed = async function (knex) {
  await knex('events').del()

  const { v5: uuidv5 } = require('uuid')

  const sourceEvents = require('./events.json')
  const requestedCount = getRequestedSeedCount()
  const events = await expandSeedEvents(sourceEvents, requestedCount)

  const eventRows = events.reduce((result, event) => {
    result.push({
      id: uuidv5(event.id, NAMESPACE),
      event_id: Buffer.from(event.id, 'hex'),
      event_pubkey: Buffer.from(event.pubkey, 'hex'),
      event_kind: event.kind,
      event_created_at: event.created_at,
      event_content: event.content,
      event_tags: JSON.stringify(event.tags),
      event_signature: Buffer.from(event.sig, 'hex'),
      event_deduplication: getEventDeduplication(event),
    })

    return result
  }, [])

  await knex.batchInsert('events', eventRows, 10)
}
