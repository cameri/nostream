import { z } from 'zod'

import { createdAtSchema, geohashFilterValueSchema, kindSchema, prefixSchema } from './base-schema'
import { isGenericTagQuery, isGeohashTagQuery } from '../utils/filter'

const knownFilterKeys = new Set(['ids', 'authors', 'kinds', 'since', 'until', 'limit'])

export const filterSchema = z
  .object({
    ids: z.array(prefixSchema).optional(),
    authors: z.array(prefixSchema).optional(),
    kinds: z.array(kindSchema).optional(),
    since: createdAtSchema.optional(),
    until: createdAtSchema.optional(),
    limit: z.number().int().min(0).optional(),
  })
  .catchall(z.array(z.string().max(1024)))
  .superRefine((data, ctx) => {
    for (const [key, value] of Object.entries(data)) {
      if (!knownFilterKeys.has(key) && !isGenericTagQuery(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown key: ${key}`,
          path: [key],
        })
        continue
      }

      // Validate #g filter values: NIP-12 geohash with optional single trailing '*'
      if (isGeohashTagQuery(key) && Array.isArray(value)) {
        value.forEach((criterion, index) => {
          if (typeof criterion === 'string' && !geohashFilterValueSchema.safeParse(criterion).success) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Invalid geohash filter',
              path: [key, index],
            })
          }
        })
      }
    }
  })
