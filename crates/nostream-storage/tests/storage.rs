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
