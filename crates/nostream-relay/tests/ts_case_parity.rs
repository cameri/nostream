//! R30's checked census: every unit case of the 22 in-scope TypeScript spec files must name the
//! Rust test that carries it.
//!
//! The two fixtures are `tests/fixtures/ts-cases.json` (the census, from
//! `tests/capture/gen-ts-cases.mjs`) and `tests/fixtures/ts-case-map.json` (the mapping). This
//! test fails when a census case has no mapping, when a mapped test function is absent from the
//! sources, when a mapped test is `#[ignore]`d, or when a per-file count disagrees with the
//! table the spec measured.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// The spec's Context table: each in-scope spec file and its measured case count.
const CENSUS: &[(&str, usize)] = &[
    ("test/unit/handlers/event-message-handler.spec.ts", 200),
    ("test/unit/handlers/subscribe-message-handler.spec.ts", 58),
    ("test/unit/handlers/count-message-handler.spec.ts", 10),
    ("test/unit/handlers/auth-message-handler.spec.ts", 12),
    ("test/unit/handlers/unsubscribe-message-handler.spec.ts", 1),
    (
        "test/unit/handlers/event-strategies/default-event-strategy.spec.ts",
        4,
    ),
    ("test/unit/adapters/web-socket-adapter.spec.ts", 60),
    ("test/unit/adapters/web-socket-server-adapter.spec.ts", 17),
    ("test/unit/utils/nip42.spec.ts", 27),
    ("test/unit/utils/nip42-session.spec.ts", 9),
    ("test/unit/utils/messages.spec.ts", 14),
    ("test/unit/utils/filter.spec.ts", 9),
    ("test/unit/utils/ewma-rate-limiter.spec.ts", 6),
    ("test/unit/utils/sliding-window-rate-limiter.spec.ts", 3),
    ("test/unit/factories/event-strategy-factory.spec.ts", 25),
    ("test/unit/factories/message-handler-factory.spec.ts", 6),
    ("test/unit/factories/websocket-adapter-factory.spec.ts", 1),
    ("test/unit/schemas/event-schema.spec.ts", 57),
    ("test/unit/schemas/message-schema.spec.ts", 17),
    ("test/unit/utils/hidden-content-cache.spec.ts", 12),
    ("test/unit/utils/shutdown-state.spec.ts", 5),
    ("test/unit/utils/validation.spec.ts", 4),
];

/// The capture commit the census was recorded from.
const CAPTURE: &str = "242a3001d77149e4d70151ec03060c4ef44a1547";

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));

    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The workspace root: two directories above this crate.
fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("the crate lives two levels below the workspace root")
        .to_path_buf()
}

/// Whether `source` defines `fn name` and, if it does, whether that function is `#[ignore]`d.
fn test_function(source: &str, name: &str) -> Option<bool> {
    let needle = format!("fn {name}(");
    let lines: Vec<&str> = source.lines().collect();
    let index = lines.iter().position(|line| line.contains(&needle))?;

    // Walk up over the attribute and doc-comment block that decorates the function.
    let mut ignored = false;
    let mut above = index;

    while above > 0 {
        let line = lines[above - 1].trim();

        if line.starts_with("#[") || line.starts_with("///") || line.starts_with("//") {
            if line.starts_with("#[ignore") {
                ignored = true;
            }

            above -= 1;
            continue;
        }

        break;
    }

    // A one-line declaration (`fn name() { … }`) must still end the walk at a declaration.
    Some(ignored)
}

#[test]
fn the_census_counts_are_the_tables() {
    let census = fixture("ts-cases.json");

    assert_eq!(
        census["capture"].as_str(),
        Some(CAPTURE),
        "the census records its capture commit"
    );

    let table: BTreeMap<&str, usize> = CENSUS.iter().copied().collect();
    let mut counted = BTreeMap::new();
    let mut total = 0;

    for file in census["files"].as_array().expect("files") {
        let name = file["file"].as_str().expect("file");
        let cases = file["cases"].as_u64().expect("cases") as usize;
        let titles = file["titles"].as_array().expect("titles").len();

        assert_eq!(
            titles, cases,
            "{name}: the case count and the titles disagree"
        );
        assert_eq!(
            table.get(name).copied(),
            Some(cases),
            "{name}: {cases} cases, the Context table says {:?}",
            table.get(name)
        );

        counted.insert(name.to_owned(), cases);
        total += cases;
    }

    assert_eq!(
        counted.keys().len(),
        table.keys().len(),
        "the census covers a different file set than the table: {counted:?}"
    );
    assert_eq!(total, 557, "the census is 557 cases");
}

#[test]
fn every_case_is_mapped_or_explicitly_exempt() {
    let census = fixture("ts-cases.json");
    let map = fixture("ts-case-map.json");

    // The capture has two cases with the same title in the deprecated `maxLength` group, so a
    // file's titles are compared as an ordered-by-sort multiset rather than a set.
    let mut expected: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for file in census["files"].as_array().expect("files") {
        let name = file["file"].as_str().expect("file").to_owned();
        let mut titles: Vec<String> = file["titles"]
            .as_array()
            .expect("titles")
            .iter()
            .map(|title| title.as_str().expect("title").to_owned())
            .collect();

        titles.sort();
        expected.insert(name, titles);
    }

    let mut mapped: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for group in map["groups"].as_array().expect("groups") {
        let file = group["file"].as_str().expect("file").to_owned();

        assert!(
            expected.contains_key(&file),
            "the map names a file outside the census: {file}"
        );
        assert!(
            group["test"].is_string() || group["exempt"].is_string(),
            "a group must name a test or say why it is exempt: {group}"
        );

        for title in group["titles"].as_array().expect("titles") {
            mapped
                .entry(file.clone())
                .or_default()
                .push(title.as_str().expect("title").to_owned());
        }
    }

    for titles in mapped.values_mut() {
        titles.sort();
    }

    for (file, titles) in &expected {
        let found = mapped.get(file).cloned().unwrap_or_default();

        if &found != titles {
            let missing: Vec<&String> = titles
                .iter()
                .filter(|title| !found.contains(title))
                .collect();
            let extra: Vec<&String> = found
                .iter()
                .filter(|title| !titles.contains(title))
                .collect();

            panic!("{file}: unmapped {missing:?}, mapped but not in the census {extra:?}");
        }
    }

    assert_eq!(
        mapped.keys().len(),
        expected.keys().len(),
        "the map covers every census file"
    );
}

#[test]
fn every_mapped_test_exists_and_is_not_ignored() {
    let map = fixture("ts-case-map.json");
    let root = workspace_root();

    let mut checked = 0;
    let mut exempt = 0;
    let mut titles_in_exempt = 0;

    for group in map["groups"].as_array().expect("groups") {
        let titles = group["titles"].as_array().expect("titles").len();

        let Some(target) = group["test"].as_str() else {
            let reason = group["exempt"].as_str().expect("exempt reason");

            assert!(
                reason.contains("job 0"),
                "an exemption names the job that carries it: {reason}"
            );

            exempt += 1;
            titles_in_exempt += titles;
            continue;
        };

        let (path, function) = target
            .split_once("::")
            .unwrap_or_else(|| panic!("a mapping is `<file>::<fn>`: {target}"));
        let file = root.join(path);

        assert!(
            file.exists(),
            "{}: the mapped file is absent",
            file.display()
        );

        let source = std::fs::read_to_string(&file).expect("the mapped source");

        match test_function(&source, function) {
            Some(false) => checked += 1,
            Some(true) => panic!("{target} is #[ignore]d, so it carries nothing"),
            None => panic!("{target}: no such test function in {}", file.display()),
        }
    }

    assert!(checked > 0, "the map names no tests at all");

    println!(
        "census: {} cases, {} mapped to {} live tests, {} exempt groups holding {} cases",
        map["cases"].as_u64().unwrap_or(0),
        map["cases"].as_u64().unwrap_or(0) as usize - titles_in_exempt,
        checked,
        exempt,
        titles_in_exempt
    );
}

#[test]
fn the_map_records_the_census_it_was_built_from() {
    let census = fixture("ts-cases.json");
    let map = fixture("ts-case-map.json");

    assert_eq!(map["capture"].as_str(), census["capture"].as_str());
    assert_eq!(
        map["cases"].as_u64(),
        Some(557),
        "the map covers the whole census"
    );
}
