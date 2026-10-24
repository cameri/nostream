---
---

Port the relay's wire handlers, strategies and rate limits into the Rust rewrite.

No JavaScript package changes in this branch, so there is nothing to release; the
changeset check asks for a file because the diff touches a package directory, and its
own guidance for that case is `changeset add --empty`.
