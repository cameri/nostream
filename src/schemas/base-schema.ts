import Schema from 'joi'

export const prefixSchema = Schema.string().case('lower').hex().min(4).max(64).label('prefix')

export const idSchema = Schema.string().case('lower').hex().length(64).label('id')

export const pubkeySchema = Schema.string().case('lower').hex().length(64).label('pubkey')

export const kindSchema = Schema.number().min(0).multiple(1).label('kind')

export const signatureSchema = Schema.string().case('lower').hex().length(128).label('sig')

export const subscriptionSchema = Schema.string().min(1).max(255).label('subscriptionId')

const seconds = (value: any, helpers: any) => (Number.isSafeInteger(value) && Math.log10(value) < 10) ? value : helpers.error('any.invalid')

export const createdAtSchema = Schema.number().min(0).multiple(1).custom(seconds)

// [<string>, <string> 0..*]
export const tagSchema = Schema.array()
  .ordered(Schema.string().max(255).required().label('identifier'))
  .items(Schema.string().allow('').max(1024).label('value'))
  .max(10)
  .label('tag')
