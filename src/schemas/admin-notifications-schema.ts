import { z } from 'zod'

const targetSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['http', 'discord', 'slack', 'telegram']),
    enabled: z.boolean(),
    url: z.string().optional(),
    botToken: z.string().optional(),
    chatId: z.string().optional(),
  })
  .strict()

export const adminNotificationsPatchBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    targets: z.array(targetSchema).optional(),
    events: z
      .object({
        'admission.invoice.created': z.boolean().optional(),
        'admission.invoice.paid': z.boolean().optional(),
        'admission.invoice.failed': z.boolean().optional(),
        'settings.changed': z.boolean().optional(),
        'relay.restarted': z.boolean().optional(),
      })
      .strict()
      .optional(),
    retry: z
      .object({
        maxAttempts: z.number().int().min(1).optional(),
        baseDelayMs: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    deliveryLogRetentionDays: z.number().int().min(1).optional(),
  })
  .strict()
