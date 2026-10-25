---
---

fix(core): accept a zero-fraction float timestamp and refuse an over-long client frame

Two inbound decode divergences from the capture, both measured against it:

- An event's `created_at` or `kind` written in float spelling with a zero fractional
  part (`1700000000.0`, `1.7e9`, `1.0`) is now the integer it denotes. JavaScript has
  no float/int distinction after `JSON.parse`, so the capture accepts these and the
  port refused them. A genuine fraction now answers `Expected integer, received float`
  on `created_at` too, which is the capture's message (#960).
- `EVENT`, `AUTH` and `CLOSE` refuse a frame longer than their tuple with the capture's
  `Array must contain at most 2 element(s)`, after the element checks, so a frame that
  is also wrong-typed keeps the message it answered before (#961). `REQ`/`COUNT` keep
  their filter bounds.

The TypeScript tree is untouched: no `src/` or `test/` file changes, so the published
package has no user-visible change.
