# KPIs: what is measured, from where, and what fires

Six numbers, three about the rewrite and three about the machine building it. Each one names
the artifact it is read from and the threshold that makes someone act. Nothing here is a
dashboard: a figure with no decision attached is a report, and a check that cannot fail is not
a check.

**The rules this document holds itself to.**

1. **A KPI names a command.** A number that needs a person to remember how it was produced
   stops being produced.
2. **A threshold comes from the recorded distribution, not from a wish.** Where the history is
   too thin to give one, the KPI is not shipped — an invented target is worse than none,
   because it gets quoted.
3. **A KPI is measured from an artifact the work already writes**, so measuring costs nothing
   per job.
4. **A KPI that cannot fail is not a KPI.** It is checked against the base in §7 before it is
   adopted.

## 1. NIP parity — the cutover gate

**Status: not measurable yet, and the obvious measurements are wrong.** Both were tried on
`rewrite/main` at the time of writing, and both are recorded here so they are not tried again.

- **Stub count.** `grep -c 'unimplemented!\|todo!('` across all 282 `.rs` files (84,757 lines)
  answers **0**. This repository does not stub unimplemented behaviour, so the metric would
  read zero forever and a KPI that always passes is decoration.
- **Module presence.** `crates/*/src/nipNN.rs` exists for 12 NIPs — `03 04 05 25 42 43 44 56 65
  66 77 98` — while `package.json` advertises 25 (`1 2 3 4 9 11 12 13 14 15 16 17 20 22 25 28
  33 40 42 43 44 45 50 65 77`). The overlap is 8, and four modules (`05 56 66 98`) are helpers
  for NIPs that are not advertised. Behaviour for the rest is implemented outside a per-NIP
  module, so module presence measures file layout, not coverage.

**What to build instead: a per-NIP ledger keyed to evidence.** One row per advertised NIP, and
the row's status is set by what exists, not by what is claimed:

| column | what it holds |
|---|---|
| `nip` | the number, from `package.json`'s `supported_nips` at the v3 grading tip |
| `oracle` | the path of the TypeScript test or feature file that pins the behaviour today, from `docs/rewrite/nip-parity.md`, or `none` where the audit found no test |
| `rust test` | the path of the Rust test that proves the same behaviour, or `none` |
| `teeth` | the inversion that makes that test fail — the same obligation `build.md` rows carry |
| `status` | `ported` when a Rust test proves it and the inversion was recorded, `partial`, or `open` |

The KPI is `ported / advertised`. It fires in two places: a NIP moving backwards, and the
cutover requiring 25/25 `ported`. The floor is not a percentage chosen for comfort — it is the
cutover's own precondition, which is what makes it a gate rather than a score.

## 2. Store performance — did the rewrite earn its price

**Base: recorded.** `docs/rewrite/benchmarks/lmdb-50k-seed7.json`, from `cargo run --release -p
nostream-storage --example bench`, with the host, the load average per repeat and the workload
constants echoed into the artifact. `docs/rewrite/benchmarks.md` carries the table.

**What fires now:** a regression against that artifact on the same workload, beyond the spread
the three repeats already show. The comparison is against the recorded run, not against a
number from memory.

**What cannot fire yet:** the multiple against v3. The Rust/Postgres and TypeScript/Postgres
columns are absent because the host has no database, and #1132 owns them. Until it lands, a
"faster than v3" claim has no artifact behind it, and this document does not carry one.

## 3. Migration safety — may the cutover run unattended

**Base: recorded.** Job `031-held-descriptor` ran 300 randomised swap rounds against the
descriptor pin: 21 pinned, 0 opened the wrong directory, 279 refused. The window it narrowed is
named in the record rather than claimed closed.

**What fires:** any round that opens a directory the pin did not hold, on any release. The
threshold is zero and it is not negotiable — this is the check that decides whether a data
migration may run without a person watching.

## 4. Review share of job spend — is the factory paying to verify more than to build

**Base: measured over 27 recorded jobs** in the factory history (`.factory/jobs/*/runs.jsonl`,
`t: "spans"` lines), **$103.16 in total**. The ratio is review cost (lenses plus approver)
divided by build cost, and it has a wide spread:

| job | rounds | ratio |
|---|---|---|
| `001-nip-audit` | 4 | 2.18 |
| `027-expiry-clock` | 1 | 2.58 |
| `019-refusal-exhaustive` | 2 | 2.85 |
| `026-nwc-req-before-event` | 1 | 4.14 |
| `017-frame-budget-settings` (median) | 4 | 1.56 |
| `031-held-descriptor` | 2 | 1.16 |

**Median 1.5 over 24 jobs that have a build session.** The useful reading is that a review
costing more than the build it reviews is *normal here*, not exceptional — so a target of
"well under 1" would be an aspiration with no history behind it.

**What fires:** a job whose ratio exceeds 2.0, at which point the round composition is read
from `runs.jsonl` — which lenses ran, and whether a confirmation round re-read a lens that had
already passed. `031`'s round 2 spent $0.138 on a lens that had **PASSED** in round 1 and
skipped the scoper; that is the shape the threshold is looking for.

**Caveat the number carries:** the ratio is unstable below roughly $1 of total spend, where a
small build divides into a fixed review. Report the share only for jobs above that floor, or
the KPI will reward making builds expensive.

## 5. Rounds per merged job — is the spec buying the right amount

**Base: measured over the same 27 jobs.** Median 3, maximum 15, distribution
`1×4 2×4 3×5 4×6 5×1 6×1 7×1 8×1 11×1 15×1`.

**What fires:** above 5 rounds on a job whose scope is one crate. A job that needs a sixth
round is a spec defect showing up late, and the fix belongs in recon and the spec — the same
conclusion `cameri/skills#286` reaches about citations, one level up.

## 6. Escapes — is the gate real

**Base: recorded per job** in the `outcome` and `regret` lines of `runs.jsonl`. An escape is a
defect found after approval: by the hosted reader on the pull request, by a person, or by the
next job working in the same file.

**What fires:** any escape. The count is not a rate to reduce gradually — the approver's whole
purpose is that the number is zero, and a single escape names the lens or the criterion that
should have caught it.

## 7. What is deliberately not a KPI

| candidate | why not |
|---|---|
| stub count | measured 0 across 282 files; cannot fail (§1) |
| test count | 1,390 `#[test]`/`#[tokio::test]` attributes today; the number rises with tests that prove nothing |
| files changed, diff size | rewards motion; `031` closed a real window in 4 files and a larger diff would have scored better |
| token spend | a proxy for cost, not for value; job cost is already recorded against a bracket |
| PR count, commit count | output, not distance |

## 8. How each number is produced

| KPI | artifact | command |
|---|---|---|
| NIP parity | `docs/rewrite/nip-porting.md` (to build) | a script over the ledger; `grep -c` over `crates/**/*.rs` for the stub check this document retires |
| performance | `docs/rewrite/benchmarks/lmdb-50k-seed7.json` | `cargo run --release -p nostream-storage --example bench -- --backend lmdb --events 50000 --seed 7 --repeats 3 --verify` |
| migration safety | the job record's `round-*/` and `build.md` | the randomized-round harness the job added, run per release |
| review share, rounds | `.factory/jobs/*/runs.jsonl` | sum `spans.sessions[].cost` by agent: `reviewer` and `approver` against `builder` |
| escapes | `.factory/jobs/*/runs.jsonl` | `outcome` and `regret` lines |

**Order of work.** The parity ledger is the only one of the six that needs building before it
can report; the other five are read from records that already exist. Until the ledger exists,
the honest statement about parity is the one in §1: it is unknown, and the two cheap proxies
for it are wrong.
