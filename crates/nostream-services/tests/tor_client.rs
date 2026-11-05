//! The Tor control-port client and the hidden-service bootstrap.
//!
//! Mirrors `test/unit/tor/client.spec.ts` against a loopback fake control port: no Tor daemon
//! is needed, only the reply grammar the capture's `isCompleteTorReply` accepts.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nostream_services::tor::{
    DEFAULT_CONTROL_PORT, DEFAULT_HIDDEN_SERVICE_PORT, HiddenServiceOutcome, ONION_KEY_FILE,
    TorClient, TorConfig, ensure_hidden_service,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

/// One scripted reply. A `Split` reply arrives in two TCP segments.
#[derive(Clone)]
enum Reply {
    Whole(&'static str),
    Split(&'static str, usize),
}

/// A fake control port: one script per accepted connection.
async fn control_server(scripts: Vec<Vec<Reply>>) -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("local addr").port();
    let received = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&received);

    tokio::spawn(async move {
        for script in scripts {
            let (socket, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(socket);
            let mut reader = BufReader::new(read_half);
            let mut replies = script.into_iter();
            let mut buffer = Vec::new();

            loop {
                buffer.clear();

                match reader.read_until(b'\n', &mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }

                let command = String::from_utf8_lossy(&buffer).into_owned();
                log.lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(command);

                let Some(reply) = replies.next() else { break };

                match reply {
                    Reply::Whole(text) => {
                        write_half.write_all(text.as_bytes()).await.expect("write")
                    }
                    Reply::Split(text, at) => {
                        write_half
                            .write_all(&text.as_bytes()[..at])
                            .await
                            .expect("write");
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        write_half
                            .write_all(&text.as_bytes()[at..])
                            .await
                            .expect("write");
                    }
                }

                write_half.flush().await.expect("flush");
            }
        }
    });

    (port, received)
}

fn commands(received: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    received
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn config(port: u16, config_dir: PathBuf) -> TorConfig {
    TorConfig {
        host: Some("127.0.0.1".to_owned()),
        port,
        password: "pw".to_owned(),
        hidden_port: 80,
        config_dir,
        relay_port: 8008,
    }
}

#[tokio::test]
async fn the_control_dialogue_authenticates_and_adds_an_onion() {
    let (port, received) = control_server(vec![vec![
        Reply::Whole("250 OK\r\n"),
        Reply::Whole("250-ServiceID=abc\r\n250 OK\r\n"),
        Reply::Whole("250 closing connection\r\n"),
    ]])
    .await;

    let mut client = TorClient::connect("127.0.0.1", port, "pw")
        .await
        .expect("connect");
    let onion = client
        .add_onion("80,127.0.0.1:8008", None)
        .await
        .expect("add onion");
    client.quit().await;

    assert_eq!(onion.service_id, "abc.onion");
    assert_eq!(
        commands(&received),
        [
            "AUTHENTICATE \"pw\"\r\n".to_owned(),
            "ADD_ONION NEW:BEST Port=80,127.0.0.1:8008\r\n".to_owned(),
            "QUIT\r\n".to_owned(),
        ]
    );
}

#[tokio::test]
async fn multi_line_and_data_block_replies_parse() {
    let (port, _received) = control_server(vec![vec![
        Reply::Whole("250 OK\r\n"),
        Reply::Whole("250-ServiceID=abc\r\n250-PrivateKey=ED25519-V3:stored-secret\r\n250 OK\r\n"),
        Reply::Whole("250 closing connection\r\n"),
    ]])
    .await;

    let mut client = TorClient::connect("127.0.0.1", port, "pw")
        .await
        .expect("connect");
    let onion = client
        .add_onion("80,127.0.0.1:8008", None)
        .await
        .expect("add onion");
    client.quit().await;

    assert_eq!(onion.service_id, "abc.onion");
    assert_eq!(
        onion.private_key.as_deref(),
        Some("ED25519-V3:stored-secret")
    );

    // A `250+` data block terminated by `.` completes, and a key inside the block is not a
    // name/value reply line.
    let (port, _received) = control_server(vec![vec![
        Reply::Whole("250 OK\r\n"),
        Reply::Whole(
            "250-ServiceID=def\r\n250+PrivateKey=ED25519-V3:block-secret\r\n-----BEGIN ED25519-V3-----\r\n.\r\n250 OK\r\n",
        ),
        Reply::Whole("250 closing connection\r\n"),
    ]])
    .await;

    let mut client = TorClient::connect("127.0.0.1", port, "pw")
        .await
        .expect("connect");
    let onion = client
        .add_onion("80,127.0.0.1:8008", None)
        .await
        .expect("add onion");
    client.quit().await;

    assert_eq!(onion.service_id, "def.onion");
    assert_eq!(
        onion.private_key.as_deref(),
        Some("NEW:BEST"),
        "a data-block PrivateKey line is not a name/value reply, so the request's key stands"
    );
}

#[tokio::test]
async fn a_reply_split_across_tcp_segments_completes() {
    let (port, _received) = control_server(vec![vec![
        Reply::Whole("250 OK\r\n"),
        Reply::Split("250-ServiceID=abc\r\n250 OK\r\n", 7),
        Reply::Whole("250 closing connection\r\n"),
    ]])
    .await;

    let mut client = TorClient::connect("127.0.0.1", port, "pw")
        .await
        .expect("connect");
    let onion = client
        .add_onion("80,127.0.0.1:8008", None)
        .await
        .expect("add onion");
    client.quit().await;

    assert_eq!(onion.service_id, "abc.onion");
}

#[tokio::test]
async fn a_non_250_auth_reply_is_an_error() {
    let (port, received) =
        control_server(vec![vec![Reply::Whole("515 Authentication failed\r\n")]]).await;

    let error = TorClient::connect("127.0.0.1", port, "pw")
        .await
        .err()
        .expect("a refused auth fails");

    assert_eq!(
        error.to_string(),
        "Tor auth failed: 515 Authentication failed"
    );
    assert_eq!(commands(&received), ["AUTHENTICATE \"pw\"\r\n".to_owned()]);
}

#[tokio::test]
async fn the_private_key_file_is_written_once_and_reused() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (port, received) = control_server(vec![
        vec![
            Reply::Whole("250 OK\r\n"),
            Reply::Whole(
                "250-ServiceID=abc\r\n250-PrivateKey=ED25519-V3:first-secret\r\n250 OK\r\n",
            ),
            Reply::Whole("250 closing connection\r\n"),
        ],
        vec![
            Reply::Whole("250 OK\r\n"),
            Reply::Whole(
                "250-ServiceID=abc\r\n250-PrivateKey=ED25519-V3:ignored-secret\r\n250 OK\r\n",
            ),
            Reply::Whole("250 closing connection\r\n"),
        ],
    ])
    .await;

    let config = config(port, directory.path().to_path_buf());

    assert_eq!(
        ensure_hidden_service(&config).await,
        HiddenServiceOutcome::Enabled {
            service_id: "abc.onion".to_owned(),
            port: 80,
        }
    );

    let key_file = directory.path().join(ONION_KEY_FILE);
    assert_eq!(
        std::fs::read_to_string(&key_file).expect("the reply's key is written"),
        "ED25519-V3:first-secret"
    );

    assert_eq!(
        ensure_hidden_service(&config).await,
        HiddenServiceOutcome::Enabled {
            service_id: "abc.onion".to_owned(),
            port: 80,
        }
    );

    let commands = commands(&received);
    assert_eq!(commands[1], "ADD_ONION NEW:BEST Port=80,127.0.0.1:8008\r\n");
    assert_eq!(
        commands[4], "ADD_ONION ED25519-V3:first-secret Port=80,127.0.0.1:8008\r\n",
        "the second bootstrap sends the stored key"
    );
    assert_eq!(
        std::fs::read_to_string(&key_file).expect("the key file"),
        "ED25519-V3:first-secret",
        "a stored key is never overwritten"
    );
}

#[tokio::test]
async fn an_empty_key_file_counts_as_absent() {
    let directory = tempfile::tempdir().expect("tempdir");
    std::fs::write(directory.path().join(ONION_KEY_FILE), "").expect("write");

    let (port, received) = control_server(vec![vec![
        Reply::Whole("250 OK\r\n"),
        Reply::Whole("250-ServiceID=abc\r\n250-PrivateKey=ED25519-V3:new-secret\r\n250 OK\r\n"),
        Reply::Whole("250 closing connection\r\n"),
    ]])
    .await;

    let config = config(port, directory.path().to_path_buf());
    assert!(matches!(
        ensure_hidden_service(&config).await,
        HiddenServiceOutcome::Enabled { .. }
    ));

    assert_eq!(
        commands(&received)[1],
        "ADD_ONION NEW:BEST Port=80,127.0.0.1:8008\r\n"
    );
    assert_eq!(
        std::fs::read_to_string(directory.path().join(ONION_KEY_FILE)).expect("the key file"),
        "ED25519-V3:new-secret"
    );
}

#[tokio::test]
async fn a_missing_or_unreachable_host_disables_the_service() {
    let directory = tempfile::tempdir().expect("tempdir");

    let mut missing = config(DEFAULT_CONTROL_PORT, directory.path().to_path_buf());
    missing.host = None;
    assert_eq!(
        ensure_hidden_service(&missing).await,
        HiddenServiceOutcome::Disabled
    );

    // A port with nothing listening: bind to learn a free one, then release it.
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        listener.local_addr().expect("local addr").port()
    };
    let unreachable = config(port, directory.path().to_path_buf());
    assert_eq!(
        ensure_hidden_service(&unreachable).await,
        HiddenServiceOutcome::Disabled
    );

    assert!(
        !directory.path().join(ONION_KEY_FILE).exists(),
        "a disabled bootstrap writes no key"
    );
    assert_eq!(DEFAULT_HIDDEN_SERVICE_PORT, 80);
}
