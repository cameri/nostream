import { pubkeySchema } from './base-schema'
import { z } from 'zod'

const openNodeCallbackStatuses = ['expired', 'refunded', 'unpaid', 'processing', 'underpaid', 'paid'] as const

export const opennodeWebhookCallbackBodySchema = z
  .object({
    id: z.string(),
    hashed_order: z.string(),
    status: z.enum(openNodeCallbackStatuses),
  })
  .passthrough()

export const opennodeCallbackBodySchema = z
  .object({
    id: z.string(),
    status: z.string(),
    order_id: pubkeySchema,
    description: z.string().or(z.literal('')).optional(),
    amount: z.number().optional(),
    price: z.number().optional(),
    created_at: z.union([z.number(), z.string()]).optional(),
    lightning_invoice: z
      .object({
        payreq: z.string().optional(),
        expires_at: z.number().optional(),
      })
      .passthrough()
      .optional(),
    lightning: z
      .object({
        payreq: z.string().optional(),
        expires_at: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
