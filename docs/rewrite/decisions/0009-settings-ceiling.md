# ADR 0009: The validator owns both ends of the two bounds (job 022)

- **Status:** accepted (job 022, Phase 2)
- **Deciders:** the rewrite team, on the operator's decisions on #998 and the evidence in job 022's recon and spec
- **Date:** 2026-11-03

## Context

#996 put the floor of both runtime bounds in the settings validator; the ceiling stayed in
`nostream-relay`, where `MAX_SETTING_BOUND`, `in_range`, `BoundRefusal`, `refused_bounds`,
`bound_refusal`, `refusal_message` and a start-up `warn!` all lived. The asymmetry was measurable at
the two doors, and job 022's recon measured it:

```
nostreamd --check, both keys 1099511627776   → exit 0, stdout "settings valid: 0 issues", stderr empty
nostreamd --check, both keys 1099511627777   → exit 0, stdout "settings valid: 0 issues",
                                               stderr the two "above the 1099511627776 a bound accepts" lines
nostream-cli config validate, both 1099511627777
    → exit 0, one line "settings valid: 0 issues; network.frameMemoryBudgetBytes: above the …;
      limits.connection.maxConnectionsPerIp: above the …"
```

**The refusal was not silent. The verdict was wrong.** Both doors printed the value they would
ignore, and neither counted it, changed its exit code or changed its verdict. So the defect this
job fixes is three things at once — the count, the exit code and the door — and a change that only
made the sentence louder would have fixed the part that already worked.

**What the two documents mean differs by 4096×, not 4000×.** 1 TiB is 1 099 511 627 776 bytes and
the compiled default is 268 435 456, so the documents `--check` blessed with one verdict differ by
2^40 / 2^28 = 4096. For the cap the ratio is 17 179 869 184 (2^40 / 64), and the two prose surfaces
that described that ceiling got its magnitude wrong in both directions — one counted sockets in
millions, the other in multiples of a deployment. 1 099 511 627 776 is 1.09 **trillion**, in either
unit.

**Why one bad number takes the whole file.** `load` validates the merged document and, on any issue
at all, substitutes the shipped defaults for the whole document and sets `used_defaults`:
"    if !issues.is_empty() {"
(`crates/nostream-config/src/load.rs:418`) returns the substitution at
`crates/nostream-config/src/load.rs:419-425`. An `Issue` therefore does not drop one key; it
discards the operator's file. That is the cost every rule in this validator already pays, and it is
the reason each message has to be self-sufficient.

## What "not used" means at both ends

**A value the relay does not use is a value the operator must be told about.** Applied to these two
keys, that gives four refusals and no fifth: zero at each end, and the ceiling at each end. Both are
the same word — *not used* — and both are an `Issue`, because after this job the validator is the
only reporter that exists.

The four lines, verbatim from this branch's tree, each quoted above its citation as
`docs/rewrite/decisions/0008-frame-memory-budget.md:392-399` quotes the two zero rules:

"            \"frameMemoryBudgetBytes must be greater than 0\","
(`crates/nostream-config/src/validate.rs:129`)

"                \"the file states {number}; frameMemoryBudgetBytes must be at most 1099511627776\""
(`crates/nostream-config/src/validate.rs:142`)

"            \"maxConnectionsPerIp must be greater than 0\","
(`crates/nostream-config/src/validate.rs:153`)

"            format!(\"the file states {number}; maxConnectionsPerIp must be at most 131072\"),"
(`crates/nostream-config/src/validate.rs:164`)

**The ceiling message carries three facts, because the substitution leaves nothing else.** `Issue`
renders as `{path}: {message}` (`crates/nostream-config/src/issue.rs:27-30`), so the path is the
prefix, and the message states the value the file carries beside the ceiling it crossed. The
operator reads

```
network.frameMemoryBudgetBytes: the file states 1099511627777; frameMemoryBudgetBytes must be at most 1099511627776
```

and knows which key, which number, and what the largest accepted number is — without opening a
document whose other keys were just discarded. A generic line would be indistinguishable from the
file being unreadable, and the two faults have different fixes. The ceiling is a literal in the
source so this record can quote it and an operator reading the code sees the number; the stated
value is interpolated because it is the operator's, and the whole-issue-vector tests in
`crates/nostream-config/tests/validator.rs` keep the literal and the constant in step.

**Only a JSON number takes either rule**, so a wrong type stays the shape walk's single finding —
"    if let Some(budget @ Value::Number(number)) =" (`crates/nostream-config/src/validate.rs:135`)
and the same guard over the cap (`crates/nostream-config/src/validate.rs:158`) — which is the
guarantee #996 wrote for the floor. The rules run in the validator's fixed order: budget zero,
budget ceiling, cap zero, cap ceiling, then the adaptive-pow rules.

## Why the two ceilings are two numbers

**The budget's ceiling is 1 TiB, and it exists for the arithmetic.** `FrameBudget::admit` guards
with `saturating_sub` —
"            if bytes > self.limit_bytes.saturating_sub(accounted) {"
(`crates/nostream-relay/src/sink.rs:158`) — and then adds unchecked —
"                accounted + bytes," (`crates/nostream-relay/src/sink.rs:164`) — so a budget at
`usize::MAX` makes the guard untrippable and the add overflow. 1 099 511 627 776 is 0.000006 % of
`usize::MAX` (18 446 744 073 709 551 615), 16 777 215× of headroom:
"pub const MAX_FRAME_MEMORY_BUDGET_BYTES: u64 = 1024 * 1024 * 1024 * 1024;"
(`crates/nostream-config/src/validate.rs:32`).

**1 TiB is the published valve, not a tight bound, and this record says so.** Any value below about
18.4 EB satisfies the overflow argument, so the number is not derived from the arithmetic: it is
chosen to be obviously outside any deployment while leaving the add room. What it buys is that a
stray digit cannot reach the arithmetic; what it does not claim is that 1 TiB of queued frames is a
figure a host should aim at.

**The cap's ceiling is computed, not chosen.** 131 072 = 1 099 511 627 776 ÷ 8 388 608, and in
exponents **2^40 / 2^23 = 2^17 = 131 072 exactly**: the sockets whose full per-socket queues exhaust
the budget's own ceiling. That is an absolute maximum the budget's ceiling implies, not a
preference someone argued for, so the constant is that division rather than the product:
"pub const MAX_CONNECTIONS_PER_IP: u64 = MAX_FRAME_MEMORY_BUDGET_BYTES / FRAME_QUEUE_BYTES;"
(`crates/nostream-config/src/validate.rs:40`), with the divisor repeated beside it
(`crates/nostream-config/src/validate.rs:25`) because `nostream-config` cannot depend on
`nostream-relay`, where the same 8 MiB is a default:
"            frame_queue_bytes: 8 * 1024 * 1024," (`crates/nostream-relay/src/relay.rs:85`).

**The cap is reachable, and it bounds queued bytes rather than resident memory.** The shipped
attempt windows admit 12 connections a second and 48 a minute from one address
(`resources/default-settings.yaml:300-304`), so 131 072 sockets is about three hours of a single
address's full allowance — unusual, and not impossible. What the ceiling bounds is the queued
payload one address may hold at the budget's ceiling, 131 072 × 8 MiB = 1 TiB. It is not a
resident-memory figure: the accounting it lands in is outbound payload, not RSS
(`docs/rewrite/decisions/0008-frame-memory-budget.md:54-66`).

## Where the arithmetic runs out

No per-socket cost and no descriptor limit exists in this tree —
`grep -rn "rlimit\|NOFILE\|file descriptor" crates docs/rewrite` prints nothing — so the cap's
ceiling cannot be argued from a host's descriptor table, and this record does not pretend it was.
The number is what the relay's own units produce: the sockets whose queues exhaust the budget's
ceiling. A host whose `RLIMIT_NOFILE` is below 131 072 will bind first; that is a deployment fact
the relay neither reads nor reports, and measuring it is not this job's.

## What the operator sees

Each of these was measured on this branch after the change:

- A document with an over-ceiling value is **discarded whole** by `load`
  (`crates/nostream-config/src/load.rs:419-425`); the relay serves the shipped defaults, including
  the operator's other keys.
- At start-up stderr carries one `{path}: {message}` line per issue
  (`crates/nostreamd/src/settings_gate.rs:32`) and then
  `nostreamd: continuing on the shipped defaults (N issue(s) in the user settings)`
  (`crates/nostreamd/src/settings_gate.rs:41`).
- `nostreamd --check` exits 2, prints no `settings valid` line, and ends stderr with
  `settings invalid: N issues` (`crates/nostreamd/src/main.rs:43`).
- `nostream-cli config validate` exits 2 with the issue lines then the same verdict
  (`crates/nostream-cli/src/config.rs:78`).
- A value **at** the ceiling is accepted by both doors, logged by neither, and is the value the
  relay runs with.

The valid verdict lost its suffix with the report and is exactly `settings valid: 0 issues`
(`crates/nostream-cli/src/config.rs:72`).

## What `from_settings` no longer does

The constructor keeps no range rule: `None` means the compiled default, and every present value is
taken as written —
"    pub fn from_settings(settings: &Settings) -> Self {"
(`crates/nostream-relay/src/relay.rs:116`) reading the budget leaf from
"        if let Some(bytes) = settings.network.frame_memory_budget_bytes {"
(`crates/nostream-relay/src/relay.rs:119`) and the cap through the two optional levels the typed
schema forces (`crates/nostream-relay/src/relay.rs:123-129`).

**There is no defensive copy of the ceiling**: no `assert!`, no `debug_assert!`, no silent branch.
A panic whose only trigger is a caller that built `Settings` without the validator is a second gate
with no test that can reach it, and this repository's rule is that a finding is an `Issue`, not an
error (`CLAUDE.md:129-132`). The precondition is documented on the constructor instead, and
`load` is the single production caller.

**What went with it.** `MAX_SETTING_BOUND`, `in_range`, `BoundRefusal`, `refused_bounds`,
`bound_refusal`, `refusal_message` and `warn_refused_bound`, and with them the
`nostream-cli` → `nostream-relay` edge that existed only to reach the last two. `cargo tree -p
nostream-cli --edges normal | grep -c nostream-relay` prints `0`; it printed `1` before this job.

## The guided catalogue

Both entries carry the validator's own ceiling instead of the capture's maximum safe integer, as
one new variant — "    SafeNonNegativeIntegerAtMost(u64),"
(`crates/nostream-config/src/guided.rs:29`) — used with the constants rather than a number repeated
beside them: `SafeNonNegativeIntegerAtMost(MAX_FRAME_MEMORY_BUDGET_BYTES)`
(`crates/nostream-config/src/guided.rs:238`) and `SafeNonNegativeIntegerAtMost(MAX_CONNECTIONS_PER_IP)`
(`crates/nostream-config/src/guided.rs:301`). Its message is formatted from the payload —
"        Ok(_) | Err(_) => Some(format!(\"Value must be at most {ceiling}\")),"
(`crates/nostream-config/src/guided.rs:104`) — because one variant serves both ceilings, which is
also why `validate` returns `Option<String>` (`crates/nostream-config/src/guided.rs:34`). The two
entries serialize as `{"safe_non_negative_integer_at_most": <ceiling>}`; the other fourteen keep the
plain string. **The `0` gap stays open**: the editor still accepts a `0` the document validator
refuses, which is the gap `docs/rewrite/decisions/0008-frame-memory-budget.md:602-623` records, and this job adds the
ceiling only.

## What this does not decide

- **What a socket costs.** No measurement and no descriptor limit exists in the tree, so the cap's
  reachability rests on the attempt limiter rather than on a host's capacity.
- **The 8 MiB divisor.** `FRAME_QUEUE_BYTES` is repeated in `nostream-config`
  (`crates/nostream-config/src/validate.rs:25`) rather than shared, because the alternative is a
  relay default with a second home or a dependency edge this job deletes. No test asserts 8 388 608
  as a default, so nothing catches the two drifting; the constant's doc says where it comes from.
- **The TypeScript application.** `src/` knows neither key, so no parity case can encode either
  ceiling and this record is their only specification.
- **The whole-document substitution.** That `load` discards the file for one issue is `load`'s rule
  and predates this job; this record states the cost rather than changing it.
- **A per-key fallback, or a report that is not an issue.** Both were deleted here and neither
  returns under another name.

## The answer

The two bounds now have both ends in one place: `validate_document` refuses a stated zero and a
stated value above the key's own ceiling, by name, with the value and the ceiling in the sentence.
The relay runs whatever the validator accepted, both doors report the same issues with the same exit
code, and the two ceilings are two numbers because the two keys mean two things — 1 TiB of queued
payload against the unchecked add, and 2^40 / 2^23 = 2^17 = 131 072 sockets against the budget's own
ceiling.
