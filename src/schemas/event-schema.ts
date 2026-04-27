import { z } from 'zod'

import { EventKinds, EventTags } from '../constants/base'
import { createdAtSchema, idSchema, kindSchema, pubkeySchema, signatureSchema, tagSchema } from './base-schema'

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
    if (event.kind === EventKinds.RELAY_LIST) {
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

    if (event.kind === EventKinds.REACTION) {
      const hasETag = event.tags.some((tag) => tag[0] === EventTags.Event)
      if (!hasETag) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Reaction event must have at least one e tag',
          path: ['tags'],
        })
      }
    }

    if (event.kind === EventKinds.EXTERNAL_CONTENT_REACTION) {
      const hasKTag = event.tags.some((tag) => tag[0] === EventTags.Kind)
      const hasITag = event.tags.some((tag) => tag[0] === EventTags.Index)
      if (!hasKTag) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'External content reaction must have a k tag',
          path: ['tags'],
        })
      }
      if (!hasITag) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'External content reaction must have an i tag',
          path: ['tags'],
        })
      }
    }
  })
