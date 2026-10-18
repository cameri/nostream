//! Geohash helpers. Mirrors `src/utils/geohash.ts`.

use crate::error::CoreError;

/// Encodes coordinates at the requested precision.
///
/// Phase 1 stub — job 005; will encode latitude/longitude into a geohash; see `src/utils/geohash.ts`.
pub fn encode(_latitude: f64, _longitude: f64, _precision: usize) -> Result<String, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::geohash::encode",
    })
}

/// The set of geohash cells covering a radius, for NIP-52 queries.
///
/// Phase 1 stub — job 005; will expand a prefix into covering cells; see `src/utils/geohash.ts`.
pub fn covering_cells(_center: &str, _radius_km: f64) -> Result<Vec<String>, CoreError> {
    Err(CoreError::NotImplemented {
        module: "core::geohash::covering_cells",
    })
}
