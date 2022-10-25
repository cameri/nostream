export function getLeadingZeroBits(hash: Buffer) {
  let total: number, i: number, bits: number

  for (i = 0, total = 0; i < hash.length; i++) {
    bits = msb(hash[i])
    total += bits
    if (bits != 8) {
      break
    }
  }
  return total
}

function msb(b: number) {
  let n = 0

  if (b == 0) {
    return 8
  }

  // eslint-disable-next-line no-cond-assign
  while (b >>= 1) {
    n++
  }

  return 7 - n
}
