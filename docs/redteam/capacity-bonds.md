> Taken from the Transit Fabric source repository at commit 91be12e (91be12ef98b775c7f045124e6b8c686c15439650, main), file docs/specs/capacity-bonds.md. Links into the private source tree are shown as plain text.

# Spec: capacity bonds

Status: draft · Implemented in `crates/bwos-core/src/scoring/mod.rs` · See ADR-0006

Bittensor has no native slashing for subnet-defined behavior. v0 therefore uses a **reputation bond**: the operator's future emissions are what's at risk. v1 may add an escrow contract on Bittensor EVM (OQ-2).

## Declaration

Operators commit a capacity declaration on chain (hash) and serve the object:

```json
{"v":0,"hotkey":"<ss58>","netuid":<int>,"window_from":<int>,"nodes":[{"node":"<pubkey hex>","mbps":3000,"cost_ppm":800000}],"hotkey_sig":"<hex>"}
```

A declaration has `1..=MAX_DECLARATION_NODES` entries (`MAX_DECLARATION_NODES = 1024`), sorted and unique by `node`, and is signed with `hotkey_sig`. Each node entry may optionally declare `cost_ppm`, which must be in `[MIN_COST_PPM = 200_000, MAX_COST_PPM = 2_000_000]`; the default is `1_000_000` ppm = `1.00x` (`ADR-0018`). An operator's declared `cost_ppm` sets its base hop transit cost for Mechanism 1 solvers AND scales its Mechanism 0 billable volume `V_bill` by `cost_ppm / 1_000_000`, so discounting `cost_ppm` attracts least-cost and `low_latency_hd` routes in exchange for a proportional per-byte rate discount.

Changes are judged field by field (ADR-0018 §3, `can_update_declaration`, TV-16):

- **Lowering a node's `mbps` is free.** It applies from the next window, so an operator can always lower capacity to stay out of the overclaim haircut.
- **Node additions take effect mid-epoch.** A node first declared mid-epoch gets its declared `mbps` at once, and its declared `cost_ppm` capped at `1_000_000` (1.0x).
- **Everything else waits for the next epoch boundary** (the next multiple of `CAP_CHANGE_WINDOWS`, default 24, below). That covers any change to `cost_ppm`, up or down, any `mbps` raise, and node removals or moves to another UID. A declaration that lowers `mbps` and also changes `cost_ppm` gets the `mbps` decrease now; the cost change waits for the next epoch boundary.
- Operator tooling (`can_update_declaration`) requires a new declaration's `window_from` to be strictly greater than the previous one's. **Scoring does not enforce it, because epochs make it unnecessary.** Validators date a declaration by the chain read that first names it, not by `window_from` (below), and a node's state only changes at fixed epoch boundaries. A backdated or replayed `window_from` therefore changes nothing. Scoring only ignores a declaration whose `window_from` is after the read window.

Whether to allow immediate cost decreases that restart the raise clock is OQ-54; the current answer is no, because ADR-0018 stands.

### Where the cooldown is enforced (`[T56]`, PB-31)

`validator::run_tempo` never scores the raw `TempoInput::declarations`. It scores each node's declaration as it stands in the current **cooldown epoch**: the windows `[k * CAP_CHANGE_WINDOWS, (k + 1) * CAP_CHANGE_WINDOWS)` (`validator::DeclarationEpoch`, `tempo_declaration_epoch`).

**What one read counts** (`validator::node_declarations`). A declaration counts from the window after the chain commitment that names it. The validator reads the UID's on-chain commitment at block `w * tempo - 1`, the last block before window `w`, and the declaration it names counts from window `w`. Of that read, an entry counts only if all of these hold:

- the declaration is valid and for this `netuid`;
- its `window_from <= w`;
- it is signed by the UID's metagraph hotkey at that read, and the signature verifies (`CapacityDeclaration::verify`: sr25519 for an SS58 hotkey, ed25519 for a hex one; a missing or all-zero `hotkey_sig` fails, audit S4, `scoring.md` §Capacity declarations are verified);
- the node is bound to that UID at that read.

A declaration signed by any other hotkey, or an entry for a node bound to another UID, is ignored. It neither changes nor resets anything, and nobody can set a rival node's cost.

**Per-node epoch state.** State is kept per node, whichever UID the node is bound to:

- **At the epoch's first window,** each declared node takes the read's `mbps` and `cost_ppm`.
- **Later in the epoch,** a known node keeps its epoch `cost_ppm`, and its `mbps` becomes the lower of its current value and the read's. A node first declared mid-epoch gets its declared `mbps` at once, and its declared `cost_ppm` capped at the default `1_000_000`. So a fresh node key can discount at once but cannot price above the default before the next epoch; after that its cost is held like any other node's.
- **A node absent from a read keeps its state.** That covers a UID that withdrew its declaration, a declaration signed by the wrong hotkey, and a node moved to another UID. Such a node is still billed, and its links still priced, at its carried `cost_ppm` and `mbps` until the epoch ends.
- **At the next epoch's first window,** nothing is carried. An undeclared node then has no declared capacity and the default cost.

So every `cost_ppm` change and every `mbps` raise takes effect at the next epoch boundary: changes in force are at least `CAP_CHANGE_WINDOWS` windows apart. A raise committed just before a boundary applies sooner than 24 windows after the previous change committed, but never sooner than 24 windows after the previous change took effect.

**Billing at the solved-on cost** (`validator::billing_cost_ppm`, run_tempo step 5). The production table for window `W` was solved on the snapshot built at `W - 1`, whose links were priced with each node's epoch cost at `W - 1` (`TempoOutcome::next_snapshot_costs`, passed back with the snapshot as `TempoInput::current_snapshot_costs`) (pass `Some` even when the map is empty; `None` means billing at the epoch cost). Mechanism 0 bills each node's paid and free bytes at

```
min(epoch cost at W, cost in the solved-on snapshot)    (a node missing from the solved-on costs: 1_000_000)
```

So routes chosen at an old price are never billed at a higher one. That includes a raise at an epoch boundary, a withdrawal at a boundary, and a re-keyed node (sims `epoch_boundary_raise`: 0 mis-priced windows; `rekey_mid_epoch`: at most 1.0x the solved-on cost). A decrease is billed at once. When `current_snapshot_costs` is `None` (not supplied), the epoch cost is billed.

**Determinism.** The epoch state is a pure function of the chain reads from the epoch's first window, at most `CAP_CHANGE_WINDOWS` reads (the documented lookback bound). It has no other history, so every validator agrees whatever its local history:

- A validator that scored window `W - 1` passes its state forward: `TempoOutcome::declaration_epoch` goes into the next tempo's `TempoInput::declaration_epoch`. `bwos-validator --state-dir` caches it in `accepted-declarations.json`. The cache holds the state before and after the last tempo, so re-running a window after a restart is idempotent. The state stays out of the published outcome JSON.
- The cache never fails a tempo. If it can't be saved (for example, key churn pushed the epoch past `MAX_EPOCH_NODES` = 196,608 nodes), the validator warns, scores the window anyway, and the next tempo rebuilds the epoch from the reads.
- Any other validator passes the epoch's earlier reads as `TempoInput::declaration_reads` and gets the same state. That covers a validator with no state, one restarting after downtime, and one whose cache is from another epoch.
- A validator with neither starts the epoch at the current read. It can then disagree with its peers until the epoch ends, so the live validator loop MUST fill `declaration_reads` after any gap (PB-14). `bwos-validator` warns when it has to fall back this way.

Since Task 19b the declaration is named through the commitment manifest (ADR-0036): the manifest's `capacity-declaration` slot holds its hash, read at block `w * tempo - 1` from manifests that cover `w` (`identity.md` §Commitment manifest). The domain is active from window 0 on `local` and `test` only; its mainnet activation is OQ-45. A UID's manifest lapses after two windows (`covers`), and its declaration with it, so operators re-commit at least every other window (OQ-210).

## Verified capacity per node

```
measured  = lower median of achieved Mbps across capacity tests in the last CAP_PENALTY_WINDOWS windows
peak      = max(declared, declared Mbps of this node in each of the last CAP_PENALTY_WINDOWS windows)
if no tests yet:                verified = 0
elif measured >= declared:      verified = declared
elif measured >= declared * (1e6 - CAP_TOLERANCE_PPM)/1e6:
                                verified = measured
else:                           verified = measured * (1e6 - OVERCLAIM_PENALTY_PPM)/1e6
if measured < peak * (1e6 - CAP_TOLERANCE_PPM)/1e6:
                                verified = min(verified, measured * (1e6 - OVERCLAIM_PENALTY_PPM)/1e6)
```

**Team tests and the ramp (ADR-0039, Phase B Task 4Dc).** Once team tests replace single-agent tests, the rule above is replaced by the one below. A team test pushes the ramped rate, capped at the team's budgets (`measurement.md` §Team capacity tests), not the declaration. So comparing with the declaration would haircut every honest node while its ramp climbs, and every node faster than the team can push. Each test is therefore recorded as `(team_t, pushed_t, ratio_t)`, from `measurement.md`'s combining rule:

```
S_t         = Σ rate_i over the whole scheduled team, revealed or not   (cohort member n: Σ_i rate_{i,n})
pushed_t    = the rate test t is judged on:
                team test:                min(declared at t, S_t)
                cohort member n:          min(declared_n at t, S_t)
                legacy single-agent test: the peak declaration over the span (below)
j           = the lower-median revealed member by c_i / rate_i, c_i = min(m_i, rate_i), ties to the lower hotkey
median_t    = c_j * S_t / rate_j
measured_t  = min(Σ c_i over the revealed members, median_t)
team_t      = min(declared, measured_t + bg_t)  after Task 12b
            = min(declared, measured_t)         before Task 12b (bg_t lifts only the ratio)
              in kbps, floored to whole Mbps once
ratio_t     = team test:                min(1e6, (c_j * S_t + bg_t * rate_j) * 1e6 / (rate_j * pushed_t))
                                        none with fewer than CAP_TEAM_MIN_VALIDATORS revealed members
              legacy single-agent test: min(1e6, achieved_t * 1e6 / pushed_t)
              (a test with fewer than two revealed members, or with pushed_t = 0, isn't a sample)
measured    = lower median of team_t (or achieved_t) over the tests in the last CAP_PENALTY_WINDOWS windows,
              leaving out a budget-starved cohort member's tests (ratio only)
ratio       = lower median of ratio_t over the same tests that have one
if no tests yet:                                       verified = 0
elif no test has a ratio_t, or ratio >= 1e6 - CAP_TOLERANCE_PPM:
                                                       verified = min(declared, measured)
else:                                                  verified = min(declared, measured) * (1e6 - OVERCLAIM_PENALTY_PPM) / 1e6
```

All of it is `u128` integer arithmetic with floor division, and lower medians sort ascending and take index `(n-1)/2`. `ratio_t` is one division with no intermediate floor, so an honest node gets exactly `1e6` (round 5 A; worked example in `measurement.md` §Team capacity tests: `C = 1000`, four members at 275).

**In code (Task 4Dc, fix round 1).** `validator::team_verified_capacity` is this rule over a node's `validator::CapTestRecord`s (`team`, `pushed`, `ratio_ppm`, `ratio_only`). `run_tempo` uses it in team mode (`TempoInput.block_hashes` supplied **and** endpoint dedupe on: team mode MUST NOT run while the endpoint stake trigger fails, Task 4Dc fix round 5, T124), through `validator::team_verified_capacities` (review R1):
- **The span holds both kinds of test.** A node's records are its team tests (node tests and team cohort members' tests) in the last `CAP_PENALTY_WINDOWS` entries of `cap_team_history` plus this window's `TempoOutcome.cap_team_tests`, **and** its single-agent `cap:` tests in the last `CAP_PENALTY_WINDOWS` entries of `cap_test_history` (this window's included), each a legacy record (`CapTestRecord::legacy`) judged against the node's peak declaration over the span. The two histories aren't index-aligned, so the peak is the conservative declaration.
- **No freeze, no fallback.** In team mode both histories gain an entry every window, empty or not, so old single-agent tests age out after `CAP_PENALTY_WINDOWS` windows. A node with no record in the span has no tests yet and gets `0`; nothing falls back to the single-agent rule.
- **Budget-starved cohort members (red team F8).** A cohort member whose scheduled rates fall short of its `R(n)` is recorded `ratio_only`: its `ratio_t` counts, its `team_t` doesn't enter `measured`.
- **Units (OQ-91, closed).** Rates are kbps and `m_i` is exact from the ack, so an honest small node is measured to within 1% of its goodput from 20 Mbps up (sim `small_declared_honest`). Only the final floor to whole Mbps remains, a documented residual (red team N7): about 0.90x of goodput at 10 Mbps, 0.95x at 20 Mbps, 0.97-0.99x at 30-50 Mbps.

- **Headroom isn't an overclaim (round 4 RR1, RT1).** Members stream about `1.1 × declared`, but `ratio_t` divides by `pushed_t = min(declared, sent_t)` while `median_t` scales by all of `sent_t`. A node that carries its declaration has `ratio_t = 1e6`. Under-declaring to `C / 1.1` to dodge the headroom earns `C / 1.1`, less than declaring `C` (sim `headroom_underdeclarer`, at most 1.0x).
- **A climbing ramp isn't an overclaim.** Neither is a node faster than the team can push. A declaration above what was pushed is not an overclaim while the ramp is still climbing, or when the team's budgets cap the rate (red team RT2): a node that delivers what was pushed has `ratio_t = 1e6`.
- **Small reveal sets don't judge (round 4 RT5, round 5 D; red team F9).** A test with fewer than `CAP_TEAM_MIN_VALIDATORS` revealed members counts in `measured`, still capped by the median term at two members, but has no `ratio_t`, so two members never decide a haircut. A test with one revealed member isn't a sample.
- **A missing batch doesn't haircut (OQ-93, closed in Task 4Dc fix round 1).** A member that streamed but revealed nothing stays in `S_t`, so the node is judged on everything it was sent: an honest node is never haircut for it, near its declaration too (97%: kept 0.75x, sim `withholding_near_declaration`), and withholding never lifts a node above an honest declarer of its real capacity (sim `void_by_withholding`).
- **Over-reporting members are capped (red team F1).** `measured_t` sums `c_i = min(m_i, rate_i)`, so a colluder's inflated result adds no more than its own share; one colluder is bounded at `(k-1)/(k-2)` (`measurement.md` §Team capacity tests, "Residuals").
- **Griefing members can't force a haircut (red team RT3).** `ratio_t` comes from the lower median of per-member ratios, never from `Σ`. A minority of members that zero or omit their samples can't force a haircut, and can't lift one. One griefer on a team of `k` cuts the victim's `measured_t` to no less than `(k−1)/k`: 0.75x at `k = 4`, 0.67x at `k = 3` (sim `sample_omission_griefer`).
- **Background counts.** Background counts in `ratio_t`, so real traffic never looks like an overclaim. Before Task 12b it is the window average and lifts only the ratio, never `team_t`. After Task 12b it is measured from receipts bracketing the test and counts in both (`measurement.md` §Background traffic).
- **What still triggers the haircut.** It applies only when the node fails to carry what was actually pushed in at least half of its recent tests.
- **Lowering the declaration after failing.**
  - It doesn't change past `ratio_t`, so the haircut lasts until passing re-tests are half of the rolling history: about 5 tests, about 12 windows at the default test period.
  - `CAP_PENALTY_WINDOWS` stays at 24 (red team RT7). The peak-declaration rule kept the haircut for the full 24, so the haircut is shorter now. But a dodger still earns no more than an honest declarer, because it carries the haircut while its failed tests are the majority, and it can't be credited above what it carries. T27's bound is restated as dodger ≤ honest, and Task 4Dc re-runs `declaration_dodger`.
- **Legacy single-agent tests are close to the old rule, not the same (review RR nit).** For legacy tests `pushed_t` is the declaration at the time. The haircut test is then "the lower median of per-test `achieved / declared_at_test` is below tolerance". The old rule compared the median achieved rate with the current and the peak declaration. The two agree while the declaration is constant. They differ when the declaration changes, where the per-test form judges each test against the declaration it was run under.

**The single-agent rule's peak check.** The overclaim haircut is checked against the **peak** declaration over the rolling window (`[C-04]`, `RT2-4`), so lowering a declaration after a failed test does not lift the haircut early: it lasts until the overclaimed declaration is more than `CAP_PENALTY_WINDOWS` windows old. Validators keep one `node -> declared Mbps` map per window (`TempoOutcome::declared_capacities`, passed back as `TempoInput::declaration_history`; `validator::tempo_verified_capacities`). The same rule applies to an honest downgrade: an operator that removes capacity should lower its declaration at least `CAP_PENALTY_WINDOWS` windows before the measured capacity falls below `peak * (1 - CAP_TOLERANCE_PPM)`.

Only capacity tests acknowledged by the node under test count (`measurement.md`, `cap-test-ack`, `RT2-3`): a `cap:<node>` sample without a valid node-signed ack for that validator and window is scored as a failed (`0` Mbps) test, so several node keys cannot borrow one operator's real sink.

Failed or unreachable capacity tests are recorded as `0` Mbps samples (`measurement.md`), so a node that goes dark loses verified capacity once failures reach the lower median. Verified capacity also bounds Mechanism 0 usage credit: a node is never credited more bytes per window than `verified_mbps * 125_000 * WINDOW_BLOCKS * BLOCK_SECONDS` (`scoring.md`, `[SCR-11]`).

**Endpoint dedupe (`[T24]`).** For scoring, verified capacity is pooled per dedupe group (nodes whose validator-observed public endpoint shares an IPv4 /24, or for IPv6-only endpoints an IPv6 /32 (tunnel-broker /48s share the broker's /32), across UIDs; one group per node, no transitive merging): the group is credited at most its largest single verified capacity, split pro rata among its members (`scoring.md` §Endpoint dedupe, `scoring::dedupe_diverse_node_capacities`). N node keys behind one pipe that pass N sequential tests (OQ-18) therefore earn one pipe's capacity term. ASN alone does not pool capacity.

**Cohort credit (`[T28]`, OQ-18, OQ-20).** Let `P` be the group's members with verified capacity `> 0`. Every cohort `C` (`2..=MAX_CAP_COHORT_NODES` nodes, `measurement.md` §Cohort capacity tests) whose members are all in `P` is a candidate, and the group is credited

```
pool = max(largest single verified, max over candidates C of min(cohort_verified(C), Σ_{n in C} verified(n)))
```

instead of the largest single verified capacity, where `cohort_verified(C)` is the lower median of that exact membership's aggregated cohort throughput (`Σ acked bytes * 8 / common span`) over the last `CAP_COHORT_FRESH_ENTRIES` (8) cohort-history entries; a cohort not re-tested within them has no credit. **In team mode a cohort counts toward its group's credit only with at least `CAP_COHORT_TEAM_MIN_SAMPLES` (2) samples in that span** (Task 4Dc fix round 5, red team B1(b), T125); with fewer it has no credit, so it can't raise the group above its largest single. A cohort test started short at its last chance (`measurement.md` §Team capacity tests) records its aggregate capped at `Σ max(verified_prev(n), CAP_RAMP_FLOOR_MBPS)` over its members (red team L3, B1(a)). A cohort falls due about once per 2.5 windows, so with no attacker about 4% of cohort-windows have lapsed credit, about 15% in team mode with two samples required, and the group is paid as its largest member for them (Task 4Dc red team L1, T116(a), T125, OQ-95). The team schedule's round-robin weight is this pooled figure, with a node that has no endpoint weighing 0 and, while dedupe is off, each UID's lower-median node (`validator::schedule_weights`, T114, T124). The pool is split pro rata as above (zero-capacity members get `0`). Candidates are never summed: disjoint chunks of a group above 16 nodes, or cohorts tested at different times, could have been served one after another by one pipe. Honest operators with separate uplinks in one /24 (or one provider IPv6 /32) are therefore paid up to what validators measured at the same time (sim `colocated_cohort_honest`: 1.000x, 0.333x with sequential tests only), while N keys on one pipe still earn one pipe, whether tested sequentially or in a cohort (sim `sequential_key_replay`: 1.000x / 0.998x). A cohort containing a node outside `P` does not count. A zero-capacity key bound into the /24, a key rotated every window, or a new member does not void an earlier cohort result (red-team Pass-7 `cohort_burner_griefer`: attacker 1.256x and co-located victims 0.573x before, 1.000x / 1.000x after); a 17-node group keeps its best 16-node chunk. The group's credit can never exceed the verified sum of a cohort's members or what that cohort test measured.

`CAP_TOLERANCE_PPM` (10%) protects honest operators from the `OVERCLAIM_PENALTY_PPM` (20%) haircut during minor measurement jitter without ever crediting unmeasured phantom capacity above `measured`. Over-declaring is strictly worse than or at best equal to declaring honestly, with one residual after Task 12b: a node that stalls real routed traffic during its tests and carries it just outside them can gain up to about 1.11x through credited background (about 1.48x estimated with one colluding team member), as set out below and in `measurement.md` §Background traffic.

**Why declaring honestly stays the best strategy under the ramp (ADR-0039).** Compare the alternatives with declaring your real capacity `C` from day one:
- **Declaring above `C`.** Credit is never more than what the team measured plus credited background (`min(declared, measured)`, with `measured` including at most a quarter background after Task 12b, and none before).
  - **Before Task 12b,** background lifts only the ratio, so credit is what the team measured, however the node times its traffic (sim `bg_priority_overdeclarer`, at most 1.0x).
  - **After Task 12b,** background is the slowest in-test interval of each stream's receipt run, with no missing receipts and intervals of at most 3 blocks, so it is close to the traffic the node carried during the test (red team RT4, round 5 F1, sim `bracket_widener`, at most 1.0x). **This is not exactly 1.0x.** A node that stalls real routed traffic during a test and carries it in the overlapping intervals gains up to about 1.11x (sim `bracket_stall_carry`, bound 1.12x), and up to an estimated 1.48x with one colluding member at `k = 4` (`measurement.md` §Background traffic, OQ-41). Measured in Task 12b under rule (a), a claimed block at or one below the co-signer's view, it is 1.175x, and 1.734x with the colluding member; `bracket_stall_carry` is model-only until PB-38 (OQ-106).
  - Once the ramp pushes past what the node carries, `ratio_t` falls below `1e6 - CAP_TOLERANCE_PPM` in most tests, and the 20% haircut applies to everything. Over-declaring within the tolerance is credited what was measured, never more.
- **Declaring below `C`.** A node that declares `C / 1.1`, so that the headroom pushes exactly `C`, is credited `C / 1.1` (sim `headroom_underdeclarer`, at most 1.0x).
- **Declaring below `C`, raising it in steps.** The tested rate is capped at `declared * 1.1`, and raises are allowed once per `CAP_CHANGE_WINDOWS`. So the step declarer's tested rate, and with it `measured`, climbs no faster than the honest declarer's, and usually slower.
- **Declaring `C`.** The ramp alone sets the pace, every test delivers what was pushed, and verified capacity reaches `C` as fast as any strategy can.
  - This holds for a 10 Gbps honest declarer too. At the default four 2,500 Mbps budgets the team pushes the full 10 Gbps.
  - A node faster than the team's budgets is tested and verified at the team cap with no haircut, under-credited but never penalised (sim `honest_ramp_no_haircut`, Task 4Dc).

## Peer-load calls (ADR-0056 with red-team revision 1; specified and simulated, not scored)

Once peer-load tests score (`measurement.md` §Peer-load capacity tests), they replace the team-test rule above for the nodes they call.

```
sample    = 0                                                   if the call is short
          = min(declared, usable, slices_run × floor(Σ h / n))   otherwise; hidden slices only
verified  = 0                                                   if the bond applies in the current cooldown epoch
          = min(declared, lower median of the samples of calls and retests ending in the last CAP_PEER_LOOKBACK_WINDOWS windows)
          = 0                                                   with no such sample
```

**Short calls and retests.** A call is short when `slices_run × upper_median(h) < min(declared, slices_run × slice) × (1e6 − CAP_TOLERANCE_PPM) / 1e6`.
- **A short call only zeroes its own sample.** It is retested once at a secret block within `CAP_PEER_RETEST_WINDOWS` windows, with a fresh draw of slices, relays and hidden validators.
- **Why.** Anyone can make one call short by flooding the node's port by about 12% while it runs. The first draft's public call blocks and one-strike bond let a flood for 0.1% of the day zero a node (sim `capacity_flood_framing`).

**The bond.** The node's capacity credit is zeroed from the window the bond applies in to the next multiple of `CAP_CHANGE_WINDOWS` when either:
- **the retest is short too** (`peer_load::bond_applies`); or
- **the node has had `CAP_PEER_SHORT_STRIKES` short calls in the epoch** (`peer_load::strikes_apply`).

**Why the upper median.** A majority of the hidden slices must be short, so two griefing validators of four cost a sample half its value but can't make a call short. Applying the bond takes a majority in both the call and its retest: `P(majority)²` a call (sim `capacity_validator_grief_quorum`).

**What can make a call short, and what can't.**
- **Can't:** a peer's report, `usable`, or a short pool.
- **Can:** load. A flood of the node's port, a drawn source oversending on a node without link headroom, or a drawn relay dropping hidden slices (T173, T217). The retest and secret call times bound a blind flooder's damage by its own flood duty. A flooder tipped off by a drawn participant isn't bounded (OQ-167).

**Source duty.** A source whose duty record's median delivered ratio is below `CAP_PEER_DUTY_MIN_PPM` (0.95), over at least `CAP_PEER_DUTY_MIN_SLICES` slices, is charged the same bond on its own capacity credit (`peer_load::source_duty_charged`). The node under test never is.

**What the bond deters, and what it doesn't** (sim `capacity_burst_renter_calls`; founder, 2026-11-08, OQ-43):
- **A node that can't deliver when called** is within `1 + tol` per unit of cost at every share of calls it can meet. It is worse off outright when it meets few calls.
- **The strikes rule is load-bearing here.** The retest alone left a renter at up to 1.162x per unit of cost; with strikes the worst is 1.055x (10x declaration, held 75% of the time).
- **An honest node** whose calls hit a transient fault 1% of the time keeps its credit.
- **A 95th-percentile renter isn't deterred.** It holds its port speed at every call, and calls touch about 1% of its billing buckets. PB-38's sustained-carriage bound has to catch it (OQ-136).

The helpers are `peer_load::call_outcome`, `bond_applies`, `strikes_apply`, `verified_kbps` and `source_duty_charged`, pure `u128` arithmetic.

## v1 escrow (not built)

An EVM contract holding stake per operator, slashed on a validator-majority attestation of failed tests. Needs: attestation format, quorum, appeal window, and who receives slashed funds. Tracked in OQ-2.
