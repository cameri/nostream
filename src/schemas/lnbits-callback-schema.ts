import { idSchema } from './base-schema'
import { z } from 'zod'

export const lnbitsCallbackQuerySchema = z
  .object({
    hmac: z.string().regex(/^[0-9]{1,20}:[0-9a-f]{64}$/),
  })
  .strict()

export const lnbitsCallbackBodySchema = z
  .object({
    payment_hash: idSchema,
  })
  .strict()
