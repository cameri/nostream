# NIP parity audit: the registry at 2026-10-15 against nostream 3.5.1

## 1. What was audited, and how

**Registry.** [`nostr-protocol/nips`](https://github.com/nostr-protocol/nips) at
`a79e21d90fce5465b50ef385dd368bba99ec4a0b` (2026-10-05, *"NIP-92: imeta tags for kind 0
picture and banner (#2494)"*), resolved as the last commit before
`2026-10-15T00:00:00Z` (`git log -1 --before='2026-10-15T00:00:00Z'`). **The audit date
is 2026-10-15.** The registry tip at the time of writing is `ba59df89` (2026-10-16,
*"Fix typos (#2503)"*): it is a day after the audit date and is **not** the audited
revision. 99 NIP documents exist at the cutoff, and this document has a row for every
one of them.

Registry paths are cited as they exist at the cutoff: at this revision the documents
sit at the repository root, so they are cited as `11.md`, `67.md` and so on. The
registry's own link markup inside a quoted sentence is rendered as plain `text (file)`,
so a quotation here is verbatim except for that one substitution.

**This audit and the rewrite.** It is Phase 0 of the Rust rewrite tracked in
[nostream#860](https://github.com/cameri/nostream/issues/860), and it is
[nostream#861](https://github.com/cameri/nostream/issues/861)'s deliverable. Every
`src/…` citation below is to **nostream 3.5.1** (`041fe34e`) — the implementation that
was measured — not to the planned integration branch `rewrite/main`, where those files
will not exist. The porting oracle is the TypeScript suite **`test/` at `041fe34e`,
where a test exists**: #860 requires a Rust module to reproduce the TypeScript module's
observable behaviour, so `test/` is the evidence that survives the rewrite and a
`src/…` reference is provenance rather than a description of the target. `rewrite/main`
is planned to be cut from the capture commit `242a3001`, and that tree is **not** the
oracle: 14 test
files changed in the window, including the NIP-77 wire tests
(`test/unit/utils/nip77.spec.ts` and `test/unit/utils/negentropy-sessions.spec.ts`, both
new), the `isReconciliationAuthorized` cases added to `test/unit/utils/nip42.spec.ts`,
and the NIP-11 `supported_nips` expectation in
`test/integration/features/nip-11/nip-11.feature.ts`. Five behaviours this document
reports have no test at all — `min_prefix`, `supported_nip_extensions`, `supported_mips`,
`max_event_tags`, and NIP-78's kinds 78 and 30078 (`grep -rn` over `test/` returns 0 for
each of the first four, for `30078`, and for the word-bounded `\b78\b`; a bare `78`
matches 98 lines across 21 files, all inside hex ids) — so a parity test for each is
Phase 2 work, not something the suite already pins.

**nostream.** The capture commit is `242a3001…` (`chore: release nostream@3.4.0`,
2026-10-13, version 3.4.0). This audit absorbs the **24 commits** that landed between
it and the grading tip `041fe34e` (*"docs: link the project website from the README
intro (#855)"*, version 3.5.1); §6 sorts them. The worktree tip is `811fbb5`, one
commit past the grading tip, and it touches no `src/` file.

**Baseline agreement.** `package.json:7` lists 25 advertised ids, and the tip and the
pin carry the byte-identical file: `git rev-parse 811fbb5:package.json` and
`git rev-parse 041fe34e:package.json` both answer
`3cce1f408438a4ef038ccb193d5182ac5f709668`. The `Advertised` column below and
`package.json` therefore agree at both commits; a later push that changed
`supportedNips` would
break that agreement. `supportedNipExtensions` is `[]` (`package.json:34`) and
`supportedMips` is `[0,1,2,3]` (`package.json:35`). At serve time `supported_nips` is
filtered, so 43 appears only while NIP-43 is enabled and 77 only while NIP-77 is
active (`src/handlers/request-handlers/root-request-handler.ts:94-96`).

**The delta window: `2024-01-01`.** "Changed since nostream implemented it" needs a
boundary, and nostream carries no per-NIP implementation date — its changelog is
release-scoped, and a `git log -S` walk per NIP would guess at a commit. `2024-01-01`
is a **stated, reproducible boundary**, not a measured implementation date: every
registry file whose last commit falls on or after that date, and that nostream either
advertises or implements, is examined in §4 or §5. Those are the **candidates**: 31
NIPs, each named outside the table. Changing the boundary would be changing a rule, not
correcting an observation.

## 2. The disposition table

One row per registry NIP, in the order the registry lists them — its own order is
lexicographic, so the hex ids (`5A`, `7D`, `A0`…) sit among the decimal ones.

- **Status** is the registry's own tag read from the NIP body at the cutoff — the
  first backticked status word — with `unrecommended` appended where the registry
  marks it. Three bodies carry no status tag (46, 92, A0) and the cell says so.
- **Summary** is written from the NIP body at the cutoff.
- **Advertised** is membership in `supportedNips` at `041fe34e` (`package.json:7`),
  never the README's list — the two disagree, and §7 records how.
- **In nostream** is judged against the code at the worktree tip: `implemented` means
  NIP-specific code carries the NIP's relay-side work, `partial` means an artifact —
  a kind or tag constant, a codec, a comment, or code that implements an earlier text
  of the number — exists without the work being done, `absent` means no NIP-specific
  artifact at all.
- **Delta** is the relay-visible difference between the registry text at the cutoff
  and that code, or `none`. Every row that does not say `none` is argued in §4.
- **Disposition** uses §3's three words.

| NIP | Status | Summary | Advertised | In nostream | Delta | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | draft | Base protocol: event ids and signatures, filters, REQ/EVENT/CLOSE, EOSE/OK/CLOSED/NOTICE, replaceable and ephemeral kinds, deletion. | yes | implemented | prefix matching on ids and authors where 01.md requires exact 64-character values | must-have |
| 02 | final | Kind 3 follow list: a p tag per followed profile, replaceable so only the latest is kept. | yes | implemented | none | must-have |
| 03 | draft, unrecommended | Kind 1040 OpenTimestamps attestation carrying an OTS proof for another event. | yes | implemented | none | must-have |
| 04 | final, unrecommended | Kind 4 encrypted direct message: NIP-04 ciphertext in content with a p tag per recipient. | yes | partial | none | must-have |
| 05 | final | Maps a pubkey to a DNS internet identifier through the nip05 field of kind 0 metadata. | no | implemented | none | must-have |
| 06 | draft, unrecommended | Derives a Nostr keypair from a BIP39 mnemonic seed phrase. | no | absent | none | out-of-scope |
| 07 | draft | Defines the window.nostr object browsers and extensions expose for signing. | no | absent | none | out-of-scope |
| 08 | final, unrecommended | Standardizes how clients render inline mentions inside text note content. | no | absent | none | out-of-scope |
| 09 | draft | Kind 5 deletion request: e and a tags naming events the author asks relays to delete. | yes | partial | `DeleteEventStrategy` collects valid `e` tags only and calls `deleteByPubkeyAndIds`; an `a`-only request leaves its targets untouched (`src/handlers/event-strategies/delete-event-strategy.ts:22-31`) | must-have |
| 10 | draft | Kind 1 text notes, with e and p tag conventions for replies and threads. | no | absent | none | out-of-scope |
| 11 | draft | Relay information document: a JSON capabilities document served over HTTP at the relay URI. | yes | implemented | four non-spec limitation keys (two removed from 11.md) plus two non-standard top-level keys | must-have |
| 12 | final | Tombstone: generic tag queries moved to NIP-01. | yes | implemented | none | must-have |
| 13 | draft | Proof of work: leading zero bits on the event id, used to deter spam and set admission policy. | yes | implemented | none | must-have |
| 14 | draft | Defines the subject tag for kind 1 text events. | yes | partial | none | must-have |
| 15 | draft, unrecommended | Nostr Marketplace: a client protocol for stalls and products built on addressable events. | yes | partial | the advertised number now means Marketplace, while nostream's NIP-15 is the obsolete EOSE NIP | out-of-scope |
| 16 | final | Tombstone: event treatment for replaceable and ephemeral kinds moved to NIP-01. | yes | implemented | none | must-have |
| 17 | draft | Private direct messages built on NIP-44 encryption wrapped in NIP-59 gift wraps; relays store kind 1059. | yes | implemented | none | must-have |
| 18 | draft | Kind 6 reposts of kind 1 notes and kind 16 generic reposts of any event. | no | partial | none | out-of-scope |
| 19 | draft | bech32 encodings such as npub, note, nevent and naddr for displaying and sharing entities. | no | partial | none | out-of-scope |
| 20 | final | Tombstone: command results, the OK and CLOSED messages, moved to NIP-01. | yes | implemented | none | must-have |
| 21 | draft | The nostr: URI scheme for referencing Nostr entities inside text. | no | absent | none | out-of-scope |
| 22 | draft | Kind 1111 comment: a threading note scoped to a root event or I-tag, with uppercase root and lowercase parent tags. | yes | partial | the advertised number now means Comment, while nostream's NIP-22 behaviour is the old created_at limits | must-have |
| 23 | draft | Kind 30023 addressable long-form articles. | no | absent | none | out-of-scope |
| 24 | draft | De-facto extra metadata fields and tags, such as alt and content-warning. | no | absent | none | out-of-scope |
| 25 | draft | Kind 7 reactions whose content is +, - or an emoji. | yes | implemented | none | must-have |
| 26 | draft, unrecommended | Delegated signing: a delegation tag lets one keypair sign events attributed to another pubkey. | no | absent | none | out-of-scope |
| 27 | draft | Standardizes inline references to other events and profiles inside event content. | no | absent | none | out-of-scope |
| 28 | draft, unrecommended | Public chat: kinds 40 to 49 for channels, channel metadata and channel messages. | yes | partial | none | must-have |
| 29 | draft | Relay-based groups: relay-generated group metadata and closed-membership message rules. | no | absent | none | out-of-scope |
| 30 | draft | Custom emoji referenced by shortcode with emoji tags pointing at images. | no | absent | none | out-of-scope |
| 31 | draft, unrecommended | Uses the alt tag so clients can render an unknown event kind as readable text. | no | absent | none | out-of-scope |
| 32 | draft | Labeling: kind 1985 label events and l/L tags that classify other events. | no | absent | none | out-of-scope |
| 33 | final | Tombstone: parameterized replaceable events renamed to addressable events and moved to NIP-01. | yes | implemented | none | must-have |
| 34 | draft | Git stuff: repository, patch, issue and status events for code collaboration over Nostr. | no | absent | none | out-of-scope |
| 35 | draft | Kind 2003 torrent index events carrying enough metadata to build a magnet link. | no | absent | none | out-of-scope |
| 36 | draft | The content-warning tag, letting clients gate display of sensitive content. | no | absent | none | out-of-scope |
| 37 | draft | Kind 31234 encrypted storage for unsigned draft events of any kind. | no | absent | none | out-of-scope |
| 38 | draft | Kind 30315 user status events such as what someone is listening to or doing. | no | absent | none | out-of-scope |
| 39 | draft | Kind 10011 lists linking a profile to identities on other platforms with i tags. | no | absent | none | out-of-scope |
| 40 | draft | The expiration tag: a unix timestamp after which relays and clients should drop the event. | yes | implemented | none | must-have |
| 42 | draft | Client authentication to relays by signing an ephemeral kind 22242 event carrying a challenge. | yes | implemented | EOSE never carries the NIP-67 auth hint; the mixed-filter trim needs nip42.restrictedReads.enabled, off by default | must-have |
| 43 | draft | Relay access metadata and join and leave requests, with membership lists and relay-signed events. | yes | implemented | kind 28935 invite-request minting was removed from 43.md, which now points claims at NIP-86 | must-have |
| 44 | optional | Versioned encrypted payload format; version 2 uses ChaCha20, HMAC-SHA256 and base64. | yes | implemented | 65535-byte plaintext cap and 2-byte length prefix against 44.md's extended 6-byte format | must-have |
| 45 | draft | The COUNT verb, returning how many events match a set of filters. | yes | implemented | none | must-have |
| 46 | no status tag | Remote signing: a client and a bunker exchange requests over kind 24133 events. | no | absent | none | out-of-scope |
| 47 | draft | Nostr Wallet Connect: clients drive a remote Lightning wallet over Nostr events. | no | partial | none | out-of-scope |
| 48 | draft | The proxy tag linking an event bridged from another protocol back to its source object. | no | absent | none | out-of-scope |
| 49 | draft | ncryptsec: password-based encryption of a private key. | no | absent | none | out-of-scope |
| 50 | draft | The search filter, a full-text search extension to structured REQ filters. | yes | implemented | none | must-have |
| 51 | draft | Lists: replaceable events holding public and private references to anything. | no | absent | none | out-of-scope |
| 52 | draft | Calendar events: date-based and time-based addressable event kinds. | no | absent | none | out-of-scope |
| 53 | draft | Live streaming and spaces: kinds advertising streams and who takes part. | no | absent | none | out-of-scope |
| 54 | draft | Kind 30818 addressable wiki articles, with many articles per subject. | no | absent | none | out-of-scope |
| 55 | draft | Android signer application protocol, signing without exposing the private key. | no | absent | none | out-of-scope |
| 56 | optional | Kind 1984 report events signalling objectionable content to clients and relays. | no | implemented | none | must-have |
| 57 | draft | Lightning zaps: kind 9734 zap requests and kind 9735 zap receipts. | no | partial | none | out-of-scope |
| 58 | draft | Badge definition, award and profile badge events. | no | absent | none | out-of-scope |
| 59 | optional | Gift wrap: encapsulates any event in a kind 1059 envelope to hide its metadata. | no | implemented | none | must-have |
| 5A | draft | Static websites hosted from Blossom assets, with manifest and snapshot events. | no | absent | none | out-of-scope |
| 60 | draft | Cashu wallets whose state is stored in relay events. | no | absent | none | out-of-scope |
| 61 | draft | Nutzaps: P2PK Cashu tokens where the payment is the receipt. | no | absent | none | out-of-scope |
| 62 | draft | Request to Vanish: asks a relay to delete every event from a pubkey. | no | implemented | vanish soft-deletes rows instead of deleting them, and keeps gift wraps that p-tag the pubkey | must-have |
| 64 | draft | Kind 64 chess games in PGN format. | no | absent | none | out-of-scope |
| 65 | draft | Kind 10002 relay list metadata advertising where a user reads and writes. | yes | implemented | none | must-have |
| 66 | draft | Relay liveness monitoring: monitor announcements and relay discovery events. | no | implemented | none | must-have |
| 67 | draft | Extends EOSE with an optional third element carrying finish, more or auth hints. | no | absent | EOSE is two elements only; no finish, more or auth hints, and 67 is not advertised | opportunistic |
| 68 | draft | Kind 20 picture-first feeds whose images are referenced with imeta tags. | no | absent | none | out-of-scope |
| 69 | draft | Peer-to-peer order events for trading platforms. | no | absent | none | out-of-scope |
| 70 | draft | Protected events: a - tag means only the author may publish the event to a relay. | no | implemented | none | must-have |
| 71 | draft | Video events for externally hosted video content. | no | absent | none | out-of-scope |
| 72 | draft, unrecommended | Moderated communities: kind 34550 community definitions plus approval events. | no | absent | none | out-of-scope |
| 73 | draft | External content ids such as ISBN, podcast GUID and ISAN, referenced with i tags. | no | absent | none | out-of-scope |
| 75 | draft | Zap goals: fundraising goal events funded by zaps. | no | absent | none | out-of-scope |
| 77 | draft | Negentropy syncing: NEG-OPEN, NEG-MSG, NEG-CLOSE and NEG-ERR for set reconciliation. | yes | implemented | none in the registry text; the advertisement landed after the capture commit | must-have |
| 78 | draft | Arbitrary custom application data in kind 78 and addressable kind 30078 events, behind AUTH. | no | absent | on a default deployment, kind 78 and 30078 are accepted and served without the AUTH guard 78.md asks for; item 7 closes unauthenticated serving for reads that name the kinds, not the owner-only rule or a kindless COUNT | opportunistic |
| 7D | draft | Forum threads: kind 11 thread events with titles and replies. | no | absent | none | out-of-scope |
| 84 | draft | Kind 9802 highlight events pointing at content a user found valuable. | no | absent | none | out-of-scope |
| 85 | draft | Trusted assertions: providers publish signed computed claims about users. | no | absent | none | out-of-scope |
| 86 | draft | Relay management API: a JSON-RPC-like HTTP API for relay administration. | no | absent | none | opportunistic |
| 87 | draft | Cashu mint and Fedimint discovery events. | no | absent | none | out-of-scope |
| 88 | draft | Poll events and their response events. | no | absent | none | out-of-scope |
| 89 | draft | Kind 31989 and 31990 recommended application handlers for unknown event kinds. | no | implemented | none | must-have |
| 90 | draft, unrecommended | Data vending machines: job request and result events for paid computation. | no | implemented | none | must-have |
| 92 | no status tag | imeta tags adding media metadata such as url, mime type, blurhash and dimensions. | no | absent | none | out-of-scope |
| 94 | draft | Kind 1063 file metadata events describing shared files. | no | absent | none | out-of-scope |
| 96 | draft, unrecommended | An HTTP file storage API for files referenced from Nostr events. | no | absent | none | out-of-scope |
| 98 | draft | Ephemeral kind 27235 event authorizing an HTTP request. | no | implemented | none | must-have |
| 99 | draft | Kind 30402 classified listings for products and services. | no | absent | none | out-of-scope |
| A0 | no status tag (body says Draft) | Kinds 1222 and 1244 voice messages carrying short audio URLs. | no | absent | none | out-of-scope |
| A3 | draft | payto tags declaring payment targets such as bitcoin addresses or Lightning addresses. | no | absent | none | out-of-scope |
| A4 | draft | Kind 24 public plaintext messages to one or more users. | no | absent | none | out-of-scope |
| B0 | draft | Kind 39701 web bookmarks keyed by URI. | no | absent | none | out-of-scope |
| B7 | draft | How clients use Blossom servers for media, including kind 10063 server lists. | no | absent | none | out-of-scope |
| BE | draft, unrecommended | Nostr over BLE: device advertisement and GATT characteristics for syncing. | no | absent | none | out-of-scope |
| C0 | draft | Kind 1337 code snippet events with language, extension and dependency tags. | no | absent | none | out-of-scope |
| C7 | draft | Kind 9 chat messages and q-tag replies. | no | absent | none | out-of-scope |
| CC | draft | Geocaching events: kind 37516 cache listings and log events. | no | absent | none | out-of-scope |
| EE | final, unrecommended | End-to-end encrypted group messaging using the MLS protocol. | no | absent | none | out-of-scope |
| F4 | draft | Podcast episodes as Nostr events, for podcast players. | no | absent | none | out-of-scope |

## 3. What the three dispositions mean

- **`must-have`** — the rewrite cannot ship without this NIP's relay-side behaviour.
  That covers two cases: the NIP is advertised today (`package.json:7`), so dropping
  it would change what the relay claims and does; or it is implemented today without
  being advertised (NIP-05, 56, 59, 62, 66, 70, 89, 90, 98), so dropping it would
  silently delete a feature from the rewrite's parity target.
- **`opportunistic`** — the NIP asks something of a relay that nostream does not do
  today, and the work is small and local enough to take while the surrounding area is
  being rewritten. It is not required for parity.
- **`out-of-scope`** — no NIP-specific relay work is owed. This is a statement about
  what the NIP asks of a relay, never about who its audience is: a NIP that defines
  event kinds a relay stores and serves under the generic rules asks for nothing
  NIP-specific, and that is the reason given for every such row. Where a NIP does ask
  a relay for real work that the rewrite will not carry (NIP-29 groups, NIP-96 file
  storage), the reason names that work.

`must-have` holds 33 rows: 01, 02, 03, 04, 05, 09, 11, 12, 13, 14, 16, 17, 20, 22, 25,
28, 33, 40, 42, 43, 44, 45, 50, 56, 59, 62, 65, 66, 70, 77, 89, 90, 98. Four of them
(12, 16, 20, 33) are tombstones in the registry — their text moved into NIP-01 — but
nostream advertises them and implements the behaviour they name, so the rewrite keeps
the behaviour; whether it should keep advertising a tombstone is a §9 question. Four
more (04, 14, 22, 28) carry no code for the NIP the number now means; for those
`must-have` means "preserve the generic behaviour that satisfies them", which costs
nothing and avoids a silent parity change. For 22 the code that does exist — the
`created_at` bounds — is NIP-11's behaviour (§4). Against the advertised set at the
grading tip `041fe34e` — 25 ids — `must-have` is **24 of the 25** plus the nine live
unadvertised subsystems. NIP-15 is the one advertised number that is not `must-have`
(`out-of-scope`): the number now means Marketplace and the relay does no NIP-15 work
(§4). NIP-77 is the id added after capture, so against `242a3001`'s 24-id list the same
set is 23 of 24. The 25 advertised ids all still carry a disposition, which is what
#861 asks.

`opportunistic` holds 3 rows:

- **NIP-67** — the third `EOSE` element is a small addition to the message nostream
  already builds, and NIP-42 now refers to it (§4).
- **NIP-78** — the **serving** half is a configuration of the read guard that already
  exists, though closing unauthenticated reads leaves the owner rule and a kindless
  COUNT open; the accept half needs a write gate the relay has only globally and off
  (§4).
- **NIP-86** — a relay management API is a real surface, but nostream already has an
  admin HTTP API, so aligning it with NIP-86 is coherent rather than new; `createclaim`
  is also where NIP-43 now points the invite flow (§4).

`out-of-scope` holds the other 63 rows, and the reasons are five:

1. **Client-side event conventions** — the NIP defines kinds, tags or client-side
   encodings that a relay stores and serves unchanged, or never parses from protocol
   traffic (08, 10, 18, 19, 21, 23, 24, 27, 30, 31, 32, 34, 35, 36, 37, 38, 39, 48, 51,
   52, 53, 54, 57, 58, 5A, 60, 61, 64, 68, 69, 71, 72, 73, 75, 7D, 84, 85, 87, 88, 92,
   94, 99, A0, A3, A4, B0, B7, BE, C0, C7, CC, EE, F4). The relay's duty is generic
   storage, already carried by the event pipeline; nothing in the NIP asks a relay to
   validate, index or transform the event. NIP-19 (bech32 encodings) and NIP-21
   (`nostr:` URIs) are here for the second half of that test: they define what clients
   build and a relay never parses them from client protocol traffic. NIP-19's row is
   `partial` for that reason: nostream has a bech32 codec
   (`src/utils/transform.ts:146-165`) that decodes an `npub1…` from the relay's own
   configuration — `info.pubkey` (`root-request-handler.ts:50,76`) and `info.self`,
   through `parseRelayPubkey` (`nip43-invites.ts:29-47`, called from `nip43.ts:60,81`
   and `cli/commands/invite.ts:158`) — and from an invoice request body
   (`src/controllers/invoices/post-invoice-controller.ts:67-78`); it also encodes one
   back into the invoice description (`:112`), and
   `test/unit/handlers/request-handlers/root-request-handler.spec.ts:230-235` pins the
   decode. What NIP-19 has that nostream does not is its TLV prefixes (`nprofile`,
   `nevent`, `naddr`, deprecated `nrelay`) and any protocol use: no Nostr protocol
   message carries a bech32 value (an event's `content` may, unparsed).
2. **Client-side signing and key protocols** — 06, 07, 46, 47, 49, 55. These describe
   how a client holds or uses a key. A relay is at most a transport: 46 and 47 define
   events a relay stores generically, and 06, 07, 49 and 55 never touch a relay.
   (nostream does ship a NIP-47 *client* for operator payments in
   `src/payments-processors/nwc-payments-processor.ts`, which is why the row says
   `partial`; that is not a relay obligation.)
3. **Relay features outside the parity target** — 29 asks the relay to generate group
   metadata and enforce per-group membership and moderation rules; 96 asks for a
   separate HTTP file-storage service. Both are product surfaces nostream has never
   had, and neither is needed to match today's relay or the advertised set.
4. **Relay work the registry has withdrawn** — 26 asks relays to answer
   delegation-tagged queries and to let a delegator delete the delegatee's events; the
   NIP is `unrecommended` upstream and nostream has no delegation path, so the rewrite
   does not take it.
5. **NIP-15** alone — the registry number no longer means what nostream advertises
   under it, for the reason §4 records.

## 4. Behavioural deltas

Each subsection names the registry file and the section the claim rests on, and the
nostream path affected. A delta is recorded only where the reading supports it.

### NIP-01

`01.md` §"From client to relay: sending events and creating subscriptions" requires
exact filter values: *"The `ids`, `authors`, `#e` and `#p` filter lists MUST contain
exact 64-character lowercase hex values."* nostream accepts hex **prefixes** from four
characters up for the first two of those lists: `src/schemas/base-schema.ts:11`
(`prefixSchema = z.string().regex(lowerHexRegex).min(4).max(64)`) is applied to `ids`
and `authors` in `src/schemas/filter-schema.ts:10-11`, and both the database query
(`applyHexCriteria` over `event_pubkey`/`event_id`,
`src/repositories/event-repository.ts:261-285`) and the in-memory matcher
(`src/utils/event.ts:60,76-79`) compare by prefix. The relaxation is advertised as
`limitation.min_prefix` (`src/handlers/request-handlers/root-request-handler.ts:112`,
default 4 at `resources/default-settings.yaml:350`). A client sending
`{"ids": ["abcd"]}` therefore gets results where the registry text requires a
64-character value. (`#e` and `#p` are a smaller difference: they are matched exactly,
`src/utils/event.ts:55`, and their length is not validated — a short value simply
matches nothing.) This is a permissive extension, not a broken feature, but it is
relay-visible and it is advertised.

It is also not free, which matters for the rewrite. A full 64-character value goes
through `orWhereIn` on `event_id`/`event_pubkey` (`event-repository.ts:274-276`), which
the btrees on those columns serve
(`migrations/20220524_153400_create_events_table.js:4-5`). Every shorter value goes
through an expression predicate instead — `substring("event_id" from 1 for ?) = ?` or
the odd-nibble `BETWEEN` (`event-repository.ts:278-288`) — and no index on the full
columns can serve that, so a **prefix-only** filter — one with no other selective
criterion — is a scan of `events` proportional to the table rather than to the result
set. Keeping the
extension in Rust is cheap only if a prefix becomes a range seek (or a functional index
does), which is why §9 item 8 says what "keep it" has to buy.

The window's change to this section — the zero-`limit` clarification at `01.md:151`
("When `limit` is zero, the relay MUST NOT return stored events for that filter … MUST
keep the subscription active") — is **met**: the filter schema allows `0`
(`src/schemas/filter-schema.ts:15`), `findByFilters` passes it to the query
(`src/repositories/event-repository.ts:88`), knex emits `limit 0` rather than omitting
the clause, and `isEventMatchingFilter` never consults `limit` (`src/utils/event.ts:39-125`),
so the subscription still receives new matching events after the `EOSE`.

### NIP-09

`09.md` requires a kind-5 deletion request to name its targets with `e` tags (events)
and `a` tags (addressable events), and says the relay should refuse or ignore requests
that do not match the author. nostream implements the `e` half only:
`DeleteEventStrategy` filters for a valid 64-hex `e` tag and then calls
`eventRepository.deleteByPubkeyAndIds`, and `deleteByPubkeyAndIds` takes event ids —
there is no addressable path
(`src/handlers/event-strategies/delete-event-strategy.ts:22-31`,
`src/@types/repositories.ts:45-46`). An `a`-only request therefore deletes nothing and
is acknowledged like any other kind-5 event, so a client that follows the spec's
addressable branch gets a success response and no deletion. The registry text did not
change (the June commit was a fence-language sweep); the gap is nostream's, and Phase 2
carries it as item 12 in §9.

### NIP-11

`11.md` §"Server Limitations" is the authoritative `limitation` block, and it no longer
contains two keys nostream emits. `max_filters` was removed by `611b635` (2025-04-13,
*"nip-11: remove max filters, add max/default query limit, update example. (#1821)"*)
and `min_prefix` by `89915e0` (2023-08-20, *"Remove min_prefix mentions from NIP-11
after prefix search was removed from NIP-01"*). nostream still emits both —
`max_filters` at `src/handlers/request-handlers/root-request-handler.ts:105` and
`min_prefix` at `:112` — alongside `max_filter_values` (`:109`) and `search_supported`
(`:142`), which `11.md` has never defined, and the top-level
`supported_nip_extensions` (`:97`) and `supported_mips` (`:98`).

This is not a conformance failure: `11.md` §"Field Descriptions" says *"Any field may
be omitted, and clients MUST ignore any additional fields they do not understand."*
The delta is that two of the six keys advertise limits the registry took away, so a
client reading the current spec learns nothing from them, while a client reading an
older copy is told a prefix floor the relay does enforce. §8 gives the full
field-by-field comparison.

### NIP-15

`15.md` §"Nostr Marketplace" is now the marketplace protocol: stalls and products
built on addressable events, chosen by clients. nostream's only NIP-15 artifact is a
comment on the `EOSE` builder — `// NIP-15` above
`src/utils/messages.ts:27-30` — because NIP-15 used to be *End of Stored Events
Notice*, whose message is now defined in `01.md` §"From relay to client: sending
events and notices". `README.md:79` still spells the old meaning out: *"NIP-15: End of
Stored Events Notice"*. Since 15 is in `supportedNips` (`package.json:7`) and served
at `src/handlers/request-handlers/root-request-handler.ts:94-96`, a current client
reads the advertisement as marketplace support that nostream does not have, while the
behaviour it does have (EOSE) needs no advertisement at all.

### NIP-22

`22.md` §"Comment" now defines kind `1111`: a threading note whose uppercase tags
point at a root (`K`, `E`, `A`, `I`) and whose lowercase tags point at the parent
(`k`, `e`, `a`, `i`). The number's previous content was *moved*, not deleted with the
file: `d784820` (2023-09-01, *"add NIP-22 created_at limits to Server-Limitations"*)
put the two `created_at` limits into `11.md` §"Server Limitations" as
`created_at_lower_limit`/`created_at_upper_limit`, and `d67988e` (2023-12-01, *"delete
NIP-22 (#897)"*) deleted `22.md` and dropped only the `[NIP-22](22.md)` links from
those two fields. They are current NIP-11 keys at the cutoff (`11.md:157-159`), and
they are exactly what nostream advertises (`src/handlers/request-handlers/root-request-handler.ts:138-139`),
with the bounds enforced at `src/handlers/event-message-handler.ts:204-216`. So the
limits are NIP-11 parity today, not an orphaned NIP-22 artifact — which is worth
saying, because a reader who takes `supported_nips`' 22 at face value would look for
Comment support in the wrong place. nostream has none of it: there is no kind 1111
constant in `src/constants/base.ts`, the string `NIP-22` appears nowhere in `src/`, and
`README.md:82` still says *"NIP-22: Event `created_at` Limits"*. The relay-visible
delta is the advertisement: `supported_nips` includes 22 (`package.json:7`), which now
promises Comment support; kind 1111 events are stored only because they fall through to
`DefaultEventStrategy` (`src/factories/event-strategy-factory.ts:108`), with none of
the NIP's tag rules checked.

### NIP-42

`42.md` §"`auth` hint in `EOSE`" says: *"Relays MAY use the `"auth"` hint in an `EOSE`
message (as defined in NIP-67 (67.md)) to notify the client that more results may be
available if they authenticate. In this case, the relay MUST send the `AUTH` challenge
before the `EOSE` message."* nostream's `EOSE` is built as a two-element array
(`src/utils/messages.ts:28-30`) and emitted at
`src/handlers/subscribe-message-handler.ts:213`; no code path appends a third element.
The `AUTH` challenge is sent unconditionally at connect
(`src/adapters/web-socket-adapter.ts:102-104`), but it is never tied to an `EOSE`.

The relay-visible consequence is in the mixed-filter case, and it only arises when the
read gate is **on**. `getRestrictedReadKinds` returns an empty list unless
`nip42.restrictedReads.enabled` is true (`src/utils/nip42.ts:17-23`), and the shipped
default is `false` (`resources/default-settings.yaml:82-86`; `CONFIGURATION.md:212` says
"Defaults to false", and `:213` gives `[4, 1059]` as the kinds). With an empty list,
`createReadAuthorizationGuard` returns `() => true` (`:48-50`) and
`isSubscriptionAuthRequired` returns `false` (`:77-79`) — the two gates on the REQ and
live paths (`src/handlers/subscribe-message-handler.ts:68,223`,
`src/adapters/web-socket-adapter.ts:137`). The setting has four consumers in all: the
other two are `isReconciliationAuthorized` (`src/utils/nip42.ts:95-116`, used at
`neg-open-message-handler.ts:145` and `neg-msg-message-handler.ts:37`) and
`isCountAuthorized` (`:120-144`, used at `count-message-handler.ts:75`), both permissive
on an empty list too (`:101-103`, `:125-127`); `CONFIGURATION.md:212` names REQ, live
broadcasts and COUNT, and the code also covers NEG. They do not filter per event: they
scope a whole reconciliation or COUNT to the client's own `authors`/`#p`, so a rewrite
that ports only the REQ and live gates leaves COUNT and reconciliation event ids
un-scoped once the list is non-empty. COUNT's reading of a filter that names no kinds is
a defect rather than a convention: `isCountAuthorized` authorizes `{"filters": [{}]}`
(`:130-135`) and `filterSchema` accepts it (`src/schemas/filter-schema.ts:9-19`), so an
unauthenticated client can count kind-4 and 1059 events that `REQ` withholds — while
`CONFIGURATION.md:212` says the setting applies to COUNT, and reconciliation refuses the
same filter (`:105-109`). The rewrite takes reconciliation's reading; item 3 owns the
fix. `nip42.authRequired` does not cover reads: it gates publishing
(`src/handlers/event-message-handler.ts:104`). So **on a default deployment no
gate withholds anything**, and kind 4 and kind 1059 events are served to unauthenticated
clients — their metadata, since the payload is encrypted to its recipient.

With `restrictedReads.enabled: true`, the gap this section is about appears:
`isSubscriptionAuthRequired` (`src/utils/nip42.ts:71-90`) closes a subscription only
when *every* filter names restricted kinds; a filter such as `{"kinds": [1, 4]}` is
served, and `createReadAuthorizationGuard` (`src/utils/nip42.ts:44-61`) drops the kind-4
events. The client receives the kind-1 events and an `EOSE` with no signal that more
exists behind authentication — exactly the ambiguity the `auth` hint was added to
remove. The narrow `CLOSED auth-required` path
(`src/handlers/subscribe-message-handler.ts:68-77`) covers only the fully-restricted
case.

The four checks of `42.md` §"Signed Event Verification" are all implemented in
`src/handlers/auth-message-handler.ts:22-63`: kind `22242` (`:13,25-28`), `created_at`
within ±600 s (`:14,40-45`), the `challenge` tag (`:47-53`) and the `relay` tag by
hostname (`:55-61`, `isRelayUrlMatch` at `:80-85`). The replay set at
`src/utils/nip42-session.ts:44-52` and the per-pubkey map at `:22` also satisfy
`42.md`'s multi-pubkey AUTH relaxation (`4c5d5ff`, 2025-09-06). So the delta is the
hint, not the verification.

### NIP-43

`43.md` §"Join Request" ends, at the cutoff: *"Users can request a `claim` using the
NIP 86 (86.md) `createclaim` method."* The `## Invite Request` section that defined
a client `REQ` for kind `28935` was deleted by `62d5fed` (2026-09-23, *"Add claim
management to nip 86 (#2408)"*), which moved the claim operation into `86.md`.
nostream still mints on that `REQ`: `maybeIssueInviteCode` runs before the stored-event
query (`src/handlers/subscribe-message-handler.ts:89-104`), the filter test is
`src/utils/nip43.ts:89-92`, and the relay-signed kind-28935 event is built by
`src/utils/nip43-invites.ts:95-121`. A client that follows the current text calls a
NIP-86 method nostream does not expose, while the removed `REQ` path still answers.
`43.md` §"Implementation" still tells clients to request kind 28935 from relays
advertising 43, a contradiction left in the registry itself. nostream advertises 43
only while the feature is on (`src/handlers/request-handlers/root-request-handler.ts:94-96`),
which keeps the advertisement honest about the old flow but not about the new one.

### NIP-44

`44.md` §"Version 2" → "### Encryption" step 4 and "### Decryption" step 7 were
rewritten by `733a047` (2026-06-28, *"allow NIP-44 to encrypt more than 65535 bytes
(#1907)"*): plaintext may now be up to 4,294,967,295 bytes, and a length of 65536 or
more uses a 6-byte prefix (`[0x00, 0x00][u32]`) while shorter lengths keep the 2-byte
`u16`. The decryption size floor and ceiling were correspondingly relaxed. nostream
still implements the pre-change format: `MAX_PLAINTEXT_SIZE = 65535` at
`src/utils/nip44.ts:5`, a 2-byte length prefix in `pad` at `:74-87`, and the old
payload bounds in `nip44Decrypt` (`:120-125`) and `validateNip44Payload` (`:162-172`).
The relay-visible path is gift-wrap admission: `validateNip44Payload` runs on every
kind-1059 event (`src/handlers/event-strategies/gift-wrap-event-strategy.ts:53-56`),
so a NIP-17 gift wrap whose NIP-44 payload exceeds the old cap is rejected with an
`invalid:` prefix even though it is valid under the cutoff text.

### NIP-62

`62.md` §"Request to Vanish from Relay" requires: *"Relays MUST fully delete any
events from the `.pubkey` if their service URL is tagged in the event"*, and *"Relays
SHOULD delete all NIP-59 (59.md) Gift Wraps that p-tagged the `.pubkey`"*. nostream's
`VanishEventStrategy` calls `deleteByPubkeyExceptKinds` with kind 62 excluded
(`src/handlers/event-strategies/vanish-event-strategy.ts:22`) and
`src/repositories/event-repository.ts:498-508` implements that as an `UPDATE … SET
deleted_at = now()` — a soft delete that leaves every row in place — filtered to
`event_pubkey`, so gift wraps that merely p-tag the pubkey are untouched. The other
two requirements are met: re-publication is blocked with
`blocked: request to vanish active for pubkey`
(`src/handlers/event-message-handler.ts:360-375`), and the kind-62 request itself is
kept (`:22` excludes it). The delta matters because the NIP is explicitly about
deletion that is *"legally binding in some jurisdictions"*; a row that still exists is
not deleted, however invisible it is to clients.

### NIP-67

`67.md` §"Specification": *"A relay that implements this NIP MAY append a third
element to the `EOSE` message: an array of hint strings"*, with `"finish"`, `"more"`
and `"auth"` defined, and §"Relay advertisement" says implementing relays *"SHOULD
include `67` in the `supported_nips` field"*. nostream sends the two-element form
(`src/utils/messages.ts:28-30`) from `src/handlers/subscribe-message-handler.ts:213`,
has no hint value anywhere (`grep -rn -iE '\bfinish\b|eoseHint' src/` finds only
unrelated `finish()` callbacks under `src/utils/relay-probe/`), and does not list 67 in
`package.json:7`. The delta is the one `67.md` §"Motivation" describes: a client cannot
tell "every stored event was sent" from "the relay's own cap cut the result", and a
client that cannot read restricted kinds gets no `"auth"` hint. This is the same gap
as `### NIP-42`, seen from the message's side; implementing it once closes both.

### NIP-77

`77.md` §"Nostr Messages" defines four message shapes and their rules. Measured
against nostream:

- **`NEG-OPEN`** (`77.md:31-44`) — the four-element shape is enforced by
  `src/schemas/message-schema.ts:61-66` and handled by
  `src/handlers/neg-open-message-handler.ts:30-130`. Met.
- **Separate subscription namespace; a re-open closes the old session**
  (`77.md:42`) — `src/utils/negentropy-sessions.ts:12-20` keeps NIP-77 ids in their
  own map, and `reserve` closes any session under the id first (`:21-24`). Met.
- **`NEG-ERR` with machine-readable prefixes** (`77.md:46-70`) — `blocked:` at
  `src/handlers/neg-msg-message-handler.ts:26` and
  `src/handlers/neg-open-message-handler.ts:56`, `closed:` at
  `neg-msg-message-handler.ts:32`, `invalid:` at `:53` and
  `neg-open-message-handler.ts:106`, and `error:` at `neg-open-message-handler.ts:70,115`.
  Met. (`auth-required:` at `neg-msg-message-handler.ts:40` is a NIP-42 prefix the
  document's "suggested" list does not enumerate; the format is the same.)
- **The optional 4th element carrying the record cap** (`77.md:64`) — emitted at
  `src/handlers/neg-open-message-handler.ts:86` as
  `createNegErrMessage(subscriptionId, 'blocked: this query is too big', maxEventsPerSession)`.
  Met.
- **A `NEG-ERR` closes the subscription** (`77.md:70`) — `reject` closes before
  replying (`neg-open-message-handler.ts:152-155`), and the malformed-message path
  closes at `neg-msg-message-handler.ts:47-53`. Met.
- **`NEG-CLOSE` releases resources and draws no reply** (`77.md:86-97`) —
  `src/handlers/neg-close-message-handler.ts:8-11`. Met.

**Conclusion: no relay-visible divergence in the registry text.** The audit-window
fact is about the advertisement, not the protocol: the wire implementation landed at
`7409006` (*"feat(nip77): add NEG-OPEN/NEG-MSG/NEG-CLOSE wire protocol (#818)"*) and
the NIP-11 advertisement at `f0bcdcc` (*"feat(nip77): advertise NIP-77 in NIP-11 and
expose its settings in the admin console (#830)"*), both **after** the capture commit
`242a3001`. NIP-77 is therefore advertised at the grading tip and not at the capture
date, and `isNip77Active` (`src/utils/nip77.ts:14-15`) adds a second condition: the
Postgres backend.

The bounds around all this are the relay's own, not the registry's: `77.md` sets no
frame or record size, while nostream defaults to 100000 events per session, three
sessions per connection and a 60000-byte frame (`src/utils/nip77.ts:5-11`), and
`NEG-OPEN` reads `maxEventsPerSession + 1` rows before deciding a set is too big
(`src/handlers/neg-open-message-handler.ts:64`). A rewrite sizing connection memory
should carry those numbers forward deliberately rather than rediscover them.

### NIP-78

`78.md` §"AUTH" says: *"relays SHOULD require clients to perform the NIP-42 (42.md) `AUTH`
flow before accepting or serving `kind 78` and `kind 30078` events, and SHOULD only
serve these events to the authenticated owner, i.e. the client must authenticate with
the same pubkey as the event author"*. nostream has no such guard, in either of two
senses. The read gate itself is off by default — `getRestrictedReadKinds`
returns `[]` unless `nip42.restrictedReads.enabled` is true (`src/utils/nip42.ts:17-23`,
default `false` at `resources/default-settings.yaml:82-86`) — and even when it is on,
`DEFAULT_RESTRICTED_READ_KINDS` is `[4, 1059]` (`src/utils/nip42.ts:10-13`), so kinds 78
and 30078 are not in the set the guard would drop. Admission has no NIP-78 branch
either: kind 78 reaches `DefaultEventStrategy` and kind 30078, being inside the
parameterized-replaceable range (`src/constants/base.ts:75,83`), reaches
`ParameterizedReplaceableEventStrategy`
(`src/factories/event-strategy-factory.ts:104-108`); neither strategy carries an AUTH
check. An unauthenticated client can therefore fetch another user's kind 78 or 30078
events on a default deployment, and on an enabled-guard deployment too, where the NIP
asks the relay to refuse. The NIP does not define kind 30078 as a restricted kind
anywhere else, so the serving half of the fix is local to the read guard. `78.md:23`
asks for more on both sides: AUTH before **accepting** as well as serving, and serving
only to the author. The guard is owner-or-recipient instead — it admits the event's
author or any authenticated pubkey a `p` tag names (`src/utils/nip42.ts:29-41`, the `p`
branch at `:38-40`) — so that is a deviation from the NIP, not a reading of it, and it
has to be closed per kind: tightening the shared predicate would also deny kind-4 and
kind-1059 recipients, which is what recipient admission exists for. The accept half is `nip42.authRequired`
(`src/handlers/event-message-handler.ts:104`, defined at `:285-295`): the one publish
gate a setting selects, global rather than kind-scoped, and off by default
(`resources/default-settings.yaml:76`). §9 item 7 carries both.

## 5. Registry changes with no relay-visible delta

The other 22 NIPs from the delta window, in registry order. Each changed at the
cutoff (date and subject from the registry's own last commit touching that file) and
none of the changes reaches a relay. Rows here carry `Delta: none`.

- **NIP-02** — 2026-09-20, *"nip02: clarify petname character eligibility."* The
  change adds a character rule for petname resolution (ASCII letters, digits and `_`)
  to the `nostr:` identifier examples; a relay stores kind 3 unchanged.
- **NIP-03** — 2026-05-31, *"add unrecommended tag and warning to NIP bodies."* A
  header tag and warning banner; the kind-1040 attestation shape is untouched, and
  nostream's `TimestampEventStrategy` needs no change.
- **NIP-04** — 2025-12-23, *"add relay tag (#2173)"*. The commit adds `relay` to the
  NIP's own role tags, a registry annotation rather than protocol text. The message
  format is unchanged; a relay stores kind 4 as opaque content.
- **NIP-05** — 2026-06-13, *```` ```jsonc -> ```yaml everywhere. ````* A fence-language sweep
  across 45 files; no requirement changed, so nostream's admission-time verification
  (`src/handlers/event-message-handler.ts:543-590`) is unaffected.
- **NIP-09** — 2026-06-13, *```` ```jsonc -> ```yaml everywhere. ````* Formatting only;
  deletion semantics are unchanged. nostream's `DeleteEventStrategy` implements the
  `e`-tag half only — it collects valid `e` tags and calls `deleteByPubkeyAndIds`
  (`src/handlers/event-strategies/delete-event-strategy.ts:22-31`), so an `a`-only
  request leaves its targets untouched. That gap is a Phase 2 item (§9.12).
- **NIP-13** — 2025-12-23, *"add relay tag (#2173)"*. Registry annotation only;
  proof-of-work is still defined by leading zero bits on the id.
- **NIP-17** — 2026-06-13, *```` ```jsonc -> ```yaml everywhere. ````* Formatting only; the
  kind-1059 envelope nostream handles is unchanged.
- **NIP-25** — 2026-06-13, *```` ```jsonc -> ```yaml everywhere. ````* Formatting only; kind 7
  reactions are unchanged.
- **NIP-28** — 2026-06-13, *```` ```jsonc -> ```yaml everywhere. ````* Formatting only; kinds
  40-49 are unchanged.
- **NIP-33** — 2024-08-20, *"rename "parameterized replaceable event" to "addressable
  event" (#1418)"*. A rename across 17 files. nostream's
  `isParameterizedReplaceableEvent` (`src/utils/event.ts:220-224`) and
  `ParameterizedReplaceableEventStrategy` implement the same semantics under the old
  name; the relay behaviour does not change.
- **NIP-40** — 2025-12-23, *"add relay tag (#2173)"*. Registry annotation only; the
  `expiration` tag and its handling are unchanged.
- **NIP-45** — 2026-02-06, *"nip45: add hyperloglog relay response (#1561)"*. The
  change adds an **optional** response shape: `approximate` and `"hll": "<hex>"` plus
  the register algorithm, each introduced with "Relays may return". nostream returns
  `{"count": <integer>}` from `src/handlers/count-message-handler.ts:45-46`, which
  stays conformant; HLL is recorded in §9 as an optional future capability.
- **NIP-46** — 2026-07-15, *"Avoid nip46 silent timeouts (#2375)"*. A client/signer
  protocol; relays only store the kind-24133 messages it defines, generically.
- **NIP-47** — 2026-08-01, *"NIP-47: simplify core spec and introduce extensions
  (#2419)"*. A client/wallet protocol. nostream's NWC use
  (`src/payments-processors/nwc-payments-processor.ts`) is an operator payment client,
  not a relay requirement.
- **NIP-50** — 2026-06-13, *```` ```jsonc -> ```yaml everywhere. ````* Formatting only; the
  `search` filter is unchanged.
- **NIP-56** — 2026-06-13, *```` ```jsonc -> ```yaml everywhere. ````* Formatting only; kind
  1984 reports are unchanged.
- **NIP-59** — 2026-06-02, *'Revert ""id"s not required in NIP-59 rumors."'* The revert
  puts the `id` field back on rumors, which is a client-side rule for the unsigned
  inner event; a relay sees only the outer kind-1059 gift wrap.
- **NIP-65** — 2026-06-13, *```` ```jsonc -> ```yaml everywhere. ````* Formatting only; kind
  10002 is unchanged.
- **NIP-66** — 2026-05-28, *"fix: sanity."* This retitled `66.md` from *Relay Discovery
  and Liveness Monitoring* to *Relay Liveness Monitoring* and fixed the heading
  underline; no requirement changed.
- **NIP-70** — 2026-06-13, *```` ```jsonc -> ```yaml everywhere. ````* Formatting only; the
  `"-"` tag and the publish rules are unchanged.
- **NIP-89** — 2026-06-16, *"Add aggregate hash and site snapshots to NIP-5A (#2287)"*.
  The commit's `89.md` change adds optional `latest` and `next` tags to web-app
  descriptors (kind 31990), pointing at NIP-5A site manifests. A relay stores 31990
  generically; nothing in the change asks a relay to read the new tags.
- **NIP-90** — 2026-06-13, *```` ```jsonc -> ```yaml everywhere. ````* Formatting only; DVM
  job kinds 5000-6999 are unchanged.

## 6. The 24 post-capture commits

Mechanical comparison, not reading: `git log --oneline 242a3001..041fe34e` lists 24
commits, and `git diff --stat 242a3001..041fe34e -- src/ resources/ migrations/`
reports 21 files changed, 671 insertions, 12 deletions.

Four commits touch protocol code:

| commit | subject | what it did |
| --- | --- | --- |
| `7409006` | feat(nip77): add NEG-OPEN/NEG-MSG/NEG-CLOSE wire protocol (#818) | the NIP-77 implementation: three handlers, `src/utils/negentropy.ts`, `src/utils/negentropy-sessions.ts`, `src/utils/nip77.ts`, schemas, settings |
| `f0bcdcc` | feat(nip77): advertise NIP-77 in NIP-11 and expose its settings in the admin console (#830) | adds 77 to `package.json`'s `supportedNips` and filters it at serve time (`root-request-handler.ts:94-96`); admin settings schema |
| `48fe9c4` | fix(settings): validate info.relay_url is a usable absolute URL (#825) | `src/utils/settings-config.ts`; protects the `payments_url`/`relay_url` values NIP-11 depends on |
| `50ffe33` | fix(deps): resolve open dependabot security alerts (#838) | dependency bumps. Its one `src/` change is an import-shape fix in `src/services/event-import-service.ts` (`stream-json` default export), not protocol behaviour |

The remaining **20 commits touch no `src/**` file**: website work (`82287d4`,
`bb28deb`, `b2a997d`, `4642dfd`, `91a5a7e`, `72fca58`, `c352d72`, `1b1ef4f`,
`2234a25`, `ee7e06b`), release chores (`d4e894d`, `9bf130b`, `4f6579d`, `ed74856`,
`3877140`, `d31f4f8`, `d3651dc`, `4d7d0d0`), CI (`13584bf`), and README copy (`041fe34`).
Checked
per commit with `git show --name-only --format= <commit> | grep -cE '^(src|resources|migrations)/'`,
which returns 0 for each of the 20.

## 7. Advertised without NIP-specific code, implemented without advertisement

**Advertised with no NIP-specific code of its own** — NIP-04, NIP-14, NIP-22, NIP-28,
and NIP-15:

| NIP | what exists | why it is not NIP-specific work |
| --- | --- | --- |
| 04 | kind constant `src/constants/base.ts:6`; in `DEFAULT_RESTRICTED_READ_KINDS` `src/utils/nip42.ts:10-13` | encryption is client-side; the relay stores and serves kind 4. The only relay-visible behaviour is the restricted-read default, and that default applies only when `nip42.restrictedReads.enabled` is on — off by default (§4) |
| 14 | tag constant `src/constants/base.ts:92` | a `subject` tag is stored with the event; no code path reads it |
| 22 | `created_at` bounds `src/handlers/event-message-handler.ts:204-216`, advertised at `src/handlers/request-handlers/root-request-handler.ts:138-139` | the number now means Comment (§4); the limits are NIP-11's behaviour, moved there before `22.md` was deleted (§4) |
| 28 | kinds 40-49 `src/constants/base.ts:20-26`; kind 41 is in `isReplaceableEvent` (`src/utils/event.ts:203-210`) | `grep -rl 'NIP-28' src/` returns nothing and `event-strategy-factory.ts` has no channel branch, but kind 41 (channel metadata) is routed to `ReplaceableEventStrategy` by that predicate; kinds 40 and 42-49 fall to `DefaultEventStrategy` |
| 15 | `// NIP-15` on the EOSE builder, `src/utils/messages.ts:27-30` | the registry's 15 is Marketplace (§4); the comment names the old EOSE NIP |

Four advertised NIPs are **tombstones** whose text moved into NIP-01: NIP-12, NIP-16
and NIP-20 (*"Moved to NIP-01 (01.md)."*) and NIP-33 (*'Renamed to "Addressable
events" and moved to NIP-01 (01.md).'*). nostream implements the behaviour and
advertises the numbers; the behaviour is what the rewrite must keep (§9).

**Implemented but not advertised** — nine NIPs, all live code:

| NIP | implementation | advertised? |
| --- | --- | --- |
| 05 | `src/utils/nip05.ts` (220 lines), `src/repositories/nip05-verification-repository.ts`, admission gate `src/handlers/event-message-handler.ts:543-590`, re-verification `src/app/maintenance-worker.ts:264-277` | no; README says yes (`README.md:73`) |
| 56 | `src/utils/nip56.ts` (102 lines), `src/handlers/event-strategies/report-event-strategy.ts`, kind 1984 `src/constants/base.ts:36`, hide-from-reads `src/repositories/event-repository.ts:221-232` | no, and absent from the README list |
| 59 | kind 1059 `src/constants/base.ts:32`; seal/direct-message admission block `src/handlers/event-message-handler.ts:347-355` | no |
| 62 | `VanishEventStrategy` `src/handlers/event-strategies/vanish-event-strategy.ts:18-30`, kind 62 `src/constants/base.ts:18`, `isRequestToVanishEvent` `src/utils/event.ts:230-244`, vanished-pubkey block `src/handlers/event-message-handler.ts:360-375` | no; README says yes (`README.md:93`) |
| 66 | `src/utils/nip66-events.ts`, `src/utils/nip66-nip11-tags.ts`, `src/utils/nip66-schedule.ts`, `src/services/nip66-event-publisher.ts`, `src/app/relay-monitor-worker.ts` | no — and `src/utils/network-health-mismatches.ts:64-74` raises `nip66-not-advertised` against *other* relays for exactly this |
| 70 | `isProtectedEvent` `src/utils/event.ts:321-323`, `EventTags.Protected` `src/constants/base.ts:111`, enforcement `src/handlers/event-message-handler.ts:299-337` | no |
| 89 | kinds 31989/31990 `src/constants/base.ts:81-82`, `src/app/dvm-orchestrator-worker.ts` | no |
| 90 | DVM ranges `src/constants/base.ts:47-51`, `src/handlers/event-strategies/dvm-job-request-event-strategy.ts`, `src/repositories/dvm-job-repository.ts`, `src/app/dvm-orchestrator-worker.ts` | no |
| 98 | `src/utils/nip98.ts` (281 lines), `src/utils/nip98-replay.ts`, gate `src/handlers/request-handlers/admin-auth-middleware.ts:41-100`, tags `src/constants/base.ts:115-118` | no |

NIP-89's implementation is deliberately passive — the two addressable kinds are
accepted and served, and `test/integration/features/nip-89/nip-89.feature` proves it
(*"NIP-89 Recommended Application Handlers (passive accept-and-serve)"*). NIP-62 is
the other row worth naming: its code is live
(`src/factories/event-strategy-factory.ts:56` dispatches to it before every other
strategy) while `package.json:7` does not list it.

**The README and `package.json` disagree in both directions** at 3.5.1. `README.md:69-95` lists
NIP-05 (`:73`), NIP-26 (`:84`, rendered `- [ ] … (removed upstream; not implemented)`)
and NIP-62 (`:93`), none of which `supportedNips` carries; and it omits NIP-17, which
`package.json:7` carries. It also spells the two number collisions out in its own
words: `README.md:79` *"NIP-15: End of Stored Events Notice"* and `README.md:82`
*"NIP-22: Event `created_at` Limits"*. The `Advertised` column comes from
`package.json:7` only, never from the README.

## 8. NIP-11, field by field

`11.md` at the cutoff defines **fourteen** top-level keys: the eleven of
`### Name` through `### Terms of Service` (`name`, `description`, `banner`, `icon`,
`pubkey`, `self`, `contact`, `supported_nips`, `software`, `version`,
`terms_of_service`), plus `limitation` (`### Server Limitations`), `payments_url` and
`fees` (`### Pay-to-Relay`). nostream emits **all fourteen**
(`src/handlers/request-handlers/root-request-handler.ts:83-161`), four of them
conditionally: `banner` (`:86`), `icon` (`:87`), `self` (`:89`, derived by
`resolveRelaySelfPubkey` (`src/utils/nip43.ts:77`) at `:81` when unset) and
`terms_of_service` (`:101`).

The reverse direction is where the extras are. Six names nostream emits occur **zero
times** in `11.md` at the cutoff (`grep -c` for each is 0):

| key | where nostream emits it | registry history |
| --- | --- | --- |
| `limitation.max_filters` | `root-request-handler.ts:105` | removed by `611b635` (2025-04-13) |
| `limitation.max_filter_values` | `:109` | never defined |
| `limitation.min_prefix` | `:112` | removed by `89915e0` (2023-08-20) |
| `limitation.search_supported` | `:142` | never defined |
| `supported_nip_extensions` | `:97` | never defined |
| `supported_mips` | `:98` | never defined; Marmot's registry |

Two behaviours behind those fields are worth stating precisely, because they read as
contradictions and are not:

- **`auth_required` is hard-coded `false`** (`root-request-handler.ts:136`) while the
  relay can require AUTH to publish. That is deliberate and matches the spec's split:
  `11.md` §"Server Limitations" defines `auth_required` as authentication before any
  action, and `restricted_writes` as *"some kind of condition to be fulfilled to accept
  events (not necessarily, but including `payment_required` and `min_pow_difficulty`)"*
  (`11.md:151-154`). The publish-only
  condition is computed by `hasWriteRestriction` (`:63-74`) and advertised as
  `restricted_writes` (`:141`). A client is correctly told "you may read without
  auth, you may not write without it".
- **`search_supported` tracks `settings.nip50.enabled`** (`:142`) while NIP-50 stays
  in the static `supported_nips` list. With NIP-50 disabled the document says both
  "50 is supported" and "search is not supported". The spec does not define
  `search_supported`, so this is an internal inconsistency rather than a violation;
  §9 item 11 records it as a decision for the rewrite.

A third field is advertised but not enforced. `limitation.max_event_tags` is the
literal `2500` (`root-request-handler.ts:113`), and `11.md:135` gives the field meaning
— *"the maximum number of elements in the `tags` list"* — while nothing checks it: the
event schema puts no maximum on `tags` (`src/schemas/event-schema.ts:37`) and no
admission path counts them. The only ceiling is the transport's
`network.maxPayloadSize` of 524288 bytes (`resources/default-settings.yaml:161`,
handed to the websocket at `src/factories/worker-factory.ts:75`). A rewrite that carries
`2500` forward should decide to enforce it, or it is advertising a limit it does not
keep.

## 9. Open items for Phase 2

This job files no issues: the dispositions above are the deliverable, and Phase 2
turns them into work. The items, in the order they affect the rewrite:

1. **The advertisement set needs a decision, not a copy.** Nine live features are
   unadvertised (NIP-05, 56, 59, 62, 66, 70, 89, 90, 98), five advertised numbers have
   no code for the NIP they now name (04, 14, 15, 22, 28), and four more are
   advertised tombstones whose text now lives in NIP-01 (12, 16, 20, 33). The answer
   differs by group — keep 12/16/20/33 or drop them, preserve 04/14/28's generic
   behaviour, decide 15 and 22 in item 2, name the nine — but it should be one list
   that matches what the relay does, and `README.md:69-95` should stop contradicting
   `package.json:7` in both directions.
2. **NIP-15 and NIP-22 are number collisions.** `README.md:79` and `:82` name the old
   NIPs. Either the relay drops those numbers from `supported_nips` (NIP-15 has no
   relay duty; NIP-22's kind 1111 is client-side) or it implements the current texts.
   Implementing NIP-22's tag rules is the larger of the two.
3. **NIP-42 / NIP-67: the `auth` hint.** One change closes both: emit the third
   `EOSE` element with `"auth"` where restricted kinds were trimmed (and `"finish"` /
   `"more"` where the limit was reached), and add 67 to `supported_nips`. This is the
   `opportunistic` disposition on 67 and the narrow gap in §4's NIP-42.
4. **NIP-43 / NIP-86: the invite flow.** `43.md` now delegates claims to NIP-86's
   `createclaim`. The rewrite either exposes that method (which also covers the
   NIP-86 disposition) or keeps the removed kind-28935 `REQ` path and says so. If it
   exposes it, the method carries NIP-86's own auth model — a NIP-98 event in
   `Authorization` on every method (`86.md:255-259`) — and must stay behind
   `admin.nip98.allowedPubkeys` (`src/handlers/request-handlers/admin-auth-middleware.ts:41-100`);
   as a public route it would mint invite codes for anyone.
5. **NIP-44's extended length.** Adopt the 6-byte prefix and the raised cap, or the
   relay keeps rejecting valid large gift wraps at admission. This is a prerequisite
   for NIP-17 parity, not a separate feature. The 4 GiB figure is the format's ceiling,
   not the relay's: `network.maxPayloadSize` (524288,
   `resources/default-settings.yaml:161`) still caps what arrives, so the raise is a
   format change, not a bigger buffer.
6. **NIP-62's deletion.** Replace the soft delete for vanish requests with a real
   delete, and remove gift wraps that p-tag the vanished pubkey.
7. **NIP-78's AUTH guard — two halves, two decisions.** The serving half: set
   `nip42.restrictedReads` to `enabled: true` with `kinds: [78, 30078]`, or take the
   broader `[4, 1059, 78, 30078]` — which a relay already running `enabled: true` with
   the shipped list must, since the narrow form would drop the protection 4 and 1059
   have today — and record what the choice does to DM and gift-wrap reads. Land item 3
   with either: once any kind is trimmed, the missing `auth` hint is the silence §4
   describes. The flag is `enabled` at `resources/default-settings.yaml:83` and the
   shipped kinds list is `:84-86`; `getRestrictedReadKinds` returns the configured list
   when it is set (`src/utils/nip42.ts:23`), so "add 78 and 30078" means replacing that
   list, and adding kinds to a list the guard never reads changes nothing (§4). It
   closes unauthenticated serving only for reads that **name** the kinds: `78.md:23`'s
   owner rule is not met (the guard admits any authenticated p-tagged pubkey, `:29-41`),
   and a COUNT that names no kinds still counts (§4). Both are the rewrite's to close —
   the owner rule per kind, because tightening that predicate also denies kind-4/1059
   recipients, and the COUNT beside item 3, which designs the read guards. The accept
   half: the only AUTH gate a setting selects, and the only one that applies to every
   publish, is `nip42.authRequired` (`src/handlers/event-message-handler.ts:104`,
   defined at `:285-295`), global rather than kind-scoped and off by default
   (`resources/default-settings.yaml:76`). Turning it on makes every publisher AUTH as
   the event's author, so clients without NIP-42 AUTH stop publishing — every publish by
   a normal client, since the relay's own pubkey is exempt (`:290-292`) and relay-signed
   invite and monitor events keep flowing. NIP-70's protected-event check (`:111`,
   `:299-304`) is the existing precedent for the cheaper alternative: a per-event
   AUTH-as-author test that fires only when the `-` marker is present, so a kind test
   beside it would cover 78 and 30078 without new machinery. The other write-side
   refusals — admission (`isUserAdmitted`, `:125`), NIP-05 (`:132`), content limits, PoW
   and lists (`canAcceptEvent`, `:97`), rate limits (`:86`) and vanish blocks (`:118`) —
   are policy, not AUTH, and a port carries them unchanged.
8. **NIP-01's prefix matching.** Keep it or move to exact 64-character values as the
   current text requires; whether `min_prefix` stays advertised is item 11's decision,
   per key. Keeping it is not free: the prefix arms are `substring(...)` predicates
   that no index on `event_id` or `event_pubkey` can serve
   (`src/repositories/event-repository.ts:278-288`), so a prefix-only filter scans
   `events`. The rewrite can keep the extension cheaply by making a prefix a range seek
   in its key layout; otherwise the honest choice is exact values. Either way the
   decision should be written down, because today it is an undocumented extension.
9. **NIP-45's HyperLogLog response** is optional under the cutoff text. Take it when
   `COUNT` is next touched, not before — and set the exact-versus-approximate policy
   at the same time, because HLL still visits every matching event to fill its
   registers; its leverage is the deterministic `offset` and cross-query caching, not
   a cheaper single pass.
10. **NIP-29 and NIP-96 are out of scope** until the rewrite takes on relay groups or
    a file-storage service; neither exists in nostream today.
11. **NIP-11's field set.** Four keys in `limitation` are not in `11.md` today
    (`max_filters` and `min_prefix` were removed, `max_filter_values` and
    `search_supported` were never defined) and two top-level keys never were
    (`supported_nip_extensions`, `supported_mips`). Decide per key whether to keep it,
    rename it into an extension object or drop it, and settle `search_supported`
    against `supported_nips` so the document stops saying both "50 is supported" and
    "search is off" (§8). Decide `limitation.max_event_tags` too: `2500` is advertised
    and not enforced. `min_prefix` follows item 8's answer: keep it only if prefix
    matching is kept. Whatever survives needs a test. `max_filters` is checked by the
    NIP-11 integration feature (`test/integration/features/nip-11/nip-11.feature:30-33`),
    and `max_filter_values` and both `search_supported` cases by the root-handler unit
    tests (`test/unit/handlers/request-handlers/root-request-handler.spec.ts:137,310-326`);
    the four untested keys are `min_prefix`, `supported_nip_extensions`, `supported_mips`
    and `max_event_tags` (§1). NIP-78's two kinds have no test either, and item 7
    carries that pair.
12. **NIP-09 `a`-tag deletion.** `DeleteEventStrategy` accepts only `e` tags
    (`src/handlers/event-strategies/delete-event-strategy.ts:22-31`); a kind-5 event
    whose tags are `a`-only deletes nothing. The rewrite either implements
    addressable-event deletion or records the omission deliberately — but §5 and the
    §7 row now say so, and Phase 2 must not inherit the silence.
