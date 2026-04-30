import { pubkeySchema } from './base-schema'
import { z } from 'zod'

const hexRegex = /^[0-9a-f]+$/i

export const nodelessSignatureSchema = z.string().regex(hexRegex).length(64)

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
