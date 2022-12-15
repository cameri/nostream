import Schema from 'joi'

import { kindSchema, prefixSchema } from './base-schema'

export const filterSchema = Schema.object({
  ids: Schema.array().items(prefixSchema.label('prefixOrId')).max(1000),
  authors: Schema.array().items(prefixSchema.label('prefixOrAuthor')).max(1000),
  kinds: Schema.array().items(kindSchema).max(20),
  since: Schema.number().min(0).multiple(1),
  until: Schema.number().min(0).multiple(1),
  limit: Schema.number().min(1).multiple(1).max(10000),
}).pattern(/^#[a-z]$/, Schema.array().items(Schema.string().max(1024)).max(256))
