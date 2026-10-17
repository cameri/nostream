//! The LMDB environment slice and the backend stubs.

use std::path::Path;

use nostream_storage::{Backend, LmdbEnv, StorageError};

#[tokio::test]
async fn the_lmdb_environment_round_trips_a_value() {
    let directory = tempfile::tempdir().expect("tempdir");
    let env = LmdbEnv::open(directory.path(), 1024 * 1024).expect("the environment opens");

    env.put("greeting", "hello").expect("put");
    assert_eq!(env.get("greeting").expect("get"), Some("hello".to_owned()));
    assert_eq!(env.get("absent").expect("get"), None);
    assert_eq!(env.path(), Path::new(directory.path()));
}

#[test]
fn the_backend_parses_the_settings_spelling() {
    assert_eq!(Backend::parse("postgres"), Some(Backend::Postgres));
    assert_eq!(Backend::parse("lmdb"), Some(Backend::Lmdb));
    assert_eq!(Backend::parse("mongodb"), None);
    assert_eq!(Backend::Lmdb.to_string(), "lmdb");
}

#[tokio::test]
async fn the_postgres_backend_is_a_labelled_stub() {
    let error = nostream_storage::backend::PostgresBackend::connect("postgres://nostream")
        .await
        .expect_err("the Postgres backend is a stub");
    assert!(
        error
            .to_string()
            .contains("not implemented in Phase 1 (job 005)")
    );
    assert!(matches!(error, StorageError::NotImplemented { .. }));
}

#[test]
fn the_repository_traits_are_dyn_compatible() {
    // The seam exists so a backend can be picked at runtime: the trait objects must compile.
    // A boxed stub proves the vtable exists without touching a database.
    use std::future::Future;
    use std::pin::Pin;

    use nostream_core::{Event, EventId, Pubkey};
    use nostream_storage::StorageError;
    use nostream_storage::repositories::{
        EventPurgeCounts, EventRepository, Report, ReportRepository,
    };

    struct Noop;

    impl EventRepository for Noop {
        fn create(
            &self,
            _event: &Event,
        ) -> Pin<Box<dyn Future<Output = Result<u64, StorageError>> + Send>> {
            Box::pin(async { Err(StorageError::NotImplemented { module: "noop" }) })
        }

        fn count_by_filters(
            &self,
            _filters: &[nostream_core::Filter],
        ) -> Pin<Box<dyn Future<Output = Result<u64, StorageError>> + Send>> {
            Box::pin(async { Err(StorageError::NotImplemented { module: "noop" }) })
        }

        fn delete_by_pubkey_and_ids(
            &self,
            _pubkey: &Pubkey,
            _ids: &[EventId],
        ) -> Pin<Box<dyn Future<Output = Result<u64, StorageError>> + Send>> {
            Box::pin(async { Err(StorageError::NotImplemented { module: "noop" }) })
        }

        fn delete_expired_and_retained(
            &self,
            _options: &nostream_storage::repositories::EventRetentionOptions,
        ) -> Pin<Box<dyn Future<Output = Result<EventPurgeCounts, StorageError>> + Send>> {
            Box::pin(async { Err(StorageError::NotImplemented { module: "noop" }) })
        }
    }

    impl ReportRepository for Noop {
        fn create(
            &self,
            _report: &Report,
        ) -> Pin<Box<dyn Future<Output = Result<Report, StorageError>> + Send>> {
            Box::pin(async { Err(StorageError::NotImplemented { module: "noop" }) })
        }

        fn find_by_event_id(
            &self,
            _event_id: &EventId,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<Report>, StorageError>> + Send>> {
            Box::pin(async { Err(StorageError::NotImplemented { module: "noop" }) })
        }

        fn find_actionable(
            &self,
            _limit: u64,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<Report>, StorageError>> + Send>> {
            Box::pin(async { Err(StorageError::NotImplemented { module: "noop" }) })
        }
    }

    let _event_repository: std::sync::Arc<dyn EventRepository> = std::sync::Arc::new(Noop);
    let _report_repository: Box<dyn ReportRepository> = Box::new(Noop);
}
