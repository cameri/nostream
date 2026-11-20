
/** Bounds decode work without rejecting real invoices with route hints (a few KB). */
const MAX_BOLT11_LENGTH = 4_096

const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32_ALPHABET_MAP: Record<string, number> = {}
for (let i = 0; i < BECH32_ALPHABET.length; i++) {
  BECH32_ALPHABET_MAP[BECH32_ALPHABET[i]] = i
}

const bech32PolymodStep = (pre: number): number => {
  const b = pre >> 25
  return (
    ((pre & 0x1ffffff) << 5) ^
    (-((b >> 0) & 1) & 0x3b6a57b2) ^
    (-((b >> 1) & 1) & 0x26508e6d) ^
    (-((b >> 2) & 1) & 0x1ea119fa) ^
    (-((b >> 3) & 1) & 0x3d4233dd) ^
    (-((b >> 4) & 1) & 0x2a1462b3)
  )
}

const bech32PrefixChk = (prefix: string): number => {
  let chk = 1
  for (let i = 0; i < prefix.length; ++i) {
    chk = bech32PolymodStep(chk) ^ (prefix.charCodeAt(i) >> 5)
  }
  chk = bech32PolymodStep(chk)
  for (let i = 0; i < prefix.length; ++i) {
    chk = bech32PolymodStep(chk) ^ (prefix.charCodeAt(i) & 0x1f)
  }
  return chk
}

const bech32Convert = (data: number[], inBits: number, outBits: number, pad: boolean): number[] => {
  let value = 0
  let bits = 0
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
    if (bits > 0) {
      result.push((value << (outBits - bits)) & maxV)
    }
  } else if (bits >= inBits || ((value << (outBits - bits)) & maxV) !== 0) {
    throw new Error('Invalid bech32 padding')
  }
  return result
}

const bech32Decode = (input: string): { prefix: string; words: number[] } => {
  const value = input.trim()
  if (!value || value.length > MAX_BOLT11_LENGTH) {
    throw new Error(`Invalid bolt11 invoice (length ${value.length})`)
  }
  const lower = value.toLowerCase()
  if (value !== lower && value !== value.toUpperCase()) {
    throw new Error('Invalid bolt11 case')
  }

  const split = lower.lastIndexOf('1')
  if (split < 1 || split + 7 > lower.length) {
    throw new Error('Invalid bolt11 bech32 payload')
  }

  const prefix = lower.slice(0, split)
  const wordChars = lower.slice(split + 1)
  let chk = bech32PrefixChk(prefix)
  const words: number[] = []
  for (let i = 0; i < wordChars.length; ++i) {
    const v = BECH32_ALPHABET_MAP[wordChars[i]]
    if (v === undefined) {
      throw new Error(`Unknown bolt11 character: ${wordChars[i]}`)
    }
    chk = bech32PolymodStep(chk) ^ v
    if (i + 6 < wordChars.length) {
      words.push(v)
    }
  }
  if (chk !== 1) {
    throw new Error('Invalid bolt11 checksum')
  }

  return { prefix, words }
}

const HRP_PATTERN = /^ln(bcrt|bc|tbs|tb)(\d+)?([munp])?$/
const UNIT_MSATS: Record<string, bigint> = {
  '': 100_000_000_000n,
  m: 100_000_000n,
  u: 100_000n,
  n: 100n,
  p: 1n,
}
const UNIT_DIVISOR: Record<string, bigint> = {
  '': 1n,
  m: 1n,
  u: 1n,
  n: 1n,
  p: 10n,
}

export interface DecodedBolt11 {
  /** Payment hash from the `p` tagged field, lowercase hex. */
  paymentHash: string
  /** Invoice amount in millisatoshis. Zero means a no-amount invoice. */
  amountMsats: bigint
  network: 'bc' | 'tb' | 'tbs' | 'bcrt'
}

/**
 * Decodes just enough of a BOLT11 invoice to dedupe on its payment hash and
 * compare its amount with an advertised term. This is not a signature or
 * preimage verifier: the paying processor remains the authority on validity.
 */
export const decodeBolt11 = (invoice: string): DecodedBolt11 => {
  const { prefix, words } = bech32Decode(invoice)
  const match = HRP_PATTERN.exec(prefix)
  if (!match) {
    throw new Error('Unsupported bolt11 network or amount')
  }

  const [, network, digits, unit = ''] = match
  const amount = digits ? BigInt(digits) : 0n
  const divisor = UNIT_DIVISOR[unit]
  const amountMsats = (amount * UNIT_MSATS[unit]) / divisor
  if ((amount * UNIT_MSATS[unit]) % divisor !== 0n) {
    throw new Error('bolt11 amount is not a whole number of millisatoshis')
  }

  // The first 7 words are the 35-bit timestamp. The final 104 words are the
  // recoverable signature and must never be read as tagged fields.
  let index = 7
  const dataEnd = words.length - 104
  let paymentHash: string | undefined

  while (index + 3 <= dataEnd) {
    const type = words[index]
    const length = words[index + 1] * 32 + words[index + 2]
    index += 3

    if (length < 0 || index + length > dataEnd) {
      break
    }

    const data = words.slice(index, index + length)
    index += length

    if (type === 1 && data.length >= 52) {
      const bytes = bech32Convert(data.slice(0, 52), 5, 8, false)
      if (bytes.length === 32) {
        paymentHash = Buffer.from(bytes).toString('hex')
      }
    }
  }

  if (!paymentHash) {
    throw new Error('bolt11 invoice has no payment hash')
  }

  return {
    paymentHash,
    amountMsats,
    network: network as DecodedBolt11['network'],
  }
}

/** BOLT11 payment hash, used as the dedupe key for a buyer invoice. */
export const bolt11PaymentHash = (invoice: string): string => decodeBolt11(invoice).paymentHash
