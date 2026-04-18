import { pubkeySchema } from './base-schema'
import { z } from 'zod'

export const zebedeeCallbackBodySchema = z
  .object({
    id: z.string(),
    status: z.string(),
    internalId: pubkeySchema,
    amount: z.union([z.string(), z.number()]),
    description: z.string(),
    unit: z.string(),
    expiresAt: z.string().optional(),
    confirmedAt: z.string().optional(),
    createdAt: z.string().optional(),
    invoice: z
      .object({
        request: z.string(),
      })
      .strict(),
  })
  .passthrough()
