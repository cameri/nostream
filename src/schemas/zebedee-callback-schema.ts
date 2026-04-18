import { pubkeySchema } from './base-schema'
import Schema from 'joi'

export const zebedeeCallbackBodySchema = Schema.object({
  id: Schema.string().required(),
  status: Schema.string().required(),
  internalId: pubkeySchema.label('internalId').required(),
  amount: Schema.alternatives().try(Schema.string(), Schema.number()).required(),
  description: Schema.string().required(),
  unit: Schema.string().required(),
  expiresAt: Schema.string().optional(),
  confirmedAt: Schema.string().optional(),
  createdAt: Schema.string().optional(),
  invoice: Schema.object({
    request: Schema.string().required(),
  }).unknown(false).required(),
}).unknown(true)
