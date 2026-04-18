import { idSchema } from './base-schema'
import Schema from 'joi'

export const lnbitsCallbackQuerySchema = Schema.object({
  hmac: Schema.string().pattern(/^[0-9]{1,20}:[0-9a-f]{64}$/).required(),
}).unknown(false)

export const lnbitsCallbackBodySchema = Schema.object({
  payment_hash: idSchema.label('payment_hash').required(),
}).unknown(false)
