//! Protocol constants. Mirrors `src/constants/base.ts` (the subset the domain types need).

/// The NIP-62 relay tag value meaning "every relay" (`src/constants/base.ts` `ALL_RELAYS`).
pub const ALL_RELAYS: &str = "ALL_RELAYS";

/// The largest integer JavaScript represents exactly; used by the settings defaults and by
/// the negentropy storage seam's timestamp bound.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The NIP-11 `supported_nips` advertisement: the Phase 0 audit's `must-have` set
/// (`docs/rewrite/nip-parity.md` §2, 33 rows) plus NIP-67, whose hint this tree implements
/// (§10, decision D2). Ascending, no duplicates.
///
/// Nothing serves this yet — the workspace has no HTTP listener and no NIP-11 document — so
/// the list is a decision record rather than an answer on the wire (D1). The array length is
/// the second guard: an id added without the type changing does not compile.
pub const SUPPORTED_NIPS: [u16; 34] = [
    1, 2, 3, 4, 5, 9, 11, 12, 13, 14, 16, 17, 20, 22, 25, 28, 33, 40, 42, 43, 44, 45, 50, 56, 59,
    62, 65, 66, 67, 70, 77, 89, 90, 98,
];

/// The payment processors the settings surface names (`src/constants/base.ts` `PaymentsProcessors`).
pub const PAYMENTS_PROCESSORS: [&str; 6] =
    ["lnurl", "zebedee", "lnbits", "nodeless", "opennode", "nwc"];
