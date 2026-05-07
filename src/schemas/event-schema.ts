import { z } from 'zod'

import { EventKinds, EventTags } from '../constants/base'
import { isExternalContentReactionEvent, isReactionEvent } from '../utils/nip25'
import {
  createdAtSchema,
  geohashSchema,
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
export const eventSchema = z
  .object({
    // NIP-01
    id: idSchema,
    pubkey: pubkeySchema,
    created_at: createdAtSchema,
    kind: kindSchema,
    tags: z.array(tagSchema),
    content: z.string(),
    sig: signatureSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    if (isReactionEvent(event)) {
      let hasEventTag = false
      let hasAddressTag = false
      for (const tag of event.tags) {
        if (tag[0] === EventTags.Event && typeof tag[1] === 'string' && tag[1].length > 0) { hasEventTag = true }
        else if (tag[0] === EventTags.Address && typeof tag[1] === 'string' && tag[1].length > 0) { hasAddressTag = true }
        if (hasEventTag && hasAddressTag) { break }
      }
      if (!hasEventTag && !hasAddressTag) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Reaction event (kind 7) must have at least one e or a tag',
          path: ['tags'],
        })
      }
    } else if (isExternalContentReactionEvent(event)) {
      let hasKTag = false
      let hasITag = false
      for (const tag of event.tags) {
        if (tag[0] === EventTags.Kind && tag.length >= 2 && typeof tag[1] === 'string' && tag[1].length > 0) { hasKTag = true }
        else if (tag[0] === EventTags.Index && tag.length >= 2 && typeof tag[1] === 'string' && tag[1].length > 0) { hasITag = true }
        if (hasKTag && hasITag) { break }
      }
      if (!hasKTag || !hasITag) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'External content reaction event (kind 17) must have k and i tags',
          path: ['tags'],
        })
      }
    } else if (event.kind === EventKinds.RELAY_LIST) {
      event.tags.forEach((tag, index) => {
        if (tag[0] === EventTags.Relay && !z.string().url().safeParse(tag[1]).success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid relay URL`,
            path: ['tags', index, 1],
          })
        }
      })
    }

    // Validate geohash tag values (NIP-12 #g)
    event.tags.forEach((tag, index) => {
      if (tag[0] === EventTags.Geohash && typeof tag[1] === 'string' && !geohashSchema.safeParse(tag[1]).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid geohash',
          path: ['tags', index, 1],
        })
      }
    })
  })
