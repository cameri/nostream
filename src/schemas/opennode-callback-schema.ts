import { pubkeySchema } from './base-schema'
import Schema from 'joi'

export const opennodeCallbackBodySchema = Schema.object({
  id: Schema.string().required(),
  status: Schema.string().required(),
  order_id: pubkeySchema.label('order_id').required(),
  description: Schema.string().allow('').optional(),
  amount: Schema.number().optional(),
  price: Schema.number().optional(),
  created_at: Schema.alternatives().try(Schema.number(), Schema.string()).optional(),
  lightning_invoice: Schema.object({
    payreq: Schema.string().optional(),
    expires_at: Schema.number().optional(),
  }).unknown(true).optional(),
  lightning: Schema.object({
    payreq: Schema.string().optional(),
    expires_at: Schema.string().optional(),
  }).unknown(true).optional(),
}).unknown(true)
