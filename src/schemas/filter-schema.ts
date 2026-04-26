import { z } from 'zod'

import { createdAtSchema, kindSchema, prefixSchema } from './base-schema'
import { isGenericTagQuery } from '../utils/filter'

const knownFilterKeys = new Set(['ids', 'authors', 'kinds', 'since', 'until', 'limit', 'search'])

export const filterSchema = z
  .object({
    ids: z.array(prefixSchema).optional(),
    authors: z.array(prefixSchema).optional(),
    kinds: z.array(kindSchema).optional(),
    since: createdAtSchema.optional(),
    until: createdAtSchema.optional(),
    limit: z.number().int().min(0).optional(),
    // NIP-50: full-text search query string
    search: z.string().min(1).max(1024).optional(),
  })
  .catchall(z.array(z.string().max(1024)))
  .superRefine((data, ctx) => {
    for (const key of Object.keys(data)) {
      if (!knownFilterKeys.has(key) && !isGenericTagQuery(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown key: ${key}`,
          path: [key],
        })
      }
    }
  })
