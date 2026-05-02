// Geohash base32 alphabet (excludes 'a', 'i', 'l', 'o')
export const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'

// Matches a complete geohash (one or more base32 chars)
export const GEOHASH_PATTERN = /^[0123456789bcdefghjkmnpqrstuvwxyz]+$/

// Matches a geohash filter criterion: one or more base32 chars, with an
// optional single trailing '*' wildcard (NIP-12 prefix matching)
export const GEOHASH_FILTER_PATTERN = /^[0123456789bcdefghjkmnpqrstuvwxyz]+\*?$/
