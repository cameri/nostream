---
---

refactor(relay): decode the refusal word exhaustively

The refusal word's decode is now total and its bytes pinned: a cause the enum does not name is a compile error at every reader, and there is no behaviour change.
