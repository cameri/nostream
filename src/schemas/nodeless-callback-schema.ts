import { pubkeySchema } from './base-schema'
import { z } from 'zod'

export const nodelessCallbackBodySchema = z
  .object({
    id: z.string().optional(),
    uuid: z.string(),
    status: z.string(),
    amount: z.number(),
    metadata: z
      .object({
        requestId: pubkeySchema,
        description: z.string().optional(),
        unit: z.string().optional(),
        createdAt: z.union([z.string(), z.date()]).optional(),
      })
      .passthrough(),
  })
  .strict()
