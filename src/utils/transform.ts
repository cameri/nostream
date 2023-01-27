import { always, applySpec, ifElse, is, isNil, path, pipe, prop, propSatisfies } from 'ramda'
import { bech32 } from 'bech32'

import { Invoice } from '../@types/invoice'
import { User } from '../@types/user'

export const toJSON = (input: any) => JSON.stringify(input)

export const toBuffer = (input: any) => Buffer.from(input, 'hex')

export const fromBuffer = (input: Buffer) => input.toString('hex')

export const toBigInt = (input: string): bigint => BigInt(input)

export const fromBigInt = (input: bigint) => input.toString()

export const fromDBInvoice = applySpec<Invoice>({
  id: prop('id') as () => string,
  pubkey: pipe(prop('pubkey') as () => Buffer, fromBuffer),
  bolt11: prop('bolt11'),
  amountRequested: pipe(prop('amount_requested') as () => string, toBigInt),
  amountPaid: ifElse(
    propSatisfies(isNil, 'amount_paid'),
    always(undefined),
    pipe(prop('amount_paid') as () => string, toBigInt),
  ),
  unit: prop('unit'),
  status: prop('status'),
  description: prop('description'),
  confirmedAt: prop('confirmed_at'),
  expiresAt: prop('expires_at'),
  updatedAt: prop('updated_at'),
  createdAt: prop('created_at'),
})

export const fromDBUser = applySpec<User>({
  pubkey: pipe(prop('pubkey') as () => Buffer, fromBuffer),
  isAdmitted: prop('is_admitted'),
  balance: prop('balance'),
  createdAt: prop('created_at'),
  updatedAt: prop('updated_at'),
})

export const fromBech32 = (input: string) => {
  const { prefix, words } = bech32.decode(input)
  if (!input.startsWith(prefix)) {
    throw new Error(`Bech32 invalid prefix: ${prefix}`)
  }

  return Buffer.from(
    bech32.fromWords(words).slice(0, 32)
  ).toString('hex')
}

export const toBech32 = (prefix: string) => (input: string): string => {
  return bech32.encode(prefix, bech32.toWords(Buffer.from(input, 'hex')))
}

export const toDate = (input: string) => new Date(input)

export const fromZebedeeInvoice = applySpec<Invoice>({
  id: prop('id'),
  pubkey: prop('internalId'),
  bolt11: path(['invoice', 'request']),
  amountRequested: pipe(prop('amount') as () => string, toBigInt),
  description: prop('description'),
  unit: prop('unit'),
  status: prop('status'),
  expiresAt: ifElse(
    propSatisfies(is(String), 'expiresAt'),
    pipe(prop('expiresAt'), toDate),
    always(null),
  ),
  confirmedAt: ifElse(
    propSatisfies(is(String), 'confirmedAt'),
    pipe(prop('confirmedAt'), toDate),
    always(null),
  ),
  createdAt: ifElse(
    propSatisfies(is(String), 'createdAt'),
    pipe(prop('createdAt'), toDate),
    always(null),
  ),
  rawRespose: toJSON,
})
