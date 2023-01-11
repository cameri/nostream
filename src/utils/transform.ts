import { applySpec, is, path, pathEq, pipe, prop, propSatisfies, when } from 'ramda'
import { bech32 } from 'bech32'

import { DBInvoice, Invoice } from '../@types/invoice'
import { Pubkey } from '../@types/base'

export const toJSON = (input: any) => JSON.stringify(input)

export const toBuffer = (input: any) => Buffer.from(input, 'hex')

export const fromBuffer = (input: Buffer) => input.toString('hex')

export const toBigInt = (input: string): bigint => BigInt(input)

export const fromBigInt = (input: bigint) => input.toString()

export const fromDBInvoice = (input: DBInvoice): Invoice => applySpec<Invoice>({
  id: prop('id') as () => Pubkey,
  pubkey: pipe(prop('pubkey') as () => Buffer, fromBuffer),
  bolt11: prop('bolt11'),
  amountRequested: pipe(prop('amount_requested'), toBigInt),
  amountPaid: pipe(prop('amount_paid'), toBigInt),
  unit: prop('unit'),
  status: prop('status'),
  description: prop('description'),
  confirmedAt: prop('confirmed_at'),
  expiresAt: prop('expires_at'),
  updatedAt: prop('updated_at'),
  createdAt: prop('created_at'),
})(input)

export const fromNpub = (npub: string) => {
  const { prefix, words } = bech32.decode(npub)
  if (prefix !== 'npub') {
    throw new Error('not an npub key')
  }

  return Buffer.from(
    bech32.fromWords(words).slice(0, 32)
  ).toString('hex')
}

export const toDate = (input: string) => new Date(input)


export const fromZebedeeInvoice = applySpec<Invoice>({
  id: prop('id'),
  pubkey: prop('internalId'),
  bolt11: path(['invoice', 'request']),
  amountRequested: pipe(prop('amount'), toBigInt),
  amountPaid: when(
    pathEq(['status'], 'completed'),
    pipe(prop('amount'), toBigInt),
  ),
  unit: prop('unit'),
  status: prop('status'),
  description: prop('description'),
  confirmedAt: when(
    propSatisfies(is(String), 'confirmed_at'),
    pipe(prop('confirmed_at'), toDate),
  ),
  expiresAt: when(
    propSatisfies(is(String), 'confirmed_at'),
    pipe(prop('expires_at'), toDate),
  ),
  createdAt: pipe(prop('created_at'), toDate),
})
