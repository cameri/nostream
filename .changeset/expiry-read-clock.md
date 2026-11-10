---
---

fix(relay): ask the clock at the expiry check, not before the stored read (#953)

`fetch_and_send` captured `now` once, between `find_by_filters` and the loop that streams
the stored records, and judged every record against that one instant, so a record that
expired while earlier records were still being read was delivered anyway. The expiry check
now reads `context.now_secs()` as it runs, one record at a time, which is what the capture's
`isTagUnexpired` does inside `isExpiredEvent`. No other behaviour changes.
