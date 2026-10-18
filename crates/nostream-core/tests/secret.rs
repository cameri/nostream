//! `Secret` redacts through every formatting path that reaches a log line.

use nostream_core::Secret;

#[test]
fn debug_and_display_redact() {
    let secret = Secret("deadbeef".to_owned());
    assert_eq!(format!("{secret:?}"), "Secret(***)");
    assert_eq!(format!("{secret}"), "***");
    assert_eq!(format!("{}", Secret(String::new())), "***");
}

#[test]
fn a_struct_carrying_a_secret_redacts() {
    #[derive(Debug)]
    #[allow(dead_code)] // the fields exist to be formatted; only the rendering is asserted
    struct Carrier {
        name: String,
        token: Secret,
    }
    let rendered = format!(
        "{:?}",
        Carrier {
            name: "relay".to_owned(),
            token: Secret("s3cr3t".to_owned()),
        }
    );
    assert!(!rendered.contains("s3cr3t"), "{rendered}");
    assert!(rendered.contains("Secret(***)"));
}
