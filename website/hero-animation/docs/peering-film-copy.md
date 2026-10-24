# Relay peering launch film — scene copy

Source: [nostream#942](https://github.com/cameri/nostream/issues/942). Composition: `src/peering-film.ts`.  
40 s · 1920×1080 · 30 fps · 1200 frames. One job per scene; jobs-to-be-done only (no protocol tutorial).

**Approval:** Draft for maintainer review before the peering release ships on the site.

## Factual guardrails (#931, #932–#940)

| Claim on screen | Spec / issue |
|---|---|
| **Flat or traffic-based** fees for a **period** the operator sets | #931 paid peering terms (`amount`, `unit`, `period` in NIP-11) |
| **Never per event** | #931 out of scope: no per-event payments |
| **Lightning**, **sats**, **between relays** | #931 / #937 settlement between peer relays |
| **Cache window** operator-configured; “the last hour” is an **example** | #931 cache peers + rolling-window scope in NIP-11 |
| **Ask an archive** outside the window | #931 cache miss must not imply “event does not exist” |
| **Sell feeds** to other relays | #931 archive/backbone peers; paid terms |
| No operator names, adoption stats, or network metrics | #942 production notes |

---

## Scene 1 · PEOPLE (frames 0–240)

**Beat:** Run a relay for your people, not the whole network.

| Element | Copy |
|---|---|
| Kicker | `01 — YOUR PEOPLE` |
| Headline | Run a relay for your people. |
| Accent | Not the whole network. |
| Card 1 | **SCOPE** · Your people · the people you follow |
| Card 2 | **PEERING** · Their relays · the ones your people use |
| Card 3 | **FETCHES** · The rest · on demand |
| Payoff | Feel complete without ingesting everything. |

**Issue gloss:** Community relay peers for its scope and fetches the rest on demand.

---

## Scene 2 · WORTH (frames 240–520)

**Beat:** Your archive is worth something now.

| Element | Copy |
|---|---|
| Kicker | `02 — YOUR ARCHIVE` |
| Headline | Your archive / is worth something now. |
| Sub | Sell feeds to other relays — settled in sats. |
| Panel | PEERING TERMS · **PER PERIOD** chip |
| Terms | fee: flat or traffic-based — you set the terms · period: you set the length · settlement: Lightning, in sats, between relays · per event: **never** |
| Payoff | A product, not a cost center. |

**Issue gloss:** Deep history can be sold to other relays; completeness becomes a product.

---

## Scene 3 · FAST (frames 520–760)

**Beat:** Fast, everywhere.

| Element | Copy |
|---|---|
| Kicker | `03 — HOT FEED` |
| Headline | Fast, everywhere. |
| Sub | The hot feed, near the readers. |
| Track | OLDER THAN THE WINDOW · THE HOT FEED |
| Note A | BEFORE THIS CUT · Ask an archive. · outside the window |
| Note B | CACHE PEERS · A rolling window · the last hour, or whatever you configure |
| Payoff | Small relays feel instant — without owning the firehose. |

**Issue gloss:** Cache peers holding only the last hour put hot feed near readers.

---

## Scene 4 · MIDDLE (frames 760–980)

**Beat:** Relays that only talk to relays.

| Element | Copy |
|---|---|
| Kicker | `04 — THE MIDDLE` |
| Headline | Relays that only talk to relays. |
| Accent | The network can grow a middle. |
| Archive | Deep history · backbone infrastructure |
| Cache | Rolling window · hot feed near readers |
| Edge | **EDGE** · the relay readers connect to |
| Payoff | Infrastructure behind. Users in front. |

**Issue gloss:** Archives and caches as infrastructure; edge relays facing readers.

---

## Scene 5 · CLOSE (frames 980–1200)

**Beat:** Inversion — one thing well; the network assembles the rest.

| Element | Copy |
|---|---|
| Contrast | Today, every relay tries to be everything. |
| Headline | Each relay gets to be one thing well. |
| Accent | The network assembles the rest. |
| Lockup | [nostream mark] nostream relay peering |

---

## Site

After render: `pnpm run media` in `website/site` → `public/media/peering.mp4`, `peering-poster.webp`.  
Home section: `#peering` (`Peering.astro`).
