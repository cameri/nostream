---
---

fix(import): parse each JSON array element once, however many reads it spans (#1101)

The array reader re-parsed an incomplete element from its first byte after every 8 KiB read, so importing a large event cost time quadratic in its size. It now scans for the element's end as bytes arrive, keeping that scan's state across reads, and hands the element to `serde_json` once it is complete. An unfinished element is also tried each time it doubles, so a malformed one still fails without the reader buffering the rest of the input, and the parsing stays linear. Error messages for malformed or truncated input are unchanged. A bare number split across two reads is no longer cut at the read boundary. Rust-only; no published package changes.
