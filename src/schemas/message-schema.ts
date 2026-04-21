import { z } from 'zod'

import { eventSchema } from './event-schema'
import { filterSchema } from './filter-schema'
import { MessageType } from '../@types/messages'
import { subscriptionSchema } from './base-schema'

export const eventMessageSchema = z.tuple([z.literal(MessageType.EVENT), eventSchema])

export const reqMessageSchema = z
  .tuple([z.literal(MessageType.REQ), z.string().max(256).min(1)])
  .rest(filterSchema)
  .superRefine((val, ctx) => {
    if (val.length < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_small,
        minimum: 3,
        type: 'array',
        inclusive: true,
        message: 'REQ message must contain at least one filter',
      })
    } else if (val.length > 12) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: 12,
        type: 'array',
        inclusive: true,
        message: 'REQ message must contain at most 12 elements',
      })
    }
  })

export const countMessageSchema = z
  .tuple([z.literal(MessageType.COUNT), z.string().max(256).min(1)])
  .rest(filterSchema)
  .superRefine((val, ctx) => {
    if (val.length < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_small,
        minimum: 3,
        type: 'array',
        inclusive: true,
        message: 'COUNT message must contain at least one filter',
      })
    } else if (val.length > 12) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: 12,
        type: 'array',
        inclusive: true,
        message: 'COUNT message must contain at most 12 elements',
      })
    }
  })

export const closeMessageSchema = z.tuple([z.literal(MessageType.CLOSE), subscriptionSchema])

export const messageSchema = z.union([eventMessageSchema, reqMessageSchema, closeMessageSchema, countMessageSchema])
