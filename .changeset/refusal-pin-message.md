---
---

test(relay): say what the refusal pin test holds

`every_refusal_word_is_pinned_to_its_byte`'s failure message no longer says the refusal bytes
travel. They do not: the word is a process-local `AtomicU8` (`Refusal::from_word`'s doc,
`crates/nostream-relay/src/sink.rs:92-98`), and a refused client receives a `1013` close with
a reason string. The message now names the pin it holds — the three bytes, `word()`'s arms and
the enum's discriminants are the same numbers — and is declared once, as
`PINNED_BYTES_MESSAGE`. Test-only: no production code path, no behaviour change.
