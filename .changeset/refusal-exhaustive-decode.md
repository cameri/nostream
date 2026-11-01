---
---

refactor(relay): decode the refusal word exhaustively

The refusal word's decode is now total and its bytes pinned: a cause the enum does not name is a compile error at the encoder and at every reader that matches, a byte `from_word` has no arm for traps instead of reading as no refusal, and there is no behaviour change.
