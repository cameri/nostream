import { Event } from '../@types/event'

export const serializeEvent = ({
  pubkey,
  created_at,
  kind,
  tags,
  content,
}: Event): string =>
  JSON.stringify([0, pubkey, created_at, kind, tags, content])
