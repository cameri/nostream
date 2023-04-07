import Schema from 'joi'

import { createdAtSchema, kindSchema, prefixSchema } from './base-schema'

export const filterSchema = Schema.object({
  ids: Schema.array().items(prefixSchema.label('prefixOrId')),
  authors: Schema.array().items(prefixSchema.label('prefixOrAuthor')),
  kinds: Schema.array().items(kindSchema),
  since: createdAtSchema,
  until: createdAtSchema,
  limit: Schema.number().min(0).multiple(1),
}).pattern(/^#[a-z]$/, Schema.array().items(Schema.string().max(1024)))
