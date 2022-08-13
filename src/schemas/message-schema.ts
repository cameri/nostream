import Schema from 'joi'
import { subscriptionSchema } from './base-schema'
import { eventSchema } from './event-schema'
import { filterSchema } from './filter-schema'

export const eventMessageSchema = Schema.array().ordered(
  Schema.string().valid('EVENT').required(),
  eventSchema.required(),
)

export const reqMessageSchema = Schema.array()
  .ordered(Schema.string().valid('REQ').required(), Schema.string().required())
  .items(filterSchema.required())

export const closeMessageSchema = Schema.array().ordered(
  Schema.string().valid('CLOSE').required(),
  subscriptionSchema.required(),
)

export const messageSchema = Schema.alternatives(
  eventMessageSchema,
  reqMessageSchema,
  closeMessageSchema,
)
