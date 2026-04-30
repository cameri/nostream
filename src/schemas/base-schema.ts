import { z } from 'zod'

import { GEOHASH_FILTER_PATTERN, GEOHASH_PATTERN } from '../utils/geohash'

const lowerHexRegex = /^[0-9a-f]+$/

// NIP-12 geohash schemas
export const geohashSchema = z.string().regex(GEOHASH_PATTERN, 'Invalid geohash')
export const geohashFilterValueSchema = z.string().regex(GEOHASH_FILTER_PATTERN, 'Invalid geohash filter')

export const prefixSchema = z.string().regex(lowerHexRegex).min(4).max(64)

export const idSchema = z.string().regex(lowerHexRegex).length(64)

export const pubkeySchema = z.string().regex(lowerHexRegex).length(64)

export const kindSchema = z.number().int().min(0)

export const signatureSchema = z.string().regex(lowerHexRegex).length(128)

export const subscriptionSchema = z.string().min(1)

export const createdAtSchema = z
  .number()
  .int()
  .min(0)
  .refine((value) => Number.isSafeInteger(value) && Math.log10(value) < 10, { message: 'Invalid timestamp' })

// [<string>, <string> 0..*]
export const tagSchema = z.tuple([z.string().min(1)]).rest(z.string())
