//! Load-aware PoW difficulty. Mirrors `src/utils/adaptive-pow.ts`.

/// The adaptive-difficulty knobs, copied from the settings section of the same name.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AdaptivePowConfig {
    pub enabled: bool,
    pub floor_bits: u32,
    pub ceiling_bits: u32,
    pub target_events_per_second: f64,
    pub period_ms: u64,
}

/// The required difficulty for the observed event rate.
///
/// Phase 1 stub — job 005; will scale difficulty between `floor_bits` and `ceiling_bits`
/// from the EWMA event rate; see `src/utils/adaptive-pow.ts`.
pub fn compute_difficulty(
    _config: &AdaptivePowConfig,
    _observed_events_per_second: f64,
) -> Result<u32, crate::error::CoreError> {
    Err(crate::error::CoreError::NotImplemented {
        module: "core::adaptive_pow::compute_difficulty",
    })
}
