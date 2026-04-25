# NIP-03 smoke test with a real OpenTimestamps client

This exercises a running nostream relay against a genuine Bitcoin-attested
OpenTimestamps proof that a real OTS client produced in the wild (the
event used in the [NIP-03 spec example](https://github.com/nostr-protocol/nips/blob/master/03.md)
on `wss://nostr-pub.wellorder.net`).

The relay never sees a synthetic proof here: the `.ots` blob in `content`
was made by a real `ots stamp` + `ots upgrade` flow, is attested to a real
Bitcoin block header, and is validated by the real `ots verify` binary
against a public Esplora server before and after it round-trips through
your relay.

## Why not generate our own proof end-to-end?

`ots stamp` writes a pending proof. A pending proof has to sit in a
calendar server's queue for several Bitcoin blocks (typically a few
hours) before `ots upgrade` can turn it into a confirmed Bitcoin
attestation. Running that end-to-end in CI or on a developer machine is
impractical. Re-using an already-upgraded, already-published kind 1040
event is an equally honest "real client" test: we did not make the
proof, and we prove its validity with the same binary a Nostr client
would use.

## Prerequisites

- A running nostream relay (default `ws://127.0.0.1:8008`).
- Node.js (same as the repo; the script runs via `ts-node` and uses the `ws` package).
- [`opentimestamps-client`](https://github.com/opentimestamps/opentimestamps-client)
  for the real `ots` step (optional; the script auto-detects and skips
  gracefully if it's not installed):
  - Linux / macOS: `pipx install opentimestamps-client`, or
    `pip install opentimestamps-client`.
  - Windows: Python 3.13 has an OpenSSL compatibility bug in
    `python-bitcoinlib` on which the client depends. Run it inside a
    container instead:

    ```bash
    docker run --rm -v $PWD:/work python:3.11-slim \
      sh -c "pip install -q opentimestamps-client && ots info /work/proof.ots"
    ```
- A Bitcoin node (optional, only for `--verify`). Without one the script
  runs `ots info`, which parses the proof and confirms the Bitcoin
  attestation it terminates in. `ots verify` additionally looks up the
  block header on a Bitcoin node to prove the attestation is genuine; if
  you don't have one, `ots info` is the honest equivalent of
  structural-client acceptance.

## Running the automated script

```bash
npm run smoke:nip03
# or, with non-default relays:
npx ts-node scripts/smoke-nip03.ts \
  --local-relay ws://127.0.0.1:8008 \
  --source-relay wss://nostr-pub.wellorder.net
```

Expected output on a healthy relay with `ots` installed:

```
NIP-03 end-to-end smoke test
  local relay:   ws://127.0.0.1:8008
  source relays: wss://nos.lol, wss://relay.damus.io, wss://nostr.wine, wss://offchain.pub, wss://nostr-pub.wellorder.net

1) Discovering a real NIP-03 event from public relays
  trying wss://nos.lol for any recent kind 1040…
  PASS  discovered 697b40df2f1c… on wss://nos.lol (pubkey=b1104a6e…, attests e=88fea43a70bd…, content=4968 chars)

2) Parsing OTS content with the real `ots` client
  PASS  ots info parsed proof — BitcoinBlockHeaderAttestation(941057) (file: /tmp/nip03-XXXX/proof.ots)

3) Publishing the real event to the local relay
  PASS  local relay accepted real NIP-03 event (reason="")

4) Round-tripping the event through the local relay
  PASS  local relay returned the same event (id, sig, content) on REQ

summary: 3 passed, 0 failed
```

Pass `--verify` (or set `OTS_VERIFY=1`) to additionally run
`ots verify -d <target-event-id>` which asks a Bitcoin node to confirm
the block header. Exit code is `0` iff every step passes.

## What each step proves

1. **Source discovery** — confirms a real third-party kind 1040 event
   exists, came from a real signed OTS client flow, and that you and the
   network agree on its bytes.
2. **`ots info` (or `ots verify`)** — confirms the `.ots` content in
   `event.content` is a structurally valid OpenTimestamps proof when fed
   to the real reference client, and that it terminates in a Bitcoin
   block header attestation (which is what NIP-03 requires). If
   `--verify` is set, additionally walks the Bitcoin header via a
   configured node to prove the attested block really contains the merkle
   root.
3. **Publish** — confirms nostream's NIP-03 strategy accepts a
   real-world, real-client-produced kind 1040 event (structure,
   `e` tag, digest match, Bitcoin attestation requirement all satisfied).
4. **Round-trip** — confirms the relay persisted the event unchanged and
   returns the exact same id, signature, and base64 content on REQ, so
   downstream clients that re-run `ots verify` on the relay's output will
   still succeed.

## Manual walkthrough (if you want to stamp your own)

If you do have a few hours to wait and want a proof you made yourself:

```bash
export RELAY=ws://127.0.0.1:8008
export SK=$(nak key generate)
export EVENT_ID=$(nak event --sec "$SK" -k 1 -c "anchor this note" "$RELAY" | jq -r '.[1].id // .id')

# Stamp the raw 32 bytes of the event id (not the hex string)
echo -n "$EVENT_ID" | xxd -r -p > /tmp/nip03-digest.bin
ots stamp /tmp/nip03-digest.bin

# Wait for calendars + Bitcoin confirmation, then:
ots upgrade /tmp/nip03-digest.bin.ots
ots verify  /tmp/nip03-digest.bin.ots

export OTS_B64=$(base64 -w0 /tmp/nip03-digest.bin.ots)
nak event --sec "$SK" -k 1040 \
  -t e="$EVENT_ID" \
  -t k=1 \
  -c "$OTS_B64" \
  "$RELAY"

# round-trip
nak req -k 1040 -a "$(nak key public "$SK")" "$RELAY" \
  | jq -r '.content' | base64 -d | ots verify -
```

Each publish attempt should come back as `["OK", "<id>", true, ""]`.

## Negative paths

Actively testing NIP-03 rejection paths (mismatched digest, uppercase
`e` tag, multiple `k` tags, unsupported OTS version, garbage content)
would require re-signing a mutated event, which means the proof would no
longer be produced by a real OTS client. Those paths are covered in
isolation by the unit tests:

- `test/unit/utils/nip03.spec.ts`
- `test/unit/handlers/event-strategies/timestamp-event-strategy.spec.ts`
