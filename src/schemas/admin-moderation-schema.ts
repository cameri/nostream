import { z } from 'zod'

import { kindSchema } from './base-schema'

// Match event admission (`kindSchema`), which accepts any non-negative integer,
// so moderation rules can configure and round-trip every kind admission allows.
const kindRuleSchema = z.union([
  kindSchema,
  z.tuple([kindSchema, kindSchema]).refine(([start, end]) => start <= end, {
    message: 'Kind range start must not exceed its end',
  }),
])

export const adminModerationLimitsPatchSchema = z
  .object({
    pubkey: z
      .object({
        blacklist: z.array(z.string()).optional(),
        whitelist: z.array(z.string()).optional(),
      })
      .optional(),
    kind: z
      .object({
        blacklist: z.array(kindRuleSchema).optional(),
        whitelist: z.array(kindRuleSchema).optional(),
      })
      .optional(),
    rateLimitBypass: z
      .object({
        pubkeys: z.array(z.string()).optional(),
        ipAddresses: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .strict()

export const adminModerationActionSchema = z
  .object({
    action: z.enum([
      'ban-pubkey',
      'unban-pubkey',
      'whitelist-pubkey',
      'unwhitelist-pubkey',
      'whitelist-ip',
      'unwhitelist-ip',
    ]),
    pubkey: z.string().optional(),
    ip: z.string().optional(),
  })
  .strict()
