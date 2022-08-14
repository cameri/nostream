export const toJSON = (input: any) => JSON.stringify(input)

export const toBuffer = (input: any) => Buffer.from(input, 'hex')

export const fromBuffer = (input: Buffer) => input.toString('hex')
