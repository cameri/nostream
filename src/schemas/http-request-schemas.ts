import Schema from 'joi'

import { pubkeySchema } from './base-schema'


export const generateInvoiceSchema = Schema.object({
  pubkey: pubkeySchema.required(),
  tosAccepted: Schema.valid('yes').required(),
}).unknown(false)
