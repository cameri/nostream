//! Protocol constants. Mirrors `src/constants/base.ts` (the subset the domain types need).

/// The NIP-62 relay tag value meaning "every relay" (`src/constants/base.ts` `ALL_RELAYS`).
pub const ALL_RELAYS: &str = "ALL_RELAYS";

/// The largest integer JavaScript represents exactly; used by the settings defaults and by
/// the negentropy storage seam's timestamp bound.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The NIP-11 `supported_nips` advertisement (`src/constants/base.ts` `SUPPORTED_NIPS` shape).
pub const SUPPORTED_NIPS: [u16; 4] = [11, 42, 45, 50];

/// The payment processors the settings surface names (`src/constants/base.ts` `PaymentsProcessors`).
pub const PAYMENTS_PROCESSORS: [&str; 6] =
    ["lnurl", "zebedee", "lnbits", "nodeless", "opennode", "nwc"];
