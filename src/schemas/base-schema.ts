import Schema from 'joi'

export const prefixSchema = Schema.string().case('lower').hex().min(1).max(64)

export const idSchema = Schema.string().case('lower').hex().length(64)

export const pubkeySchema = Schema.string().case('lower').hex().length(64)

export const kindSchema = Schema.number().min(0).multiple(1)

export const signatureSchema = Schema.string().case('lower').hex().length(128)

export const subscriptionSchema = Schema.string().min(1).max(255)

// [<string>, <string> 0..*]
export const tagSchema = Schema.array()
  .ordered(Schema.string().max(255).required())
  .items(Schema.string().allow('').max(1024))
  .max(10)
