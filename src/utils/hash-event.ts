import { createHash } from 'crypto'

import { Event } from '../types/event'
import { serializeEvent } from './serialize-event'

export const getEventHash = (event: Event) => {
  const hash = createHash('sha256')
    .update(Buffer.from(serializeEvent(event)))
    .digest()

  return Buffer.from(hash).toString('hex')
}
