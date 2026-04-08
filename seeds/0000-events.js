/* eslint-disable @typescript-eslint/no-var-requires */

const NAMESPACE = 'c646b451-db73-47fb-9a70-ea24ce8a225a'

function isReplaceableEvent(kind) {
  return kind === 0
    || kind === 3
    || kind === 41
    || (kind >= 10000 && kind < 20000)
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

exports.seed = async function (knex) {
  await knex('events').del()

  const { v5: uuidv5 } = require('uuid')

  const eventRows = require('./events.json').reduce((result, event) => {
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
