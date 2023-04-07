import Schema from 'joi'

import {
  createdAtSchema,
  idSchema,
  kindSchema,
  pubkeySchema,
  signatureSchema,
  tagSchema,
} from './base-schema'


/**
 * {
 *   "id": <32-bytes sha256 of the the serialized event data>
 *   "pubkey": <32-bytes hex-encoded public key of the event creator>,
 *   "created_at": <unix timestamp in seconds>,
 *   "kind": <integer>,
 *   "tags": [
 *     ["e", <32-bytes hex of the id of another event>, <recommended relay URL>],
 *     ["p", <32-bytes hex of the key>, <recommended relay URL>],
 *     ... // other kinds of tags may be included later
 *   ]
 *   "content": <arbitrary string>,
 *   "sig": <64-bytes signature of the sha256 hash of the serialized event data, which is the same as the "id" field>,
 * }
 */
export const eventSchema = Schema.object({
  // NIP-01
  id: idSchema.required(),
  pubkey: pubkeySchema.required(),
  created_at: createdAtSchema.required(),
  kind: kindSchema.required(),
  tags: Schema.array().items(tagSchema).required(),
  content: Schema.string()
    .allow('')
    .required(),
  sig: signatureSchema.required(),
}).unknown(false)
