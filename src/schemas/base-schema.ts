import Schema from 'joi'

export const pubkeySchema = Schema.string().length(64)

export const kindSchema = Schema.number().min(0).multiple(1)

export const signatureSchema = Schema.string().length(128)

export const subscriptionSchema = Schema.string().min(1).max(255)

// [<string>, <string> 0..*]
export const tagSchema = Schema.array()
  .ordered(Schema.string().max(255).required())
  .items(Schema.string())
