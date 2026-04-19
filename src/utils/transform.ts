import {
  always,
  applySpec,
  cond,
  equals,
  ifElse,
  is,
  isNil,
  multiply,
  path,
  pathSatisfies,
  pipe,
  prop,
  propSatisfies,
  T,
} from 'ramda'

import { Invoice, InvoiceStatus, InvoiceUnit } from '../@types/invoice'
import { User } from '../@types/user'

const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32_ALPHABET_MAP: Record<string, number> = {}
for (let i = 0; i < BECH32_ALPHABET.length; i++) { BECH32_ALPHABET_MAP[BECH32_ALPHABET[i]] = i }

function bech32PolymodStep(pre: number): number {
  const b = pre >> 25
  return (((pre & 0x1ffffff) << 5) ^
    (-((b >> 0) & 1) & 0x3b6a57b2) ^
    (-((b >> 1) & 1) & 0x26508e6d) ^
    (-((b >> 2) & 1) & 0x1ea119fa) ^
    (-((b >> 3) & 1) & 0x3d4233dd) ^
    (-((b >> 4) & 1) & 0x2a1462b3))
}

function bech32PrefixChk(prefix: string): number {
  let chk = 1
  for (let i = 0; i < prefix.length; ++i) {
    const c = prefix.charCodeAt(i)
    chk = bech32PolymodStep(chk) ^ (c >> 5)
  }
  chk = bech32PolymodStep(chk)
  for (let i = 0; i < prefix.length; ++i) {
    chk = bech32PolymodStep(chk) ^ (prefix.charCodeAt(i) & 0x1f)
  }
  return chk
}

function bech32Convert(data: number[], inBits: number, outBits: number, pad: boolean): number[] {
  let value = 0, bits = 0
  const maxV = (1 << outBits) - 1
  const maxAcc = (1 << (inBits + outBits - 1)) - 1
  const maxInput = (1 << inBits) - 1
  const result: number[] = []
  for (const byte of data) {
    if (!Number.isInteger(byte) || byte < 0 || byte > maxInput) {
      throw new Error(`Invalid value for ${inBits}-bit input: ${byte}`)
    }
    value = ((value << inBits) | byte) & maxAcc
    bits += inBits
    while (bits >= outBits) {
      bits -= outBits
      result.push((value >> bits) & maxV)
    }
  }
  if (pad) {
    if (bits > 0) { result.push((value << (outBits - bits)) & maxV) }
  } else if (bits >= inBits || ((value << (outBits - bits)) & maxV) !== 0) {
    throw new Error('Invalid bech32 padding')
  }
  return result
}

function bech32Decode(str: string): { prefix: string; words: number[] } {
  const lower = str.toLowerCase()
  const split = lower.lastIndexOf('1')
  if (split < 1 || split + 7 > str.length) { throw new Error(`Invalid bech32: ${str}`) }
  const prefix = lower.slice(0, split)
  const wordChars = lower.slice(split + 1)
  let chk = bech32PrefixChk(prefix)
  const words: number[] = []
  for (let i = 0; i < wordChars.length; ++i) {
    const v = BECH32_ALPHABET_MAP[wordChars[i]]
    if (v === undefined) { throw new Error(`Unknown bech32 character: ${wordChars[i]}`) }
    chk = bech32PolymodStep(chk) ^ v
    if (i + 6 < wordChars.length) { words.push(v) }
  }
  if (chk !== 1) { throw new Error('Invalid bech32 checksum') }
  return { prefix, words }
}

function bech32Encode(prefix: string, words: number[]): string {
  prefix = prefix.toLowerCase()
  let chk = bech32PrefixChk(prefix)
  let result = prefix + '1'
  for (const w of words) {
    chk = bech32PolymodStep(chk) ^ w
    result += BECH32_ALPHABET[w]
  }
  for (let i = 0; i < 6; ++i) { chk = bech32PolymodStep(chk) }
  chk ^= 1
  for (let i = 0; i < 6; ++i) { result += BECH32_ALPHABET[(chk >> ((5 - i) * 5)) & 0x1f] }
  return result
}

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
  isVanished: prop('is_vanished'),
  balance: prop('balance'),
  createdAt: prop('created_at'),
  updatedAt: prop('updated_at'),
})

export const fromBech32 = (input: string) => {
  const normalizedInput = input.toLowerCase()

  if (input !== normalizedInput && input !== input.toUpperCase()) {
    throw new Error('Bech32 mixed-case input is invalid')
  }

  const { prefix, words } = bech32Decode(input)
  if (!normalizedInput.startsWith(prefix)) {
    throw new Error(`Bech32 invalid prefix: ${prefix}`)
  }

  return Buffer.from(
    bech32Convert(words, 5, 8, false).slice(0, 32)
  ).toString('hex')
}

export const toBech32 = (prefix: string) => (input: string): string => {
  return bech32Encode(prefix, bech32Convert(Array.from(Buffer.from(input, 'hex')), 8, 5, true))
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
  expiresAt: ifElse(propSatisfies(is(String), 'expiresAt'), pipe(prop('expiresAt'), toDate), always(null)),
  confirmedAt: ifElse(propSatisfies(is(String), 'confirmedAt'), pipe(prop('confirmedAt'), toDate), always(null)),
  createdAt: ifElse(propSatisfies(is(String), 'createdAt'), pipe(prop('createdAt'), toDate), always(null)),
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
    ifElse(propSatisfies(is(String), 'createdAt'), pipe(prop('createdAt'), toDate, addTime(15 * 60000)), always(null)),
  ),
  confirmedAt: cond([
    [propSatisfies(is(String), 'paidAt'), pipe(prop('paidAt'), toDate)],
    [T, always(null)],
  ]),
  createdAt: ifElse(propSatisfies(is(String), 'createdAt'), pipe(prop('createdAt'), toDate), always(null)),
  // rawResponse: toJSON,
})

export const fromOpenNodeInvoice = applySpec<Invoice>({
  id: prop('id'),
  pubkey: prop('order_id'),
  bolt11: ifElse(
    pathSatisfies(is(String), ['lightning_invoice', 'payreq']),
    path(['lightning_invoice', 'payreq']),
    path(['lightning', 'payreq']),
  ),
  amountRequested: pipe(
    ifElse(propSatisfies(is(Number), 'amount'), prop('amount'), prop('price')) as () => number,
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
      [
        pathSatisfies(is(Number), ['lightning_invoice', 'expires_at']),
        pipe(path(['lightning_invoice', 'expires_at']), multiply(1000)),
      ],
    ]),
    toDate,
  ),
  confirmedAt: cond([
    [propSatisfies(equals('paid'), 'status'), () => new Date()],
    [T, always(null)],
  ]),
  createdAt: pipe(
    ifElse(propSatisfies(is(Number), 'created_at'), pipe(prop('created_at'), multiply(1000)), prop('created_at')),
    toDate,
  ),
  rawResponse: toJSON,
})
