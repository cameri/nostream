import { pubkeySchema } from './base-schema'
import Schema from 'joi'

export const nodelessCallbackBodySchema = Schema.object({
  id: Schema.string(),
  uuid: Schema.string().required(),
  status: Schema.string().required(),
  amount: Schema.number().required(),
  metadata: Schema.object({
    requestId: pubkeySchema.label('metadata.requestId').required(),
    description: Schema.string().optional(),
    unit: Schema.string().optional(),
    createdAt: Schema.alternatives().try(Schema.string(), Schema.date()).optional(),
  }).unknown(true).required(),
}).unknown(false)
