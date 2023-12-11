import { always, applySpec, cond, equals, ifElse, is, isNil, multiply, path, pathSatisfies, pipe, prop, propSatisfies, T } from 'ramda'
import { bech32 } from 'bech32'

import { Invoice, InvoiceStatus, InvoiceUnit } from '../@types/invoice'
import { User } from '../@types/user'

export const toJSON = (input: any) => JSON.stringify(input)

export const toBuffer = (input: any) => Buffer.from(input, 'hex')

export const fromBuffer = (input: Buffer) => input.toString('hex')

export const toBigInt = (input: string | number): bigint => BigInt(input)

export const fromBigInt = (input: bigint) => input.toString()

const addTime = (ms: number) => (input: Date) => new Date(input.getTime() + ms)

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
  verifyURL: prop('verify_url'),
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

export const toDate = (input: string | number) => new Date(input)

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
  rawResponse: toJSON,
})

export const fromNodelessInvoice = applySpec<Invoice>({
  id: prop('id'),
  pubkey: path(['metadata', 'requestId']),
  bolt11: prop('lightningInvoice'),
  amountRequested: pipe(prop('satsAmount') as () => number, toBigInt),
  description: path(['metadata', 'description']),
  unit: path(['metadata', 'unit']),
  status: pipe(
    prop('status'),
    cond([
      [equals('new'), always(InvoiceStatus.PENDING)],
      [equals('pending_confirmation'), always(InvoiceStatus.PENDING)],
      [equals('underpaid'), always(InvoiceStatus.PENDING)],
      [equals('in_flight'), always(InvoiceStatus.PENDING)],
      [equals('paid'), always(InvoiceStatus.COMPLETED)],
      [equals('overpaid'), always(InvoiceStatus.COMPLETED)],
      [equals('expired'), always(InvoiceStatus.EXPIRED)],
    ]),
  ),
  expiresAt: ifElse(
    propSatisfies(is(String), 'expiresAt'),
    pipe(prop('expiresAt'), toDate),
    ifElse(
      propSatisfies(is(String), 'createdAt'),
      pipe(prop('createdAt'), toDate, addTime(15 * 60000)),
      always(null),
    ),
  ),
  confirmedAt: cond([
    [propSatisfies(is(String), 'paidAt'), pipe(prop('paidAt'), toDate)],
    [T, always(null)],
  ]),
  createdAt: ifElse(
    propSatisfies(is(String), 'createdAt'),
    pipe(prop('createdAt'), toDate),
    always(null),
  ),
  // rawResponse: toJSON,
})

export const fromOpenNodeInvoice = applySpec<Invoice>({
  id: prop('id'),
  pubkey: prop('order_id'),
  bolt11: ifElse(
    pathSatisfies(is(String), ['lightning_invoice', 'payreq']),
    path(['lightning_invoice', 'payreq']),
    path(['lightning', 'payreq'])
  ),
  amountRequested: pipe(
    ifElse(
      propSatisfies(is(Number), 'amount'),
      prop('amount'),
      prop('price'),
    ) as () => number,
    toBigInt,
  ),
  description: prop('description'),
  unit: always(InvoiceUnit.SATS),
  status: pipe(
    prop('status'),
    cond([
      [equals('expired'), always(InvoiceStatus.EXPIRED)],
      [equals('refunded'), always(InvoiceStatus.EXPIRED)],
      [equals('unpaid'), always(InvoiceStatus.PENDING)],
      [equals('processing'), always(InvoiceStatus.PENDING)],
      [equals('underpaid'), always(InvoiceStatus.PENDING)],
      [equals('paid'), always(InvoiceStatus.COMPLETED)],
    ]),
  ),
  expiresAt: pipe(
    cond([
      [pathSatisfies(is(String), ['lightning', 'expires_at']), path(['lightning', 'expires_at'])],
      [pathSatisfies(is(Number), ['lightning_invoice', 'expires_at']), pipe(path(['lightning_invoice', 'expires_at']), multiply(1000))],
    ]),
    toDate,
  ),
  confirmedAt: cond([
    [propSatisfies(equals('paid'), 'status'), () => new Date()],
    [T, always(null)],
  ]),
  createdAt: pipe(
    ifElse(
      propSatisfies(is(Number), 'created_at'),
      pipe(prop('created_at'), multiply(1000)),
      prop('created_at'),
    ),
    toDate,
  ),
  rawResponse: toJSON,
})
