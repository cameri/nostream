import Schema from 'joi'

export const filterSchema = Schema.object({
  ids: Schema.array().items(Schema.string()),
  authors: Schema.array().items(Schema.string()),
  kinds: Schema.array().items(Schema.number().min(0)),
  since: Schema.number().min(0).multiple(1),
  until: Schema.number().min(0).multiple(1),
  limit: Schema.number().min(1).multiple(1).max(500),
  '#e': Schema.array().items(Schema.string()),
  '#p': Schema.array().items(Schema.string()),
})
