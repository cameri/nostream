# Plan: Fix Unit Test Hang After PR #615

## Problem

`npm run test:unit` hangs indefinitely after all 1342 tests pass. Introduced by our PR changes (not pre-existing on main).

The fix approach agreed on: **both** `--exit` as a safety net AND proper teardown of leaked handles.

## What We Know

### Active handles at hang time
- `process.stdin`, `process.stdout`, `process.stderr` — always present, not our fault
- After `1342 passing`, log messages `"exiting"` and `"close"` from `app-primary` scope appear — an `App` instance's `onExit()` is being triggered after the test run, likely from a buffered/async callback

### Root cause candidates (to verify)

1. **WebSocket connections left open by `static-mirroring-worker.spec.ts`**
   - Tests that call `worker.run()` create a real `WebSocket` to `ws://source-relay.com`
   - On connection failure, the `close` handler sets a 5-second `setTimeout` for reconnect
   - `afterEach` never calls `worker.close()` to clean up the socket and cancel the timer
   - Tests that call `run()`: "initializes the worker", "uses MIRROR_INDEX", "applies mirror-specific limits", "admits users when skipAdmissionCheck is true", "relays broadcast messages to connected mirror" (onMessage beforeEach)

2. **App instance `onExit` triggered after tests**
   - Log `"scope":"primary:app-primary","msg":"exiting"` appears after `1342 passing`
   - Could be a deferred Promise callback (from `addOnion().then(...)`) calling something unexpected
   - Could be a real SIGTERM reaching the process if `fakeProcess` ever references the real `process`

3. **`mochawesome` reporter async file writes**
   - `.mocharc.js` uses `mochawesome` — could hold the process open while writing report files

## Fix Steps

### Step 1: Add `--exit` to `.mocharc.js`
```js
module.exports = {
  exit: true,   // <-- add this
  extension: ['ts'],
  require: ['ts-node/register'],
  // ...
}
```

### Step 2: Fix `static-mirroring-worker.spec.ts` teardown
Add `worker.close()` in `afterEach` to terminate WebSocket and stop the reconnect timer:
```typescript
afterEach(() => {
  worker.close()   // terminate WebSocket + prevent reconnect timer
  // ...existing cleanup...
})
```

Also: the `onMessage` `beforeEach` injects a mock client, so `worker.run()` is not needed there anymore. The tests that explicitly call `worker.run()` (run describe block, canAcceptEvent "applies mirror-specific limits", isUserAdmitted "skipAdmissionCheck") should either:
- Call `worker.close()` after, or
- Be covered by the global `afterEach`

### Step 3: Investigate the `app-primary` `onExit` log
- Determine why `onExit` fires after tests — add logging or a spy to trace which test triggers it
- Check if `addOnion().then()` or any async callback in `app.run()` has a deferred side-effect
- Check if `sandbox.restore()` with fake timers causes any pending timer to fire unexpectedly

### Step 4: Verify fix
```bash
npm run test:unit  # should complete and exit cleanly
```

## Branch

`test/app-worker-unit-tests` — latest commit `1ef509e`
