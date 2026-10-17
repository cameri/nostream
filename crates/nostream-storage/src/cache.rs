//! The cache seam. Mirrors `src/@types/cache.ts` and `src/cache/client.ts`.

use crate::error::StorageError;

/// The cache operations the relay uses, with a default TTL for `set`.
///
/// Crate-private in Phase 1 so the crate's public trait surface is exactly the nine
/// repositories (the cache's only consumer is inside this crate until the Redis backend
/// lands); it becomes public with the Phase-2 cache implementation.
#[allow(dead_code)]
pub(crate) trait Cache {
    fn get(&self, key: &str) -> impl Future<Output = Result<Option<String>, StorageError>> + Send;
    fn set(&self, key: &str, value: &str) -> impl Future<Output = Result<(), StorageError>> + Send;
    fn del(&self, key: &str) -> impl Future<Output = Result<(), StorageError>> + Send;
}

/// The Redis-backed cache (`src/cache/client.ts`).
///
/// No `redis` dependency is carried in Phase 1; the type exists so the relay's seams are
/// visible and the Phase-2 implementation has its place marked.
#[derive(Debug, Clone, Default)]
pub struct RedisCache {
    _private: (),
}

impl RedisCache {
    /// Connects to Redis at `url`.
    ///
    /// Phase 1 stub — job 005; will connect a redis client with the shared cache config; see `src/cache/client.ts`.
    pub async fn connect(_url: &str) -> Result<Self, StorageError> {
        Err(StorageError::NotImplemented {
            module: "storage::cache::RedisCache::connect",
        })
    }
}

impl Cache for RedisCache {
    async fn get(&self, _key: &str) -> Result<Option<String>, StorageError> {
        Err(StorageError::NotImplemented {
            module: "storage::cache::RedisCache::get",
        })
    }

    async fn set(&self, _key: &str, _value: &str) -> Result<(), StorageError> {
        Err(StorageError::NotImplemented {
            module: "storage::cache::RedisCache::set",
        })
    }

    async fn del(&self, _key: &str) -> Result<(), StorageError> {
        Err(StorageError::NotImplemented {
            module: "storage::cache::RedisCache::del",
        })
    }
}
