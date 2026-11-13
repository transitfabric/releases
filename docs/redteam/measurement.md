> Taken from the Transit Fabric source repository at commit 91be12e (91be12ef98b775c7f045124e6b8c686c15439650, main), file docs/specs/measurement.md. Links into the private source tree are shown as plain text.

# Spec: measurement

Status: draft · Probe schedule and canary plans implemented in `crates/bwos-core/src/probe.rs` and `probe_canary.rs` · Vectors: `testdata/vectors/probe_schedule.json` · ADR-0039 (proposed) adds the sections marked with it. They are ahead of the code, and each says which Phase B task implements it (PB-06).

## Canary plans (ADR-0051, ADR-0053, Task 14)

Implemented in `crates/bwos-core/src/probe_canary.rs`, re-exported from `probe`. Vectors: the `canary` object in `probe_schedule.json` and the `canary-plan` entry in `canonical.json`. **Not scored.** How canary carriage is paid is PB-38, and nothing in `run_tempo` reads a canary plan yet.

The always-on canary stream (ADR-0051 §1) is built in four parts:
- an **allocation**, which node pairs carry how many bytes, drawn from public committed data so anyone can check it;
- each validator's **plan**, the timing, size and class of its own flows on those pairs, drawn from a secret;
- a **commitment** to the plan, in the validator's manifest at window open, and its **reveal** after the window ends;
- the **injector**, `bwos-probe canary --plan`, which sends the plan through a validator-run node.

**What this replaces and what stays.**
- **Replaced: the computable schedule, for the canary stream.** Before Task 14 every validator and every node could compute when canaries were due (§Shared probe schedule below). Canary flows now follow each validator's secret plan, and nobody can compute their timing or sizes before the reveal (red team finding 3).
- **Replaced: the class mix from client receipts.** The first Task 14 shaped canaries with `receipts::TrafficProfile`. Shaping now reads only `GlobalMarginals`, never per-pair or per-ingress customer data (ADR-0053 M6).
- **Stays: the shared probe schedule, for probe samples.** `probe::seed` and `probe::schedule` still pick the validator probe agent's `link:`, `path:`, `route:` and `direct:` samples (§Probe vantage). Those samples feed probe results, uptime and Mechanism 1 grading exactly as before. They are measurements, not carriage, are aggregated by stake-weighted median, and stay computable (T19). `probe::seed` is also the allocation's seed.

### Allocation: a verifiable draw (ADR-0051 requirement 1, ADR-0053 M5)

`probe::canary_allocation_deduped(seed, window, snapshot, caps, budget_bytes) -> CanaryAllocation` and `probe::canary_allocation(seed, window, snapshot, budget_bytes)`, which is the same with `caps` read from the snapshot's `capacity_mbps`. `CanaryAllocation { window, pairs }` maps `(ingress, dst)` to bytes for the window.

**Inputs, all committed.**
- `seed`: `probe::seed(block_hash, window)` of the window's first block.
- `snapshot`: the window's committed snapshot, the previous tempo's `next_snapshot`. It is fixed before the seed's block exists, so nobody can grind the snapshot against the seed.
- `caps`: each node's **deduped verified capacity**. Validators MUST pass `scoring_capacity_mbps` from window `w - 1`'s `run_tempo`, after §Endpoint dedupe (`[T24]`) and cohort credit (`[T28]`), the same capacities the team schedule admits nodes by (`routing.md` §Who is admitted). `canary_allocation` reads the snapshot's `capacity_mbps`, which is verified but not deduped. It is for the sim, tests and runs with dedupe off. Task 19b passes the deduped map.
- `budget_bytes`: `CANARY_BUDGET_BYTES_PER_WINDOW` (`scoring.md` §Parameters).

**The draw.**
1. **Eligible nodes.** Snapshot nodes with `caps[n] > 0` whose key is a valid route-table identifier of at most `CANARY_MAX_KEY_LEN` (64) bytes, as an ed25519 key in hex is. A key listed twice keeps its first UID.
2. **Bounded weight.** `w_n = min(caps[n], CANARY_NODE_WEIGHT_CAP_MBPS)`.
3. **Per-UID cap, water-filled (fix round 1, F4).** UID totals `W_u` become `min(W_u, C)`, where the level `C` solves `C = c * Σ_u min(W_u, C)` with `c = CANARY_UID_CAP_PPM / 1e6`, so no UID holds more than `c` of the capped total. With UID totals sorted descending, `C` is `c_ppm * S_k / (1e6 - k * c_ppm)` (`u128`, floor) for the smallest `k` whose next total `W_(k+1)` is at most it, `S_k` the sum of the totals after the first `k`. No cap binds when `k = 0`. With too few UIDs for any level (`k * c_ppm` reaching `1e6`), every UID is cut to the smallest UID's total. A held UID's nodes are scaled to `w_n * C / W_u` (floor), and nodes scaled to 0 drop out. (The first version made one pass against the uncapped total, which left a UID with 90% of the raw weight 69%.)
4. **Too many nodes.** If more than `CANARY_MAX_PAIRS` nodes remain, only the `CANARY_MAX_PAIRS` with the lowest ticket `SHA-256("BWOS-v0/canary-alloc" || 0x00 || seed || snapshot_hash || u64be(window) || u32be(len(n)) || n)`, compared as 32-byte big-endian numbers, are kept. The ticket doesn't depend on weight, so the cut is the same lottery for every node.
5. **Ingress quota.** `q_n = budget_bytes * w_n / W'` (`u128`, floor), where `W'` is the total weight after the cap and the cut.
6. **Draws per node.** `d_n = clamp(q_n / CANARY_CHUNK_BYTES, lo_n, CANARY_MAX_PAIRS_PER_NODE)`. The floor `lo_n` is `CANARY_MIN_PAIRS_PER_NODE` for a node with `caps[n] >= CANARY_FLOOR_MIN_MBPS` that is among the first `CANARY_FLOOR_NODES_PER_UID` nodes of its UID, ordered by weight descending, then key. It is `1` for any other node. **If `Σ d_n > CANARY_MAX_PAIRS` (`M`), the draws are cut in proportion (fix round 1, F7).** Each `d_n` becomes `max(1, floor(d_n * M / Σ d))`. What that leaves under `M` goes back one draw at a time by largest remainder `d_n * M mod Σ d` (then key), never above the old `d_n`, and anything over `M` from the minimum of 1 comes off the largest counts first (then key). So at 3_072 nodes, where the floors alone exceed `M`, every node keeps about its floor, and one big node can't collapse the rest to one draw.
7. **Each draw.** Draw `j < d_n` of node `n` carries `q_n / d_n` bytes, plus 1 for `j < q_n mod d_n`. Its destination is a weighted pick by `w` among the eligible nodes of **other UIDs**:
   ```
   r   = u128be(SHA-256("BWOS-v0/canary-alloc" || 0x00 || seed || snapshot_hash || u64be(window) || u32be(len(n)) || n || u32be(j))[0..16])
   dst = the node whose weight interval, over nodes sorted by (uid, key) with n's UID left out, holds r mod (W' - W'_uid(n))
   ```
   `W'_uid(n)` is the weight of `n`'s UID. A draw whose UID holds all the weight has no destination and is dropped, and so is a draw of 0 bytes.
8. **Per-pair cap.** A pair `(n, dst)` sums its draws, capped at `CANARY_PAIR_MAX_BYTES`. Anything over the cap is dropped, not moved.

`snapshot_hash = SHA-256(signing_bytes("snapshot-attestation", snapshot))`: the bytes validators attest (`signed::SignedSnapshot`). `n` is the node's key as it appears in the snapshot. Modulo bias is accepted.

**What the draw guarantees.**
- **Identical everywhere.** It is a pure function of committed data. Every validator and every node computes the same allocation, and anyone can check a reveal against it.
- **Contribution, not node count.** A node's ingress bytes are exactly proportional to its weight. Same-UID pairs are left out, so its expected destination bytes are proportional to its weight too. Splitting deduped verified capacity across more nodes, or more /24s, gains nothing (sim `canary_alloc_node_count_sybil`).
- **The floor is a floor of draws, not bytes.** It gives each eligible node at least `CANARY_MIN_PAIRS_PER_NODE` destination draws (two may land on the same destination), so its availability is sampled over several paths. It applies only to deduped verified capacity of at least `CANARY_FLOOR_MIN_MBPS`, and to at most `CANARY_FLOOR_NODES_PER_UID` nodes of one UID. It adds no bytes, so sybils can't drain validators through it (ADR-0051 finding 10).
- **Capped per node, per UID and per path.** The production table routes each pair and class on one path, so the pair cap is the per-path cap.
- **The table supplies only the hops.** The allocation never reads the route table. No solver can steer which pairs carry canaries (ADR-0051 requirement 1, finding 1).

**The budget (ADR-0051 §5).** `CANARY_BUDGET_BYTES_PER_WINDOW` is 27_000_000_000 bytes, a starting value. That is 50 Mbps averaged over a 4_320 s window, fabric-wide. The budget is global, so the per-node rate falls as the fabric grows:

| Fabric | Ingress bytes per node per window | Average ingress rate per node | Whole stream, per month (600 windows) |
|---|---|---|---|
| 100 equal nodes | 270 MB | 0.5 Mbps | 16.2 TB |
| 1,000 equal nodes | 27 MB | 50 kbps | 16.2 TB |

A node also carries the canaries routed through it as a relay, so its carried bytes are a few times its ingress bytes. A validator sources and sinks its stake share of the stream: a validator with 1% of the counted stake sends and receives 270 MB a window, about 162 GB a month each way, whatever the fabric's size. PB-38 sets the final budget.

### Stake shares (ADR-0053 §4, OQ-105)

`probe::canary_stake_shares(stakes, excluded_stake_hotkeys) -> BTreeMap<hotkey, ppm>`.
- **Pinned at the seed block (fix round 1, F2).** Both inputs are taken as of the window's seed block, its first block, and every verifier MUST use those pinned values for the plans and for `verify_reveal`. A share is exact to the ppm, so live stakes would let any stake change after the seed block, even 1 rao, move every share and void every reveal (test `canary_stake_drift_void`).
- `stakes` is `TempoInput::canary_seed_stakes`: the stake of each hotkey holding a validator permit at the seed block, keyed by SS58 hotkey. Hotkeys without a permit are left out. Never `validator_stakes`. Task 19b fills it from the chain at the seed block.
- `excluded_stake_hotkeys` lists the buyback and owner hotkeys, whose stake gets no canary share. It is `TempoInput::excluded_stake_hotkeys`, committed with the window inputs as of the seed block (`validator::tempo_canary_stake_shares`). PB-38 fills it from the committed public list the company can only add to. Until then it is empty unless a test sets it.
- A counted validator's share is `stake * 1e6 / Σ counted stake` (`u128`, floor). Excluded and zero-stake hotkeys, and any whose share floors to 0, get no entry. The shares sum to at most `1e6`, and the dust is not sent.

A validator's share of pair `p` is `probe::validator_pair_share(B_p, share) = B_p * min(share, 1e6) / 1e6` (floor), or 0 when that is below `CANARY_MIN_FLOW_BYTES`.

### Plans

```json
{"entries":[{"bytes":1200,"class":"latency","dst":"<node hex>","ingress":"<node hex>","start_ms":31337}],"v":0,"validator":"<ss58 hotkey>","window":1234}
```

`probe::canary_plan(secret, allocation, stake_share_ppm, marginals) -> CanaryPlan`. It leaves `validator` empty. The caller sets it to its SS58 hotkey before committing.

1. **Shaping input.** `marginals.effective()`: the committed `GlobalMarginals`, with any empty or invalid part replaced by the default mix's part.
2. **Draws.** Draw `i` is `u64be(SHA-256("BWOS-v0/canary-draw" || 0x00 || secret || u64be(window) || u64be(i))[0..8])`, with `i` counting up from 0 over the whole plan. Nobody without the 32-byte secret can compute timing or sizes before the reveal.
3. **Pairs in order.** Pairs go in ascending `(ingress, dst)` order, each with share `s = validator_pair_share(B_p, stake_share_ppm)`, skipping zeros. Flows are drawn until `s` is spent. Each flow takes exactly five draws, in this order: size bucket, size, class, slice, offset. A weighted pick by `r` over weights `w_0..w_k` takes `r mod Σ w` (`u128`) and walks the weights in order (sizes by bucket order, classes by name).
   - **Size.** Pick a size bucket `b` by weight, then the size `lo + 1 + r mod (hi - lo)`, where `hi` is `b`'s `max_bytes` and `lo` the previous bucket's (0 for the first). Raise it to at least `CANARY_MIN_FLOW_BYTES` and cut it to what's left. If what would be left is below `CANARY_MIN_FLOW_BYTES`, the flow takes all of it.
   - **Entry limit.** If `CANARY_MAX_ENTRIES - (entries so far + 1)` is at most the number of pairs still to spend after this one, the flow takes the pair's whole remainder, so every pair gets at least one entry within the limit. The allocation caps a pair at `CANARY_PAIR_MAX_BYTES`, which fits a `u32`.
   - **Class.** Pick one by the class weights.
   - **Start.** Pick a timing slice `k` by weight, then `start_ms = k * L + r mod len_k`. The window is `CANARY_WINDOW_MS` (4_320_000 ms), cut into slices of `L = CANARY_WINDOW_MS / slices`, with the remainder in the last (`len_k = L`, or what's left for the last).
4. **Order.** Entries are sorted ascending by `(start_ms, ingress, dst, class, bytes)`.

**`GlobalMarginals`** (canonical JSON, `probe::GlobalMarginals`):

```json
{"classes":{"latency":500000},"sizes":[{"max_bytes":1500,"weight":250000}],"timing":[1,1],"v":0}
```

- `sizes`: a flow-size histogram, at most 64 buckets, `max_bytes` strictly ascending from 1.
- `classes`: class to weight, at most 16 classes, each a valid route-table identifier of at most `MAX_MARGINAL_CLASS_LEN` (32) bytes.
- `timing`: weights of equal slices of the window, at most 1_024.
- Every part needs a positive total weight. A part that is empty, or breaks a rule, is replaced by the default's. A marginals with `v != 0` is replaced whole.
- **Global only.** It is a fabric-wide distribution and has no field for a pair, an ingress or a customer. It can't carry per-pair or per-ingress data (ADR-0053 M6).
- **Elephants.** The size histogram includes full-rate elephant flows (ADR-0053 H4), and the injector sends every flow at full rate.

**The default mix** (`GlobalMarginals::default_mix()`), used when there is no data:

| Part | Default |
|---|---|
| `sizes` (`max_bytes`: weight ppm) | 1_500: 250_000 · 16_000: 250_000 · 128_000: 200_000 · 1_000_000: 150_000 · 8_000_000: 100_000 · 64_000_000: 40_000 · 256_000_000: 10_000 (elephants) |
| `classes` | `latency`: 500_000 · `bulk`: 300_000 · `realtime`: 200_000 |
| `timing` | uniform: one slice |

**The producer is a stub.** Every validator uses `GlobalMarginals::default_mix()` until PB-38 or PB-39 adds a producer and commits the marginals with the window inputs. The default is a constant in the code, so all validators agree on it. The producer MUST build the marginals from validator-observed, fabric-wide counts only.

### Commit and reveal (ADR-0051 requirement 2, finding 8)

The revealed object is a `CanaryReveal`, domain `canary-plan`:

```json
{"plan":{"entries":[...],"v":0,"validator":"<ss58>","window":1234},"secret":"<64 lowercase hex>","v":0}
```

- **Commitment.** `probe::plan_commitment(plan, secret) = SHA-256(signing_bytes("canary-plan", CanaryReveal { v: 0, plan, secret }))`. It is also the reveal's object-store key. The 256-bit secret hides the plan, and SHA-256 binds it. A plan that can't be encoded commits to 32 zero bytes, which `verify_reveal` never accepts. The limits below keep a valid plan of `CANARY_MAX_ENTRIES` entries under the 4 MiB wire limit.
- **A fresh secret every window (fix round 1, F6).** A validator MUST draw a fresh 32-byte secret from a CSPRNG for every window, and never reuse one. Verifiers MUST reject a reveal whose secret the same hotkey revealed for an earlier window, checked over the windows they retain: `probe::canary_secret_is_fresh(secret, window, earlier)` looks back `CANARY_SECRET_RETAIN_WINDOWS` (48) windows, and reuse further back is outside the bound.
- **At window open.** The validator puts the commitment in its hotkey-signed `CommitmentManifest`, under the slot `canary-plan` (`identity.md`). The hotkey signature binds the commitment to the validator.
- **Which commitment counts (fix round 1, F3).** Only the hotkey's `canary-plan` slot as of block `seed block + CANARY_COMMIT_CUTOFF_BLOCKS` (5), among values set at or after the seed block. Later overwrites are ignored, and two different values set in the same last block count as none (`probe::pinned_canary_commitment`). A validator therefore can't swap its plan once it has seen the window's traffic.
- **After the window ends.** It serves the reveal at `/v0/objects/canary-plan/<commitment>`. The object store checks the reveal's structure and that its hash matches the key. It refuses to serve a reveal before its window has ended by the store's window clock, and without a clock it never serves one: the reveal reads as not found (`ObjectStore::get_raw`).
- **`probe::verify_reveal(commitment, plan, secret, allocation, stake_share_ppm)`** accepts a reveal only if all of these hold:
  - the commitment matches;
  - `v == 0`, and `window` is the allocation's;
  - `validator` is 1 to 64 printable ASCII bytes;
  - there are at most `CANARY_MAX_ENTRIES` entries, sorted ascending (equal entries allowed);
  - every entry has `ingress != dst`, both valid identifiers of at most `CANARY_MAX_KEY_LEN` bytes, `start_ms < CANARY_WINDOW_MS`, `bytes >= CANARY_MIN_FLOW_BYTES` and a class that is a valid identifier of at most `MAX_MARGINAL_CLASS_LEN` bytes;
  - for **every** allocated pair, the entries on it sum to exactly `validator_pair_share(B_p, stake_share_ppm)`, and no entry is on any other pair.

  So no validator can skimp on a rival's pairs, overload a friend's, or move bytes between them (sim `validator_canary_alloc_favour`). The caller checks that `plan.validator` is the manifest's hotkey and that `stake_share_ppm` is that hotkey's `canary_stake_shares` entry.
- **`probe::canary_plan_is_derived(plan, secret, allocation, stake_share_ppm, marginals)`** checks that the plan is exactly `canary_plan`'s output, apart from `validator`. Validators MUST check it as well, so a validator can't hand-pick its timing or sizes. While the marginals are the constant default, this needs no other input.
- **A missing or failed reveal** removes that validator's canaries from all evidence. They count for no node and against none, because missing evidence is never a node failure (ADR-0051 §5). Only PB-38 scores what the reveals show.

### Injection: validator-run ends (ADR-0051 requirement 3)

- **Validator-run nodes source and sink the canaries.** They are the canaries' hop-digest ends and the only holders of their sampling keys (§Secure sampling), so no miner node can tip off a relay about which packets are sampled.
- **The flow.** For an entry `(ingress, dst)`, the validator's source node hands each packet to `ingress`. The production route for `(ingress, dst, class)` carries it to `dst`, and `dst` hands it to the validator's sink node.
- **The driver.** The probe agent runs it: `bwos-probe canary --plan <plan.json> --via <host:port> [--window-start-unix-ms <ms>] [--dry-run]`.
  - It reads a canonical `CanaryPlan` and checks its form.
  - It sends each entry at `window start + start_ms`, at full rate, as UDP datagrams to `--via`, the validator-run source node's injection socket.
  - Each datagram is `ingress (32 bytes) || dst (32 bytes) || random payload`. The payload is the packet less 48 bytes of IPv6 and UDP header, and the packet is at most `CANARY_PACKET_BYTES` (1_420, the overlay path MTU).
  - **Packets are filled to the path MTU (fix round 1, F1).** An entry's `bytes` go out as full `CANARY_PACKET_BYTES` packets and a remainder tail, as a bulk sender fills its packets, so the inner IPv6 packets add up to exactly `bytes`. A tail under 48 bytes is raised to 48, taken from the packet before. (Splitting evenly at 1_280 gave every canary a packet size no ordinary flow has.)
  - The 64-byte prefix exists only on the hop from the agent to its own node. It is never on the fabric.
  - `--dry-run` prints the entry, packet and byte counts without sending.
- **Not built yet.** The source node's side (stripping the prefix, sending as its own overlay address into `ingress`) and the hand-off from `dst` to the sink are the live loop's (Tasks 18a and 19b, OQ-117).

### Counted once (ADR-0051 requirement 4, finding 9)

Canary bytes count in one place only, the canary evidence PB-38 scores.
- **Which hops a canary used.** `probe::canary_route(table, ingress, dst, class)` is the production table's `path` for `(ingress, dst, class)`. Failing that, it is the first route in table order for `(ingress, dst)` that has a `path`. A pair the table doesn't route over the overlay has no attributable hops.
- **What the plans put on each hop.** `probe::canary_hop_bytes(plans, table)` sums the revealed entries' bytes onto every directed hop of their routes.
- **The legs to the validator's own nodes.** The hops from the validator's source node to `ingress` and from `dst` to its sink are not on the route. Their receipts are canary bytes too, and the live loop removes them with the validator's declared source and sink (OQ-117).
- **Planned, not delivered, and the first route only** (OQ-120). The removal subtracts the bytes the plans planned, not those delivered, and attributes each entry to one route: the class's, or the pair's first. A dropped canary is still taken out of the hop's usage, and bytes a hop carried on another route aren't.
- **Taking them out.** `probe::remove_canary_bytes(usage, canary)` subtracts that from the per-hop receipt usage (the highest-`seq` co-signed totals, `receipts::select_window_receipts`), saturating at 0, before receipts are credited. Canary bytes are therefore never credited as receipt usage.
- **No paid-traffic trigger.** Canary flows have no client receipt, so they are never attested paid bytes and never count toward a paid-traffic trigger (Task 15, retired by ADR-0053).
- **Wiring.** `run_tempo` doesn't call the removal yet. No canary is sent until the live loop, and Task 19b adds the revealed plans to `TempoInput`. Receipts stay an upper bound and never the measure. Only delivered, digest-passing canary bytes count (PB-38).

### Residuals (T19)

- **At bootstrap every transit flow is a canary.** Before customer traffic exists there is nothing to hide among. Shaping protects nothing then. The protection is the end-to-end check: only delivered, digest-passing bytes count (PB-38, PB-39).
- **Flows to or from validator-run nodes can be spotted.** The source and sink are validator nodes, and a node next to them sees that. Entering through ordinary ingress nodes hides the source from relays deeper in, but not from `ingress` and `dst` (PB-38, PB-39).
- **The packet shape still gives canaries away** (T148, OQ-117). Canaries are one-way UDP with no reverse traffic, from a validator's source address. Filling packets to the MTU removes the packet-size tell, not these. The node side MUST hide validator addresses and shape reverse traffic per class before canaries are scored.
- **The allocation is public during the window** (T145, OQ-116). A node knows which pairs carry canaries. Once customer traffic exists, a flow on an unallocated pair is customer traffic.
- **What is and isn't hidden within an allocated pair.** Hidden: when each flow starts, how big it is and its class, which come from each validator's secret and the global marginals. A node can't predict them from public data, and guesses on them gain nothing beyond sampling noise (sims `canary_favourer`, `canary_slot_presence`). Not hidden: the pair itself, the packet shape and source address (T148), and anything that tells canaries from customer flows that the marginals don't capture.
- **A validator can tell a friend its plan, or grind its secret** (T146). A plan is secret from nodes, not from the validator. Planned fix for grinding: commit `SHA-256(secret_w)` in window `w - 1` and key the draws on `secret || seed`, so a secret is fixed before the seed is known. Each validator's share is fixed by stake and checked at reveal, so this moves only that validator's evidence. Results are aggregated by stake-weighted median (PB-38, ADR-0051 requirement 5).
- **Splitting above the per-node weight cap** (T147). Weight is linear up to `CANARY_NODE_WEIGHT_CAP_MBPS`. A node above it gains by splitting into nodes under it, bounded by the per-UID cap. With the water-filled cap, 40 Gbps split four ways in one UID gains nothing in the sim (1.00x), because the UID is held to the cap either way. Across UIDs the cap doesn't hold: 90% of the raw weight over four UIDs keeps 90% of the weight (sim `canary_alloc_uid_split`, OQ-119).

### Sims (Task 14)

They run the real draw and plan generator; nothing is scored until PB-38, so each measures what PB-38 will read. The customer flows in `canary_favourer` come from the plan generator itself, so they share its quirks; PB-38 needs an independent customer model (OQ-121).
- `canary_favourer`: forwards what it guesses are canaries and drops 10% of the bytes of every other flow, with 19 guesses from size bucket, class, eighth of the window and the old computable schedule. Customer flows on the allocated pairs are drawn from the same marginals. Bound: canary delivery over an honest node's at the same real loss is at most 1 plus a 2% sampling tolerance. The public-allocation residual (T145) is reported, not gated.
- `canary_slot_presence`: up only when four public predictors say its canaries are due (old schedule slots, the first half, odd blocks, a plan drawn with the public seed as the secret). Bound: canaries delivered while up over an honest node's with the same uptime, by flow, at most 1 plus 2%.
- `validator_canary_alloc_favour`: six favouring plans (bytes moved, skimped or overloaded, a lied allocation, a doubled share, hand-picked timing), each recommitted and each against the honest commitment. Bound: none is accepted by `verify_reveal` and `canary_plan_is_derived`.
- `canary_alloc_uid_split` (fix round 1, F4): an operator with 50%, 90% or 99% of the raw weight. Bound: as one UID its weight share is at most `CANARY_UID_CAP_PPM`. Split across 2 or 4 UIDs it holds more, reported, not gated (OQ-119).
- `canary_alloc_node_count_sybil`: 1_024 Mbps split into 1 to 64 nodes in separate /24s against one honest node of the same capacity. Bound: ingress plus expected destination bytes per Mbps at most 1. The drawn destinations over 40 windows are reported. Splitting across UIDs gains a little more, because a UID never draws itself as a destination (T147).

## Shared probe schedule

Every validator derives the same probe schedule for a window. It times the validator probe agent's `link:`, `path:`, `route:` and `direct:` samples. It does not time the canary stream, which follows the canary plans above:

```
seed      = SHA-256("BWOS-v0/probe-seed" || 0x00 || block_hash_32_bytes || u64be(window))
rand(i)   = u64be(SHA-256(seed || u64be(i))[0:8])
paths     = path IDs from the window's topology snapshot, sorted ascending (bytes)
for slot j in 0 .. N_PROBES-1:
    path_j   = paths[rand(2j)   mod len(paths)]
    offset_j = rand(2j+1) mod WINDOW_BLOCKS
```

`block_hash` is the hash of the first block of the window. Modulo bias is accepted (documented, negligible at these sizes).

Operators can compute this schedule, so a node can tell when a probe sample is due (T19). That is why it times only probe samples, which are measurements aggregated by stake-weighted median, and not the canary stream (§Canary plans). Active UDP canary datagrams (`probe::run_udp_canary_probe`) carry no magic prefix, window, sequence number or deterministic padding: every byte is fresh OS randomness and replies are matched by exact payload equality, so a node cannot recognize canaries by content (`[SCR-6]`). Echo responders echo any `MIN_UDP_PROBE_BYTES..=MAX_UDP_PROBE_BYTES` (20..=1400) byte datagram unchanged.

**Path probes are keyed by path (Task 16a fix round 1, red team M4).** A probe of an overlay path `P` is keyed `route:<hex SHA-256 of P's node IDs joined by single spaces>` (`probe::route_path_key`; node IDs are printable ASCII without whitespace, so the join is unambiguous, and the key fits the 256-byte limit at any path length). Mechanism 1 grading reads only these (`scoring.md` §Grading item 3).
- **Same path, same result.** Every table routing over `P` gets the same result, whichever table the validators chose to probe. A table that copies a probed table's paths can't escape a slow result by not being probed, and an unprobed near-clone can't outrank a probed table on the same paths.
- **Which paths are probed (Task 19b fix round 2).** Per table, on a seed fixed after the commit deadline: when `D(w)` is read at `S + SOLVER_COMMIT_DEADLINE_BLOCKS`, the live loop pulls every committed table and draws `PATH_PROBES_PER_TABLE` (8) distinct overlay paths from each (all of them when it has fewer), by `SHA-256(seed || uid || counter)` over the table's sorted, deduplicated paths, where `seed` is the hash of the deadline block (`live::path_probe_plan`). Every table's routes are probed with the same count, so routing over paths a solver expects to go unprobed gains nothing; and no solver knew the seed when it committed. The plan goes to `<state-dir>/path-probes/<w>.json` for the probe agent. No agent runs it yet: a `route:` probe needs a canary handed to `src`'s overlay ingress and echoed by `dst`, and a probe session carries only STAMP, so it waits for a validator-run injection node and an overlay echo responder (OQ-280). A path with no probe this window is graded on the snapshot and the latency samples alone, which is every path today.
- **Minimum RTTs (planned).** The load model (ADR-0060) needs each link's windowed minimum RTT, its idle base latency, in the snapshot inputs. It isn't recorded yet: probe batches carry one RTT per key and window, and the aggregate is a median, so it needs a new sample field and a snapshot field (OQ-218).

**Older helpers.** The older helpers (`validator::evaluate_solver_table*`, the `bwos` CLI preview) still read path measurements keyed `path:uid:<uid>[:<class>]:<src>:<dst>`. Label-keyed results `path:<table.solver>[:<class>]:<src>:<dst>` are used only for a submission whose `table.solver` label is unique among the tempo's submissions (`[SCR-4]`). `run_tempo` reads neither.

## Probe vantage (`[T22]`, `[T29]`, OQ-16)

Every measurement that scoring reads comes from a **validator-run probe agent** and reaches scoring only inside the validator-signed `ProbeResultBatch` of that validator (`batch.validator`), revealed against its commitment and aggregated across validators (§Results and commit-reveal). Nodes, operators and solvers report nothing: no node-reported, node-timestamped or solver-reported latency, loss, jitter or throughput is ever a scoring input. `TempoInput::current_snapshot` (whose link and direct latencies feed predicted gains, link failover and `Q_n` predictions) MUST be the previous tempo's `TempoOutcome::next_snapshot`, which `validator::build_snapshot_and_demand` builds from aggregated validator samples only.

| Key | Originated by | What is timed |
|---|---|---|
| `vantage:<n>` | any validator probe agent | UDP canary echo exchange between the agent and node `n`'s echo responder (`probe::vantage_key`). Under ADR-0039 this is a STAMP exchange inside the WireGuard session `n` opened to the agent (§STAMP probes and probe sessions) |
| `link:<a>:<b>` | the validator's probe agent nearest `a` | canary handed to `a`'s overlay ingress addressed to `b`, forwarded by `a` to `b`, echoed by `b` back to the agent |
| `direct:<src>:<dst>` | the validator's probe agent nearest `src` | canary echo exchange with `dst`'s public endpoint over the public internet (not the overlay) |
| `path:...:<src>:<dst>` | the validator's probe agent nearest `src` | canary handed to `src`'s ingress, carried over the production route's hops to `dst`, echoed back |
| `cap:<n>` | validator probe agent | capacity test with a node-signed ack (§Capacity tests) |
| `capteam:<n>:<b>` | each team member's probe agent | its share of the team capacity test of `n` scheduled at block `b`, echoed (§Team capacity tests, ADR-0039) |

**The canary stream** (§Canary plans) is not a probe-result key. A validator's probe agent drives its own revealed plan through a validator-run source node, and its validator-run sink node receives it. Both ends are the validator's, and so are the clocks. What reaches scoring, from PB-38, is only what validators measured at their own ends: delivered bytes, and hop digests checked under keys only they hold. It is aggregated across validators like the samples here. A node's own report of canary traffic is never an input.

Rules:

1. **Only the agent's clock.** Each sample is a timing of packets the agent itself sent and received (random payloads, `[SCR-6]`). Validators MUST NOT derive a sample by subtracting another measurement that an endpoint can inflate (for example `link = composite - vantage leg`): an endpoint that delays the subtracted leg would make its link look faster. The agent-to-ingress leg therefore stays inside `link:` and `path:` samples as a conservative bias (links look slower, never faster). With this rule an endpoint or hop can only **add** delay or loss to a sample it forwards or echoes.
2. **Indistinguishable vantage and direct probes.** Before ADR-0039, an agent SHOULD send `vantage:<n>` and `direct:*:<n>` probes to `n` from the same socket, interleaved, so `n` cannot delay one class without the other.
   - **What ADR-0039 changes.** `vantage:<n>` moves inside the probe session `n` opened (§STAMP probes and probe sessions), while `direct:` stays a random-payload echo over the public internet. The two can no longer share a socket, so this rule applies to neither.
   - **What remains.** `n` can tell them apart and delay `direct:` alone. That is the OQ-16 (a) residual, unchanged in size.

Residual (`[T22]`, check of the gain formula `gain = (direct_us - overlay_us) * 1e6 / direct_us`): forwarding nodes on an overlay path can only make `overlay_us` larger, which lowers their own gain. But the destination `dst` of a pair echoes the `direct:` probe, which arrives outside the overlay and is therefore distinguishable from overlay traffic, so `dst` can inflate `direct_us` for pairs that end at itself; that raises the gain of every overlay route to `dst` and can make a route slower than the true direct path look positive (Mechanism 1 score and the `[SCR-9]` Mechanism 0 creditability check). It is bounded only by the Mechanism 1 trimmed mean and by `dst` having to delay its own vantage probes consistently. Still open (OQ-16).

## STAMP probes and probe sessions (ADR-0039)

Implemented by Phase B Task 4Da (codec and vectors), Task 4Db (sessions, sender, reflector, `latency_samples`) and Task 18b (the source match with the collector session).

**Sessions.**
- **Nodes always dial.** Each node dials every eligible validator's probe agent (`--probe-peer <wg-pub-hex>@<host:port>`, §Team capacity tests for "eligible") and keeps the WireGuard session up with keepalives. The agent never dials a node, public or not, so nodes behind NAT or CGNAT are measured the same way as public ones. The same session carries the node's own `node-consent` objects, and its operator's hotkey-signed manifest, binding and capacity declaration, to the validator (PB-45b: `identity.md` §Delivery over the probe session, ADR-0058 §7). They need no source match: each object authenticates itself, and the session's `wg-binding` names the node key.
- **What the session carries.** On this session the probe peer gets no BGP session and no routes. The node accepts from it only two things, both addressed to its own overlay `/128`:
  - STAMP test packets to UDP port 862;
  - capacity-test connections (§Capacity tests).

  It forwards nothing it receives there. Besides STAMP replies, the node sends the agent only its forwarded objects (`PROBE_FORWARD_PORT`, 8_622, from its `/128` to the probe address; `identity.md` §Delivery over the probe session), which the agent takes within a per-session token bucket and counts as `forwarded`, `forwarded_refused` or `forwarded_rate_limited`, never as `unexpected`. **Peer admission (reconciled with `datapath.md` §Peer admission in Task 4Db).** A probe peer has no `wg-binding`, so the binding rule doesn't admit it. It is admitted instead by its WireGuard key being a listed probe key, and that admission is narrower than a BGP peer's (`datapath.md` §Peer admission, "Probe peers"):
  - **What it may receive.** Replies to STAMP tests and to capacity-test connections addressed to the node's own `/128`, and nothing else: no BGP, no BFD, no link probes or pings, no transit, no forwarding, no route.
  - **What it may send.** Only those two kinds of packet, from its own probe address (below) to the node's `/128`. Everything else from it is dropped and counted (`drop_probe_peer`).
  - **Which keys are listed.** In production, a key listed as `probe_wg_pub` in one of the records of a validator in the current validator set. A probe's WireGuard key is tied to its validator by that field of the validator hotkey's `AttestationKeyRecord` (Task 11a; §Team capacity tests, "Validator identity"). A validator may hold one record per probe agent. Until Task 11a's signed set reaches nodes (Task 11c), the operator lists the keys with `--probe-peer`, and that list is the whole admission.
  - **No BGP, so no BGP rules.** Task 10's hold-down after a Cease for routes, flap damping and route caps are BGP-session rules, and a probe session has none of them. A probe session is kept up for as long as its key is listed.
- **The probe address.** The agent's source address inside the session is `identity::address_from_public(probe_wg_pub)`, derived from the WireGuard key the handshake proved. The node drops a packet from a probe peer with any other source (`drop_probe_peer`), so a probe key can't speak for another address.
- **Capacity tests on the session.** Task 4Dc lands the team test (`bwos-probe cap --team`, scoring and crediting), but, by the rule below, not over probe sessions: its members connect to the node's echoing sink (`bwos-probe cap-sink -echo`) directly until Task 18b sets collector sources. Until then a node accepts only STAMP tests on a probe session, the most conservative reading.
- **Same source as the collector session (red team RT1). Not enforced until Task 18b.** Each validator also holds a BGP collector session that the node opens to it (PB-07, Task 18b).
  - **Two peers, two sessions.** The probe agent and the collector are separate WireGuard peers of the node: the probe peer has no BGP (above), and the collector is a BGP peer. So the node holds two sessions to the validator, which may come from different ports.
  - **What is compared.** The source IP address of the probe session, as the validator sees it on the WireGuard packets, MUST equal the source IP address of the collector session for that node at that validator. Ports aren't compared.
  - A probe session whose source differs is refused: the validator records no samples on it, and runs no capacity test over it.
  - Capacity tests run only over a source-matched probe session.
  - The committed `endpoints.addr` is this shared source (§Probed endpoints).
  - **Until Task 18b (Task 4Db fix round 1, PB-48).** No collector session exists, so nothing is source-matched. `bwos_net::probe_agent` has the check (`ProbeAgent::set_collector_source`): once a collector source is set for a node, a session from another IP records no samples (`unmatched_samples`), and samples on a matching one carry `source_matched`. Nothing sets it yet. So:
    - `bwos-probe serve` reports what it saw as `unmatched_endpoints` with `"source_matched": false`, and those endpoints MUST NOT feed a `ProbeResultBatch`'s `endpoints`;
    - **its `vantage:` samples feed `samples`, with a residual accepted only while every validator is founder-run (PB-48, T300).** In plan mode (§Live loop, "The probe agent's plan and results") the agent's window samples reach the batch `live` commits and reveals, and nothing else. Each validator has its own session with the node, so a node could answer each validator from a different place than its data plane (a forwarder, or another box holding its node key), and the median is no protection. PB-48 bounds it: capacity credit needs a signed data-plane link with another UID and pools by each test's committed target (§Live loop, "PB-48's capacity rules"). The rest is accepted while the founder runs every validator on testnet and watches for it; before any third-party validator holds a permit, either Task 18b's source match lands or this rule goes back to "MUST NOT feed `samples`" (OQ-284);
    - Task 4Dc MUST NOT ship capacity tests over probe sessions before 18b sets collector sources. It doesn't: `bwos-probe cap --team` streams to the node's `cap-sink -echo` at `--target`, the plan mode's single-agent tests stream to the node's `cap-sink -persist` (§Capacity tests), never over the session, and moving the streams into source-matched probe sessions is Task 18b's.

  Without this, a node could open its probe sessions through a forwarder with a large pipe, while its BGP and data-plane sessions used a small one, and be tested on the forwarder's pipe (sim `probe_session_forwarder`, Task 18a).
- **What runs on it.** `vantage:<n>` samples and team capacity tests.

**Packets.**
- **Layout.** RFC 8762 unauthenticated mode with the RFC 8972 Session-Sender Identifier (SSID). Every field is big-endian, and the base packet is 44 bytes.
  - **Session-Sender test packet:**

    ```
    seq u32 | timestamp u64 | error_estimate u16 | ssid u16 | 28 zero bytes
    ```
  - **Session-Reflector packet:**

    ```
    seq u32 | timestamp u64 | error_estimate u16 | ssid u16 | receive_timestamp u64
        | sender_seq u32 | sender_timestamp u64 | sender_error_estimate u16 | 2 zero bytes
        | sender_ttl u8 | 3 zero bytes
    ```
- **Lengths and TLVs.**
  - A packet shorter than 44 bytes is refused.
  - Bytes after the first 44 MUST parse as RFC 8972 TLVs (each a 4-byte header of flags u8, type u8 and length u16, followed by `length` bytes, ending exactly at the packet's end). They are ignored. A packet whose trailing bytes don't parse is refused.
  - Our sender sends no TLVs. Native reflectors may add them.
  - The receiver MUST read each datagram into a buffer of at most 1,500 bytes and drop larger ones; the codec (`bwos_core::stamp`) parses whatever length it is given.
    - **Inside a probe session (Task 4Db).** The datagram is the inner UDP datagram. Both ends drop a STAMP payload longer than `STAMP_MAX_BYTES` (1_500) before decoding it.
    - **The agent's socket.** `bwos-probe serve` reads its outer UDP socket into a 1,501-byte buffer, one byte past the limit, so a datagram longer than 1,500 bytes is seen and dropped rather than silently cut short. Everything a node sends on a probe session (handshakes, keepalives, 44-byte replies) fits.
    - **The node's socket.** A node's socket is shared with BGP and transit, so it reads larger datagrams and applies the limit to the inner STAMP payload only.
- **Fields.** Timestamps use the NTP 64-bit format, so the error estimate has `Z = 0`. The agent picks a random non-zero `ssid` per session.
  - **A no-root node's reflector has no wall clock.** It fills `timestamp` and `receive_timestamp` from its monotonic clock in NTP format, with the error estimate's S bit clear (not synchronised) and multiplier 1. These fields are dashboard-only (rule 4 below), so this changes nothing scored.
- **Code.** Codec: `bwos_core::stamp` (`StampTest`, `StampReflected`, `encode_test`, `decode_test`, `encode_reflected`, `decode_reflected`). Vectors: `testdata/vectors/stamp.json`.

**Reflector (the node).**
- It runs in RFC 8762 stateless mode at its overlay `/128`, UDP 862.
- It copies the received `seq` into both `seq` and `sender_seq`, and also copies `ssid`, `timestamp` (into `sender_timestamp`) and `error_estimate` (into `sender_error_estimate`).
- It fills `receive_timestamp` and `timestamp` from its own clock, and `sender_ttl` from the received hop limit.
- **Rate limit (fix round 1, red team RT4).** It answers each probe peer at most `PROBE_PEER_STAMP_PER_SEC` (20) tests a second, from a token bucket of `PROBE_PEER_STAMP_BURST` (20) on its own clock. A sample is 10 tests at least 10 ms apart, so an honest agent never meets it; tests over it are dropped and counted (`stamp_rate_limited`), and to the agent they are lost.
- Datacenter gear that speaks STAMP can reflect natively.

**Sender (the validator's agent).** These rules keep §Probe vantage rule 1, under which an endpoint can only add delay:
1. **Fresh sequence numbers.** Every test packet's `seq` is fresh OS randomness. RFC 8762's incrementing counter isn't used, and a stateless reflector copies whatever it gets.
2. **Unpredictable timing.** A sample sends `STAMP_PACKETS_PER_SAMPLE` (10) test packets. The gaps between them are exponential with mean `STAMP_MEAN_GAP_MS` (100), drawn from OS randomness and clamped to `10..=1_000` ms, so a node can't predict when the next test leaves.
3. **Matching replies.** A reply counts only if all of these hold:
   - its `sender_seq` and `ssid` match a test this agent sent on this session;
   - it arrives after that test left and within `STAMP_REPLY_DEADLINE_MS` (2_000);
   - it's the first such reply. Later duplicates are ignored.

   A node therefore can't answer a test before it arrives.
4. **Only the agent's clock.** `stamp_rtt_us = T4 - T1`, where `T1` is the send time the agent recorded locally for that `seq` and `T4` is the agent's receive time, both on the agent's monotonic clock. The echoed `sender_timestamp`, `receive_timestamp` and `timestamp` are the node's to set. They go to dashboards only and never into any scored value (§Self-reported telemetry). In particular, RTT is never corrected by `timestamp - receive_timestamp`, which the node could inflate to make itself look faster.
5. **Loss.** A test with no counted reply by the deadline is lost.

**Where STAMP is used, and where it isn't (controller ruling 4, red team RT8).**
- **STAMP.** Only `vantage:<n>`, sent over the session `n` opened to the agent.
  - A sample's `rtt_us` is the lower median of its counted STAMP RTTs, and `ProbeSample.stamp_rtt_us` carries the same value. It's an optional field, omitted when absent, so existing samples keep their bytes.
  - `loss_ppm` is the lost share.
  - `jitter_us` is the lower median of the absolute differences between consecutive counted RTTs, in send order, as for UDP canaries (`0` with fewer than two).
  - **All lost.** A sample with no counted reply is a failed sample (`rtt_us = 0`, `loss_ppm = 1_000_000`, `jitter_us = 0`) and carries no `stamp_rtt_us`.
  - **The window's sample (PB-48).** A batch carries one `vantage:<n>` per window, so plan mode samples each session once per `VANTAGE_SAMPLE_INTERVAL_SECS` slot (30; slots run back to back from the session's first sample, each sample starts at a uniform point inside its slot, or as soon as the last one ends if a sample overran into it, at most one per slot, and a slot that passes whole with the session down is lost, never made up) and combines the window's samples (`probe_plan::window_vantage_sample`): `loss_ppm` is the mean of their losses (each sample is 10 tests, so this is the pooled loss; floor), `rtt_us` and `stamp_rtt_us` the lower median of the passing samples' RTTs, `jitter_us` the lower median of their jitters. With no sample, or none with a reply, it is a failed sample: every node the plan names gets a `vantage:` sample, so a node with no session to this validator in the window fails it rather than going unmeasured.
  - **Checked in every batch (Task 4Db).** `ProbeResultBatch::validate` refuses a batch with `stamp_rtt_us` on any key that isn't `vantage:`, or with `stamp_rtt_us` that is `0` or differs from the sample's `rtt_us`. So a STAMP layout can't reach a link, direct, path or capacity sample.
  - **Code.** `probe::StampSampler` is the sender's rules 1-5 for one sample, sans-IO, and `probe::stamp_gap_ms` the gap draw. `bwos_net::probe_agent` runs them over sessions, and `bwos-probe serve` runs that on a real socket.
- **Random payloads, never STAMP.** `link:<a>:<b>`, `direct:<src>:<dst>` and `path:` canaries are indistinguishable traffic: fresh-random payloads with no recognisable format, echoed by the echo responder, exactly as today (`[SCR-6]`, T19, PB-03). A recognisable link probe would let a relay forward probes fast and real traffic slowly, which is the conservative reason to keep them random.
  - `direct:` probes go to the destination node's UDP echo responder at its committed endpoint address (§Probed endpoints), port `DIRECT_ECHO_PORT` (8_620), over the public internet.
  - A node behind NAT has no reachable endpoint, so pairs ending at it have no `direct:` sample.
  - Native STAMP reflection on datacenter gear for link probes is a founder choice (OQ-42).
- **Latency samples.** `probe::latency_samples` builds `LatencySamples` from the window's committed `link:` and `direct:` samples' `rtt_us`, which is also the agent's clock.
  - **The pair.** `link:<a>:<b>` and `direct:<a>:<b>` both give the pair `(a, b)`. A key that doesn't split into exactly two non-empty node names is skipped.
  - **Failures.** A failed sample (`rtt_us = 0`) isn't a latency and is skipped. Its loss is counted elsewhere (§Uptime).
  - **Order.** Each pair's values are sorted ascending, so the result doesn't depend on the order of the batches or of the samples in them.
  - **Not weighted.** The function takes batches, not stakes, and keeps every value. The caller passes only the window's committed, verified batches of staked validators, one per validator. Grading never reads this raw list (OQ-83, below).
- **Latency samples for grading (Task 16a, OQ-83 option (a)).** Mechanism 1 grading (`scoring.md` §Grading on the next window's snapshot) reads `LatencySamples` built by `validator::graded_latency_samples`. It doesn't use `probe::latency_samples` and the raw lists.
  - **One value per pair.** Each pair `(a, b)` gets one value: the window's aggregated `link:<a>:<b>:rtt_us`, which is already the stake-weighted lower median over the committed batches (§Results and commit-reveal, `[T21]`, ADR-0039), and only when it is positive.
  - **No `direct:` samples.** They aren't mixed in: a route's hops are overlay links, and the `direct` baseline comes from the graded snapshot's `direct` entries.
  - **One stake can't move it.** A validator at the minimum stake can't move a pair's value without moving the median.
  - **The grader's reading.** It takes the lower median of each pair's list, which for these lists is the one value.
  - **Coverage.** In `run_tempo` the same aggregates also build `next_snapshot`'s links, so a sampled path is never faster than its predicted latency there. The samples check the solver's own `est_us`, and they bind once samples come from probes the snapshot doesn't use.

**The agent's view of the session (Task 4Db).**
- **Who gets a session (fix round 1, red team RT1).** Only a bound node: one whose WireGuard key the agent knows (below). For an initiation from any other key the agent makes no session, so strangers can't take the slots honest nodes need and frame them with `vantage:` failures (sim `vantage_denial_framer`). In order, for a datagram no session claims:
  1. **Room.** At most `MAX_PROBE_SESSIONS` (1_024) sessions; a full agent drops the datagram before any key agreement.
  2. **Rate limit.** One boringtun rate limiter, `PROBE_AGENT_HANDSHAKES_PER_SEC` (100), is shared by every session's `Tunn` and checked first: a bad MAC1 is dropped, and past the limit an initiation needs a valid cookie for its source address, or gets a cookie reply and nothing else. So a spoofed flood costs no key agreement.
  3. **The claimed key.** The initiation's static key is decrypted (`link::handshake_initiator`) and must be bound.
  4. **Proof.** The session is kept only if the agent's handshake response goes out, which proves the node holds the key.
  5. **Confirmation (PB-48).** Until the node's first packet confirms it, the session has no handshake age at the agent, so it is kept for `UNCONFIRMED_GRACE` (30 s) from the response, and only then counted stale. Dropping it at the next 250 ms tick lost a node's first datagram, its forwarded consent, which it sends again only every `PROBE_FORWARD_RESEND_SECS` (test `an_unconfirmed_session_outlives_the_agents_ticks`).
- **Plan mode (PB-48, ADR-0061).** A node holding its node key opens its probe sessions under the node key's X25519 form (`NodeKey::probe_session_wg_secret`), and a plan-mode agent binds exactly its plan's nodes under `identity::probe_session_wg_pub`, refusing a key two nodes share, within per-UID quotas (§Live loop). A session the agent answered is kept `UNCONFIRMED_GRACE` (30 s) for the node's first packet.
- **Which node it is.** A session whose WireGuard key has a `wg-binding` live at the agent's binding block is the binding's node: samples are keyed `vantage:<node key>`, and the node's `/128` is that key's address. A `--test-identity` node, which has no binding, is bound by naming its WireGuard key (`bwos-probe serve --test-node <wg-pub-hex>`, tests only): it is keyed `vantage:<wg key hex>`, with the address its WireGuard key gives. A key that is neither gets no session. In production the binding comes from the signed peer directory (OQ-84).
- **The source it records.** For each node, `probe::probed_endpoint` of the address the session's packets came from: the port is dropped, an IPv4-mapped IPv6 address is read as IPv4, and an address that fails `vpn::is_public_egress_ip` (§Probed endpoints) is dropped. It becomes the `addr` the validator commits (§Probed endpoints) only once Task 18b has matched it to the collector session; until then it is reported as unmatched and committed nowhere (§Sessions, RT1).

**Residuals.**
- **Probe priority.** A node knows which sessions are probe sessions and that STAMP is a probe. It can give `vantage:` probes and capacity tests priority over real traffic and look better than it treats customers. Only measuring real traffic closes that: secure sampling (ADR-0038), and pay moving to carried traffic.
- **Rule 2 of §Probe vantage no longer applies.** See the rule itself: `vantage:` is sent inside the session and `direct:` over the public internet. The OQ-16 (a) residual (the destination inflating `direct_us`) is unchanged in size.

## Capacity tests

Capacity tests must be unpredictable. A node `n` with declared capacity is tested at block `b` when:

```
u64be(SHA-256("BWOS-v0/cap-test" || 0x00 || block_hash(b-1) || node_pubkey)[0:8]) mod CAP_TEST_PERIOD == 0
```

Operators learn of a test at most one block ahead (12 s on mainnet), which is too short to provision fake capacity. A validator runs at most `CAP_TEST_MAX` (default 2) concurrent capacity tests per block, pushing traffic up to the node's declared capacity for `CAP_TEST_SECONDS` (default 10 s) from the nearest probe agent and recording achieved throughput (`throughput_mbps`).

Default `CAP_TEST_PERIOD` = 900 blocks (~3 h), so each node is tested a few times a day.

**ADR-0056 (2026-11-08, specified, not scored) will replace the team test's validator-pushed load** with peer-sourced load and hidden validator slices, called about 3 times a day (§Peer-load capacity tests). Until it scores, the rules below stand.

**ADR-0039 replaces the single-agent test with a team test** (§Team capacity tests, Phase B Task 4Dc). It keeps the schedule above, the request header and the `cap-test-ack` below, but changes three things:
- the test lasts `CAP_TEST_SECS` (60 s);
- the bytes are echoed;
- a team of `CAP_TEAM_MIN_VALIDATORS` to `CAP_TEAM_MAX_VALIDATORS` validators (3 to 4) each push a share, at a rate that ramps with verified capacity.

Task 4Dc implements the team test, its schedule and its crediting (§Team capacity tests, "Code"). Scoring uses it once the validator loop supplies `TempoInput.block_hashes` (Task 19b) **and** endpoint dedupe is on (§Probed endpoints, "Dedupe", stake trigger; Task 4Dc fix round 5, T124); otherwise the single-agent test with `CAP_TEST_SECONDS` (10 s) and the single-agent rule are what run.

Delivery proof (`[SCR-3]`, `RT2-3`):

1. The prober opens the connection and sends a `CAP_TEST_HEADER_BYTES` (72-byte) header: `validator_pubkey (32) || u64be(window) || test_id (32)`, where `test_id` is fresh OS randomness (`CAP_TEST_ID_BYTES`).
2. It streams uniformly random bytes and half-closes the connection.
3. The node's sink replies with `u16be(len) || canonical(CapTestAck)` (`len <= MAX_CAP_TEST_ACK_BYTES`), signed with the **node key** under domain `cap-test-ack`:
   ```json
   {"v":0,"node":"<node pubkey hex>","validator":"<validator pubkey hex>","window":1234,"test_id":"<32-byte hex>","digest":"<CapTestDigest hex>","bytes":16777216,"sig":"<ed25519 hex>"}
   ```
   `digest` is `SHA-256("BWOS-v0/cap-test-stream" || 0x00 || stream)` over every stream byte received after the header.
4. The prober stops the clock when the ack arrives and accepts it only if it verifies under the key of the node under test (the `<node>` in `cap:<node>`) and binds exactly this test's validator, window, `test_id`, digest of the bytes sent and byte count (`CapTestAck::verify_for`). Then `throughput_mbps = bytes * 8 / elapsed_us`.

Sink availability (`MED-INFRA-01`): the reference sink (`bwos-probe cap-sink`) keeps accepting connections until one valid test completes or its overall deadline expires (`-timeout-secs`, default 4 h), so a scanner cannot use up the sink before the validator connects. It serves each connection on its own thread, closes a connection that has not sent the full header within 5 s, and serves at most 32 connections at once (4 per source IP). It sends no ack, and does not count the test, if the header validator is not a valid non-weak ed25519 key (or is not in the `-validator` allowlist, or the header window differs from `-window`) or the stream carries no bytes. The UDP echo responder (`bwos-probe echo`) likewise counts echoes per peer `ip:port` (at most `-count` each, optional `-allow <ip>`) and stops when one peer completes or at its deadline. The header is not authenticated (wire format unchanged), so a scanner that forges a well-formed header with stream bytes can still complete the one test.

A connect failure, timeout, short read, or missing, foreign or replayed ack is recorded as a failed sample (`rtt_us = 0`, `loss_ppm = 1_000_000`, `throughput_mbps = 0`), never omitted, so it counts in the rolling lower median of `capacity-bonds.md`. The prober puts the accepted acks in its `ProbeResultBatch.cap_acks`. When aggregating, every validator scores a `cap:<node>` sample that claims success (`rtt_us > 0` or `throughput_mbps > 0`) as a failed sample unless the batch carries an ack that is validly signed by `<node>`, names the batch's `validator` and `window`, and has `bytes * 8 >= throughput_mbps * rtt_us` (`ProbeResultBatch::to_metric_map`). A sink that does not hold the tested node's key therefore earns that node nothing, so N node keys cannot share another operator's real sink, and an ack cannot be replayed into a test with a different `test_id`.

Known gap (OQ-18): one operator that installs all N of its node keys on the same box can still answer N **sequential** tests with one pipe. When endpoint metadata is supplied (`TempoInput::node_diversity`), scoring pools the verified capacity of a dedupe group (IPv4 /24, or IPv6 /32 for IPv6-only endpoints) to its largest single member (`scoring.md` §Endpoint dedupe, `[T24]`), so N keys on one box earn one pipe's capacity term. A group can earn more only through a simultaneous cohort test (below).

### Team capacity tests (ADR-0039)

This is FlashFlow's method: a team of measurers, an echoed-data check, and background traffic credited up to a cap. We take the method, not the code.
- **Implementation.** Phase B Task 4Dc implements the tests and their crediting. Task 11a implements the validator identity and the quorum rules below. The validator loop, Task 19b, fills the inputs.
- **Parameters.** Every parameter here is a starting value, tuned by sim and red team.
- **Domains.** The hash and signing domains used here (`cap-team`, `cap-slot`, `cap-team-test`, `attestation-key-pop`) are registered in `encoding.md`.

**Validator identity: one hotkey, keys with proof of possession (review R2, red team RT1, round 4 RT8).** This applies to every ADR-0039 rule: team draws, the evidence quorum, endpoint aggregation, and the stake-weighted probe median (§Results and commit-reveal).
- **The key.** A validator is its SS58 hotkey. Validators are sorted by the bytes of the SS58 string.
- **Keyed by hotkey.** `TempoInput::validator_stakes`, the signed validator set (`validators` and `probe_agents`, Task 11a), `evidence::agreed_records` and `probe::aggregate_endpoints` are all keyed by the hotkey.
- **The join.** `TempoInput` gains `attestation_keys: Vec<AttestationKeyRecord>` (Task 11a), filled by the validator loop. These are the records that meet both of these:
  - **committed before the window's first block.** The validator loop (Task 19b) reads each record's commitment block from the chain. A record committed during a window counts from the next window. So no one can add or withdraw a record after seeing a window's results, and the participation floor below is fixed before the window starts (round 4 RT2);
  - `not_after` is at or after the window's first block.

  Each record binds:
  - a hotkey to the ed25519 key that signs its probe batches;
  - through `probe_wg_pub`, to its probe agent's WireGuard key;
  - through `attest: bool` (round 5 F2, `#[serde(default)]`, omitted when false), whether the key is the hotkey's attestation key for signed inputs (Task 11a).
- **When a record is valid.** All of these must hold:
  1. **The hotkey's signature.** `hotkey_sig` is the hotkey's sr25519 signature over the record, under domain `attestation-key`. It covers `attest`.
  2. **Proof of possession.** `ed25519_sig` is the ed25519 key's own signature over `wire::signing_bytes("attestation-key-pop", {hotkey, not_after, probe_wg_pub})`. So a hotkey can't claim a key it doesn't hold. Without it, a squatter could list a victim's key under its own hotkey, and the duplicate rule below would knock the victim out (red team RT1, sim `attestation_key_squatter`).
  3. **The WireGuard key is derived from a canonical key.** `probe_wg_pub` MUST equal the X25519 (Montgomery) form of the record's ed25519 key, the standard birational map, as libsodium's `crypto_sign_ed25519_pk_to_curve25519`. The proof of possession then covers the WireGuard key too. Without the derivation, a squatter could copy a victim's `probe_wg_pub` under its own valid record.
     - **Canonical and torsion-free (round 4 RT8).** The `ed25519` key MUST be a canonical point encoding (`y < p`), in the prime-order subgroup (`L·A` is the identity, so no small-order or mixed-order key), with the sign bit (bit 255 of the encoding) clear.
     - **Why the sign bit.** `A` and `−A` share `y`, so both map to one X25519 key. Only the form with the sign bit clear is accepted, so each `probe_wg_pub` has exactly one valid ed25519 key. A probe agent whose fresh key has the sign bit set generates another (two tries expected).
     - **`probe_wg_pub` is canonical too (round 5 nit).** It MUST be the canonical X25519 encoding, the 32-byte little-endian `u < 2^255 − 19` with the top bit clear, in lower-case hex, byte-equal to the derived value.
     - **An attest-only record.** A record with `attest = true` MAY omit `probe_wg_pub`. It is then no probe agent's key: no probe session is accepted from it, and `E(b)` can't use it.
  4. **Positive stake.** The hotkey has positive stake in `TempoInput.validator_stakes`, the per-window stake (review RR5). Records from zero-stake hotkeys are ignored, so free hotkeys can't create collisions.
- **Strict signatures (round 5 nit, Invariant 1).** Every ed25519 signature these rules read is verified strictly, as ed25519-dalek's `verify_strict`: canonical `S < L`, canonical encodings of `A` and `R`, small-order `A` or `R` refused, and the cofactorless equation. That covers probe batches, records' `ed25519_sig`, `cap-test-ack`s and validator-set attestations. Otherwise two validators' libraries could disagree on whether a batch counts.
- **One key, two uses (round 4 RT8, corrected in round 5 F2).** Condition 3 makes the probe agent's WireGuard private key the same scalar that signs its probe batches.
  - **A leaked probe key can't forge counted batches.** A batch counts only if it matches the hotkey's on-chain commitment, which only the hotkey can make (§Results and commit-reveal). A thief holding a probe key can impersonate that agent's probe sessions and sign batches, but none of them counts.
  - **The attest key is the real risk.** Nodes accept signed inputs on ed25519 attestations alone, and never check the chain (Task 11a). So the key of the `attest` record MUST NOT sit on a field probe box. A validator keeps it offline or on its validator host, and gives each probe agent its own non-`attest` record.
  - **Rotation.** A record can't be revoked. Validators SHOULD keep `not_after` short, and replace a suspect key by committing a new record and letting the old one lapse.
- **Mapping and duplicates.**
  - **Several records for one hotkey (round 4 RT8).** A hotkey may hold several valid records, one per probe agent, each with its own ed25519 key and `probe_wg_pub`. Each maps its own key to the hotkey. Records naming the same key under one hotkey count as one: the greatest `not_after` counts, and ties go to the lower canonical hash.
  - **One key claimed twice.** An ed25519 key, or a `probe_wg_pub`, claimed by valid records of several hotkeys maps to none of them. With conditions 2 and 3, only a key's real holder can cause that.
  - **Batch mapping.** A probe batch's ed25519 `validator` key maps to a hotkey through these records. Commitments are per hotkey, so a hotkey still reveals at most one batch per window, signed by any one of its keys. A `cap-test-ack` in that batch counts for the hotkey when the ack's `validator` key maps to the batch's hotkey, so one batch carries the tests of all the hotkey's agents.
  - **The set builder refuses duplicates.** Task 11a's set builder refuses to list an ed25519 key or `probe_wg_pub` under two hotkeys.
  - **The attestation key comes only from the `attest` record (round 5 F2).** A hotkey has at most one valid `attest` record. `ValidatorEntry.ed25519`, the key that attests signed inputs (Task 11a), is that record's key, and never a probe agent's key unless that record is flagged. A hotkey with no valid `attest` record, or with more than one, has no attestation key: it isn't listed in the signed set until it has exactly one.
- **Stake but no record.** A hotkey with stake but no valid record has no probe batches that count. It is excluded from `E(b)` and never drawn for a team. Teams are drawn from the remaining hotkeys in SS58 order, so the exclusion is deterministic. It can still sign outside evidence, which is sr25519 under the hotkey itself.
- **Before Task 11a (sim and localnet only).** With an empty `attestation_keys`, each ed25519 probe key is its own validator identity and `validator_stakes` is keyed by it, as today. The daemon's `--stakes-file` then maps probe keys.
- **Code (Task 11a).**
  - `signed::AttestationKeyRecord::verify` checks conditions 1-3, with strict ed25519 and the canonical-key rules. `signed::window_attestation_keys` keeps the records committed before the window's first block with `not_after` at or after it, and drops records that don't verify or whose hotkey has no stake, so a junk record can't switch scoring to the identity join on its own.
  - `signed::resolve_attestation_keys` applies condition 4 and the mapping and duplicate rules. A record whose key or `probe_wg_pub` is claimed by another hotkey counts for nothing, and a hotkey is *recorded* (its stake is in `recorded_stake`) when at least one of its keys still maps to it.
  - `validator::verify_and_aggregate_probes_attested` is the batch mapping. Once `attestation_keys` is non-empty, `TempoInput.probe_commitments` is keyed by SS58 hotkey, as `validator_stakes` is, and acks count through `ProbeResultBatch::to_metric_map_for_keys`.
  - `signed::build_validator_set` is the set builder.

**Quorum over recorded stake (red team RT5).**
- **What it's measured against.** `PROBE_STAKE_QUORUM_PPM`, for probe keys, endpoint aggregation and agreed evidence, is measured against `recorded_stake`: the total `validator_stakes` of hotkeys that hold a valid record. It is never measured against all stake.
- **Why.** Stake whose holders can't run probes would otherwise raise the bar until no key reaches quorum. Every node would then take missing-measurement failures, so idle stake could stall the subnet.
- **The participation floor.** A window is under-participated when `recorded_stake * 1e6 < total_stake * PROBE_PARTICIPATION_FLOOR_PPM` (500_000). Both stakes come from `TempoInput.validator_stakes`. `recorded_stake` counts only the records that count for the window, which were committed before its first block, so whether the floor applies is fixed before anyone sees the window's results (round 4 RT2).
- **The carry budget (round 4 RT2, round 5 F5).** At most `PROBE_CARRY_MAX_WINDOWS` (2) windows in any `PROBE_CARRY_SPAN_WINDOWS` (24) consecutive windows carry.
  - **Input and output.** `TempoInput.prev_carried_windows` lists the window numbers of earlier carried windows, sorted ascending. The window outputs `TempoOutcome.carried_windows`: the same list, plus this window if it carried, keeping only windows `>= saturating_sub(window, PROBE_CARRY_SPAN_WINDOWS - 1)`, so the bound never underflows near window 0. It is passed back, as `prev_endpoints` is. The first window's input is empty.
  - **When a window carries.** An under-participated window carries only if fewer than `PROBE_CARRY_MAX_WINDOWS` entries of `prev_carried_windows` are `>= saturating_sub(window, PROBE_CARRY_SPAN_WINDOWS - 1)` (`u64::saturating_sub`). This bounds consecutive carries too, and alternating above and below the floor can't restart the budget (sim `freeze_alternator`).
- **What a carried window does.**
  - **Fresh results win.** Each probe key takes this window's fresh aggregate wherever that reaches `MIN_VALIDATORS` and the quorum against `recorded_stake`. Otherwise it takes the carried value from `TempoInput.prev_aggregated_metrics`.
  - **The merged map is the output (review RR5).** The window outputs that merged map as its `TempoOutcome.aggregated_metrics`. So a second carried window carries the same values, plus any fresh ones.
  - **History.** Capacity and cohort history get only this window's fresh tests: team tests with at least `CAP_TEAM_MIN_VALIDATORS` revealed members, and `cap:` and `capcohort:` keys that reached quorum. Carried values are never appended again.
  - **No failures charged for gaps.** A key with no fresh aggregate charges no missing-measurement failure.
  - **Weights.** Weights are still set.
- **A failed probe is a value, not a gap (round 5 F5).** A probe that an agent attempted and that failed MUST be reported as a sample (`rtt_us = 0`, `loss_ppm = 1_000_000`, `throughput_mbps = 0`), never omitted. Only a probe that wasn't attempted is absent. So failures reach quorum exactly as passes do, including inside a carried window.
- **Past the budget.** An under-participated window with no carry budget left is scored fresh against `recorded_stake`, exactly as a window above the floor: nothing is carried, history is appended, and missing measurements are failures.
  - **A freeze can't shelter a node for long.** A stall, or a freeze chosen to shelter an offline node, carries at most `PROBE_CARRY_MAX_WINDOWS` windows in any `PROBE_CARRY_SPAN_WINDOWS`. Fresh failing results that reach quorum count even inside them (sims `selective_freeze` and `freeze_alternator`, Task 11a: an offline node earns at most 2 windows' credit in any 24).
  - **Honest nodes still see no failures.** Validators that hold records keep probing, and quorum is measured against their stake, so honest nodes are measured fresh past the budget too (sim `recordless_stake_staller` runs past it).
- **Before Task 11a.** With an empty `attestation_keys`, `recorded_stake` is all stake and the floor never triggers.
- **Code (Task 11a).** `validator::probe_stage` returns the merged `metrics` scoring reads, the `fresh` aggregate history is appended from, and `carried_windows`. In a carried window `run_tempo` charges no missing-measurement failure: an outgoing snapshot link with no value in the merged map isn't counted as unmeasured (`ProbeStage::evidence_links`, `evidence_link_set`), and a node with capacity and no evidence takes no failure (`ProbeStage::evidence_verified`). A carried value is used as a value, pass or fail. Endpoint aggregation and agreed evidence don't exist in code yet; Tasks 4Db and 4C measure their quorums against the same `recorded_stake` (`signed::AttestationKeys::recorded_stake`).

**Two stake sources (review RR2).**
- **The team draw.** `E(b)` and the team draw use `ValidatorEntry.stake` from the signed validator set in force at block `b` (Task 11a). It is the same input every validator, and every probe agent in real time, holds for block `b`.
- **Everything else.** `TempoInput.validator_stakes` is the metagraph stake the validator loop reads once per window, and it is what the probe median, the quorums, the participation floor and record validity condition 4 use. Both are keyed by SS58 hotkey, and both are filled by Task 19b from the chain.
- **They may differ.** Stake moves within a window. Each rule names its source, so validators never disagree about which one applies.

**Inputs scoring needs to recompute every team (reviews R1, RR1).** `TempoInput` gains these fields, all filled by the validator loop (Task 19b), so every validator recomputes the same teams:
- `block_hashes`: `BTreeMap<u64, String>`, holding the hash of every block from `window_first_block - CAP_TEST_BLOCKS` to the window's last block.
- `validator_sets`: the signed validator sets in force over the same span. The set in force at block `b` is the one with the highest `block <= b`.
- `prev_cap_assignments`: the team assignments of tests that started in the previous window's last `CAP_TEST_BLOCKS - 1` blocks. Each entry has the subject, the block `b`, the team's hotkeys and each member's rate.
  - They are carried as `TempoOutcome.cap_assignments_open` and passed back, as `prev_endpoints` is.
  - They give the slot state at the start of the window, so the schedule never has to be recomputed from earlier windows.
  - For the very first window the starting state is empty.

**Which window a test belongs to.** A test due at block `b` ends at block `b + CAP_TEST_BLOCKS - 1`. It is recorded in the batch of the window containing that block. So a test that starts in a window's last `CAP_TEST_BLOCKS - 1` blocks counts in the next window, and none is dropped at a boundary.

A `capteam:<n>:<b>` sample counts only if all of these hold:
- `b + CAP_TEST_BLOCKS - 1` lies inside the batch's window;
- `n` was due at `b` (§Capacity tests, using `block_hashes[b-1]`), and isn't a member of a cohort due at `b`;
- the batch's hotkey is in `team(n, b)`, as recomputed below or carried in `prev_cap_assignments`.

Unscheduled or foreign samples are refused. They count for nothing, neither as a pass nor as a failure.

**Eligible validators.** `E(b)` is the set of hotkeys in the validator set in force at `b` that meet all of these.

Which sets scoring trusts (Task 4Dc fix rounds 1-2, red team F6, N2, review R10; `validator::verified_set_chain`): the walk starts from `TempoInput.prev_validator_set`, the set in force at the previous window, which the validator loop takes from chain state (Task 19b) and which scoring trusts as given; with signed sets and no anchor, `E(b)` is empty. From the current trusted set, a set is taken only if `signed::accept_next_set` accepts it: a higher block at most `MAX_SET_ADVANCE_BLOCKS` ahead and not past the current set's `not_after` (Task 4Dc fix round 3, red team R6: an expired set accepts no successor, where nodes re-anchor), attested by a `SIGNED_INPUT_QUORUM_PPM` quorum of the current set's stake. So an unattested or self-signed set can neither anchor nor veto, and a set at or below the anchor's block is ignored. Two different sets the quorum accepts at one block mean it equivocated: both are refused, the current set stays, and later blocks are judged from it. The set in force at `b` is the last trusted one with `block <= b`, and only while `b <= not_after`; past it `E(b)` is empty.
- `ValidatorEntry.stake > 0`;
- they hold a valid attestation-key record;
- they have a `probe_agents` entry whose `probe_wg_pub` is in one of their valid records, with a per-test share budget `cap_share_budget_mbps >= CAP_SHARE_BUDGET_MIN_MBPS` (1_000). The budget is the most one agent will push to one node in one test, `2_500` Mbps for the reference validator.
  - **Several agents.** A hotkey with several such entries has the largest of their budgets, and runs its share from that agent. Ties go to the lower `probe_wg_pub`.
  - **Why the floor (review RR3, round 4 RT6).** A member with a tiny budget caps the team's rate, which under-credits the node, yet still casts a full vote in the median of per-member ratios. With the floor, a team of `k` always pushes at least `min(R, k * CAP_SHARE_BUDGET_MIN_MBPS)` (sim `low_budget_griefer`).
  - **What the floor still allows (round 5 nit).** A validator at the floor still caps the teams it sits on. With about 16% of eligible stake it sits on most of a node's teams (§Residuals), so it holds a 10 Gbps node at about 0.85x in the lower median: `1_000 + 3 × 2_500 = 8_500` Mbps. The node is under-credited, never haircut, because `pushed` follows the cap.

Until signed validator sets exist (sim and localnet only), `E(b)` is:
- the validators in `validator_stakes` with positive stake, drawn by that stake, and once `attestation_keys` is non-empty only hotkeys holding a valid record (review R8);
- or, with an empty map, the validators whose batches were revealed in the previous window, each weighing 1 (not in code: scoring has no such input yet, so with an empty map and no sets no team test is scheduled, OQ-92);

each with an unlimited budget.

**Test rate: the ramp (red team RT4, RT5).**

```
R(n) = min( ceil(declared(n) * 1000 * (1e6 + CAP_TEST_HEADROOM_PPM) / 1e6),
            (2 * verified_prev(n) + CAP_RAMP_FLOOR_MBPS) * 1000 )              in kbps
```

Rates and budgets are in kbps (Task 4Dc fix round 1, OQ-91), so a small node's shares aren't rounded to whole Mbps: a budget of `B` Mbps is `B * 1000` kbps (`probe::test_rate_kbps`, `probe::budget_kbps`).

- **What `verified_prev` is.** The node's verified capacity in the previous window's outcome, and `0` for a new node.
- **Headroom.** `CAP_TEST_HEADROOM_PPM` (100_000) pushes 10% above the declaration, so a small node's packet overhead doesn't keep it below 90% of declared (sim `small_declared_honest`).
- **The ramp.** `CAP_RAMP_FLOOR_MBPS` (100) and the doubling mean a node can raise its tested rate only as fast as it proves capacity. A flood of huge declarations therefore can't use up validators' budgets (sim `declared_flood_cotest`).
  - Verified capacity is a rolling lower median, so it rises a step only after a few tests at the new rate.
  - An honest new 10 Gbps node therefore reaches its declaration in roughly twenty tests, a few days at the default `CAP_TEST_PERIOD`. That cost falls on new nodes only.

**Slots, order and per-UID cap (reviews R4, RR1; re-review breakage 2).**
- **Slots.** A team test due at `b` occupies each member for `CAP_TEST_BLOCKS = ceil(CAP_TEST_SECS / BLOCK_SECONDS)` blocks (5), from `b` to `b+4`. A validator has a free slot at `b` while fewer than `CAP_TEST_MAX` of its assigned tests overlap `b`. Tests in `prev_cap_assignments` count.
- **Order.** Blocks ascending. A test is in one of three tiers:
  1. cohort tests;
  2. node tests with `verified_prev > 0`;
  3. node tests with `verified_prev = 0`.

  Each due test has

  ```
  slot_key = SHA-256("BWOS-v0/cap-slot" || 0x00 || block_hash(b-1) || subject)
  ```

  from the block `b` it fell due at. It is never the subject itself, which could be ground. The block hash isn't known until block `b-1`.
- **Waiting (Task 4Dc fix rounds 1-2, red team F3, review minor 3).** A due test waits until it starts, at most `CAP_TEST_DEFER_BLOCKS` (4) blocks after it fell due and never past the window's last block; then it is skipped, neither a pass nor a failure. A test that doesn't start at a block keeps waiting; it is never dropped for that. It is dropped only when its waiting ends (above), or when it is a tier-3 test over the per-UID cap (below). A test's `b` (its sample key, `test_id`, team seed and slots) is the block it starts at.
- **Capacity-weighted round-robin by UID, all tiers (Task 4Dc fix rounds 1-4, red team F3, N3, N4, R1, R2, E1, E2).** At each block, while at least `CAP_TEAM_MIN_VALIDATORS` validators are free, every waiting test is tried once, by the smallest `(t_uid / weight_uid, tier, due block, slot_key)`:
  - `t_uid` is the number of tests of the UID, of any tier, cohorts included, that already count in the window this test would count in (below), updated after each start;
  - `weight_uid` is the UID's summed **pooled** previous capacity (Task 4Dc fix round 3, red team R2): each node's `TempoInput.prev_pooled_capacities`, the previous window's `TempoOutcome.pooled_capacities`, the endpoint-deduped, cohort-credited, policy-capped figure pay uses (`capacity-bonds.md` §Endpoint dedupe). So 1024 keys at 5 Mbps weigh like one 5 Gbps node, a 200-node 1 Gbps fleet like 200 Gbps, and N keys on one box like the box: unpooled per-node figures let co-located keys verified one after another weigh up to 64x their box (sim `colocated_flood_weight`). A node missing from the map weighs 0;
  - the weight applies pay's rules (Task 4Dc fix round 4, red team E1, T114; `validator::schedule_weights`). **With endpoint dedupe on**, a node with no committed endpoint weighs **0**, as it adds nothing to `K_u` (§Dedupe, "Fail-closed"): a box showing two /24s to split validators, so that no prefix wins, no longer keeps each key's full unpooled figure. **With dedupe off** (no endpoint quorum; in production until the endpoint producer, PB-06), nothing says which keys share a pipe, so each UID weighs its **lower-median** node's figure (Task 4Dc fix round 5, red team A1, T124): the UID's nodes ordered by `(figure, key)`, the one at index `(n - 1) / 2` keeps its figure and the others weigh 0. That is one pipe, never the sum, and not the largest, which one anchor key per UID would set. A 200-node honest fleet then weighs one 1 Gbps node. Team mode doesn't run with dedupe off (§Team capacity tests, "Team mode MUST NOT run with endpoint dedupe off"), so this branch is defence in depth. "Dedupe on" here means a non-empty `node_diversity`; `bwos-validator` always builds it from `tempo_node_diversity`, empty below the stake trigger, so only a hand-built input below the trigger is treated more strictly than `K_u` (red team C3, T126);
  - the weight is at least `CAP_RAMP_FLOOR_MBPS` per unproven node (`declared > 0`, `verified_prev = 0`), counting one up to `CAP_TESTS_PER_UID_MAX` of them (red team R4), so a new operator with several nodes isn't held to one node's turns. Splitting into UIDs adds at most the same floor per registered UID;
  - a cohort test counts against every member's UID and is keyed by the **smallest** `t_u / (weight_u · m_u / N_u)` over its members' UIDs `u`, where `m_u` is u's members in the cohort and `N_u` is u's schedule nodes (Task 4Dc fix rounds 3-4, red team R1, E2): a cohort behind a carrier /24 of many operators takes its least-tested member's turn (single-node UIDs have `m_u = N_u = 1`), rather than waiting until every member is at the lowest level, but a UID lends a cohort only its **per-node** weight. Keyed by a member UID's whole weight, one attacker key in each of a 200-node fleet's /24s made 200 two-node cohorts that ran at the fleet's turn and were charged to it (fleet node tests 0.67, singles 0.86, fresh 0.57; sim `cohort_ride_along`, T115). Packaging keys as cohorts still doesn't bypass the round-robin, because every member's UID pays for the test;
  - fractions are compared cross-multiplied in `u128` (a cohort's as `(t_u · N_u, weight_u · m_u)`).

  So a UID competes by its verified capacity, not its key count, and proven tests still go before unproven ones of the same UID.
- **Holding (Task 4Dc fix rounds 2-3).** A test that can't start because a drawn member isn't free holds its drawn members that **are** free and not already held, for the rest of that block only:
  - held validators don't count as free, either for the loop's "at least `CAP_TEAM_MIN_VALIDATORS` free" guard or for later tests' draws, where a held drawn member counts as busy;
  - a test that fails for any other reason (`|E(b)| < CAP_TEAM_MIN_VALIDATORS`, no non-zero rate) holds nothing, and a tier-3 test over the per-UID cap is dropped before it is drawn;
  - a test at its last chance with fewer than `CAP_TEAM_MIN_VALIDATORS` free holds its free drawn members for that block, then is dropped when its waiting ends;
  - holds never carry to the next block, where every draw is made afresh.
- **Per-UID fairness (bounds; Task 4Dc fix rounds 3-4, red team R3, E1, E2).** Tests run / tests due, gated on the worst of 3 seeds × 4 windows (`make sim-flood`; `make sim` runs a one-seed smoke). Figures are worst seed (mean). Flood UIDs of 1024 proven 5 Mbps keys, against 40 single-node honest UIDs, a 200-node honest 1 Gbps fleet and an honest UID of 4 fresh nodes (sim `proven_sybil_slot_flood`, T104, T110):
  - **at most 8 flood UIDs at 8 or more validators:** every honest proven UID, single-node or fleet, at least 0.85 (measured single / fleet: 4 UIDs at 8 validators 0.92 (0.94) / 0.87 (0.90); 8 UIDs at 8 0.90 (0.90) / 0.86 (0.89); 8 UIDs at 16 0.95 (0.97) / 0.95 (0.96));
  - **at most 16 flood UIDs at 8 validators:** at least 0.80 (16 UIDs 0.85 (0.85) / 0.84 (0.86); 12 UIDs packaged as cohorts behind one /24 0.88 (0.91) / 0.89 (0.91): with cohorts keyed by per-node weight the flood's cohorts go last, so it competes as node tests);
  - **at most 12 flood UIDs at 6 validators:** at least 0.75 (12 UIDs 0.82 (0.82) / 0.80 (0.82)). 16 flood UIDs at 6 validators are outside the bound and not gated: the red team measured 0.72 / 0.76 on the worst seed;
  - **fresh UIDs, an entry delay (review B3, re-ruled):** at least 0.5 under 4 flood UIDs and at least 0.33 under 8 to 16, worst seed (measured 0.33-0.80, mean 0.44-0.93). Turns by capacity leave a 4-node new UID about a third of its due tests while 8 or more UIDs flood, so its first test can come about 6 windows after it joins. It is a delay before a new node's first test, not a pay loss: a node is paid on what it is verified at once tested;
  - **outside the bounds:** 4 validators give about 0.70 under a flood, and 0.89-0.93 with no flood at all; each flood UID costs a registration;
  - **co-located keys (red team R2):** 4 flood UIDs of 1024 keys on one box, verified at 200 Mbps each by sequential tests, weigh their pooled capacity: honest single-node UIDs 0.93 (0.95), fleet 0.89 (0.89), fresh 0.75 (sim `colocated_flood_weight`, bounds 0.85, fresh 0.5);
  - **endpoint-less keys (red team E1, T114):** the same box showing two /24s to split validators, so its keys have no endpoint, 4 and 8 flood UIDs at 200 Mbps a key, with dedupe on: single 0.93 (0.95) / 0.92 (0.94), fleet 0.89 (0.89) / 0.86 (0.88), fresh 0.75 (unfixed: fleet 0.51 / 0.30, singles 0.78; sim `endpointless_flood_weight`, bounds 0.85, fresh per above);
  - **dedupe off: team mode isn't enabled, so these bound only the schedule weight (red team A1, review B4, T114, T124).** The same floods with dedupe off: 4 UIDs single 0.95, fleet 0.86 (0.88), fresh 0.80; 8 UIDs single 0.92, fleet 0.82 (0.83), fresh 0.80 (fleet gated at 0.80). With one anchor key of 1 or 10 Gbps per flood UID among 5 Mbps keys, the lower-median weight holds the fleet at 0.87 (0.88) under 4 UIDs and 0.84 (0.86) under 8 (gated 0.85 and 0.80; with the largest node as the weight it was 0.51 / 0.30 at 1 Gbps and 0.07 / 0.04 at 10 Gbps). With **every** flood key verified at 1 Gbps by sequential tests on one box (OQ-18), no per-UID statistic helps: fleet 0.50 (0.51) under 4 UIDs and 0.29 (0.30) under 8, gated at 0.45 and 0.25 (sim `dedupe_off_anchor_weight`). That is why team mode needs endpoint dedupe;
  - **ride-along (red team E2, T115):** one 5 Mbps attacker key in each of the fleet's /24s, 200 two-node cohorts: single 0.95 (0.96), fleet node tests 0.92 (0.94), fresh 0.75 (0.83); the riders' cohorts run at 0.43 of due (sim `cohort_ride_along`, bounds 0.85, 0.85, fresh 0.5);
  - **multi-operator cohorts (red team R1; review B2, re-ruled):** 10 cohorts of 15 home nodes of 50 Mbps from 150 operators: due cohort tests run 0.91 mean, 0.88 worst seed with no flood (bounds 0.9 mean, 0.85 worst seed), and under the 4 × 1024 flood 0.83 mean, 0.76 worst seed (bounds 0.80 and 0.75; sim `cgnat_cohort_turns`). The bound under the flood is below the 0.85 of node tests because the shortfall is sampling noise: only about 16 cohort tests fall due per seed, so a seed's share moves by about ±0.1 (T111). What pay sees doesn't move: cohort credit lapsed in 9 of 240 cohort-windows with no flood, under 4 × 1024, under 16 × 1024 at 8 validators and under 12 × 1024 at 6 alike, and in each case no cohort test had even fallen due in those 8 windows (red team round-3 re-check, T116(a)). Small-node operators compete by capacity, so a cohort's members, each weighing the ramp floor, are behind larger UIDs once each has had its own test.
- **Per-UID cap.** At most `CAP_TESTS_PER_UID_MAX` (4) tier-3 tests per UID count in a window.
  - **Which window.** A test counts in the window it ends in (§Which window a test belongs to). Tests carried in `prev_cap_assignments` therefore start that window's count (review RR5).
  - **Over the cap.** A further tier-3 test of that UID is skipped, which is neither a pass nor a failure.
- **Why.** Nodes that have proved capacity are never crowded out of slots by fresh zero-capacity keys, nor by one UID's many proven tiny keys. One operator's new keys take no more tier-3 slots than any other UID with due tests, and never more than the cap (sim `zero_cap_slot_crowder`, threat-model T48). The cap applies only to unproven nodes, so a large proven fleet is tested at its full rate.
- **The team: drawn from all of `E(b)` by stake (Task 4Dc fix round 2, red team N1).** At each block a waiting test is tried, its team of `min(CAP_TEAM_MAX_VALIDATORS, |E(b)|)` is drawn by stake from **all** of `E(b)`, with that block's seed (`probe::draw_free_team`). Drawn members that aren't free (a full slot, or held) are dropped. The test starts if every drawn member is free, or, at its last chance (its last waiting block, or the window's last block), if at least `CAP_TEAM_MIN_VALIDATORS` are; otherwise it keeps waiting. A hotkey's chance of a seat is therefore its stake's, never its slot count's: drawing only among free validators let 32 hotkeys at 3.85% of stake fill whole teams under load (all-attacker teams on 73% of tests, sim `validator_hotkey_overflow`, now 0). Waiting for the whole drawn four until the last chance keeps teams of three rare for honest nodes.
- **A last-chance team of three can only lower (Task 4Dc fix round 3, red team R5).** A test that starts at its last chance with a drawn member dropped (`CapAssignment.short`) records its `team` capped at `max(verified_prev, CAP_RAMP_FLOOR_MBPS)`: it can lower a node's verified capacity, never raise it; its `ratio_t` counts as usual. A node in a flood UID late in the queue starts at its last chance on most tests, and teams of three are 31-62% of its tests (honest 1-9%), so without the cap one colluder on them gave 2x (sim `late_queue_short_team`; tests `a_last_chance_start_with_three_of_four_free_is_short`, `a_short_assignment_is_capped_through_the_stage`).
  - **A short cohort test's aggregate is capped too (Task 4Dc fix round 5, red team L3, B1(a), T125).** Its `cohort_tests` entry is recorded at most `Σ max(verified_prev(n), CAP_RAMP_FLOOR_MBPS)` over the cohort's members (`validator::short_capped_cohort`), the per-node cap summed. For co-located keys each verified at its own rate by sequential tests the sum is far above the box (16 keys at 200 Mbps: 3.2 Gbps), so there the bound is the two-sample rule (§Cohort capacity tests item 5), not this cap.
  - **A node is never skipped for being fast (red team RT2).** Budgets don't decide eligibility. They cap the rate below.
- **Determinism.** Every validator computes the same assignment from committed inputs (`probe::team_schedule`).

**Team draw.** The draw is stake-weighted, without replacement, in integers only, using `ValidatorEntry.stake` at `b`, over all of `E(b)` with `k = min(CAP_TEAM_MAX_VALIDATORS, |E(b)|)` (vectors: `testdata/vectors/cap_team.json`):

```
seed      = SHA-256("BWOS-v0/cap-team" || 0x00 || block_hash(b-1) || subject)
            subject = the node's 32-byte key (node test) or the 32-byte cohort_id (cohort test)
remaining = E(b) in SS58 hotkey order
for j in 0 .. k-1:
    total = Σ stake over remaining                                  (u128)
    r     = u128be(SHA-256(seed || u32be(j))[0:16]) mod total
    pick the first validator in remaining whose cumulative stake > r; remove it from remaining
```

**Member rates, capped by the team's budgets (red team RT2).** The team can push at most `R_team = min(R, Σ_i cap_share_budget_mbps_i)` over its members, in kbps. It is split by water-filling, which is deterministic: take members in ascending order of budget, then hotkey, and give each `rate_i = min(budget_i, ceil(remaining_R / members_left))`, then subtract it from `remaining_R`.
- **Zero rates are dropped (round 4 RR3, RT6).** A member whose `rate_i` is `0` (possible only when `R` is smaller than the team) is removed from the test before slots are taken. It streams nothing, holds no slot, and has no sample and no vote in the median.
- **A node faster than the team can push** is tested at `R_team`. `pushed` follows that cap (below), and it is verified at what the team measured.
- **So it is never untestable.** It can't shelter old history by being too fast (sim `untestable_shelter`).
- **The cost.** A node faster than `Σ` budgets (10 Gbps at the default four 2,500 Mbps budgets) is under-credited until validators raise their budgets.

**Each member's stream.**
1. **Connection.** The member's agent opens a capacity-test connection to the node's overlay address, inside the source-matched probe session the node opened to that agent (§STAMP probes and probe sessions). It sends the 72-byte request header as in §Capacity tests. **Until Task 18b** the reference agent (`bwos-probe cap --team`) connects to the node's echoing sink (`cap-sink -echo`) directly; that is a localnet and test harness only (below).
2. **Test id (review R5).** The member declares the test in its batch's `cap_teams`: `[{"node":"<hex>","block":b,"nonce":"<32-byte hex>"}]`, sorted and unique by `(node, block)`, omitted when empty. The header's `test_id` is:

   ```
   SHA-256("BWOS-v0/cap-team-test" || 0x00 || node_key || u64be(b) || nonce)
   ```

   The ack must carry it.
3. **Start and rate.** On first seeing block `b`, it streams for `CAP_TEST_SECS` at `rate_i` kbps.
4. **Content.** The stream is a keystream only the member can regenerate, for example ChaCha20 under a fresh private key.
5. **Echo.** The node's sink writes every stream byte back on the same connection, in order, as it receives it. Once the member has half-closed and the sink has echoed every byte, the sink sends `u16be(len) || canonical(CapTestAck)`. The ack's `digest` and `bytes` cover every stream byte received.
6. **Echo check.** The member splits the echoed stream into blocks of `CAP_ECHO_BLOCK_BYTES` (4_096) and checks each block with probability `CAP_ECHO_CHECK_PPM` (10_000), using its own OS randomness. It draws that randomness after the block was sent and never discloses it.
   - **Why it's hard to fake.** A node that corrupts or skips a fraction `f` of the blocks passes with probability `(1 - CAP_ECHO_CHECK_PPM / 1e6)^(f * blocks)`, which is about 1% for `f = 1e-4` over a 2.5 Gbps, 60 s share.
   - **Why echo everything.** The test then measures the lower of the node's downlink and uplink.
7. **Member sample.** The member records `capteam:<node>:<b>`, with these fields:
   - `rtt_us`: elapsed time from the first stream byte sent to the last echoed byte received;
   - `throughput_mbps`: `floor(echoed_bytes * 8 / rtt_us)`, informational;
   - `loss_ppm`: the share of checked blocks that failed;
   - `jitter_us`: `0`.

   The ack goes in `cap_acks`. A connect failure, timeout or missing ack is a failed sample. **A short echo is a failed sample (Task 4Dc fix round 1):** the member records an echo-OK sample only when the echoed bytes equal the bytes it sent and `ack.bytes`, so scoring reads `m_i` from the ack.

**Echo OK.** A member's result is echo-OK when all of these hold:
- `rtt_us > 0` and `loss_ppm == 0`;
- the batch carries an ack that verifies under the node's key for this member's validator, the window and the derived `test_id`. The window is the one holding the test's last block `b + CAP_TEST_BLOCKS - 1`, the batch's window, so a node's sink MUST accept that window for a test that starts in the window before;
- `ack.bytes * 8 >= throughput_mbps * rtt_us`.

**Combining (red team RT3; round 4 RR1, RT1, RT5; round 5 A, D; Task 4Dc fix round 1, red team F1, F2, F9, OQ-91, OQ-93).** Combining is pure and deterministic: `probe::team_capacity_mbps(declared, members, S, background_mbps, background_in_team)`. `members` lists each member with `rate_i > 0` that revealed a batch for the window (`k'` of them), with its hotkey, `rate_i` and result. `S` is the summed rates of the **whole scheduled team**, every member with `rate_i > 0`, revealed or not (`CapAssignment::scheduled_kbps`). All arithmetic is `u128` in kbps, every division floors, `1e6` is the integer `1_000_000`, and `team` is floored to whole Mbps once at the end.

```
m_i         = floor(8 * ack.bytes * 1000 / rtt_us) if echo-OK_i else 0     kbps, exact from the ack
                                                    (no sample in a revealed batch: 0)
c_i         = min(m_i, rate_i)                      capped share, so a member's ratio is at most 1
j           = the revealed member at index (k'-1)/2 when sorted ascending by c_i / rate_i,
              compared exactly as c_a * rate_b vs c_b * rate_a, ties to the lower hotkey   (the lower median)
S           = Σ rate_i over the whole scheduled team (never less than the revealed members' sum)
pushed      = min(declared, S)                      the share of it the node is judged on
median      = c_j * S / rate_j                      the k·lower_median term, generalised to unequal rates
measured    = min(Σ c_i, median)                    Σ over the revealed members, capped shares
bg          = min(background, measured * CAP_BACKGROUND_MAX_PPM / (1e6 - CAP_BACKGROUND_MAX_PPM))
team        = min(declared, measured + bg)   if background_in_team
            = min(declared, measured)        otherwise (before Task 12b, §Background traffic)
            then floored to Mbps
ratio_t     = min(1e6, (c_j * S + bg * rate_j) * 1e6 / (rate_j * pushed))   only if k' >= CAP_TEAM_MIN_VALIDATORS
a test with k' < 2, or pushed = 0, isn't a sample
```

- **Capped shares in the sum (red team F1, T103).** `measured` sums `c_i`, never `m_i`. A member's result is batch input, and a colluder with a node-signed ack can report any `m_i`; with an uncapped sum one colluder plus a starved honest member gave 1.82x at `k = 4`. An honest member's `m_i` never exceeds `rate_i`, since its stream is paced, so honest nodes lose nothing.
- **The whole scheduled team (OQ-93, closed).** A member that streamed but revealed no batch is dropped from `Σ c_i` and the median, never from `S`: the node spread its capacity over every scheduled stream, headroom included, so it is judged on all of it. This rule is safe only with capped shares: with an uncapped sum, two absent members and one colluder gave 3.64x (sim `withholder_fix_k2_colluder`, now 1.64x, bound 2x).
- **Exact units (OQ-91, closed).** Rates are water-filled in kbps and `m_i` is exact from the ack, so a 20 Mbps node's 5.5 Mbps shares aren't rounded to whole Mbps (sim `small_declared_honest`: at least 0.99x of goodput in kbps from 20 Mbps up). `team` is floored to Mbps once, so a small node's credit can still lose up to 1 Mbps to that floor: about 0.90x of goodput at 10 Mbps, 0.95x at 20 Mbps and 0.97-0.99x at 30-50 Mbps (red team N7, a documented residual; kbps credit is at least 0.9996x).

- **No intermediate floor (round 5 A).** `ratio_t` is computed from the median member's own numbers in one division, so rounding can't push an honest node below `1e6`. The median member's per-member ratio, `c_j * 1e6 / rate_j`, is never floored on the way.
- **Worked example.** `declared = C = 1000`, so `R = ceil(1000 × 1.1) = 1100` Mbps (1_100_000 kbps), split as four members at 275. The node carries 1000, so each member gets `m_i = 250`. Then `S = 1100`, `pushed = 1000`, `median = 250 × 1100 / 275 = 1000`, `measured = min(1000, 1000) = 1000`, and `ratio_t = 250 × 1100 × 1e6 / (275 × 1000) = 1e6` exactly (the same in kbps). Floored per-member ratios would have given `909_090`, then 999 Mbps and `999_000`.
- **Headroom never counts against an honest node (round 4 RR1, RT1).** The members stream about `1.1 × declared` (`CAP_TEST_HEADROOM_PPM`, capped by budgets), but the ratio's denominator is `pushed = min(declared, sent)`, while `median_mbps` scales the median ratio by everything sent. A node that carries its declaration has `ratio_t = 1e6`, as in the example. Under-declaring gains nothing: a node of real capacity `C` that declares `C / 1.1` is credited `C / 1.1` (sim `headroom_underdeclarer`, at most 1.0x).
- **Recorded.** The test goes into the node's rolling capacity history as `(team, pushed, ratio_t)`. A test where `k' < 2` (red team F9: one revealed member's value would decide the test alone), or where `pushed = 0`, isn't a sample.
- **Small reveal sets (round 4 RT5, round 5 D).** With `k' = 2`, `measured` still takes the median term, so a test can't be inflated past what the lower of the two members saw. A test with fewer than `CAP_TEAM_MIN_VALIDATORS` (3) revealed members produces no `ratio_t`. It is recorded as `(team, pushed, none)`: it counts in `measured`, but not in the haircut's `ratio` (`capacity-bonds.md`). With so few members, one member's value would decide the haircut.
  - **The `k' = 2` bounds.** With two revealed members the lower median is the smaller one. One colluding member that reports its full share lets a node that serves only the honest member in full be credited the two shares, 2x of what it carried at equal shares (sim `withholder_fix_k2_colluder`). One griefing member that zeroes its sample zeroes the test. Either needs the test to be down to two revealed members, from members that withheld or a team of 3 with one member gone.
- **The haircut reads `ratio_t`, which comes from the median, never from `Σ` (red team RT3).** A minority of members can therefore neither force a haircut by zeroing or omitting their samples nor lift one. It moves the median, and so the haircut, only with at least half of the revealed members.
  - **The griefer's bound.** A griefing member lowers `Σ`, and with it `measured`, by at most its own share `rate_i / S`. On a team of `k` equal shares the victim keeps `(k−1)/k`: 0.75x at `k = 4` and 0.67x at `k = 3`. At `k = 3` a withheld batch also leaves 2 revealed members, so the test gives no `ratio_t` (sim `sample_omission_griefer`).
- **Members that reveal nothing (red team RT6; restated in Task 4Dc fix round 1).** They are dropped from `Σ` and the median, without rescaling, but stay in `S` and so in `pushed`. **Withholding never haircuts an honest node** (sim `withholding_near_declaration`: a node at 97% of its declaration keeps 0.75x, never haircut), and **never lifts a node above an honest declarer of its real capacity** (sim `void_by_withholding`, swept over real capacity 500-1000 of a 1000 declaration: at most 0.88x). A colluding withholder that lets the node put all its capacity on the honest members can lift a haircut a node would otherwise take; its gain stays within T42(b).
- **Why the sum stays in `measured`.** A node can't gain by throttling one honest member to give the others room: a throttled member only lowers `Σ c_i`. With a colluder on the team it can, within the residual below.
- **Echo failures.** A node that fails the echo check for at least half the members has a median ratio of 0.
- **Reporting.** `capteam:` keys are combined by this rule and never median-aggregated across validators.

**Background traffic (controller ruling 2, red team RT4; round 4 RR2, RT3, RT4; round 5 B, C, F1, F3).** As in FlashFlow, traffic the node keeps carrying during a test is credited, up to a cap, so a busy honest node isn't haircut. `background_mbps(n)` is never the node's own report. It comes from co-signed hop receipts with peers of other UIDs on production-table paths. **Gated until PB-38 (Task 12b fix round 2, red team H1).** `probe::BACKGROUND_IN_TEAM` is `false`: background is each stream's window average and lifts only `ratio_t`, never `team`, exactly as before Task 12b, and `validator::tempo_team_stage` enforces it whatever `TempoInput` holds (sim `gate_holds_in_run_tempo`, run through `run_tempo` in team mode). The receipt-run rule below is built and tested on the gate-on path (`tempo_team_stage_gated`, sims only) but scores nothing. **Background in `team` will come only from canary or digest-verified carriage (PB-38, ADR-0051, ADR-0053)**, because counted hop bytes, even transit only, can be junk a node or its sybils push through assigned hops (red team H2, sim `sybil_uid_background`); only PB-38's change may turn the gate on.
- **The cap, both before and after.** `CAP_BACKGROUND_MAX_PPM` (250_000) limits `bg` to a quarter of `measured + bg`, so at most a third of what the team measured.
- **In force until PB-38: the window average, in the ratio only.** Task 4Dc introduced it, and Task 12b keeps it while the gate is off: the window average, `floor(Σ_streams Δbytes_window * 8 / (WINDOW_BLOCKS * BLOCK_SECONDS * 1e6))`, where `Δbytes_window` is the change in the cumulative counters across the window's co-signed receipts of that stream. It calls `team_capacity_mbps` with `background_in_team = false`.
  - **In `ratio_t`, never in `team`.** So a busy honest node isn't haircut: carrying a quarter of its capacity, it is verified at what the team measured, about 0.75 of declared, with no haircut (sim `busy_honest_pre12b`).
  - **Over-declaring still pays at most 1.0x.** Credit is `min(declared, measured)`, what the team measured, however the background is timed. A window average can lift only the ratio, never the credit (sim `bg_priority_overdeclarer`).
  - **Stalling during tests (round 5 F3, residual until Task 12b).** A busy node that stalls its routed traffic during each test is measured at its full `C`, while a busy honest node that keeps serving is credited about `0.75 C`. The staller gets no more than an idle honest node of the same capacity, but it is paid more than a busy honest one. `busy_honest_pre12b` reports both (T42(g), T44).
- **Each node or cohort, both paths (red team H3).** A node's background is `max(Σ in, Σ out)` over its streams, `in` those it is `down` of and `out` those it is `up` of, so a relay carrying `R` through is credited `R`, not `2R` (`validator::background_mbps`, sim `relay_direction_double_count`). A team cohort counts each stream crossing its boundary once and skips a stream whose other end is in its dedupe group, traffic that never crosses the shared uplink (`validator::cohort_background_mbps`, sim `cohort_internal_stream`).
- **PB-38's gate-on path, not scored: in-test intervals of receipt runs, in both.** In code: `validator::background_streams` collects each window's cross-UID production streams from the batches that verify, `validator::test_background_mbps` sums a node's streams at its test's block, and `probe::stream_background_mbps` reads one stream under the rules below (`CAP_BACKGROUND_GAP_BLOCKS` = 3, `CAP_BACKGROUND_SPAN_BLOCKS` = 11). A cohort's background is its members' sum. Task 12b adds an optional `block` field to hop receipts: the latest block the proposer has seen, accepted by the co-signer only at or one below its own view, never ahead of it (OQ-106 (a)). Receipts are co-signed every `RECEIPT_INTERVAL` (30 s). Then `background_in_team = true`, and background is computed per stream, a `(window, up, down)` pair in which the node under test is `up` or `down` and the other node is of another UID:
  - **The bracket.** `before` is the stream's last counted receipt with `block <= b`, and `after` its first with `block >= b + CAP_TEST_BLOCKS - 1`.
  - **The run (round 4 RT4, round 5 B).** The node's batch MUST carry every counted receipt of the stream from `before` to `after` (Task 12b), with `seq` strictly increasing. A counter-proposal's `seq` jump (`receipts.md` §Hop receipts) is allowed and doesn't break the run, provided each receipt in the run is the dominant one for its `seq`: fully signed, and the only byte vector for that `seq` (`select_window_receipts`). Receipts with the same `block` count as one point, the later one.
  - **Same window (round 5 C).** `before` and `after` MUST carry the same receipt `window`, because counters are cumulative within a window. A test whose bracket crosses a window boundary is scored in the window its last block falls in, as every test is, under the bracket rule: its stream adds 0. The window average is never a fallback after Task 12b, so the node can't pick the rule (round 5 C, red team F4). The cost: an honest busy node loses background in tests near a boundary, at most about `(CAP_TEST_BLOCKS + 6) / WINDOW_BLOCKS`, 3% of its tests, too few to move its lower medians.
  - **Tight intervals (round 5 F1).** Every consecutive pair of points in the run MUST be at most `ceil(RECEIPT_INTERVAL / BLOCK_SECONDS)` (3) blocks apart, and `block_after - block_before <= CAP_TEST_BLOCKS + 2 * ceil(RECEIPT_INTERVAL / BLOCK_SECONDS)`. A dropped or delayed receipt therefore shows as a wide interval.
  - **The rate is the slowest in-test interval (round 5 F1).** For each interval between consecutive points `p` and `p+1` that overlaps the test (`block_p < b + CAP_TEST_BLOCKS` and `block_{p+1} > b`), `rate_p = floor(Δbytes_p * 8 / ((block_{p+1} - block_p) * BLOCK_SECONDS * 1e6))`. The stream's background is the minimum `rate_p`. Traffic stalled during the test therefore drags the minimum down, however it is carried around it.
  - **Otherwise 0.** A stream with no bracket, a broken run, a crossing bracket or any interval wider than 3 blocks adds `0` (sims `bracket_widener`, `bracket_stall_carry`).
  - **Summed.** `background_mbps(n)` is the sum over streams of each stream's minimum. That is never more than the minimum of the sums.
  - **Why not the window average here.** Once background is in `team`, a window average would let a node carry its traffic outside tests and still be credited during them, which made over-declaring pay (red team RT4, sim `bg_priority_overdeclarer`). An honest node carrying a quarter of its capacity during a test verifies at its declaration (sim `busy_honest_node`, Task 12b).
- **It counts in the ratio.** Background is in `ratio_t` in both cases, so carrying real traffic during a test never looks like an overclaim.
- **Kept separate from the tolerance.** `CAP_TOLERANCE_PPM` (10%) keeps its meaning in `capacity-bonds.md`.
- **What lying can gain on the gate-on path.** A node whose cross-UID receipts carry bytes it chose, junk it or its sybil UIDs push through assigned hops, gains up to the cap, `1 / (1 - 0.25)`, about 1.33x of measured (sim `sybil_uid_background`; 2.0x with a colluding member). T16's defences bound byte *crediting*, with `attest_free` on, not background, so they don't bound this. That is why the gate stays off until PB-38 credits only canary or digest-verified carriage. On the path in force it gains nothing: the window average lifts only the ratio.
- **Stall and carry, after Task 12b (round 5 F1, residual).** A node can still stall real routed traffic during the test's 60 s and carry it in the parts of the overlapping intervals that lie outside the test. With intervals of at most 3 blocks, `team <= C + 0.4 T`, where `T` is the stalled traffic, and the node can stall no more than `T <= C / 3.6`. So it gains at most about 1.11x (sim `bracket_stall_carry`, bound 1.12x). Invariant 2 doesn't limit it: the stalled bytes need only be counted transit, which a node can manufacture with its own sybils (red team H2). It applies only on the gate-on path.
  - **Measured (Task 12b), and model-only until PB-38 (OQ-106).** As first written, the co-signer took a claimed `block` within one block of its view either way, so a proposer could claim its last receipt before a test one block early and its first after one block late, and `bracket_stall_carry` measured 1.263x at `T = C / 3.6`. The rule is now (a): a claim at or one below the co-signer's view, never ahead. The after point can still lag a block, so a staller still shows background: 184 Mbps at `T = C / 3.6`, 1.175x of declaring honestly (1.088x with blocks claimed exactly), 1.290x at the background cap (nothing in the rule limits `T` to `C / 3.6`), and 1.734x with one colluding member at `k = 4`. `bracket_stall_carry` reports these and is model-only (`UNTIL_PB38`): team-test background credit isn't scored until Task 19b supplies `block_hashes` with endpoint dedupe on. The fix is PB-38's (ADR-0051, ADR-0053): per-digest timing checks on routed traffic, so a stall shows as delay. Lowering `CAP_BACKGROUND_MAX_PPM` is ruled out, because ADR-0053's red team wants more background credit for busy nodes, up to verified capacity. The gate MUST NOT lift until PB-38 lands (threat model T131).
  - **With one colluding member.** The two compound. The product of the bounds, about `1.33 × 1.11 ≈ 1.48x` at `k = 4`, is an upper estimate. The sim reports the measured figure, and the rolling lower median of tests bounds it as it bounds T42(b).
- **Founder confirmation.** OQ-41.

**Residuals.**
- **One colluding member (controller ruling 3; restated in Task 4Dc fix round 1, red team F1).** One member that pushes nothing but reports its full share (or more: it is capped at its share) lets the node serve the honest members instead. The lower median, at index `(k-1)/2`, then ignores one starved honest member, so the node needs to serve only `k-2` honest shares to be credited `k-1`: **`(k-1)/(k-2)`, 1.5x at `k = 4` and 2x at `k = 3`** (sims `colluder_overreport_k4`, `colluder_overreport_k3`, `colluder_overreport_end_to_end`). Before the cap on `Σ` it was 1.82x and 2.73x. That is why `CAP_TEAM_MIN_VALIDATORS` is 3.
- **Two colluding members, by splitting stake (red team RT6, F1).** A colluder that splits its stake across several hotkeys can put two members on one team. With `c` colluders the node serves `k-1-c` honest shares for `k-1` credited: **3x with two of four** (sim `two_colluders`, 3.64x before the cap), and with two of three the node is credited two shares for carrying nothing. These need the stake below on most of a node's tests. With the team drawn by stake from all of `E(b)` (Task 4Dc fix round 2, T108), two seats on half a node's teams take about 41-47% of eligible stake at `k = 4` and 53-59% at `k = 3`, and teams of three are rare.
- **A large-budget colluder (red team F7, documented, no code).** Water-filling gives the remainder to the largest budget, so a colluder with a far larger budget than its teammates takes more than `1/k` of a test above `k × 2500` Mbps (10 Gbps): with budgets 2500 × 3 and 100_000, a 32% share instead of 25%, so one colluder's throttling gain is about 1.7x instead of 1.5x. Only for nodes tested above 10 Gbps.
- **How much stake it takes (re-review breakage 3, red team RT6).** `s` here is the colluder's share of eligible stake, the stake of `E(b)`. With replacement as an approximation:
  - one colluding member is on a team with probability about `1 - (1 - s)^k`. That passes one half at about 16% of eligible stake at `k = 4` (`1 - 0.5^(1/4)`), or 21% at `k = 3`. Drawing without replacement among 20 equal-stake validators gives about 15% at `k = 4`;
  - two members (split stake, `k = 4`) is `1 - (1-s)^4 - 4s(1-s)^3`, which passes one half at about 38.6% of eligible stake.
- **The bound is the rolling lower median of tests** (`capacity-bonds.md`). It moves only when more than half of a node's tests are inflated, so below those stake shares inflated tests are a minority, and the median stays at the honest value (sim `team_lottery_splitter`: 15.5% at `k = 4`, 19% at `k = 3`, two colluders 37.5%).

**Team mode MUST NOT run with endpoint dedupe off (Task 4Dc fix round 5, red team A1, review B4, T124).** `run_tempo` uses team-mode capacity tests only when `validator::tempo_endpoint_trigger` is met; otherwise it runs the single-agent tests exactly as before, even with `block_hashes` supplied (test: the `[T24]` `run_tempo` test's team-mode block). With dedupe off nothing pools co-located keys: N keys on one box answer N sequential tests (OQ-18), and with one key per flood UID at a fleet's node size no per-UID schedule weight keeps a multi-node fleet above about 0.5 of its due tests at 4 flood UIDs or 0.3 at 8 (§"Per-UID fairness").

**Team mode MUST NOT be enabled before PB-38 has landed and turned `probe::BACKGROUND_IN_TEAM` on, and only PB-38 may turn it on (Task 12b fix round 2, red team H1, OQ-106).** Task 19b, which turns team mode on by filling `block_hashes`, has this as a precondition.

**Team mode MUST NOT be enabled before Task 18b (red team F4, T105).** Nothing committed ties a team stream to the endpoint validators see on the node's sessions: a sink box holding many node keys could answer the tests of nodes whose endpoints are in many /24s (about 16x for 20 keys behind one 10 Gbps box). The validator loop (Task 19b) MUST NOT fill `TempoInput.block_hashes`, which turns team mode on, until Task 18b runs team streams inside source-matched probe sessions with a per-validator member agent. `cap --team --target` is localnet and test only.
- **Recovery.** Once inflation stops, the median falls back when honest tests are half the history: about 5 tests, roughly 12 windows (about 14 h) at the default `CAP_TEST_PERIOD` (0.4 tests per window) and `CAP_PENALTY_WINDOWS` (24).
- **Yuma doesn't clip any of this.** Every validator scores the same committed samples, so this is a validator-collusion bound, tightened only by larger teams or less concentrated stake.
- **Start skew.** Members start on first seeing block `b`, so a node that serves members one after another gains at most about `s_skew / CAP_TEST_SECS`.
- **Burst capacity (OPEN, T41).** Capacity that is rented, or free under 95th-percentile billing, passes a 60 s test. Eight tests a day touch about 2.8% of a day's five-minute billing buckets (sim `burst_renter_95th`, Task 15). Until the founder decides (OQ-43, default (a)), verified capacity can mean port speed, and the ramp limits how fast any node's tested rate grows.

**Code (Task 4Dc).**
- **Combining.** `probe::team_capacity_mbps` (with `TeamMemberResult`, `TeamResult`, `team_median_member`); a member's `m_i` in kbps from its batch is `ProbeResultBatch::team_member_kbps_for` (echo-OK: `rtt_us > 0`, `loss_ppm == 0`, an ack for the derived `test_id`, enough bytes; `8 * ack.bytes * 1000 / rtt_us`), and a team cohort member's aggregate `ProbeResultBatch::team_cohort_kbps_for`. `ProbeResultBatch::to_metric_map` skips `capteam:` samples and team cohorts.
- **Rates and draw.** `probe::test_rate_kbps` (the ramp), `probe::budget_kbps`, `probe::water_fill`, `probe::draw_team`, `probe::cap_team_seed`, `probe::cap_slot_key`. Vectors: `testdata/vectors/cap_team.json` (`make vectors`).
- **Schedule.** `probe::team_schedule` over `probe::TeamScheduleInput`, producing `probe::CapAssignment`s (`rates_kbps`, `target_kbps` for cohort members, `uid`, `unproven_uid`); `probe::CAP_TEST_DEFER_BLOCKS`; the per-block draw `probe::draw_free_team`. `E(b)` from a signed set is `validator::set_eligible_validators`, over `validator::verified_set_chain(anchor, sets)` with the anchor `TempoInput.prev_validator_set`.
- **Ids and keys.** `probe::CapTeamTest` (`ProbeResultBatch::cap_teams`), `probe::cap_team_test_id`, `probe::cap_team_key` and `parse_cap_team_key` (a `capteam:` sample key must be `capteam:<64 hex>:<canonical decimal>`).
- **Scoring.** `validator::tempo_team_stage`: the window's blocks are `validator::window_blocks` (`[w * WINDOW_BLOCKS, (w + 1) * WINDOW_BLOCKS - 1]`); a sample counts only when it is looked up for a scheduled `(node, b)` in a member hotkey's committed batch, so unscheduled and foreign samples are never read. Background is `validator::window_background_mbps`; cohorts come from `validator::team_cohorts`. `run_tempo` switches to team mode when `TempoInput.block_hashes` is non-empty.
- **Inputs and outputs.** `TempoInput.block_hashes` (hex), `validator_sets`, `prev_cap_assignments`, `prev_verified_capacities` (the previous window's `TempoOutcome.verified_capacities`) and `cap_team_history` (past `TempoOutcome.cap_team_tests`; in team mode callers append it, and `cap_tests` to `cap_test_history`, every window, empty or not), `prev_validator_set` (the anchor) and `prev_pooled_capacities` (the previous window's `TempoOutcome.pooled_capacities`, the round-robin weight); `TempoOutcome.cap_assignments_open`.
- **Agent.** `bwos-probe cap --team <key,...> --node <hex> --target <ip:port> --rate <mbps> [--declared <mbps>] [--secs N] [--window W] [--block B]` runs one team test: each member streams its water-filled share of `--rate` at once as a ChaCha keystream in whole `CAP_ECHO_BLOCK_BYTES` blocks, checks a private 1% of the echoed blocks, and records `capteam:<node>:<b>`; the output carries each member's sample, ack and `cap_teams` entry and the combined `TeamResult`. The node side is `bwos-probe cap-sink -echo`, which writes every byte back and acks after the member's half-close.
- **Not yet.** Before signed sets, `E(b)` with an empty `validator_stakes` should be the previous window's revealed validators; that input doesn't exist, so with neither sets nor stakes no team test is scheduled (OQ-92). Cohort streaming in `bwos-probe` is M4-08. The bracketing rule and `background_in_team = true` are Task 12b's. Team streams over source-matched probe sessions and a per-validator member agent are Task 18b's, and team mode waits for them (above).

### Cohort capacity tests (`[T28]`, OQ-18, OQ-20)

A validator may test every live node of one dedupe group at the same time, as one **cohort**:

1. **Membership is validator-chosen.** The cohort is the set of live nodes **with verified capacity > 0** that the validator puts in one dedupe group (from the endpoint addresses it probes itself, never from operator self-reports), `2..=MAX_CAP_COHORT_NODES` (16) nodes; zero-capacity keys bound into the /24 (burners) are left out. A larger group is tested in disjoint chunks of at most 16 nodes, each chunk its own cohort; scoring credits the best single chunk, never the sum of chunks (chunks tested at different times could be served one after another by one pipe). The cohort id is `SHA-256("BWOS-v0/cap-cohort" || 0x00 || u32be(n) || node_1 || ... || node_n)` over the 32-byte keys in ascending order (`probe::cap_cohort_id`). The group is due for a cohort test when `capacity_test_due(prev_block_hash, cohort_id, CAP_TEST_PERIOD)` holds (team cohorts are scheduled in scoring by `probe::team_schedule`, item 6; cohort streaming in `bwos-probe` is not implemented yet, roadmap M4-08; the library verifies and scores declared cohorts); its members are then not tested individually in that block, and a cohort test uses one of the validator's `CAP_TEST_MAX` test slots.
2. **Simultaneous streams.** One probe agent opens all member streams at the same time. Member `i`'s request header carries `test_id_i = SHA-256("BWOS-v0/cap-cohort-test" || 0x00 || cohort_id || nonce || node_i)` (`probe::cap_cohort_test_id`) with a fresh 32-byte validator `nonce`, so each member's node-signed `cap-test-ack` is bound to this cohort test. The agent records each member's `cap:<node>` sample as usual and `span_us`, the time from the first stream start to the last ack (or timeout).
3. **Validator-signed declaration.** The batch lists the cohort in `cap_cohorts` (omitted when empty, so legacy encodings and signatures are unchanged): `{"nonce":"<32-byte hex>","nodes":["<pubkey hex>",...],"span_us":<int>}`, sorted and unique by `(nodes, block)` (`block` absent sorts first, so legacy batches order as before); a node is in at most one cohort per batch and block, and every member has a `cap:<node>` sample, or `capteam:<node>:<b>` in a team cohort (`ProbeResultBatch::validate`). A `cap_teams` entry may not repeat a team cohort member's `(node, block)`, since that test's id comes from the cohort. Sample keys starting with `capcohort:` are rejected.
4. **Aggregate.** `ProbeResultBatch::to_metric_map` adds `capcohort:<node_1>,...,<node_n>:throughput_mbps = Σ bytes * 8 / span_us` (floor; the key is the ascending membership joined with `,`, `probe::cap_cohort_key`), summing the ack `bytes` of members whose sample completed within the span (`0 < rtt_us <= span_us`) and whose valid ack is signed by that member for this batch's validator and window with the member's cohort `test_id`; other members add `0`. Total bytes over the **common** span, not the sum of per-member rates: one pipe serving the streams one after another (per-member rates `C, C/2, C/3, C/4`, sum `2.08 C`) measures as `C`. The key is aggregated like every other key (stake-weighted lower median, `MIN_VALIDATORS`, stake quorum), so validators must have tested the same membership.
5. **History.** `TempoOutcome::cap_cohort_tests` (`membership key -> Mbps`, `probe::cap_cohort_members_key`) is appended to `TempoInput::cap_cohort_history`; a cohort's verified aggregate is the lower median of its samples over the last `CAP_COHORT_FRESH_ENTRIES` (8) entries (`validator::rolling_cohort_capacities`; entries are windows with at least one aggregated cohort test). A cohort not re-tested in that span has no credit. **In team mode a cohort needs at least `CAP_COHORT_TEAM_MIN_SAMPLES` (2) samples in the span** (`validator::rolling_cohort_capacities_min`; Task 4Dc fix round 5, red team B1(b), T125): a team cohort sample is one team's result, and with one colluding seat on a cohort's only sample its lower median was the seat's figure, so the group, the max over its cohorts, took the best of many such lotteries (×1.5-2.0 at 5% of stake). The lower median of two is their minimum, so one seat never raises a group; with fewer than two the group falls back to its largest single. Residual: both samples with the colluder seated still give 1.5x in some runs (sim `colocated_cohort_lottery`, T125, OQ-99). A cohort falls due about once per 2.5 windows (`CAP_TEST_PERIOD`, 900 blocks), so by due-time randomness alone, with no attacker, about 4% of cohort-windows have no test in the last 8 (9 of 240 in the red team's round-3 re-check; 0.045 by due times in `cgnat_cohort_turns`), and in team mode, needing two, about 15% (0.151); while it has lapsed, a 15-operator carrier group is paid as its largest member, about 1/15 each, which costs such groups about 3.5% of their capacity term on average before team mode and about 14% in it (red team L1, T116(a), T125; OQ-95 proposes keeping credit until the cohort's next due test). A consolidated group (three pipes shrunk to one) falls to its new measurement once re-tests make up at least half of the samples in that span (two re-tests after a single earlier sample, up to four) instead of keeping the old aggregate for `CAP_PENALTY_WINDOWS` (red-team round 2). History is keyed by exact membership, and scoring applies any cohort whose members are all current positive-capacity members of the group (`capacity-bonds.md`), so a burner or a new member joining the /24 does not void an earlier result (red-team Pass-7 `cohort_burner_griefer`: 1.256x before, 1.000x after).

6. **Team cohorts (ADR-0039, Phase B Task 4Dc).** Under team tests, a cohort is tested by one team. Design §4.2 covers this case: nodes sharing a `/24` (including home users behind one CGNAT range, seen by validators as one public `/24`) or an IPv6 `/32` get a simultaneous cohort test and share the measured aggregate.
   - **Membership.** It is fixed by the dedupe groups of the previous window's aggregated endpoints (§Probed endpoints). These are carried in `TempoOutcome.endpoints` and passed back as `TempoInput.prev_endpoints`, so membership is known before the window starts and is the same for every validator. Members are the group's nodes with verified capacity `> 0` in the previous window's outcome. Operator reports are never used.
   - **Groups above 16.** The members are sorted by node key and cut into consecutive chunks of `MAX_CAP_COHORT_NODES` (16). A final chunk of one node isn't a cohort; that node is tested individually. Each chunk has its own `cohort_id` and is due on its own. Scoring credits the best chunk, as in item 1.
   - **The team.** When the cohort is due at block `b`, its team is drawn as in §Team capacity tests, as a tier-1 test, with the subject being the `cohort_id`. It takes each member validator's slot from `b` to `b+4`. Members of a cohort due at `b` aren't individually due at `b`.
   - **Per-node rates, under one budget per member (round 4 RR4).** A member's budget covers the whole cohort test: `Σ_n rate_{i,n} <= budget_i`.
     - **Order.** Nodes are taken in ascending order of their own `slot_key = SHA-256("BWOS-v0/cap-slot" || 0x00 || block_hash(b-1) || node_key)`, so the node served last changes from test to test and can't be chosen.
     - **Split.** For each node `n` in turn, the team splits `R(n)` by the same water-filling over each member's remaining budget, `budget_i − Σ rate_{i,m}` over the nodes `m` before `n`, with members in ascending order of remaining budget, then hotkey. That gives `rate_{i,n}`.
     - **Zero rates.** A member with `rate_{i,n} = 0` is dropped from node `n`'s stream, as in a node test.
     - **What each node is judged on.** Each node's `S_n = Σ_i rate_{i,n}` over the scheduled members and `pushed_n = min(declared_n, S_n)`. A node late in the order whose share the budgets ran out on (`S_n < R(n)`) is tested at less and judged against that, so it is never haircut; and its record counts in its `ratio` only, never in its `measured` (Task 4Dc fix round 1, red team F8), so a budget-starved test doesn't drag its credit down.
   - **Streams.** Each team member's agent opens all member streams at once, one inside each member node's source-matched probe session to that agent. Each stream runs at `rate_{i,n}` for `CAP_TEST_SECS`, with the member `test_id_i` of item 2 and the echo and echo check of §Team capacity tests. The batch's `cap_cohorts` entry gains `block` (`b`), omitted for legacy entries.
   - **Each node's own result.** Each node records `capteam:<node>:<b>` at each member validator. These samples also count as each node's individual team test: they are combined per node by `team_capacity_mbps` with that node's rates and `background_mbps(n)`, under the same background rule as node tests, and enter its rolling history as `(team, pushed_n, ratio_t)`.
   - **The cohort's aggregate.** Each member validator `v` declares the cohort in `cap_cohorts`. Its aggregate is computed as in item 4, but counting only intact echoed bytes:

     ```
     agg_v = Σ_n echoed_bytes(v, n) * 8 / span_v
     ```

     The cohort's result is `team_capacity_mbps` over the members `v` that revealed, with `rate_v = Σ_n rate_{v,n}`, `S = Σ_n S_n` over the whole scheduled team, `declared = Σ_n declared_n` and `background = Σ_n background_mbps(n)`, in kbps with capped `c_v` as for a node. It isn't the stake-weighted median. It enters `cap_cohort_history` as in item 5.
   - **Credit.** The validator credits this measured aggregate through `capacity-bonds.md` §Endpoint dedupe, unchanged.

Until M4-08, `bwos-probe` emits batches with an empty `cap_cohorts` (no cohort streaming yet); scoring schedules team cohorts (item 6) and verifies and scores the cohorts validators declare.

How scoring uses it: `capacity-bonds.md` §Endpoint dedupe. Residuals: simultaneity and `span_us` are attested by the validator (as every throughput is); a group's credit is bounded by what one probe agent can push at once, and a group above 16 nodes by its best chunk; a node with real capacity placed in an honest group's /24 is pooled with it (co-location griefing, as in `[T24]`), but cannot reset the group's cohort credit. Two more, recorded under OQ-90 and T107 (red team F8, not redesigned in Task 4Dc): a group's credit is at most one team's budgets (10 Gbps at `k = 4`) and its best 16-node chunk, so a CGNAT /24 of 160 honest home nodes is credited as about 16 of them (about 0.1x); and chunks are cut by sorted node key, which keys are free to grind, so a planted key can push one honest member into a chunk of one, which isn't a cohort.

### Peer-load capacity tests (ADR-0056)

**Status: specified and simulated, not scored.** Red-team revision 1 (2026-11-08) is folded in below.
- **The code.** `bwos_core::scoring::peer_load` holds the pure helpers; `validator::run_tempo` doesn't call them yet. The sims are in `crates/bwos-sim/src/peer_load.rs`.
- **Until it scores.** Team tests (above) stay the scored mechanism.
- **Before it may score:**
  - the incentive red team's second pass;
  - OQ-135, the collusion bound;
  - hidden-slice indistinguishability: T148, OQ-117 and OQ-166 (sim `capacity_hidden_leak_ramp` gates nothing until then);
  - flood framing by a drawn participant (T173, OQ-167);
  - ADR-0056 §9's Phase 2 run.
- **Parameters.** Every parameter here is a starting value, tuned by sim and red team (`scoring.md` §Parameters, "Peer-load capacity tests").

Peers make the load, and a few hidden validator slices that the node can't pick out measure it. So validator cost per test doesn't depend on the node's size.

**Calls: secret times.** Each window, a node with a declaration has a **coordinator**, a validator drawn by stake from `E(b)` with the seed `SHA-256("BWOS-v0/cap-peer-coord" || 0x00 || window_seed || node_pubkey)`. The coordinator commits a 32-byte `plan_secret` in its window manifest before the window's first block, and reveals it after the window ends, as Task 14's canary plan secrets are.
- **The call draw.** The node is called at block `b` of the window when `u64be(SHA-256("BWOS-v0/cap-peer-call" || 0x00 || plan_secret || node_pubkey || u64be(b))[0:8]) mod CAP_CALL_PERIOD == 0`. `CAP_CALL_PERIOD` is 2_400 blocks, about 3 calls a day.
- **No public warning.** Only the coordinator knows the call blocks before they happen. The public block hash no longer sets them: in the first draft anyone could compute a call one block ahead and flood it (T173).
- **Every participant learns at the call's start.** Peers, relays and the node under test receive their instructions as the call begins. A drawn participant can therefore tip off a flooder (T173 residual, OQ-167).
- **A withheld `plan_secret` voids the coordinator's calls.** They give no sample and no retest, and the coordinator is charged as for a withheld canary plan.
- A call's samples count in the window containing its last block, as for team tests.

**Slices** (`peer_load::slice_plan`):

```
R     = probe::test_rate_kbps(declared, verified_prev)          the ADR-0039 ramp, headroom included
k     = max(CAP_PEER_HIDDEN_SLICES, ceil(R / CAP_PEER_SLICE_KBPS))
slice = ceil(R / k)                                             kbps, at most CAP_PEER_SLICE_KBPS
m     = min(CAP_PEER_HIDDEN_SLICES, k)                          hidden slices; k - m peer slices
```

- **A slice's path.** Every slice, peer or hidden, runs `source → N → R_out → sink` at `slice` kbps for `CAP_PEER_TEST_SECS` (30 s). It crosses both directions of `N`'s port.
- **Small nodes.** A node with `R <= CAP_PEER_HIDDEN_SLICES * CAP_PEER_SLICE_KBPS` (2 Gb/s) has no peer slices. Its test is validator-pushed through relays, at `R / 4` per hidden slice.

**Sink blinding.** `N` never learns a slice's sink.
- **The encapsulation.** `N` forwards every slice to `R_out`, the slice's drawn egress relay. Each packet's inner header (sink address, slice id) is sealed to `R_out`'s node key, `ChaCha20-Poly1305` under an X25519 key the source agrees with `R_out` for the call, with the label `cap-peer-inner`. `N` sees only the session it came in on and the next hop.
- **What `R_out` carries.** `R_out` opens the inner header, forwards the slice to its sink, and is drawn as one endpoint like any other. Hidden slices leave `N` through drawn `R_out` relays too, so `R_out` can't tell them from peer slices.
- **What it buys.** A node that wants to drop a cartel sink's slice before egress needs `R_out` to collude too, and to say which inner sinks are the cartel's. So the egress that collusion can shed falls from `f` to `f²` (sim `capacity_peer_collusion`).
- **What it costs.** Every slice has three drawn endpoints: source, `R_out` and sink. The bwos-net work (sealed inner header, `R_out` forwarding, per-session policing) is roadmap PB-43e.

**The draw: committed, secret until the reveal.**
- **The hidden validators self-select.** For a call `c`, validator `v` holds a hidden slot when `VRF_v("BWOS-v0/cap-peer-hidden" || call_id) < stake_v × m / Σ stake` (one slot at most; `call_id = SHA-256(plan_secret || node_pubkey || u64be(b))`). The coordinator announces calls to validators, sealed, at the call's start. A validator stays unknown until it reveals its VRF proof with its result. So the coordinator doesn't know which validators are hidden, but it still knows which sessions aren't its own peer slices (T172).
- **The peer slices and all relays.** The coordinator draws them from the seed `SHA-256("BWOS-v0/cap-peer-slice" || 0x00 || plan_secret || node_pubkey || u64be(b))`. Draw `j` reads `u64be(SHA-256(seed || u32be(j))[0..8])`. Each endpoint is drawn in two steps:
  - **a UID, uniformly,** among eligible UIDs with a free slot (fewer than `CAP_PEER_UID_SLOTS`, 8, endpoints in this call), from UIDs sorted ascending;
  - **then a node in it, uniformly,** among its eligible nodes with a free slot, sorted by node key.
- **Rejected draws.** A draw that breaks a rule below is rejected, and `j` moves on, up to `CAP_PEER_DRAW_TRIES` per endpoint.
- **Why uniform per UID.** The first draft weighted peers by spare capacity. An inflated cartel then had more spare, so more slots, so more collusion: its share fed on itself (spare-weighted: `f0` 0.3 grows to 0.61, inflation 2.0x; sim `capacity_spare_feedback`). Drawn per UID, the cartel's share is its share `f_uid` of the UIDs with a free slot, whatever its credit.
- **Why it's secret.** A public draw would let `N` list its peers and know every other session is hidden.
- **Why it's checkable.** After the reveal every validator recomputes the draw and rejects a call whose endpoints differ. So test traffic is validator-assigned (Invariant 2), and the secret is committed too early to grind.

**Eligible endpoints.** A node is eligible as a source, `R_out`, sink or hidden relay at `b` when all of these hold:

- It has `spare = verified_prev − assigned >= CAP_PEER_SLICE_KBPS`, where `assigned` is the demand the production table routes through it. Its slots are `floor(spare / CAP_PEER_SLICE_KBPS)`, the most endpoints it may hold in one call.
- It is not under test in an overlapping call.
- It shares neither `N`'s UID, nor its coldkey group, nor its dedupe group, nor its underlay ASN (the origin AS of `N`'s public address).
- Within one slice, the three endpoints are in different UIDs and dedupe groups.
- A NAT-ed node is eligible only for roles whose neighbours on the slice are public.
- A hidden relay is never validator-run.

A 100 Gb/s call needs 660 endpoints: at 8 per UID, at least 83 UIDs (OQ-137).

**If the pool runs dry,** the call runs with the slices that could be drawn. `call_outcome` takes `slices_run = m + drawn`, so the sample is at most `slices_run * slice` and a short pool never makes a call short.

**Running a call.**
- **Instructions.** Endpoints receive their instructions at the call's start, each with a session token `HMAC-SHA-256(K_call, slice_id)`. `K_call` comes from `plan_secret` and is released to `N` at the call's start. Every token has the same form, whoever minted it.
- **Sessions.** `N` accepts a slice session only with a valid token. It polices each session to the instructed rate and counts the excess in its record.
- **Payload.** Every slice carries uniformly random bytes from a seed in its instruction.
- **Peer reports.** Each sink returns per-second delivered bytes to the coordinator. These **peer sink reports are diagnostics only and never set the node's credit.** That stops framing through reports, but not framing through load (floods and oversends, T173) or through relays dropping hidden slices (T217).

**Hidden slices.** A hidden slice runs validator source agent → `H_in` → `N` → `R_out` → `H_out` → validator sink agent, at the slice rate.
- **Terminating relays.** `H_in` and `H_out` are drawn relays. They terminate the validator's own session and re-originate (or absorb) the slice, so no validator address appears in any header `N` or `R_out` sees.
- **They count against slots** like any endpoint, obey the UID and NAT rules, and are never validator-run.
- **Hidden slices never count as relay carriage.** Carrying one earns a relay nothing beyond its duty record.
- **What still tells them apart (OQ-166; scoring blocked):**
  - **The relays themselves.** `H_in` and `H_out` know they talk to a validator agent. A cartel holding `f_uid` of the UIDs is `H_in` or `H_out` of a hidden slice with probability about `2 f_uid`, and can tell `N`. At `f_uid = 0.1` that leak is 0.2 a slice, and sim `capacity_hidden_leak_ramp` gains 0.62x: no profit. At a 0.5 leak it gains 1.35x, and at a full leak 94x. The first draft's 2.0x was its declaration cap; the ramp compounds the leak.
  - **Published plans.** Plans are revealed after each window, so a node can build a blocklist of past relays and timing. The relays are drawn fresh from all peers each call, so a past relay predicts nothing. Timing and shape fingerprints learnt from past plans are OQ-166's to rule out.
  - **One sender for hidden slices and canaries.** If hidden slices used Task 14's canary sender, a tell in one would leak the other. Hidden slices MUST use the peer-slice sender (`bwos-probe cap --slice`), byte for byte, not the canary sender.
  - **Shape.** Validator source addresses are hidden by the relays. A hidden slice must not be the only one-way flow (T148, OQ-117).
- **Peer-load credit MUST NOT be scored** until indistinguishability is shown: `capacity_hidden_leak_ramp` must hold at the leak a measured classifier achieves (ADR-0056 §9 item 5).

**Measurement and path proof.**
- **What a validator reports.** Each hidden sink reports `h_i`, the slice's delivered rate over the last `CAP_PEER_MEAS_SECS` (20 s) of the call. It goes in the validator's probe batch, commit-reveal as for every sample, with its VRF proof.
- **The packets that count.** Only packets that both:
  1. arrived at `H_out` over the session from `R_out`, as `H_out` records, so a bypass of `N` doesn't count; and
  2. have sampled digests (ADR-0038 sampling, with the hidden source's key chain, revealed after each epoch) that appear in `N`'s `HopDigestBatch` for that epoch, published before the key.
- **Why the last 20 s.** The first `T - T_meas` seconds let a token bucket's burst allowance drain. A policer with committed rate `r` is measured at `r` for any bucket that drains within 10 s (sim `capacity_token_bucket`).

**The call outcome** (`peer_load::call_outcome`). With `n` revealed hidden results `h_i`, each capped at `slice`:

```
n < CAP_PEER_HIDDEN_MIN (3)    →  void: not a sample, not a short call
short       = slices_run × upper_median(h) < min(declared, slices_run × slice) × (1e6 − CAP_TOLERANCE_PPM) / 1e6
sample      = 0 if short, else min(declared, usable, slices_run × floor(Σ h / n))
```

- **Why the mean.** Each bad hidden result moves the sample by at most `1/n` of it: one griefing validator of four costs 25%, two cost 50%. In the first draft, two zeroed a sample through the lower median (sim `capacity_validator_grief_quorum`).
- **What the mean costs.** Two favouring validators of four lift a node that delivers half to 0.80 of its declaration (T216).
- **Why the upper median for short.** A majority of the hidden slices must be short.
- **What never makes a call short.** `usable` and a short pool cap the sample only.

**Retests, the bond and verified capacity** (`peer_load::bond_applies`, `strikes_apply`, `verified_kbps`; `capacity-bonds.md` §Peer-load calls):
- **A short call only zeroes its own sample,** and is retested once, at a block drawn from `plan_secret` within `CAP_PEER_RETEST_WINDOWS` (4) windows. The retest has a fresh slice draw and fresh hidden validators.
- **The bond.** The node's capacity credit is zeroed to the end of the cooldown epoch (the next multiple of `CAP_CHANGE_WINDOWS`) when either:
  - the retest is short too; or
  - the node has had `CAP_PEER_SHORT_STRIKES` (2) short calls in the epoch.
- **Why the strikes rule (accepted by the controller, 2026-11-08).** The retest alone left a burst renter at up to 1.162x per unit of cost (sim `capacity_burst_renter_calls`, detail).
- **Verified capacity.** It is `min(declared, lower median of the samples of calls and retests that ended in the last CAP_PEER_LOOKBACK_WINDOWS (48) windows)`, and `0` with no sample.

**Source duty** (`peer_load::source_duty_charged`). A source that sends less than its slice relieves the node it is drawn for. Lazy sources fabric-wide inflate every over-declarer by `dilution(λ)` (1.42x at λ = 0.3; sim `capacity_lazy_sources`).
- **The record.** Each source keeps a duty record: one delivered ratio per slice it sourced in the lookback. Each ratio is counted from the hop digests that slice's node under test committed for the session, so the node can under-count the source but never over-count it.
- **The charge.** The source is charged when the record holds at least `CAP_PEER_DUTY_MIN_SLICES` (8) slices and its `CAP_PEER_DUTY_QUANTILE_PPM` (median) ratio is below `CAP_PEER_DUTY_MIN_PPM` (0.95). The charge is the bond on its own capacity credit. Only the source is charged, never the node under test.
- **What escapes it.** A source sending 95% is never charged, which is worth at most 1.05x to over-declarers.
- **Framing of sources.** Framing nodes under test at a share of 0.2 charge an honest source 0.05% of the time, and at 0.4, 11.6%.

**`usable`** (`peer_load::usable_kbps`, `neighbour_term_kbps`). Over `N`'s neighbours `j` in the committed snapshot:

```
a_j    = min(avail_mbps of link (N, j) if present, 2 × verified_prev_j + CAP_RAMP_FLOOR_MBPS) × 1000
usable = min(S, 2 × (S − max_j a_j)),   S = Σ_j a_j
```

- **What it is.** The exact max transit flow through `N` when each neighbour can send and receive `a_j`, with no flow leaving to the neighbour it came from. By min cut: all sources, all sinks, or all but one neighbour on both sides.
- **It's an upper bound on any multi-hop max-flow** through `N`. It equals an integer max-flow on 300 random one-hop networks (sim `capacity_usable_cap`).
- **Sybil neighbours** can raise `usable`, but it only ever caps a sample: it is a `min`, never a source of credit.
- **Cost.** `O(E)` a window, against one max-flow per node.
- **Against the plain sum.** One big neighbour can't be both ends of a flow: 100 + 7 × 1 Gb/s gives 14 Gb/s, not 107.
- **Why the ramp ceiling.** It makes `usable` grow with the fabric from zero.
- **Integers only.** `u128` integer arithmetic, sorted inputs (Invariant 1).

**Option E was dropped** in revision 1: sink blinding closes the egress gap without reading any endpoint record. Option W (committed send digests with a dead zone `q`, about 1.06x at `q` = 5%) is research (OQ-168).

**Bounds, and what each sim gates:**
- **Collusion (`capacity_peer_collusion`, T165).** A cartel holding a UID share `f_uid`, its node shedding the cartel's slices. A colluding source sheds ingress alone, and with sink blinding egress needs `R_out` and sink both.
  - **Symmetric port:** `k / (m + (k − m)(1 − f)) <= 1/(1 − f)`.
  - **Egress-bound port:** `<= 1/((1 − f)(1 − f²))`, about `1/(1 − f)`.
  - **At 100 Gb/s:** 1.111x, 1.245x, 1.417x and 1.639x symmetric, and 1.122x, 1.294x, 1.549x and 1.939x egress-bound, at `f_uid` = 0.1 to 0.4. Without blinding, egress-bound is 1.231x to 2.694x.
  - **The founder's `1/(1 − f²) + tol` fails at every `f`** (`capacity_peer_collusion_f2`, gating nothing until OQ-135).
- **Draw feedback (`capacity_spare_feedback`, T174):** per UID, inflation stays within `1/(1 − f_uid)`.
- **Framing by reports (`capacity_peer_framing`, T166):** 0 change.
- **Flood framing (`capacity_flood_framing`, T173):** a blind flooder's loss is at most its own flood duty. A tipped flooder isn't bounded (OQ-167).
- **Oversend (`capacity_peer_oversend`, T173):** 0 on a node with link headroom.
- **Selective throttling (`capacity_selective_throttle`, T167):** at most 1.0x at any declaration while hidden slices are indistinguishable.
- **Burst renting (`capacity_burst_renter_calls`, T168):** within `1 + tol` per unit of cost at every share of calls it can meet. A 95th-percentile renter isn't deterred (OQ-136).
- **Lazy sources (`capacity_lazy_sources`, T215)** and **griefing validators (`capacity_validator_grief_quorum`, T216).**
- **Validator cost and peer duty (`capacity_big_node`, `capacity_peer_duty`, T169):** at most `m × slice × T` = 7.5 GB per call. Fabric-wide duty is 0.34% of capacity-time, about 0.1% per role. Per node it is uneven, because the per-UID draw gives every UID the same expected duty: 2.7% for a 1 Gb/s node against 0.05% for a 100 Gb/s one (OQ-137).

### Capacity tests of nodes behind NAT (interim, PB-48 fix 9, OQ-283)

**Interim.** This holds until team tests (Task 18b, OQ-99) or relay tests give a node behind NAT a test of its own. It exists so a home or router node can earn capacity on testnet. It changes nothing for a node whose sink can be reached. `bwos_core::cap_dial` has the encodings.

**When.** A plan-mode agent run with `--cap-dial-listen <ip:port>` takes dials. When a planned test is due (same `start_block`, stagger and group rules as a pushed test, §Live loop), the agent first tries to push to the node's sink, giving the connect `CAP_PUSH_CONNECT_SECS` (3 s). It asks for a dial only if that connect fails. Both happen in the one group test, so a node never has a pushed and a dialed test at the same time.

**One start (PB-48 final verification F3).** Once any member of a group test has asked for a dial, every stream of the group, pushed or dialed, starts at one instant: `CAP_DIAL_HOLD_SECS` (`CAP_PUSH_CONNECT_SECS + CAP_DIAL_WAIT_SECS + 2` = 20 s) after the group started, past every push connect and the dial deadline. Each connection gets its request header as soon as it is made and is then held until that instant; one not made by then fails. So a node can't choose when its test runs by when it dials, and one back end can't serve a UID's nodes in staggered dial batches, each seeing the whole pipe.

**The request.** The agent sends one UDP datagram over the node's up probe session:
- from its probe address to the node's `/128`;
- both ports `CAP_DIAL_PORT` (8_625);
- payload `u16be(port) || token`: the listener's TCP port, and 16 bytes of fresh OS randomness.

Only the session's WireGuard peer can send this, so the request carries the session's authentication. Before sending, the agent registers the token for the session's current source IP, valid for `CAP_DIAL_WAIT_SECS` (15 s).

**The node.** A node that holds its node key (`--node-key`: a no-root node, or a kernel node's `bwos-node probe-session`) takes the request from its probe peer and dials TCP:
- to that probe peer's configured endpoint IP at the given port. It never dials any other host, so a request can't turn a node into a dialer of third parties.
- from the host its session comes from, so through the same NAT.

It then sends `CAP_DIAL_MAGIC ("BWD1") || token` and serves the echoed test on that connection as `cap-sink -echo` does:
- it reads the request header within `CAP_DIAL_HELLO_SECS` (5 s);
- it echoes every byte as it arrives, until the agent half-closes, for at most `CAP_DIAL_MAX_BYTES` and `CAP_DIAL_HOLD_SECS + CAP_TEST_SECONDS + 30` s (the agent may hold the connection until its group starts);
- it then sends the `cap-test-ack` signed with its node key over the bytes it received.

The node's limits:
- **Gap.** It takes at most one request per probe peer per `CAP_DIAL_MIN_GAP_SECS` (30).
- **At once.** It runs at most `CAP_DIAL_MAX_CONCURRENT` (4) dials at once, off its main loop. A request beyond that is dropped, so that test fails. Staggered starts keep validators' tests apart.
- **No key.** A node without its node key refuses every request.

Each dial's outcome is a `CapDial` log line. `NodeStats` counts `dial_requested` and `dial_refused`.

**The agent's checks.** A dialed connection counts only if all of these hold:
- its hello arrives within `CAP_DIAL_HELLO_SECS`;
- it names a token the agent issued for a test due now;
- it comes from the session's source IP the token was registered for;
- it arrives before the token expires.

The token is then spent. Anything else is closed unanswered.

**Admission (PB-48 final verification F1).** On accept, before any read, the listener takes a connection only from a source IP holding an unexpired token that no connection has been taken on yet, and marks that token taken: one connection per token. A connection from any other IP is closed at once and takes no slot, so a flood from IPs with no token, however many, can't keep a due node's dial out. A connection whose hello then fails (garbage, late, or naming another token) gives its grant back, so the node can dial again on its token (release round, T324). It reads at most `CAP_DIAL_MAX_HANDSHAKES` (64) hellos at once, which only token holders reach. It keeps no state per IP beyond the tokens, which expire with their tests. `ProbeServeStats` counts `dials_taken` and `dials_refused`.

**The test.** The stream, the private byte checks, the early abort and the ack checks are the pushed test's (red team fix 3), so the test measures `min(up, down)`. Its ceiling is `min(declared, CAP_DIALED_CEILING_MBPS)`, and it is paced at its share of the agent's budget under that ceiling (§Live loop, "Rates"). The `CapTarget` is the connection's source IP with `dialed: true` and its `paced_mbps`.

**Credit.** Under PB-48's capacity rules, a dialed `cap:` sample needs its ack bytes, its target and `CAP_MIN_REPORTERS` like any other. Its throughput and pace are then capped at `CAP_DIALED_CEILING_MBPS` (100, proposed), and it pools by its target's `/24` (`/48`) within its UID like a pushed one (F3). The node's credit is `min(up, down, ceiling)`. Data-plane and uptime rules are unchanged.

**Residuals.**
- **T312.** A dialed test can't tell one NAT'd box from several behind one public IP. The ceiling, the group test (every node behind one public IP is drawn and tested together) and pooling within a UID bound what such a box gets.
- **T313.** The dial itself is a new inbound port on the agent and an outbound connection by the node.
- Not yet measured: whether a NAT's mapping changes between the session's source and the TCP dial's (a carrier-grade NAT that maps them to different public IPs). Such a node's dial is refused, and its test fails, as it does today.

## Secure sampling (ADR-0038)


Status: specified and spiked, **not scored** (`hop_digest::HOP_DIGESTS_SCORED` is `false`). Implemented in `crates/bwos-core/src/hop_digest.rs`; vectors in `testdata/vectors/hop_digest.json`. How hops commit digests and how loss is attributed is in `receipts.md` §Hop digests.

The ingress and egress of a flow measure loss and delay on its real traffic by sampling packets that relays can't pick out. No byte is added to the packet.

**Invariant bytes** (`hop_digest::invariant_bytes(packet) -> Option<Vec<u8>>`). For a packet of at least 40 bytes whose version nibble is 6: the 40-byte IPv6 header with the traffic class (the low 4 bits of byte 0 and the high 4 bits of byte 1) and the hop limit (byte 7) set to zero, followed by the first 32 bytes of payload, or all of it if shorter. Anything else gives `None` and is never sampled or recorded. These are the bytes no relay changes: relays decrement the hop limit, and ECN may rewrite the traffic class.

**Hop digest.** `hop_digest(inv) = SHA-256("BWOS-v0/hop-digest" || 0x00 || inv)[0..8]`. Any hop can compute it. Two packets share a digest only when their invariant bytes match, or by a 2^-64 collision.

**Sampling decision** (`hop_digest::sampled(key, invariant_bytes, rate_ppm) -> bool`):

```
tag     = HMAC-SHA-256(key, "BWOS-v0/packet-sample" || 0x00 || hop_digest(inv))
sampled = u32be(tag[0..4]) < rate_ppm * 4294          (rate_ppm capped at 1_000_000)
```

`hop_digest::digest_sampled(key, digest, rate_ppm)` is the same test from the digest alone. The HMAC runs over the digest of the invariant bytes rather than the raw bytes, so anyone holding a revealed key and a signed list of digests can check which digests were sampled. A relay without the key sees a uniform 32-bit value either way. `rate_ppm * 4294` is `floor(2^32 / 10^6)`, so the realised rate is `rate_ppm` less 0.0225% of itself (10_000 ppm samples at 9_997.75 ppm). The default rate is `SAMPLE_RATE_PPM` (10_000, 1%).

**Epochs.** A window's time is cut into epochs of `SAMPLE_EPOCH_MS` (1_000 ms), numbered `1 ..= SAMPLE_EPOCHS_PER_WINDOW` (8_192, enough for a window running about 1.9 times its nominal 72 minutes). Epoch 0 is the anchor and is never sampled. A node counts epochs on its own monotonic clock from the start of the window as it learned it, so nodes' epochs are not aligned: a packet can sit in epoch `e` at one hop and `e + 1` at the next, and clock skew moves the boundaries further. `SAMPLE_REVEAL_DELAY_MS` only gives a late hop time to publish; it doesn't align anything. Until validators can match epochs across nodes deterministically (OQ-63, T74), attribution has to be run over a span of epochs rather than one, and nothing here is scored.

**Keys** (a backwards hash chain, as in TESLA):

```
K_N = SHA-256("BWOS-v0/sample-key" || 0x00 || mask_key || u64be(window))      N = SAMPLE_EPOCHS_PER_WINDOW
K_e = SHA-256("BWOS-v0/sample-key-chain" || 0x00 || K_{e+1})                   e = N-1 .. 0
```

`mask_key` is the flow's 32-byte key shared by its ingress and egress (`datapath.md`, "Who holds mask_key"). The egress can therefore compute every key of the window in advance (red team RT5, T72); deriving the keys from a secret only the ingress holds is the planned fix. Packets of epoch `e` are sampled under `K_e` (`hop_digest::sample_keys`). `mask_key` is never revealed, and revealing `K_e` reveals `K_0 .. K_{e-1}` but no later key.

**`SampleKeyReveal`** (domain `sample-key-reveal`, signed by the ingress's node key):

```json
{"v":0,"window":1234,"epoch":17,"key":"<64 lowercase hex>","ingress":"<ingress node pubkey hex>","sig":"<ed25519 hex>"}
```

- The ingress MUST publish the anchor (`epoch` 0, `key` = `K_0`) before the first sampled packet of the window, and the reveal of `K_e` no earlier than `SAMPLE_REVEAL_DELAY_MS` (3_000 ms) after epoch `e` ends. It SHOULD publish it then, since a hop that missed the deadline is protected by its own clock and loses nothing from a late reveal.
- `SampleKeyReveal::verify` checks `v == 0`, `epoch <= SAMPLE_EPOCHS_PER_WINDOW`, the key's form, a valid non-weak `ingress` key, and the signature over `wire::signing_bytes("sample-key-reveal", reveal)`.
- `hop_digest::check_reveal_chain(earlier, later)` accepts `later` only if both are from the same ingress and window, `later.epoch > earlier.epoch`, and hashing `later.key` forward `later.epoch - earlier.epoch` times with the `sample-key-chain` step gives `earlier.key`. Every reveal used as evidence MUST chain to the ingress's anchor, so the ingress commits to all of a window's keys when it publishes the anchor and can't pick a key after the fact.
- Hops' batches for epoch `e` MUST be published before `K_e` is revealed (`receipts.md` §Hop digests, "Order").

**What the ends do.** The ingress records the digest of every packet it sends on the flow, and the egress of every packet it receives, each in its own `HopDigestBatch`. After the reveal, anyone can filter the ingress's batch with `digest_sampled` under `K_e` to get the epoch's sampled set: end-to-end loss is the fraction the egress's batch lacks, and per-link loss is `attribute_loss` (`receipts.md`). Delay sampling (timestamps on sampled digests at the ends) is follow-up work and is not in these objects.

**Why relays can't favour sampled packets.** While a packet crosses, its epoch key is secret, so whether it is sampled is a uniform coin to the relay, independent of anything it can see (sim `sample_favourer`). After the reveal it knows, but its batch is already signed and published, so it can't edit what it claimed to have received. It can still leave out digests of packets it dropped, without knowing the key; that moves the loss to the link behind it, never off the link (T67).

## Measurement work (ADR-0055; proposed, gated off)

This section defines what counts as a validator's **measurement work**, the bytes `scoring.md` §Measurement work pays for. Only bytes that a node signs for count, so a validator that copies the revealed inputs and measures nothing has none (T175). Nothing here is scored until `scoring::measurement_work::VALIDATOR_WORK_ENABLED` turns on (ADR-0055 §8).

- **Allocated bytes, `A_v[k]`.** These come from committed draws only, never from the validator's choice:
  - **canaries (`WORK_CANARY`):** the bytes of the validator's verified canary plan, `Σ_p validator_pair_share(B_p, s_v)` (§Canary plans). A missing or rejected reveal leaves the allocation in place with nothing verified, so `f_v` falls;
  - **capacity tests (`WORK_CAP_TEST`):** for each team test whose drawn team includes the validator's hotkey with `rate_i > 0` (§Team capacity tests, `probe::draw_free_team`), its seat is allocated **what the team really streamed, scaled to what the node is judged on**: `rate_{v,n} * CAP_TEST_SECS * pushed_n / S_n` bytes, `rate_{v,n}` the member's water-filled rate from the ramp-capped `R(n)`, `S_n` the whole scheduled team's summed rates and `pushed_n = min(declared, S_n)` (fix round 1, red team items 1 and 2, T183, T177). An honest node carrying its declaration acks exactly this, `1 / 1.1` of the stream. A test that isn't a sample (`pushed_kbps = 0`: fewer than two revealed members) allocates nothing. The declaration enters only through `pushed`, which never exceeds `S`, so a node declaring 100 Gbps can't hand its teams allocations they could never stream (sim `validator_phantom_declarer`). Before fix round 1 the seat was `declared * 1.1 / team * CAP_TEST_SECS`. The peer-load capacity tests' hidden slices join this category once their ADR says who sources and who signs each slice (OQ-143).
- **Verified bytes, `D_v[k]`.** These are delivered and digest-checked bytes (ADR-0051, "only delivered bytes"), each capped at its own allocated amount:
  - **A canary entry** `(ingress, dst)` counts in full when both of these hold:
    - the ingress node's and the destination node's signed hop digests (§Secure sampling, ADR-0038) cover the entry's sampled packets, with contents that match the revealed plan;
    - the co-signed hop receipts on the legs from the validator's source node to `ingress`, and from `dst` to its sink node, cover the entry's bytes.

    Otherwise the entry counts for nothing. Needing both ends is what makes faked work need two colluders (ADR-0055 §6).
  - **A capacity-test seat** counts `min(ack, allocated, measured_n * rate_{v,n} / R'_n * CAP_TEST_SECS)`, in bytes: `ack` the bytes in the tested node's `cap-test-ack` for that validator key and `test_id`, `measured_n` the test's `TeamResult::team_kbps` (`min(declared, measured)`, the lower-median-bounded result) and `R'_n` the summed rates of the members that revealed a result (`measurement_work::cap_test_seat`). The third term holds a colluding node's ack to the seat's share of what the team as a whole measured, so acking a colluder's whole stream, or bytes it never sent, earns no more than an honest node's ack (sim `validator_headroom_ack`). It is shared over the revealed members, not `S_n`, so a member that withholds its result doesn't cut the others' work.
  - **Nothing signed only by the validator counts**: not its sink's own report, nor its probe batch's claims.
- **Nodes of the validator's own coldkey (fix round 1 item 3, T184).** An entry is the validator's own when any of its signing nodes (`ingress` or `dst` of a canary entry, the tested node of a seat) is bound to a UID whose coldkey, in the metagraph at the window's first block, is the coldkey of the validator's hotkey (`WorkEvidence.own_uids`). Own entries **keep their allocation and verify nothing**. Dropping them from the allocation as well would let the validator skip their cost at no loss of `f_v`, which beats measuring (the drop-both rule in sim `validator_own_fleet`). A fleet under another coldkey is collusion, bounded by ADR-0055 §6.
- **Attestation keys bound as fabric nodes (T184).** A validator any of whose counted attestation-key records (§Team capacity tests) carries an ed25519 key that is also a node key bound in the window's snapshot has all its work refused (`WorkEvidence.refused`, `measurement_work::attest_key_is_node`): its own source or sink would sign as a fabric end. Task 11a's set builder SHOULD refuse such records outright once the gate turns on (PB-42b).
- **The validator's own nodes.** Its source and sink node keys count only when they appear in its ADR-0039 attestation-key records, which carry proof of possession and are committed before the window's first block. A node key claimed by two hotkeys counts for neither (T179).
- **Recorders and the floor are unchanged.** Medians are still fed only by validators with counted attestation-key records, and the participation floor (`PROBE_PARTICIPATION_FLOOR_PPM`, §Team capacity tests) still decides carry-forward. Measurement work adds pay for being a recorder that measures. It changes no median and no quorum.
- **What every validator publishes per window (dashboard, ADR-0055 §7).** For each counted hotkey, `TempoOutcome.measurement_work` reports:
  - `hotkey`, `paid_uid` (or none), `stake_share_ppm` and `recorder`;
  - `canary_allocated_bytes`, `canary_verified_bytes` and `canary_reveal` (`accepted`, `missing` or `rejected`);
  - `captest_allocated_bytes` and `captest_verified_bytes`;
  - `work_fraction_ppm` and `work_share_ppm`, with their 24-window rolling means;
  - for the window: `slice_ppm`, `work_k_ppm`, `allocated_total_bytes` and `work_participation_ppm` (scoring.md §Measurement work).

  Every validator computes these from the same committed data, so any of them can serve the dashboard.

## Results and commit-reveal

1. During the window, each validator records probe samples (`ProbeSample`) and assembles a signed `ProbeResultBatch` (domain `probe-result`):
   ```json
   {"v":0,"window":1234,"validator":"<validator pubkey hex>","samples":[{"key":"link:<a>:<b>","rtt_us":12000,"loss_ppm":0,"jitter_us":50,"throughput_mbps":1000}],"cap_acks":[<CapTestAck>,...],"hotkey_sig":"<sig hex>"}
   ```
   `cap_acks` (omitted when empty) holds the node-signed `cap-test-ack`s backing the batch's `cap:<node>` samples, sorted and unique by `(node, test_id)`, at most `MAX_PROBE_SAMPLES`. `cap_cohorts` (omitted when empty) lists the batch's simultaneous cohort capacity tests (§Cohort capacity tests). Two ADR-0039 fields are omitted when empty, so existing batches keep their bytes and signatures:
   - `endpoints` lists the public endpoint this validator saw for each node it probed (§Probed endpoints);
   - `cap_teams` declares the batch's team capacity tests with their nonces (§Team capacity tests).

   Two PB-45b fields are omitted when empty too (`identity.md` §Delivery over the probe session, OQ-200): `consents`, the node consents the validator held at the reveal cutoff, and `forwarded`, the operator objects nodes forwarded that it admitted at its read block, each as `{"domain","node","object"}`. Both are sorted and unique by canonical bytes (objects also by `(domain, hash)`), within `MAX_REVEAL_CONSENTS`, `MAX_REVEAL_OBJECTS` and together `MAX_REVEAL_FORWARD_BYTES`, and every entry must verify; `validate` refuses a batch otherwise. The window's consent and object sets are the unions of what passes the chain checks (a consent list as a whole: listed, per-UID quotas; an object list per UID: admitted, within the UID's quota, so one UID's bad entries drop only that UID's), and only those unions reach scoring, never a validator's own pending pool.
2. At commit time, each validator commits `hash("probe-result", batch)` on chain.
3. At reveal, the batch is served as canonical JSON at `/v0/objects/probe-result/<sha256>` from the validator's HTTP endpoint (ADR-0015). Validators drop batches that don't match their commitment, fail cryptographic verification (`ProbeResultBatch::verify`), or contain duplicate measurement keys within the same batch.
4. Aggregation: for each measurement key, take the **stake-weighted lower median** across distinct revealed validators (at most one batch per `batch.validator` per window, and under ADR-0039 at most one per hotkey; `scoring::stake_weighted_lower_median`, `validator::verify_and_aggregate_probes_weighted`, `[T21]`, OQ-15). Each value is weighted by its validator's stake (`TempoInput::validator_stakes`). Under ADR-0039 it is keyed by SS58 hotkey, and each batch's ed25519 key is mapped to its hotkey through `TempoInput::attestation_keys` (§Team capacity tests, "Validator identity"); a batch whose key maps to no hotkey isn't counted. Before Task 11a the map was keyed by the same ed25519 key as the probe commitments; entries are sorted by `(value, stake)` ascending and the result is the smallest value whose cumulative stake `c` satisfies `2 * c >= total stake` (`u128`, no floats). Missing values are ignored; a key needs at least `MIN_VALIDATORS` (default 2) distinct validators with **positive** stake (when `validator_stakes` is non-empty, validators absent from it or with zero stake are dropped before the count) **and** a stake quorum: the reporting stake `r` must satisfy `r * 1e6 >= total * PROBE_STAKE_QUORUM_PPM` (default 333_333, about 1/3), where `total` is the stake of every validator in `validator_stakes`, revealed or not (the number of revealed validators when the map is empty). Under ADR-0039, once `attestation_keys` is non-empty, `total` is `recorded_stake`, the stake of hotkeys holding a valid attestation-key record. Below `PROBE_PARTICIPATION_FLOOR_PPM` of all stake, the window carries forward the previous window's metrics where no fresh aggregate reaches quorum, and charges no failures for them, for at most `PROBE_CARRY_MAX_WINDOWS` windows in any `PROBE_CARRY_SPAN_WINDOWS` (§Team capacity tests, "Quorum over recorded stake"). A few minimum-stake validators therefore cannot complete a median for a key no staked validator measured (e.g. a `cap:<own node>` result; red-team T21 round 2). An exact 50/50 stake split resolves to the lower value (lower median). With an empty stake map (or all-equal stakes) every validator weighs `1` and every aggregated value is the plain lower median (sort values, pick index `(n-1)//2`); keys reported by fewer than a third of the revealed validators are dropped. This count-based fallback is for the simulator and localnet only: on testnet (and later) validators MUST supply metagraph stakes in `validator_stakes` (roadmap M4-07), because with an empty map two minimum-stake sybils pass the count quorum whenever at most four honest validators reveal. A minimum-stake validator therefore cannot fail a link or capacity test by reporting `rtt_us = 0` when higher-stake validators disagree; failing a measurement needs at least half of the reporting stake.

All validators score from the same aggregated set, so Yuma consensus does not clip honest validators for having a different vantage point.

**Daemon inputs (M4-07).** `bwos-validator` loads `validator_stakes` from `--stakes-file` / `BWOS_VALIDATOR_STAKES_FILE`. The file maps each validator's probe key, the ed25519 key in `probe_commitments`, to its metagraph stake. Under ADR-0039 the live loop (Task 19b) keys `validator_stakes` by SS58 hotkey, straight from the metagraph, and fills `attestation_keys`. The stakes file is then for sim and localnet only. A missing stakes file on testnet is logged as a warning, because the count-based quorum fallback is for sim/localnet only. `node_diversity` used to come from `--diversity-file`; that flag and `BWOS_NODE_DIVERSITY_FILE` are now refused at start-up (Task 4B fix round 1, red team F2). Under ADR-0039, `node_diversity` is built from the probed endpoints committed in validators' batches together with agreed outside evidence (§Probed endpoints, §Underlay, IXPs and shared-risk groups). Every validator then builds the same groups, which a per-validator file can't guarantee (Invariant 1). Phase B Task 4B implements this (§Probed endpoints, "Dedupe"; OQ-80). Trusted voucher issuers and vouchers come from `--trusted-issuers` / `BWOS_TRUSTED_VOUCHER_ISSUERS` and `--vouchers-file`; node consents from `--consents-file`, merged each tempo with the retained `<state-dir>/consents-state.json` (highest started `seq` per node, revocations kept past their `not_after`; `identity.md` §Sequence, revocation and moves). Every input file is size-capped and strictly parsed. A malformed input stops the validator from starting; it never runs with an empty default.

## Live loop (Task 19b)

`bwos-validator live --network local|test --netuid <n> --hotkey <file> --attestation-key <file> --state-dir <dir>` (`crates/bwos-validator/src/live.rs`) is the validator's per-window loop. It serves its object store (`--listen`, receipts open to the window's live nodes), fetches what it lacks from `--peer-validators`, and takes no demo input and no stakes, diversity or input file (F1, M4-08): every scoring input below comes from the chain and from objects the chain's commitments name. On `test`, a read with no staked hotkey is an error, never the one-vote fallback (`inputs::require_stake_source`, T21). Any network but `local` and `test` is refused before anything else, and the connection is genesis-checked (mainnet refused).

**Schedule of window `w`** (`S = w * 360`; parameters in `scoring.md` §Parameters):

| Block | What happens |
|---|---|
| `S - 1`, read `A(w)` | Metagraph and stakes (`uid_hotkeys`; `validator_stakes` keyed by SS58 hotkey, R2). From each manifest that covers `w` (`identity.md` "Read block", "Validity"): the binding, the capacity declaration and the attestation-key record with its commitment block (committed before `S`, so `window_attestation_keys` keeps it, RT2). Taken when the block is final. |
| `S` | Canary seed stakes: permit holders' stake at the seed block (`canary_seed_stakes`, §Stake shares). |
| `S + SOLVER_COMMIT_DEADLINE_BLOCKS`, read `D(w)` | Route tables of manifests covering `w`, for window `current_snapshot.window + 1`, each signed (sr25519) by its committing hotkey. `commit_block` is the commitment's block (OQ-129, OQ-107 (5) and (7)); a later commitment is no submission. `prev_table` is the table the UID committed in the previous `D` read, never the solver's word. The path-probe draw is taken here; a draw that fails is retried each pass until `S + 36 + DRAW_GRACE_BLOCKS` (19b verification, M-a). |
| `S + OWN_COMMIT_OFFSET_BLOCKS` | This validator commits its manifest for `w`: its `attest` record (renewed with four windows to spare), its probe batch for `w` from `--probe-results` and, with `--agent-results`, its probe agent's results for `w` merged in (PB-48, "The probe agent's plan and results" below; signed by the attestation key: one key per hotkey, OQ-55 (b)) and its outside evidence for `w` from `--evidence`. With `--probe-pool`, the batch's `consents` and `forwarded` are this validator's reveal of what nodes forwarded over its probe sessions (PB-45b, `identity.md` §Delivery over the probe session), and the batch is signed again with the attestation key, or is a batch of the reveal alone when `--probe-results` has none. The record and the manifest are served at once; the batch and the evidence are withheld (commit). |
| `S + 359`, read `B(w)` = `A(w + 1)` | Probe batches and outside evidence named by manifests **made for `w`** (`manifest.window == w`): each batch for window `w` and signed by a key the committing hotkey's record maps to it; each evidence object the manifest's own (`ev.validator`, `ev.window`, hash, `verify`; RT5, M2). `probe_commitments` is keyed by SS58 hotkey (the identity join). |
| `S + 360` | Withheld objects go into the store (reveal), first in each pass of the loop, before any chain read, fetch or commit (19b verification, M-b). |
| `S + 360 + REVEAL_DELAY_BLOCKS` | Score `w`, publish, set weights. A probe batch for `w` named by a manifest admitted at `B(w)`, from a validator-permit holder at `A(w)`, that isn't here yet is asked for again every 2.5 s (`PROBE_BATCH_REASK`), at most `PROBE_BATCH_REASKS` (4) times (M-b; integration fix round, M2). Catch-up scoring and re-asks stop for a path-probe draw that is due (L1). The window's revealed consents (from permit holders' batches, accepted one at a time, H1) join its `node_consents`, which `live` takes from nothing else: no consent in its own store counts (M1), and the operator objects its revealed union admits against `A(w)` go into the store before `A(w)`'s manifests are read, so they count for `w` itself (PB-45b, OQ-261, cold-start fix). Windows are scored in order from the one after the last scored (fix rounds 1-2, F3). Scoring is all or nothing: the loop state is restored if a window fails, which is retried during the next window and given up only once that has passed. A restarted validator catches up the windows it missed, at most `READ_LOOKBACK_WINDOWS` back, rebuilding the carried state without submitting or publishing for them: only the last finished window's weights are submitted. Catch-up yields to the window's own commit at `S + OWN_COMMIT_OFFSET_BLOCKS`. |

A read is the chain state at that block, by its hash: the metagraph and the commitment records are read at the same block hash and refused if they differ (OQ-222), so every honest validator reads the same commitments (Invariant 1). Each record carries the manifest hash and, from `INLINE_BINDINGS_ACTIVE_FROM_BLOCK` (`0` on `local` and `test`; a mainnet block is an ADR-0049 activation, OQ-201 (a)), the inline binding of ADR-0058, which fills `TempoInput::inline_bindings` and takes precedence over the UID's manifest binding. A manifest is admitted only if it is canonical, verifies (`CommitmentManifest::verify`, the hotkey's sr25519 signature), hashes to exactly the commitment, and is the committing registered hotkey's for the netuid (S4, D16); anything else is dropped before scoring. An SS58 binding's `hotkey_sig` is checked with `verify_sr25519_hotkey_sig` (OQ-131 (b)). Objects are pulled (OQ-220, OQ-223): from this store, then at once from the peers and the committing hotkey's on-chain axon (no URL in the manifest), each by the hash the chain authenticates, within `MAX_OBJECT_BYTES` and the fetch timeouts. On `test` an axon must be a global unicast IP; a pull base is a bare `http://<ip>:<port>` (F5). A pulled copy is kept and served. Fetches are batched (fix rounds 1-3): a read fetches every manifest at once, and scoring every unfetched manifest of `A(w)`, `B(w)` and `D(w)` and then every object they name, and each waits once for the whole batch within `READ_FETCH_BUDGET` or `SCORE_FETCH_BUDGET`. Requests are grouped by object (C1): one job per `(domain, hash)` races the peers and the axon of every hotkey whose commitment names that hash, returning on the first verified copy, so a hotkey that copies another's hash with a dead axon can't stop the owner's axon being asked. Failures are remembered per `(domain, hash, source)` for the window, except for slot objects (probe batches, outside evidence), which may be revealed late. Jobs are shared out by hotkey (H1): they start one hotkey at a time in turn, each hotkey holding at most `MAX_FETCHES_PER_HOTKEY` jobs and all of them at most `MAX_IN_FLIGHT_FETCHES`; a job that can't start yet waits in its queue until the budget ends, never dropped. One hotkey's tarpit costs only that hotkey's share, and one blackholed peer only its own timeout. A manifest not fetched by a read is kept and re-read until the scoring deadline. Each pass of the loop reveals first and commits next, so no fetch delays either (M-b). Route tables are fetched when `D(w)` is read and path probes are drawn (`S + 36`); the tables fetched then are recorded in `D(w)` (`drawn_tables`) and are the only ones graded (fix round 3, H2). A table withheld at the draw, so none of its paths was probed, and served later counts as no submission. A validator that missed the draw (down from `S + 36` to `S + 36 + DRAW_GRACE_BLOCKS`, or its plan couldn't be written: `drawn_tables` is `None`, where a draw that fetched no table is an empty set) grades no table and **holds Mechanism 1 back** for the window instead of giving the first party what the winner earned (M-a, OQ-224 (a)); the full fix is quorum-named drawn sets (OQ-224 (b)). There are no uploads from outside: an object nobody serves counts as absent (OQ-211; the full fix is OQ-211 (a), quorum-fetched objects). A validator serves its own store as its axon (`--axon`), so its manifest and revealed probe batches reach every validator, not only its `--peer-validators` (F4). Which window's objects count from each read (OQ-132): bindings, declarations and records by `covers`; batches and evidence only from manifests made for the scored window, and only objects of that window.

**Filled from the chain and the carried outcome.**
- `binding_committed_blocks` (PB-04, T83): for each live node, the commitment block of the earliest read in the unbroken run of reads, back from `A(w)`, in which its UID's manifest named the same binding, at most `READ_LOOKBACK_WINDOWS` back, and the hash of the block after it. A read without the binding breaks the run, so a lapsed binding committed again ranks from its new block. An inline node (ADR-0058 §5, OQ-204) ranks from the block of the earliest read in the unbroken run of reads whose inline binding for its UID lists it. A run that reaches the oldest retained read ranks from that window's first block (fix round 1, F6), so every binding as old as the horizon ranks alike and commit timing before it buys nothing.
- `prev_validator_set` and `validator_sets` (T106, T109, T113): no committed in-force set hash exists yet, so the loop always takes the re-anchor rule's set, `signed::build_validator_set` at `S` over the records committed before `S` and the stake history of the retained reads. Every validator builds it alike from the same reads. It anchors the table-update chain.
- `table_updates` (Task 16b): `signed-table-update` objects for the production table's window dated at most `S + 359 - MAX_UPDATE_BLOCK_SLACK - UPDATE_PROPAGATION_MARGIN_BLOCKS` (OQ-127; the margin gives the quorum's attestations time to reach every store before scoring, F4).
- `declaration_reads` (PB-14, `[T56]`): each window's `node_declarations` read is kept as it is taken; after a gap the missing windows of the cooldown epoch are rebuilt from their own reads `A(x)`, an unfetchable declaration counting as absent.
- `evidence` and the `--evidence-commitments` slots (Task 4C, F1): the committed `{hotkey, window, hash}` slots of the last `EVIDENCE_MAX_AGE_WINDOWS + 1` windows, from the retained reads. A slot counts only if its hotkey is in that window's validator set (`validator_set_at(x)`: an `attest` record committed before the window and the stake lookback minimum) and holds a validator permit (fix rounds 1-2, F1). Slots are taken per `(hotkey, window)`, and a hash named by several belongs to the earliest commitment (ties to the lower hotkey): a copier commits after it saw the hash. **Missing evidence never holds weights back** (fix round 2 ruling): an object no store served simply isn't counted, so it gives no diversity credit, and scoring goes on. It is fetched again every window of the span, so a late reveal counts once it arrives. No input a third party commits ever holds weights; only this validator's own required inputs (its chain reads, its stake source) stop a window. `evidence_count_quorum` is set only on `--network local`.
- From the last outcome, persisted in `<state-dir>/live-state.json`: `current_snapshot` and its costs, `current_demand`, `current_prod_table`, `incumbent_solver_uid`, `prev_endpoints`, `prev_cap_assignments`, `prev_aggregated_metrics`, `prev_carried_windows`, `prev_verified_capacities`, `prev_pooled_capacities`, `paid_bytes_history`, `capacity_trigger_latched_at`, `solver_win_history`, and each solver's last committed table by hash only (read back from the store for `prev_table`; fix round 2), so the state stays small whatever the tables weigh. The capacity, cohort, consent, declaration-epoch and evidence state stay in their own files (`run-tempo`'s persisted path). Reads are kept for `READ_LOOKBACK_WINDOWS` and rebuilt from historical commitments after a restart or late start; that needs an archive node, which the testnet endpoint is (on `local` a pruned read is skipped with a warning; on `test` it is an error).
- Node consents: the `node-consent` objects in this validator's store, merged with `consents-state.json` (OQ-213).
- The reference solver's submission is solved from `current_snapshot` and `current_demand` at `LIVE_DEMAND_MBPS_PER_PAIR`, under the first-party UID.

**The probe agent's plan and results (PB-48).** With `--agent-results <dir>`, `live` and its validator's probe agent (`bwos-probe serve --plan <state-dir>/probe-plan.json --results-out <dir>`) exchange two files. Each is written whole and renamed into place, read once to at most `MAX_PLAN_FILE_BYTES` (16 MiB), and strictly parsed (`bwos_core::probe_plan`).

**The plan** (`ProbePlan`) is `{"v", "window", "block", "now_block", "rank", "validator", "cap_test_period", "nodes", "cap_tests"}`. `live` keeps it written every pass once `A(w)` is read, waking every block while it has an agent.
- `validator` is the attestation key, which every capacity-test header names.
- `block` is the read's block, `S - 1`.
- `now_block` is the finalized block as of the write.
- `rank` is this validator's place among the read's permit holders, by hotkey.
- `nodes` are drawn from the nodes registered UIDs' bindings or inline bindings list at `A(w)`, at most `MAX_PLAN_NODES` (`MAX_PROBE_SAMPLES / 2`), by `probe_plan::plan_candidates` (verification C1). A binding is signed by its hotkey alone, so any UID can list any key:
  - **Consented.** A node with a held consent counts under the lowest UID whose binding lists it under the consent's hotkey, as `probe_forward` places a consent. A second UID listing it never drops it.
  - **Unconsented.** A node without one gets a delivery session only. It counts against the quota of the first UID listing it, in UID order, with room.
  - **Quotas.** Each UID takes at most `MAX_PROBE_SESSIONS_PER_UID`, of which `MAX_UNCONSENTED_SESSIONS_PER_UID` unconsented, its consented nodes first, each by key.
  - **Turns.** UIDs then take turns, one node each in UID order, until the cut, so no UID's low-sorting keys crowd another's out.

  Each node carries:
  - `uid`;
  - `declared_mbps`, from `validator::node_declarations` (`0` without one);
  - `consented`: a node-signed consent in the last window's revealed union or in this validator's pending pool;
  - `proven`: verified capacity last window.
- `cap_tests` are the window's single-agent capacity tests on the shared schedule (§Capacity tests). Tests are drawn by group (PB-48 final verification, T316/T317), `probe_plan::cap_tests_due`:
  - **Draw key** (`probe_plan::cap_draw_key`), by the node's carried target (`TempoOutcome::cap_targets` and `cap_dialed`, the same on every validator):
    - **Dialed:** its UID, `SHA-256("BWOS-v0/cap-dial-draw" || 0x00 || u32be(uid))`, so all of a UID's nodes behind NAT are tested at once wherever they are (release round, T325). Each is capped at `CAP_DIALED_CEILING_MBPS`, so `CAP_DIALED_GROUP_MAX_TESTS` (20) fit the default budget.
    - **Pushed:** its network, `SHA-256("BWOS-v0/cap-net-draw" || 0x00 || 0x04 || first 3 octets)` for IPv4 (its `/24`), `... || 0x06 || first 4 bytes` for IPv6 (its `/32`, release round: wider than a free tunnel broker's `/48`; for the draw only, pooling stays `/48` within a UID), an IPv4-mapped address read as IPv4. So co-located nodes are drawn together whatever their UIDs.
    - **None** (never tested): `SHA-256("BWOS-v0/cap-node-draw" || 0x00 || node_pub)`.
  - **Due.** A group is due at the first block `b` with `S <= b < S + CAP_PLAN_BLOCKS` (235) at which `capacity_test_due` over the hash of `b - 1` and its draw key says so. Every consented node of it with a positive declaration is then due at `b`, so one pipe can't pass its tests one after another. Each test carries its `group`, the draw key in lower hex.
  - **Start.** Its `start_block` is `b + (rank mod CAP_STAGGER_RANKS) * CAP_TEST_STAGGER_BLOCKS` (3 blocks), so validators' tests of one node don't overlap (red team fix 2). The last rank's start is still `CAP_PLAN_MARGIN_BLOCKS` (20) before the batch is committed at `S + 300`.
  - **Order.** As the team schedule orders a block's tests: proven nodes first, then unproven ones, each by `(b, probe_plan::cap_test_order)`, `SHA-256("BWOS-v0/cap-test-order" || 0x00 || hash of b - 1 || node_pub)`, so which nodes are tested is drawn per block and no key grinds to the front (final verification, medium). At most `CAP_TESTS_PER_UID_MAX` unproven tests per UID (red team fix 5), and at most `CAP_GROUP_MAX_TESTS` (16, `MAX_CAP_COHORT_NODES`) per group (`CAP_DIALED_GROUP_MAX_TESTS` for a dialed group): the rest of a crowded group waits for a later draw. Of a group's slots, up to `CAP_GROUP_UNPROVEN_SLOTS` (4) are kept for unproven nodes when that many are due, so a group crowded with proven nodes still admits newcomers (release round, T328).
  - **Period.** `cap_test_period` is `CAP_TEST_PERIOD`. `--cap-test-period` sets another only on `--network local`, for tests.

**The agent's work.**
- **Sessions.** It binds exactly the plan's nodes, each under its probe-session key, the X25519 form of its node key (ADR-0061). It refuses a key two nodes share, and allows at most `MAX_PROBE_SESSIONS_PER_UID` sessions per UID, of which `MAX_UNCONSENTED_SESSIONS_PER_UID` for unconsented nodes, which only deliver their consent (red team fixes 6 and 8).
- **STAMP samples.** It samples each session about every `VANTAGE_SAMPLE_INTERVAL_SECS`.
- **Link probes.** It relays link probes through each node to the BGP peers the node hints:
  - every `LINK_HINT_US` the node sends `LINK_PEERS_HINT || keys` on `LINK_PROBE_PORT` (8_623) inside its probe session;
  - the agent sends `b || fresh 16-byte nonce`;
  - the node passes the nonce over its session with `b` to `b`'s `LINK_ECHO_PORT` (8_624);
  - `b` answers `nonce || its node key's signature over {"v": 0, "from": a, "to": b, "nonce"}` (domain `link-echo`, `probe::LinkEcho`), only to a peer on that peer's own link;
  - `a` hands that back to the agent, which counts the round trip on its own clock only if `b`'s signature verifies. A probe with no valid echo in 2 s is lost.
  - The window's `link:<a>:<b>` sample has `rtt_us` the lower median of the counted round trips and `loss_ppm` the lost share (`window_link_sample`).
  - A no-root node relays and echoes in its own loop. A kernel node's `bwos-node probe-session --link-peer <peer node> ...` does both through UDP sockets on the node's `/128`, and the install lets `LINK_ECHO_PORT` in on overlay links only.
- **Capacity tests.** It runs a group's tests due at one block (same `group` and `start_block`) as one group test once the plan's `now_block` reaches their `start_block` (`run_group_cap_test`, PB-48 final verification).
  - **Members.** A group starts once every member has a target, or has waited 120 s for its session (then a failed sample), so no node is tested apart from its group by holding its session back. A test that joins a group already started this window (its node planned later) waits for a later window.
  - **Running.** At most `CAP_GROUPS_RUNNING_MAX` (8) group tests run at once, connecting, held or streaming. A group that can't start yet doesn't hold back the ones after it (release round, T329).
  - **Budget.** `--cap-test-budget-mbps` (default `CAP_TEST_BUDGET_MBPS`, 2_000) caps the agent's tests together (F2). A group takes its share only once its connections are made (release round, T329): `min(budget, Σ ceilings)` of its connected members, waiting up to `CAP_DIAL_HOLD_SECS` for room and then taking what's left; it gives it back when its streams end. So no group pushes the validator's link past the budget, and a group held for dials holds none of it.
  - **Rates.** Each member's ceiling is its declaration, or `min(declared, CAP_DIALED_CEILING_MBPS)` when dialed. The group's share is water-filled fairly across its UIDs first (each UID's ceiling the sum of its members'), then within each UID (`probe_plan::cap_test_rates_by_uid`, max-min fair at both levels; release round, T326), so neither a member that declares more nor a UID with more nodes takes a neighbour's share. Each rate is recorded as the target's `paced_mbps`.
  - **Hold cap.** A UID's members may cause one agent at most `CAP_HOLD_SECS_PER_UID_PER_WINDOW` (60 s) of dial holds a window, one hold charged per group; past it a member whose push fails isn't asked to dial and fails (release round, T329).
  - **One start.** All connections are made at once, each request header sent as it is made. With any dial asked, every stream starts at `CAP_DIAL_HOLD_SECS` after the group started (§Capacity tests of nodes behind NAT); otherwise once every push is in (F3).
  - **The stream.** Each test is echoed (red team fix 3): a ChaCha stream paced at its rate for `CAP_TEST_SECONDS`, to the node's `bwos-probe cap-sink -echo -persist`, with private byte checks (`team_stream`). So it measures `min(up, down, rate)`, at `throughput_mbps = echoed * 8 / rtt_us`.
  - **Cohorts.** Each UID's members of a group test (by key, in chunks of `MAX_CAP_COHORT_NODES`, two or more) are one legacy `CapCohort` (§Cohort capacity tests): their test ids are its `cap_cohort_test_id`s under a fresh nonce, and its `span_us` runs from the start to the last stream's end. Its `capcohort:` aggregate is what the UID's members measured together.
  - **Abort.** A test under `CAP_ABORT_PPM` (1%) of its paced rate after `CAP_ABORT_AFTER_SECS` stops there.
  - **Target.** The sink's address is `--cap-target` if given, else the probe session's source at `CAP_SINK_PORT` (8_621), never the session itself. The address is recorded as the test's `CapTarget`.
  - **No target.** A test whose node has no session for 120 s is a failed sample, never omitted.
  - **NAT.** With `--cap-dial-listen`, a node whose sink can't be reached is asked over its session to dial out for its test instead (red team fix 9, interim; §Capacity tests of nodes behind NAT). The target is then `dialed`, credited at most `CAP_DIALED_CEILING_MBPS`.

**The results** (`AgentResults`) are `<dir>/<w>.json`, rewritten at most every 5 s while samples come in and at the window's end, and pruned 16 windows back: `{"v", "window", "samples", "cap_acks", "cap_targets", "cap_cohorts"}` (`cap_cohorts` omitted when empty).
- **Samples.** One `vantage:` sample per consented planned node: the window expects one sample per elapsed interval less one (the slot in progress), each one short counts as lost, so a node with no session to this validator fails it (red team fix 4). Plus the `link:` samples and the `cap:` samples, sorted and unique by key; no other keys.
- **Acks** are sorted by `(node, test_id)`, **targets** by node, and **cohorts** by `nodes`: legacy cohorts only (no `block`), each member with a `cap:` sample, a node in at most one.

**What `live` takes.** At its own commit, `live` reads `<dir>/<w>.json`, refuses it unless it validates and is for `w`, and merges it into the batch (`probe_plan::merge_agent_results`).
- A key the `--probe-results` batch already has keeps that sample.
- Each added `cap:<n>` brings the results' acks for `n` that name the batch's validator and window, and its target. A cohort comes in only if every member's `cap:` sample came from the results and none is in a cohort the batch has. The merged batch must validate.
- The batch is signed again with the attestation key, then committed and revealed like any batch. Only that batch reaches scoring: the agent's files are never a scoring input. A missing or bad results file leaves the batch as it was.

**PB-48's capacity rules.** They turn on in the first window where any revealed batch carries a `CapTarget` (`validator::cap_rules_on`), as every plan-mode agent's batch does.
- **Latched.** Once on, they stay on (verification H1). `run_tempo` applies them whenever `TempoInput::prev_cap_targets` is non-empty, and targets carry forward. A window whose batches carry no target, for instance one in which no test started, is still under them.
- **Never on.** Sims and inputs that never carried a target score as before. Under them:
- **The `cap:` sample.** A sample claiming success needs its target and an ack of at least `cap_min_ack_bytes` of its rate (red team fix 7), else it is a failed test. A `dialed` one is capped at `CAP_DIALED_CEILING_MBPS`. A target's `paced_mbps` adds the batch's verdict `cap:<n>:verdict_ppm` = `probe::cap_verdict_ppm(measured, paced)`, `min(1e6, measured * 1e6 / paced)` from the sample as scored (failed: 0; pace capped like the throughput when dialed). Scoring takes the median of the validators' verdicts, never one of measures over one of paces (release round, T327).
- **Reporters.** A `cap:` key, and a `capcohort:` key (final verification F2), needs `probe_plan::cap_min_reporters` reporting validators: `clamp(revealing - 1, CAP_MIN_REPORTERS_FLOOR, CAP_MIN_REPORTERS)` = `clamp(revealing - 1, 2, 3)`. Here `revealing` is the window's staked validators whose batch counts. It is the same for every validator, since all see one revealed set.
- **Judged at its own pace (F2; release round, T326, T327).** Each window's aggregated verdicts are `TempoOutcome::cap_verdicts`, kept per window beside the measures (`cap-history.json`, `TempoInput::cap_verdict_history`), so every test in the span is judged against its own pace:
  - a test passes when its verdict is at least `1e6 - CAP_TOLERANCE_PPM`; an earlier test with no verdict gets `cap_verdict_ppm(measured, declared)`;
  - a test that passed but measured under `declared * (1 - tolerance)` was paced down by a crowded group: it is a lower bound, **censored**, left out of the measured median while any uncensored test is in the span, so a crowd in a victim's `/24` doesn't cut its credit, during the crowd or after;
  - the node is credited `min(declared, M)` if the lower median of its verdicts passes, else `M` cut by `OVERCLAIM_PENALTY_PPM`, with `M` the lower median of its uncensored measures (all of them if none is). A failed test's verdict stays in the span, so lowering a declaration after it doesn't clear the cut. A node only ever tested in a crowd is credited what it measured.
- **Pooling.** Each node's target is the stake plurality of its tests' targets (`aggregate_cap_targets`), carried with whether it was dialed as `TempoOutcome::cap_targets` and `cap_dialed` into the next window. Capacity pools by `validator::cap_target_groups` (final verification): nodes of one UID whose targets, pushed or dialed, share an IPv4 `/24` or IPv6 `/48`. Nodes of different UIDs never pool, not even at one address: co-located nodes are drawn and tested together, so each is measured at its share of a shared pipe (T316, T317). A group is credited `max(largest member, min(cohort, Σ verified))` over its members' cohort aggregates (`scoring::pool_capacities_by_groups`, `[T28]`), split by the members' verified (measured) shares, so an honest UID's separate pipes in one `/24` are credited their measured sum and one pipe behind many keys its one pipe. A node with no target gets no capacity (red team fix 1).
- **Data plane.** Only a node with a passing `link:` result with a live node of another UID, on a pair of the committed snapshot or production table, gets capacity credit (`validator::data_plane_nodes`). A probe-only node, which carries nothing, earns nothing (red team fix 1).
- **Uptime.** A failing `vantage:` window sample counts in uptime as the share of the window the node answered, `1e6 - loss_ppm` (red team fix 4).

**Not filled, by design.** `block_hashes` stays empty, so team mode stays off: Task 18b, the endpoint trigger and OQ-99 are its preconditions (T105, T124, T125). `cap_team_history` stays empty with it. ADR-0055 measurement work, ADR-0056 peer-load scoring and ADR-0057 geo pricing stay behind their gates. `failure_challenges`, `hop_digest_batches`, `sample_key_reveals`, `verdict_history` and `known_failed_links` wait for Task 16c, which isn't on main.

**Weights.** Each mechanism is judged on its own (`validator::mechanism_refusal`, `validate_weights`): a mechanism with unassigned unearned weight is held back, so with no first-party UID Mechanism 1 sets nothing, and Mechanism 0 never goes to the first-party UID (Task 15). The first party is pinned by its SS58 hotkey (`--first-party-hotkey`), resolved to its UID at `A(w)` every window, never by UID number: a UID freed by a deregistration goes to whoever registers next (fix round 3, T241). It must be registered and its coldkey must not be the subnet owner's (T129). Weights are committed timelocked when the subnet has commit-reveal on, and set directly otherwise; a direct set that errors is read back before any retry. The loop warns when a mechanism's last weights would age past `last + activity_cutoff` before the next window (`refresh_deadline_block`, R17).

**Publishing.** After scoring `w` the loop writes the next window's validator set, peer directory (window `w + 1`, block `S(w + 1)`, entries from `next_snapshot`), snapshot and table into `<state-dir>/signed-inputs/`, with `chain-block`, `demand-mbps-per-pair`, `demand.json` and `solver-hotkey`; the directory carries the window's `demand_mbps_per_pair` (OQ-221) (the incumbent UID's hotkey on chain, OQ-126), and Task 11b's `Publisher` attests them through `publish_attested`. Before an input is written, `(domain, latest_key, attestation hash)` is written and synced to `<state-dir>/attest-guard.json`, and a different object for a recorded key is refused, across restarts too (T60). Every 30 s the loop re-merges peers' attestations and relays the incumbent's latest `table-update` (named in its current manifest, pulled by hash from its axon if no store has it) for `Publisher::check_update`. Publication objects whose window or set ended more than `VALIDATOR_SET_LIFETIME_BLOCKS` ago are pruned (`ObjectStore::prune_publications`, OQ-67), and manifests and the objects they name once no retained read has named them for two windows.

## Uptime

**A draining node (ADR-0048) is not exempt.** Probes, canary flows and capacity tests scheduled during a drain are scored exactly as for any other node. A sample the node refuses because it is drained is a failure. Until OQ-100 is settled, vantage probes during a node's announced drain (its own signed `node-action` record) also count as failures. That stops a node draining between its canary and capacity-test slots while keeping uptime.

`A_u` (ppm) = probes passed / probes scheduled for the fleet's nodes in the window, **capacity-weighted**: `A_u = Σ_n Σ_s cap(n) * w_s * pass_s / Σ_n Σ_s cap(n) * w_s` over the fleet's nodes `n` with scoring capacity `cap(n) > 0` and their samples `s` of evidence weight `w_s` (below; `u128` sums, floor, `probe::compute_uptime_weighted_ppm`). A node with no scoring capacity adds no samples. Without capacity weighting a 100 Mbps fleet-mate dominated a 10 Gbps node's uptime: three 100 Mbps attacker UIDs failing links with it cost the fleet 0.801x (attackers 1.053x; five: 0.696x / 1.142x), and a genuine fault on the small node cost a 10.1 Gbps fleet 0.194x versus 0.996x for unbonding it (red-team round 3; after: victims 0.977–0.990x in that 10 Gbps + 100 Mbps configuration, attackers at most 1.001x, genuine fault 0.953x; sim `small_fleet_mate_framer` over six fleet mixes: attackers at most 1.001x, victim UID at least 0.917x, worst for 10 Gbps + 1 Gbps vs 3×1 Gbps attackers, who themselves drop to 0.979x). A probe passes if it completes (`rtt_us > 0`) with loss at or below `PROBE_LOSS_MAX_PPM` (default 50_000).

Missing measurements are failures, never passes (`validator::node_probe_evidence`, `[SCR-2]`). Per node:

- **Attributable links only (`[T29]`).** A `link:<a>:<b>` result counts only when `a != b`, both are live bound (consent-resolved) nodes of **different UIDs** (an operator's links between its own nodes prove nothing and are not evidence for anyone), and the unordered pair `{a, b}` is a link of the **current** topology snapshot or a hop (`path` or `backup_path`) of the **current** production route table. Results on any other pair, such as a burner node no route uses, count for nobody (`validator::LinkAttribution`).
- **Both endpoints, blame by leave-one-UID-out base rate.** Every attributable result, outgoing and incoming, is evidence for both endpoints (`RT2-2`): a pass is a pass for both. Each node keeps `(passes, total)` per other UID over its attributable results (each counted for both endpoints) plus one failure per outgoing attributable snapshot link with no aggregated result. A failed attributable link between `node` and `peer` is **excused** for `node` only when `base(node, excluding uid(peer)) > base(peer, excluding uid(node)) + LINK_BLAME_MARGIN_PPM` (100_000); otherwise it is charged to `node`, so a small gap charges both ends. Leaving out the judged pair's UIDs stops a fleet from pushing blame onto victims by failing many of them at once, and excluding same-UID links stops it from padding its rate with its own mesh (red-team `fleet_blame_shifter`, measured 1.82x before, 0.02x after).
- **One-sided budget.** Every failed measured attributable result gets one verdict per window, assigned in ascending `(unordered pair, direction)` order. When one end is excused by the rule above, the other end alone is charged only while it has received fewer than `MAX_ONE_SIDED_CHARGES_PER_NODE` (2) one-sided charges this window, unless it has **no validator-vantage evidence** (verified capacity 0, i.e. no node-acked capacity test in the rolling window, and no passing acked `cap:<node>` test this window) **and** its base rate excluding the peer's UID is strictly below `ONE_SIDED_EXEMPT_RATE_PPM` (250_000), as for a zero-capacity burner; every later failure is charged to **both** ends. Link evidence alone cannot separate K meshed sybil UIDs framing a node from K honest peers of a broken node (enough sybils push any victim's rate below the threshold, red-team round 3), so the exemption rests on evidence a validator measured itself. `LinkAttribution::new` (no vantage information) exempts nobody. Sybil UIDs meshed with each other can make their base rates look clean, but then cannot fail a victim's links without paying the same charges themselves (red-team `sybil_uid_blame_shifter`).
- **Per-UID charge cap.** At most `MAX_CHARGED_LINK_FAILS_PER_UID` (2, one link in both directions) failures are charged to one node from the nodes of any single other UID per window (counted in the order outgoing, unmeasured, incoming; ascending peer key), so a many-node UID cannot multiply blame by its node count. A node that blackholes incoming probes from its real peers (rate about 50%) is still charged every failure; after its one-sided budget its peers share each failure (at most one each, sim `incoming_blackhole` 0.497x). A burner that fails every probe to and from its victims (rate `0`) takes all of those failures itself (sim `burner_peer_griefer`).
- **Validator-vantage corroboration (Pass-7, `[T29]`, OQ-16).** When **both** ends of a failed measured attributable result have an aggregated `vantage:<node>` result (`validator::vantage_status`; a vantage result passes iff `rtt_us > 0` and loss within `PROBE_LOSS_MAX_PPM`, so failing it needs at least half the reporting validator stake), the verdict is:
  - one end fails its vantage probe and the other passes: the failing end is the one blamed (instead of the base-rate comparison), alone only within its one-sided budget and then together with the peer (red-team Pass-7: a node whose UDP echo is merely firewalled must not take unlimited blame, 0.614x before), **unless** it also has no passing attributable link of positive weight this window and is peered with at least `MIN_DARK_PEER_UIDS` (3) other UIDs: such a **dark** node takes every failure alone (the peer-UID minimum stops an attacker that owns all of a vantage-blocked node's peers from zeroing it at no cost; with two attacker UIDs it now pays both-ends charges, attackers 1.08x before, 1.04x after; the victim, having no passing evidence at all, is at 0 either way), so its honest peers are not charged (red-team round 2 `dark_node_peers`: 8 of 10 honest peers at 950_000 uptime before, none charged after); both fail: both are charged;
  - both pass ("both serving"): an end that is exempt as above (never vouched, base rate below `ONE_SIDED_EXEMPT_RATE_PPM`) is charged alone (a burner cannot shed blame by answering vantage probes, which cost nothing); otherwise, if both ends are **clean** (at least `MIN_CLEAN_PEER_UIDS` (2) other UIDs with which every attributable result passed, each of those UIDs including at least one vouched node) **and isolated** (failed attributable results with at most `MAX_NEUTRAL_FAIL_UIDS` (2) other UIDs), the failure is **neutral** and charged to nobody (isolated pairwise faults between serving nodes are forgiven, and small framing is worthless); otherwise the base-rate rule and one-sided budget above apply, except that a clean end is **never** charged alone.
  - If either end has no vantage result, the rules above apply unchanged, except the dark-node rule: a node that itself fails its `vantage:` probe, passes no link this window and is peered with at least `MIN_DARK_PEER_UIDS` other UIDs takes its failures alone whatever the peer's vantage result (`validator.rs` `LinkAttribution::new_with_capacities`).
  Neutral failures cost no uptime. A node's neutral **outgoing** failure adds a `Q_n` sample equal to its lowest other outgoing quality sample, so dropping its worst links cannot raise its `Q_n` (red-team Pass-7 neutral `Q_n` pruner, 1.041x before, 1.003x after) while a framed victim's `Q_n` is essentially unchanged. Neutrality is limited to isolated failures because link and vantage evidence cannot tell a victim framed by many sybil UIDs from a node that serves validators and two peer UIDs and drops all other peers (sim `selective_server`: 1.000x honest with unlimited neutrality, 0.43x with the limit).
- **Capacity-weighted evidence (Pass-7, `[T29]`).** Every link result with `peer` counts for `node` with weight `w = min(cap(peer), cap(node)) * 1e6 / cap(node)` ppm; when `node` has no capacity, `w = 1e6` for a peer with capacity and `w = 0` for a zero-capacity peer (zero-capacity keys are never evidence about anyone) (`validator::LinkAttribution::new_with_capacities`, `node_probe_evidence_weighted`). `cap` is the node's **scoring** capacity after `[T24]`/`[T28]` endpoint dedupe, so k keys behind one pipe in one /24 that each pass a sequential test weigh one pipe between them (red-team round 2 `shared_pipe_sybil_framer`: real UID 1.703x and victims 0.67x with raw verified capacity; attacker entity at most 0.933x after). The weights apply to the base rates, to the clean and isolated tests, to uptime (`A_u = Σ w(pass) / Σ w`, `probe::compute_uptime_weighted_ppm`; capacity, vantage and no-evidence samples weigh `1e6`) and to `Q_n` (weighted lower median). Results of weight `0` are not evidence at all and do not use the per-UID charge cap. A node with no scoring capacity adds nothing to `K_u` and earns no byte credit, so its samples do not enter its UID's uptime (red-team round 2 `zero_cap_fleet_member`: a fleet framed through its untested node, 0.810x before, 1.000x after). So a peer moves a node's uptime and `Q_n` only in proportion to the capacity it has at stake: zero- or tiny-capacity sybil UIDs cannot frame a large node (red-team Pass-7 `asymmetric_sybil_framer`: 1.30–2.13x before, attacker entity at most 1.000x after), while a small honest node stays fully accountable to larger peers for its passes and its clear failures.
  - **Ambiguous failures between unequal nodes.** In a failure charged to both ends, an end that is isolated (failed results with at most `MAX_NEUTRAL_FAIL_UIDS` other UIDs) while the other end is not pays only the symmetric `min(cap) / max(cap)`; otherwise each end pays its own `w` (`LinkAttribution::ambiguous_weight_ppm`). A 10 Gbps node failing its links with many 100 Mbps peers therefore costs each of them 1% of a sample, as it costs itself (red-team round 2 `big_node_griefer`: victims 0.840x before, at least 0.998x after), while tiny sybil UIDs that fail many victims still pay in full. Residuals: a large attacker that spreads its griefing over three or more UIDs makes each small victim non-isolated, and the victims then pay full weight (the attackers' gain is bounded by the victims' small share); sybils on one pipe that the validator sees in different /24s are not pooled and weigh as separate pipes (OQ-18).
- **Ambiguous failures and `Q_n`.** A measured outgoing failure charged to both ends costs uptime but adds no `Q_n = 0` sample; one-sided outgoing failures and dodged (unmeasured) snapshot links add a `0` sample.
- every outgoing link in the current snapshot with **no** aggregated result this window counts as a failed probe for the node, under the same blame rule (it is excused only when the peer's base rate is strictly worse);
- a `cap:<node>` capacity-test result counts (pass iff `rtt_us > 0`, loss within bound and `throughput_mbps > 0`);
- a `vantage:<node>` result counts as one more sample (pass or fail); it is not link evidence for the rule below and not a `Q_n` input;
- a node with verified capacity and **no counted link evidence** (no attributable pass and no charged link failure) counts one failed probe, even if it passed a capacity test, so a node cannot drop out of the snapshot and live on capacity tests alone.

Residual (`[T29]`): beyond the one-sided budget both ends pay, but a griefing contest with equal absolute losses still raises the relative share of the side holding more of the network (`(K - L)/(N - 2L) > K/N` iff `K > N/2`), and a victim with a small (sparse-schedule) honest degree loses uptime ratio faster than meshed sybils. Measured without vantage results: dense (8 honest peers per victim) attackers 0.877–0.971x for K ≤ 8 and up to 1.05x at K = 20; sparse (honest degree 2, K = 7–10 single-node sybil UIDs, m = 1–5 victims, sim `sparse_victim_framer`) attackers 0.997–1.070x, victims about 0.32–0.37x (red-team pre-fix 1.064–1.348x, victims 0.025–0.036x). With vantage results for everyone (Pass-7): K ≤ `MAX_NEUTRAL_FAIL_UIDS` sybils cannot harm a clean victim at all; K ≤ 7 attackers at most 1.000x; K = 8–10 (sybils at or above half the UIDs) attackers at most 1.043x; for K ≥ 3 victims still fall to about 0.33–0.60x (sybils pay the same per failure, so it is a costly contest, not a free one). A victim with fewer than `MIN_CLEAN_PEER_UIDS` clean peer UIDs keeps the Pass-6 treatment. Closing the majority case needs a per-UID cost or link probes peers cannot tell from other traffic.

`Q_n` is the lower median of per-outgoing-link quality over counted outgoing links (attributable passes, and failures or dodges charged to the node), with `0` for failed or dodged links; with no outgoing link samples it is `1e6` only if the node produced passing evidence (capacity test or incoming link), else `0`.

## Outside evidence (ADR-0039)

This is evidence from outside the network that a node's ASN, upstreams and IXP presence are real: RPKI, ASPA, PeeringDB, RIS, RouteViews and RIPE Atlas. Validators snapshot it, sign it and commit it. Scoring never reads it live (Invariant 1).
- **Phase B: vendored files.** The founder fetches the snapshot files, and `bwos-validator evidence-import` parses them. No Phase B code fetches outside evidence over the network. The TLS fetch is roadmap PC-16.
- **Implementation.** Phase B Task 4C implements this section: `bwos_core::evidence`, `bwos-validator`'s `evidence_import.rs` and the fixtures in `testdata/evidence/` (one per source; `routeviews.convert.sh` keeps the RouteViews conversion command). The importer signs with the validator's Bittensor hotkey keyfile through `bwos_chain::Hotkey` (R20: sr25519 signing stays out of `bwos-core`).

**Object.** `OutsideEvidence`, under domain `outside-evidence`:

```json
{"v":0,"window":1234,"validator":"<SS58 hotkey>","source":"rpki","fetched_block":443000,
 "records":[{"roa_origin":{"prefix":"203.0.113.0/24","asn":64500,"max_length":24}}],"sig":"<sr25519 hex>"}
```

**Tag names are pinned.** `EvidenceSource` serialises as one of these strings: `rpki`, `aspa`, `peering_db`, `ris`, `route_views` and `atlas`. `EvidenceRecord` is externally tagged with these snake_case names and fields:

| Tag | Fields | Allowed sources |
|---|---|---|
| `roa_origin` | `prefix`, `asn`, `max_length` (u8) | `rpki` |
| `aspa_providers` | `customer`, `providers` (sorted, deduped u32) | `aspa` |
| `ix_presence` | `asn`, `ix_id` | `peering_db` |
| `upstream` | `asn`, `upstream` | `ris`, `route_views` |
| `origin` | `prefix`, `asn`: a prefix seen announced in public BGP with that origin ASN | `ris`, `route_views` |
| `atlas_rtt` | `probe`, `target`, `rtt_us` | `atlas` |

- **Kind must match source.** An object holding a record its source doesn't allow is invalid as a whole.
- **Records.** They are sorted and unique by canonical bytes. Prefixes are canonical CIDR: network address, lower-case IPv6. ASNs are non-zero. The whole object fits `MAX_WIRE_BYTES`. Task 4C's vector in `testdata/vectors/canonical.json` pins the bytes.
- **Signature.** `sig` is the validator hotkey's sr25519 signature over `wire::signing_bytes("outside-evidence", obj)`, checked with `identity::verify_sr25519`.
- **Hash.** The manifest slot and the object-store key are `wire::hash_hex("outside-evidence", obj)`, the plain hash without `sig`, as for `probe-result`. `outside-evidence` isn't a sealed-hash domain: the store verifies the signature on every PUT, and only the hotkey itself can sign another copy of the same body (`object_store::ALLOWED_OBJECT_DOMAINS`).
- **Other checks.** `v` is `0`, `validator` is a valid SS58 address, an `atlas_rtt` `target` is a canonical IP address (lower-case IPv6), `aspa_providers.providers` holds no `0`, an `ix_presence` `asn` is non-zero, and an `origin` prefix is at least /8 (IPv4) or /16 (IPv6), so no record covers nearly every endpoint (`MIN_ORIGIN_PREFIX_V4`, `MIN_ORIGIN_PREFIX_V6`, red team RT2) (`evidence::OutsideEvidence::validate`). ROA prefixes may be shorter.
- **`window` and `fetched_block`.** `window` is the window whose manifest commits the object. `fetched_block` is the block at which the founder fetched the file, given to the importer. It is the validator's own claim. The only check is that it isn't after the window ends: `fetched_block <= (window + 1) * WINDOW_BLOCKS` (M1, RT6). Re-signing an old file under a new `window` therefore isn't detected (OQ-58, T62).

| Source | Vendored file the founder fetches | Records the importer writes |
|---|---|---|
| RPKI | rpki-client `-j` JSON: `{"roas":[{"asn":13335,"prefix":"192.0.2.0/24","maxLength":24,"ta":"apnic","expires":...}],...}` | `roa_origin { prefix, asn, max_length: maxLength }` per `roas` entry. `ta` and `expires` are dropped. `asn` 0 (AS0) is dropped |
| ASPA | the `aspas` array of the same rpki-client `-j` JSON: `[{"customer_asid":64500,"expires":...,"ta":"...","providers":[64501,64502]}]` | `aspa_providers { customer, providers }` |
| PeeringDB | PeeringDB API `netixlan` response: `{"data":[{"asn":64500,"ix_id":64,"operational":true,"status":"ok",...}]}` | `ix_presence { asn, ix_id }` per entry with `status == "ok"` and `operational != false` |
| RIS | a JSON array of RIPEstat data-call responses, each told apart by `data_call_name`. `asn-neighbours` (one per ASN): `{"data_call_name":"asn-neighbours","data":{"resource":"64500","neighbours":[{"asn":64501,"type":"left",...}]}}`. `network-info` (one per endpoint): `{"data_call_name":"network-info","data":{"prefix":"203.0.113.0/24","asns":["64500"]}}` | `upstream { asn: resource, upstream }` per `asn-neighbours` neighbour with `type == "left"`, and `origin { prefix, asn }` per `network-info` ASN. ASNs may be written `"64500"` or `"AS64500"`. Other data calls are refused |
| RouteViews | a JSON array of `{"prefix":"<cidr>","as_path":[u32,...]}` converted from a RouteViews MRT RIB dump with `bgpdump -m` and `jq`, with paths containing an AS_SET left out. The conversion command is kept with the fixture | Per path, after collapsing repeated ASNs (prepends): `origin { prefix, asn: last ASN }`, and `upstream { asn: last, upstream: the one before it }` when the path has two or more ASNs. A path in which an ASN reappears after a different ASN (AS-path poisoning or a loop) gives no record (red team RT3, `evidence::path_records`, sim `as_path_poisoner`) |
| RIPE Atlas | a RIPE Atlas ping measurement results JSON array: `[{"prb_id":1001,"dst_addr":"203.0.113.7","min":12.345,...}]` | `atlas_rtt { probe: prb_id, target: dst_addr, rtt_us: round(min * 1000) }`. A result without `min`, or with `min < 0`, is dropped. Floats appear only here, at import. Scoring sees integers |

**Import.**

```
bwos-validator evidence-import --source <s> --in <file> --out <file> --hotkey <file> --window <w> --fetched-block <b> [--scope <file>]
```

- **What it does.** It parses one vendored file and writes canonical, signed `OutsideEvidence`: the exact canonical bytes, so the file's SHA-256 framing matches its hash. It prints one JSON line, `{"hash":..,"records":..,"source":..,"validator":..,"window":..}`. Parsers use `serde_json` and are strict: a field of the wrong type, a malformed prefix or address, or a `maxLength` outside `[prefix length, 32 or 128]` refuses the whole file. The input is capped at `MAX_EVIDENCE_INPUT_BYTES` (512 MiB, `evidence_import.rs`); reduce a RouteViews dump to one collector peer, or filter it with `jq`, before importing.
- **Per-source details.**
  - RPKI and ASPA both read the whole rpki-client `-j` file (`roas` and `aspas`).
  - An ASPA customer listed twice gets one record holding the union of its providers. A provider `0` (an AS0 ASPA) is dropped, and a customer `0` refuses the file.
  - PeeringDB, RIS and RouteViews drop records with ASN `0`, and a RIS `asn-neighbours` neighbour equal to the resource. RIS neighbour ASNs may be numbers or strings. A RIS `network-info` with no `asns` (an unannounced address) gives no record.
  - A RouteViews path that is empty after collapsing prepends, or poisoned, gives no record.
  - A RIS or RouteViews origin prefix shorter than /8 (IPv4) or /16 (IPv6) is dropped, since an object may not carry it.
- **Scope.** A full RPKI or RouteViews dump doesn't fit `MAX_WIRE_BYTES` (4 MiB). The optional `--scope` file narrows the import: `{"endpoints":["<ip>",...],"asns":[u32,...],"priority_asns":[u32,...]}`. `priority_asns` (optional, Task 4C fix round 2) are underlay ASNs; they narrow like `asns`.
  - RPKI keeps the ROAs covering a scope endpoint.
  - RouteViews keeps the paths whose prefix covers a scope endpoint, or whose origin is in `asns`.
  - The other sources keep records whose `asn`, `customer` or origin is in `asns`.
  - Two readings the text above leaves open (OQ-57): a RIS `origin` is also kept when its prefix covers a scope endpoint, as RouteViews does, so the bootstrap's step 2 can be imported with a scope; and an `atlas_rtt` is kept when its `target` is a scope endpoint, since it has no ASN.
  - The scope file is strict: unknown fields, a malformed address or ASN `0` refuse it.
  - **Overflow (red team RT2, fix round 2 F3).** When a scoped object would exceed `MAX_WIRE_BYTES`, records are dropped in tiers (`evidence::ScopeTier`, `evidence::fit_to_wire`):
    1. first, those that entered only through a plain scope ASN (`asns`);
    2. then, if it still doesn't fit, those that entered only through a priority ASN (`priority_asns`);
    3. records that entered through a scope endpoint are never dropped.

    The summary line reports `dropped_asn_only`. If the endpoint matches alone don't fit, or there is no scope, the output is refused, never truncated.
- **Who writes the scope.** The validator does: `bwos-validator evidence-scope --state-dir <dir> --out <file> [--probe-batch <file>] [--validator <ss58>]` (Task 4C). It writes the aggregated endpoints and underlay ASNs from its last tempo outcome, `<state-dir>/last-outcome.json`, which `run-tempo` writes there: the outcome's `endpoints` map (Task 4Db) and the `as:<A>` labels of `next_snapshot`'s nodes' `srg` (Task 4B). Fields an older outcome lacks count as empty.
  - `--probe-batch` is this validator's own latest `ProbeResultBatch`. Its `endpoints` are added, which covers the bootstrap and nodes new since the last outcome.
  - **Public unicast only (review I2, R12).** An endpoint that isn't public unicast (private, CGNAT, loopback, link-local, documentation, the `fc00::/8` overlay) is dropped with a warning, as in §Probed endpoints, and never fails the scope. The check is `vpn::is_public_egress_ip`, the one public-address check in `bwos-core`.
  - **Origin ASNs (red team RT2).** It then adds, to `asns`, the origin ASN of every `origin` record whose prefix covers a scope endpoint, taken only from this validator's own usable retained evidence (`--validator`, its SS58 hotkey) or from the last outcome's `agreed_evidence` (`TempoOutcome.agreed_evidence`, `evidence::scope_origin_asns`). That is bootstrap step 3. Another validator's records alone never widen a scope (sim `scope_polluter`). Reserved ASNs aren't filtered here; the underlay rule below refuses them.
  - **Agreed origins are capped (fix round 2 F3).** Per endpoint, all of this validator's own origins are taken, plus at most `MAX_AGREED_SCOPE_ORIGINS` (4) agreed origins that are neither its own nor priority ASNs, lowest ASN first. Colluders who reach agreement (T61) therefore add at most four ASNs per endpoint, and can't flood a scope to make an import drop the honest underlay's records (sim `origin_stripper`).
  - **Priority ASNs.** The last outcome's `as:<A>` SRG labels go to `priority_asns`, not `asns`.
  - **Judging window (F4).** Retained evidence is judged at the window after the last outcome's. Only with no outcome is it the newest retained window.
  - **Read-only (M3).** `evidence-scope` deletes nothing in the state dir; a retained file that doesn't verify is ignored with a warning.
- **Bootstrap.** With no outcome yet, or for nodes that are new since the last outcome, the steps are:
  1. The scope's endpoints are the ones in this validator's own latest probe batch, and `asns` is empty.
  2. The founder fetches RIS `network-info` for those endpoints, which is scoped by construction, and the importer takes RPKI scoped by endpoints.
  3. `evidence-scope` then adds the origins found to `asns`.
  4. The remaining sources are imported with that scope.

**Commit, reveal and retention (review R3).**
- **One per window.** A validator commits at most one `OutsideEvidence` per window, in its manifest slot `outside-evidence` (ADR-0036, `manifest::MANIFEST_OBJECT_DOMAINS`). It rotates through the sources so each is refreshed within `EVIDENCE_MAX_AGE_WINDOWS`.
- **Reveal.** The object is served at `/v0/objects/outside-evidence/<sha256>` (ADR-0015).
- **What `TempoInput.evidence` holds.** Every evidence object that:
  - was committed by its own `validator`'s manifest for its `window`;
  - was revealed, and matches the hash;
  - lies in the last `EVIDENCE_MAX_AGE_WINDOWS + 1` windows.
- **Keeping it.**
  - Each validator retains these objects in `<state-dir>/evidence/`, as canonical files named by hash, and pruned past the age limit, so a restart loses nothing. In Phase B `run-tempo --state-dir` does this: it retains `TempoInput.evidence` as `<hash>.json`, and removes files older than `EVIDENCE_MAX_AGE_WINDOWS + 1` windows or that don't parse and verify. An object for a window after the current one is never retained (fix round 2 F4), so one far-future object can't make the rest look old.
  - **Only committed hashes come back (review I1, Invariant 1).** A retained object is merged back into `TempoInput.evidence` only when its hash is in the committed set: the `outside-evidence` hashes validators' manifests committed for those windows, given to `run-tempo` as `--evidence-commitments <file>`, which Task 19b writes from the chain. Without that file nothing retained is merged.
    - **File format (fix round 2 F1).** A JSON array of `{"hotkey":"<SS58>","window":w,"hash":"<sha256>"}` entries, one per manifest slot. A retained object merges only if its `validator` and `window` match its hash's entry.
    - **Transition.** Bare hash strings (fix round 1's format) are still read and check the hash only.
    - **Strictness.** One hash under two slots refuses the file. A file planted in the state dir therefore never reaches scoring, however validly signed (`evidence_import::merge_retained`).
  - Every validator MUST keep serving its own evidence reveals for at least `EVIDENCE_MAX_AGE_WINDOWS + 1` windows.
  - A validator that starts late, or has lost its state, rebuilds the set from each validator's commitments at the commit blocks of those windows. That needs an RPC node keeping state for at least `(EVIDENCE_MAX_AGE_WINDOWS + 1) * WINDOW_BLOCKS` blocks (9_000), such as an archive node.
  - Until it has the full set, it computes but doesn't submit weights. `run-tempo` lists the committed hashes within the age limit that it found in neither the input nor the retained objects as `missing_evidence` in its JSON output, and warns (fix round 2 F2, `evidence_import::missing_commitments`). The field is omitted when nothing is missing.
- **Producer.** The validator loop (Task 19b) fills `TempoInput.evidence`. Its fetcher:
  - checks each object's `validator` equals the manifest's `hotkey` and its `window` equals the manifest's `window` (red team RT5);
  - verifies each fetched object (hash and `OutsideEvidence::verify`) and, on a bad copy, tries the next peer serving that hash (M2).

**Usable evidence.** `evidence::usable_evidence(&input.evidence, input.window)` is the only way scoring reads outside evidence. It keeps an object only when all of these hold:
- the signature verifies;
- the object is valid;
- `ev.window <= window` and `window - ev.window <= EVIDENCE_MAX_AGE_WINDOWS`.

Then, for each `(validator, source)`, only the object with the highest `window` is kept. Ties go to the lower canonical hash (`wire::hash_hex`), then to the lower canonical bytes with `sig`, so the choice is total. The result is ordered by `(validator, source)`.

**Agreed records (review R2).** Validators are identified by SS58 hotkey (§Team capacity tests, "Validator identity"). A record counts in scoring only when enough validators agree on it, using the same quorum as probe keys (§Results and commit-reveal, step 4):
- `V(r)` is the set of distinct hotkeys whose usable evidence contains the exact record `r`.
- `V(r)` must include at least `MIN_VALIDATORS` hotkeys with positive stake.
- Their stake must reach `PROBE_STAKE_QUORUM_PPM` of the total stake in `validator_stakes`. Once `attestation_keys` is non-empty, the total is `recorded_stake`, the stake of hotkeys holding a valid attestation-key record (§Team capacity tests, "Quorum over recorded stake").
- With an empty stake map, every hotkey weighs 1, and the total is the number of distinct hotkeys with usable evidence.

The pure function `evidence::agreed_records(usable, validator_stakes /* keyed by SS58 hotkey */) -> Vec<EvidenceRecord>` returns them sorted and deduped. Everything below reads only agreed records, so one validator can't invent or delete a record.
- **Entry point for scoring.** `validator::tempo_agreed_records(&input)` applies this to a `TempoInput`. With no `attestation_keys` it calls `agreed_records` with `validator_stakes`. The result is also output as `TempoOutcome.agreed_evidence`.
- **No stakes, no records (red team RT5).** With an empty `validator_stakes` and no `attestation_keys`, nothing is agreed unless `TempoInput.evidence_count_quorum` is set. Only the sim and `--network local` set it. The validator always overwrites the field from its network, so a `true` in a tempo input file is cleared on testnet (fix round 2, B1).
- **With attestation keys.** Once `attestation_keys` is non-empty, the stakes are `AttestationKeys::recorded()` and the total is `recorded_stake` (`evidence::agreed_records_with_total`). Evidence signed by a hotkey with no valid record therefore counts for nothing, as its probe batches don't. Without that rule, unrecorded stake could add to the reporting side of a quorum it isn't in the total of.
- **Participation floor (red team RT1).** With attestation keys, a window whose `recorded_stake * 1e6 < total_stake * PROBE_PARTICIPATION_FLOOR_PPM` agrees nothing: exactly the probe stage's test (§Team capacity tests, "Quorum over recorded stake"). Evidence has no carry; below the floor the window simply has no agreed records. Otherwise a minority holding the only records could agree anything (sim `evidence_minority_injector`).
- **Order.** "Sorted" means ascending canonical bytes of each record, the order the object itself uses.

**RIPE Atlas isn't scored.** `atlas_rtt` records may be imported and committed, but no Phase B score reads them (ADR-0057 would read anchors' records as placement sites only once the terms are verified, §Network position), because Atlas's terms for commercial use aren't verified (ADR-0039 §3, OQ-39).

## Probed endpoints (ADR-0039)

**What each validator commits.**
- **The `endpoints` list.** Each validator's `ProbeResultBatch` lists `endpoints`: `[{"node":"<hex>","addr":"<ip>"}]`, sorted and unique by `node`, omitted when empty.
- **What `addr` is.** It is the source address the validator sees on the node's source-matched probe and collector sessions, the ones the node opened (§STAMP probes and probe sessions, red team RT1). Nodes always dial, so this holds for public nodes too. The port is dropped, so a NAT rebinding its port changes nothing.
- **Private addresses are dropped (review R12).** `addr` MUST be public unicast. An entry in the `fc00::/8` overlay, private, CGNAT `100.64.0.0/10`, loopback, link-local or documentation ranges is dropped, as if absent. The rest of the batch still counts.
- **Operator reports are never used.**

**Aggregated endpoint.** For each node, take the hotkeys with positive stake that report it at a public address, and group their addresses by **dedupe prefix**: the IPv4 /24 or the IPv6 `/IPV6_DEDUPE_PREFIX_LEN` (/32), exactly the prefixes `scoring::diversity_groups` and `dedupe_diverse_node_capacities` group by (§Endpoint dedupe in `scoring.md`).
- **Quorum and majority per prefix (Task 4B fix rounds 1 to 3, red team F1 and finding 2).** A prefix wins only if its own reporters meet `MIN_VALIDATORS` and `PROBE_STAKE_QUORUM_PPM` (measured against `recorded_stake`) **and** hold more than half of the stake that reported the node. At most one prefix can hold a majority. The node's endpoint is the stake-plurality address within the winning prefix, ties to the lowest address bytes, IPv4 before IPv6. With no winning prefix, the node has no endpoint.
  - **One hotkey never picks the group,** however much stake it holds, since it is one reporter (sim `endpoint_minority_pool_griefer`). The original rule counted the quorum over all of a node's reporters and then took the plurality, which let one large validator pick the address.
  - **Two colluding hotkeys don't outvote the honest report.** A pair can meet `MIN_VALIDATORS` and the quorum together, but it needs a majority of the node's reporting stake too, so honest validators that agree on one prefix and hold more than the pair keep the node's group (same sim, two-hotkey case).
  - **A split vote leaves no endpoint (residual, T92).** When honest reporters split across two prefixes (a dual-stack node reaching some validators over IPv6), no prefix may hold a majority, or the larger side may miss the quorum (honest 30% and 25% with the rest silent). The node then has no endpoint: it keeps usage credit for bytes on assigned paths and gets no capacity credit (§Dedupe). Colluders holding enough stake can turn a split that would otherwise pass (honest 40% and 15%) into one that doesn't, by reporting a third prefix. They gain nothing from it.
  - **A node behind carrier NAT keeps its carrier's prefix.** It leaves from a different address of the carrier's pool towards each validator. Fix round 1 required each exact address to meet the quorum, which left such a node with no endpoint; with the quorum per prefix it gets an endpoint in the carrier's /24 and is grouped there, as a node with a stable address in that /24 would be (sim `cgnat_honest_node`). A carrier pool that spans several /24s, none winning, still leaves the node without an endpoint.
  - **Which address within the prefix** doesn't change grouping, and the underlay rule below reads the address's covering origin, so a carrier /24 announced as one prefix gives the same underlay whichever address wins.
- **Function.** `probe::aggregate_endpoints(batches, attestation_keys, validator_stakes) -> BTreeMap<String, IpAddr>`, which is pure (PB-06). Each batch's ed25519 key is mapped to its SS58 hotkey through `attestation_keys`, and stakes are looked up by hotkey (§Team capacity tests, "Validator identity").
  - **Which batches (Task 4B).** It takes the batches it is given. `validator::tempo_endpoints(&input)` gives it only the window's batches that match their commitment and verify, exactly the batches the probe stage reads.
  - **Before attestation keys.** With no `attestation_keys`, a batch's own key is its identity and stakes are keyed by it, as in the probe stage before Task 11a. With an empty stake map every batch weighs 1 and the total is the number of batches.
  - **One batch per identity.** A second batch from the same hotkey is ignored.
  - **IPv4-mapped addresses.** An `addr` written `::ffff:a.b.c.d` counts as the IPv4 address, so it can't escape an IPv4 prefix.
  - **No participation floor (OQ-72).** A window under `PROBE_PARTICIPATION_FLOOR_PPM` still aggregates endpoints against `recorded_stake`; the stake trigger in §Dedupe decides whether dedupe uses them.
- **Use.** The map goes to `TempoOutcome.endpoints`, which comes back as next window's `TempoInput.prev_endpoints`. `validator::node_diversity_from_probes` takes it (Phase B Task 4B) and calls `NodeDiversityMeta::from_endpoint(addr, underlay_asn)` for each node.
- **`prev_endpoints` for a producer (fix round 3, finding 4).** A validator MUST rebuild `prev_endpoints` from window − 1's committed batches (`probe::aggregate_endpoints` over the batches matching window − 1's commitments), never from its own local state, so validators that restarted or missed a window agree (Invariant 1). Passing back the last `TempoOutcome.endpoints` is the same thing only when that outcome came from the same committed inputs. The endpoint producer's roadmap line carries this requirement.

**Dedupe (Task 4B fix rounds 1 and 3, red team F2, findings 1 and 3).** `TempoInput.node_diversity`, the input to `scoring.md` §Endpoint dedupe, comes only from committed endpoints:
- **Stake trigger (finding 3).** Endpoint dedupe is on for a window only when the identities whose committed batches carry at least one endpoint meet `MIN_VALIDATORS` and `PROBE_STAKE_QUORUM_PPM` of the total (`probe::endpoint_dedupe_trigger`, `validator::tempo_endpoint_trigger`). Below that, `node_diversity` is empty, dedupe is off for the window, and `TempoOutcome.endpoint_dedupe_off` gives the reason (it is omitted when no batch carries endpoints at all). A few validators running a producer therefore can't zero every other node's capacity credit.
- **Source.** `validator::tempo_node_diversity(&input)`: this window's aggregated endpoints, and for a node without one, its endpoint in `prev_endpoints` (one window, never chained, OQ-79). `bwos-validator` fills it before every tempo, and `run_tempo` builds it the same way when the input carries none. No local file feeds it: `--diversity-file` and `BWOS_NODE_DIVERSITY_FILE` are refused at start-up (OQ-80).
- **Fail-closed: no endpoint, no capacity credit (finding 1).** While dedupe is on, a live node with verified capacity and no endpoint (this window or the last) gets **zero scoring capacity**: it adds nothing to its UID's capacity term `K_u` (`validator::endpointless_nodes`), and it weighs 0 in the team schedule's round-robin (`validator::schedule_weights`, Task 4Dc fix round 4, red team E1, T114). It keeps usage credit for bytes on assigned paths, capped at its own verified capacity as before, and it is its own dedupe group. A node therefore can't escape dedupe by keeping its endpoint below quorum (sim `endpoint_absent_sybil`), and an attacker can't stuff cheap endpoint-less nodes into a shared pool and take a share of the largest honest member's capacity, as the global unknown group of fix rounds 1 and 2 allowed (about 50x at 100 nodes; sim `unknown_group_stuffer`).
- **Cost to honest nodes.** An honest node whose endpoint misses the quorum two windows running loses its capacity credit for the window, but not its usage credit. A carrier-NAT node seen at several addresses of one carrier /24 isn't such a node (fix round 2); one whose carrier spreads it over several /24s, none winning, or one caught in a split vote (T92), is.
- **Before a producer exists.** With no endpoint in the window, `node_diversity` is empty and dedupe is off, as before ADR-0039. Nothing fills `ProbeResultBatch.endpoints` in the daemon yet (roadmap PB-06, "endpoint producer"), so in production today dedupe and the diversity term are wired but inert.

**Residuals.**
- **Endpoint shopping.** A node can show different endpoints to different validators. A dedupe prefix counts only with its own quorum and a majority of reporters, so shopping inside one /24 gains nothing (the node is grouped in that /24 anyway), and a node with no winning prefix gets no capacity credit (§Dedupe) and no team-schedule weight (red team E1, T114): showing different /24s to different validators buys neither pay nor test turns. The source match means each validator's capacity test runs through the address that validator commits.
- **Data plane on another path.** A node that sends its overlay peers' traffic over a different path than its validator sessions isn't caught by this. That is bounded by T45's sim.

## Underlay, IXPs and shared-risk groups (ADR-0039)

This section is what the snapshot builder (`validator::build_snapshot_and_demand`) and the diversity term use. Every rule reads only agreed records and aggregated endpoints. Phase B Task 4B implements it.

**Reserved ASNs.** These are never an underlay ASN or an upstream:
- `0`;
- `23456` (AS_TRANS);
- `64496..=64511` and `65536..=65551` (documentation);
- `64512..=65534` and `4_200_000_000..=4_294_967_294` (private);
- `65535` and `4_294_967_295`;
- `65552..=131071` (reserved).

**Underlay ASN (red team RT2).** A node's underlay ASN `A` is the origin seen in public BGP for the longest announced prefix covering its own committed endpoint, kept only if RPKI-valid for that origin:
1. **Candidates.** Take every agreed `origin { prefix, asn }` (from RIS or RouteViews) with a non-reserved `asn` whose `prefix` contains the endpoint. The address family must match.
2. **RPKI-valid only.** Keep only the origins that are RPKI-valid for their own prefix: some agreed `roa_origin` has the same `asn`, a `prefix` covering the announced prefix, and `max_length >=` its length.
3. **Longest prefix.** Of those, keep the ones with the greatest prefix length.
4. **Pick or refuse.** If exactly one ASN remains, that is `A`. Otherwise (none, or several valid origins) `A` is none. This is the conservative reading.

**Amendment to Task 4A's text (Task 4C fix round 1, red team RT4), for Task 4B.** Steps 2 and 3 were the other way round: longest prefix first, then RPKI-valid. In that order, anyone who announces an RPKI-invalid more-specific covering a node's endpoint leaves the node with no underlay ASN, because the invalid more-specific wins the longest-prefix step and is then thrown out. Filtering RPKI-valid origins first means an invalid announcement changes nothing.

A ROA alone is never the source. A prefix holder can sign ROAs for fresh ASNs that announce nothing, and a ROA-based rule would let it give every node a unique network (sim `roa_origin_shopper`, Task 4B).

A node with no underlay ASN gets no `upstreams`, no `ixps` and no `srg`, so `diversity_ppm = 0`.

**Ambiguous underlay (Task 4B; Task 4C red team residual).** Step 4 gives none when two or more RPKI-valid origins share the longest prefix. The node is then treated exactly like a node with no evidence:
- **No bonus.** It has no `upstreams`, `ixps` or `srg`, so `diversity_ppm = 0` and `C_n = 1e6`.
- **Unknown SRG.** It has unknown risk, never independent risk (RT9). It can't be an interior node of a `resilient` route that has a backup, on either path (`routing.md` §Validation, `RouteError::UnknownRisk`).
- **Dedupe is unchanged.** `NodeDiversityMeta.asn` is none, and endpoint grouping still uses the node's prefix (`scoring.md` §Endpoint dedupe).

Validators who reach evidence agreement (T61: a third of recorded stake, at least 1/6 of all stake) can cause this. They get a fake `origin` and a matching fake `roa_origin` agreed for a victim's prefix. Agreed origins enter a scope at most `MAX_AGREED_SCOPE_ORIGINS` (4) per endpoint, lowest ASN first, so they choose low fake ASNs. The victim then loses at most `DIVERSITY_WEIGHT_PPM + IXP_PRESENCE_WEIGHT_PPM` of `C_n`, and only on its carried bytes. The attackers gain nothing directly (threat-model T82, sim `underlay_ambiguity_griefer`). With the same power they can instead give their own nodes a fake underlay with two upstreams and an IXP. That earns at most the saturated `1e6 + DIVERSITY_WEIGHT_PPM + IXP_PRESENCE_WEIGHT_PPM` (T90, sim `agreed_underlay_forger`).

**Implementation (Task 4B).**
- **Underlay.** `validator::underlay_asn(endpoint, agreed) -> Option<u32>` implements the four steps above. `validator::node_underlay(endpoint, agreed) -> NodeUnderlay { asn, upstreams, ixps, srg }` adds the rest of this section.
- **Snapshot.** `build_snapshot_and_demand` takes the window's agreed records (`validator::tempo_agreed_records`) and aggregated endpoints (`validator::tempo_endpoints`, output as `TempoOutcome.endpoints`). It fills the next window's snapshot from them. A node with no aggregated endpoint this window gets no underlay fields. Endpoints from earlier windows aren't used as a fallback (OQ-79).
  - The plan gave this function one `evidence: &[&OutsideEvidence]` parameter. It takes `agreed: &[EvidenceRecord]` and `endpoints: &BTreeMap<String, IpAddr>` instead, because every rule here reads only agreed records and aggregated endpoints.
- **Coverage.** `run_tempo` reads each node's `C_n` from `current_snapshot`, the snapshot built at the end of the previous window (`scoring.md` §Coverage).
- **Dedupe.** `validator::node_diversity_from_probes(probed, agreed)` builds the dedupe metadata from endpoints and agreed records. `TempoInput.node_diversity` comes from it as §Probed endpoints, "Dedupe" says, never from a file (OQ-80).

**Home and CGNAT nodes (controller ruling 6).** These nodes take the underlay ASN only from their own committed endpoint, by the rule above. Behind NAT or CGNAT, that endpoint and so `A` belong to the carrier. Such a node inherits the carrier's upstreams and IXPs, though its own access link is a single point of failure (threat-model T47). With diversity on the usage term only and a low weight, the effect is bounded. **This is by design** (ruling 6, confirmed in Task 4B fix round 2): a CGNAT node's aggregated endpoint is an address of the carrier's prefix (§Probed endpoints, "Quorum and majority per prefix"), so its underlay ASN, upstreams, IXPs and `as:` SRG label are the carrier's, and it shares the carrier's SRG with every other node behind that carrier.

**Upstreams.** `upstreams(n)` is the sorted, deduped set of `U` such that:
- an agreed `upstream { asn: A, upstream: U }` exists;
- `U != A`;
- `U` isn't reserved.

An `upstream` is "left of `A` in a public BGP path", which includes peers seen at IXPs as well as transit providers. Both give paths that don't depend on one provider. ASPA doesn't change this set or the count (red team RT9):
- **Classification only.** If an agreed `aspa_providers { customer: A }` exists, the neighbours it lists are providers, and the rest are peers. Both are counted in the same total.
- **No penalty for publishing.** Publishing ASPA therefore never lowers a node's count (sim `aspa_honest_publisher`).
- **Not used for scoring yet.** Phase B scores neither class differently.

**IXPs.** `ixps(n)` is the sorted, deduped set of `ix_id` over agreed `ix_presence { asn: A, ix_id }`.

**Shared-risk groups.** `srg(n)` is a sorted, deduped list of labels:
- `as:<A>`: every node in one underlay network shares that network's fate.
- `up:<U>`: only when `upstreams(n) == {U}`. A network with only one neighbour fails with it. Nodes in different networks behind one single upstream therefore share `up:<U>`.

A network with two or more neighbours gets no `up:` label. A faked second upstream (T38) therefore also removes the `up:` label the node should carry. Labels are strings so later sources can add kinds without a wire change.

**Unknown is not independent (red team RT9).** A node with no `srg` has unknown risk, not independent risk. A `resilient` route needs known SRGs on both sides (`routing.md` §Validation, sim `roaless_backup`).

**In the snapshot.** `routing::Node` carries `upstreams: Vec<u32>`, `ixps: Vec<u32>` (PeeringDB `ix_id`) and `srg: Vec<String>`, each sorted, deduped and omitted when empty, so existing snapshots keep their bytes (`routing.md` §Topology snapshot). The diversity term is `scoring.md` §Coverage.

**Not covered in Phase B.**
- **Fiber routes and cross-connects.** No committed source exists for them.
- **Traceroutes from several vantage points.** They aren't yet a committed measurement.
- **Tunnelled upstreams.** An ASN that adds a second upstream by BGP over a tunnel through its first provider looks the same in public data as real multihoming. The term saturates at two upstreams, and the weight is low (sim `diversity_faker`; T38; OQ-39).
- **Self-maintained data.** PeeringDB entries are maintained by the ASN holder. IXP presence is trusted and bounded by `IXP_PRESENCE_WEIGHT_PPM` (T39).

## Network position (ADR-0057, proposed; red-team revision 1)

**Not produced yet.** This section feeds the locational price `G_n` (`scoring.md` §Locational price `G_n`), which is off (`GEO_PRICING_ENABLED = false`). PB-44 implements it.
- **Helpers.** `scoring::geo::{site_separation_km, site_rtt_us, source_matches, place, could_qualify, resolve_placement, next_placement, in_region_from_tests, pool_in_region, priced_split}`.
- **The source of position.** A node's region comes only from validator-run timings, never from anything the node or its operator says.

**Sites and the region table.** `REGION_TABLE` (`scoring.md` §Parameters) lists regions and sites. It is published on ADR-0049's scheduled-change path.
- **A site is a point measured as one.** That is a validator's probe agent (`val:<hotkey>`), several validators' agents in one facility, or a RIPE Atlas anchor (`atlas:<id>`).
- **What a site carries.** Its region, its coordinates, its **radius** `R_a` in µs (default `GEO_PLACE_RTT_US`), and its validator set. Two sites are **independent** when their validator sets are disjoint.
- **Who can be a site.** A validator agent counts as a site only while the site's members together hold at least `GEO_SITE_STAKE_MIN_PPM` of validator stake. Buyback and owner hotkeys never count (ADR-0053 §4).
- **Three sites per location (revision 2).** Every location the table covers has at least `GEO_SITE_REDUNDANCY` (3) independent sites, and any `GEO_PLACE_MIN_SITES` (2) place a node, so one validator can't unplace a rival or a city. The publishing tool refuses a table whose coverage changes with any one validator's sites removed (`geo_coverage_band`).
- **Atlas anchors are optional.** Their terms are unverified (ADR-0039, OQ-189). Pricing works with validator agents alone, and the launch table lists no Atlas site. If they are used:
  - **Anchors only.** Never volunteer probes, whose positions their hosts set.
  - **Admission.** Each needs a proximity proof: a validator site of the claimed region measures it at or below that site's radius.
  - **Weaker figures.** An Atlas ping isn't authenticated by the node key, so the anchor's host or network can forge a fast reply (T195).
- **Claimed positions.** A site's coordinates are claimed by whoever runs it. The publishing tool refuses a site whose measured RTT to another site is below `2000 * chord_km / GEO_LIGHT_KM_PER_MS` µs for the claimed positions, because physics refutes the claim. A site that adds delay passes, which is T187 or T195.

**Separation rule.** Every two sites `a`, `b` of different regions MUST be at least `(R_a + R_b) * GEO_LIGHT_KM_PER_MS / 2000` km apart by **chord**, the straight line through the Earth (`geo::site_separation_km`). The publishing tool checks it, and a table that fails is not published.
- **Why.** An RTT of `t` µs puts the answering box within `t / 2000 * c` km of the site by chord, whatever path it uses. A box in range of both `a` and `b` would be within `R_a / 2000 * c` of one and `R_b / 2000 * c` of the other. With the rule, **no single box can be in range of two regions**.
- **Sites of one region** may be anywhere relative to each other.
- **Default radii.** The defaults and why are in ADR-0057 §9: Europe 4 ms; Lagos 27 ms; Nairobi and Johannesburg 28 ms; Cairo 14 ms; Ashburn 20 ms; São Paulo 12 ms; Singapore 16 ms. `geo_coverage_band` checks them against real city coordinates.

**Figures.** In its `ProbeResultBatch`, each validator reports `geo_rtt:<n>:<site>`. Its value is the **minimum** RTT (µs) over the window of every timing node `n` answered from that site's agent. That covers:
- `vantage:<n>` STAMP exchanges;
- `link:` and `path:` echoes the agent originated or observed end to end;
- capacity-test RTTs.

Rules for the figure:
- **Light cone.** No timing is left out. A node that answers some sites from one box and other sites from another box (an anycast or split front) is fast at both, so both regions come into range and the node gets the cheaper one (§Placement, T196).
- **Source-matched only (revision 2).** A vantage exchange counts only on a session whose source matches the node's committed endpoint (`geo::source_matches`): for IPv4 the **exact committed address**, or the committed /24 for a carrier-NAT node (whose aggregate endpoint is the carrier's pool, §Probed endpoints); for IPv6 the committed address's **/64**. A /64 is one link and longer than any globally routed prefix (/48), so a box in it is reached only where the covering prefix is announced. A wider match (revision 1 used the dedupe prefix, a /32 for IPv6) spans many cities (`geo_v6_prefix_front`). Splitting one address across places (anycast, or a backbone carrying single addresses) is the case the light cone and in-region capacity handle.
- **Atlas sites.** The validator reports the minimum of the Atlas pings to `n`'s committed endpoint, from the agreed outside evidence (§Outside evidence).
- **Why the minimum.** Queueing and added delay only raise an RTT. The minimum is the best physical estimate, and the only one an endpoint can't lower (§Probe vantage, rule 1).
- **The site's figure.** The lowest reported value below which a **strict** majority of the reporting stake lies, `cum * 2 > total` (`geo::site_rtt_us`), under the stake quorum of §Results and commit-reveal. Members with half the site's stake or less can't pull it down. A site with no figure for `n` is out of range for `n`.

**Peer links from the endpoint.** An honest node accepts a peer link (WireGuard handshake source, BGP session) from node `m` only if the source matches `m`'s committed endpoint by `geo::source_matches`. The data plane of a node therefore runs through its endpoint box, and a back box elsewhere carries nothing that is credited (T196, `geo_endpoint_front`, `geo_v6_prefix_front`). PB-44 adds this to `datapath.md` and to the no-root and kernel nodes' peer checks.

**Placement** (`geo::place`). A site is **in range** of `n` when its figure is at most its radius. Node `n` is placed in region `r` when `GEO_PLACE_MIN_SITES` in-range sites of `r` are independent.
- **Unplaced.** No region qualifies. That covers unreachable nodes, nodes too far from two independent sites, and nodes that dropped every site's probes. An unplaced node's `G_n` is `GEO_PRICE_MIN_PPM`.
- **Equidistant.** Can't decide anything. Every site in range of one box belongs to one region (separation rule), so ties between sites don't matter. The dashboard's "nearest site" is the lowest figure, then the lowest site id.
- **Conflict.** Two or more regions qualify. That means a broken table, false site figures, or a node answering from more than one place.
  - **Resolution.** The node counts in the qualifying region with the lowest price in the committed snapshot it follows; ties and unknown prices go to the lowest region id (`geo::resolve_placement`). So neither a false site nor a second box can move a node to a dearer region.
  - **Reporting.** `TempoOutcome` lists every conflict, naming the node and the regions.
- **Carry while sites are silent (revision 2;** `geo::could_qualify`, `geo::next_placement`). A node placed in `r` that doesn't qualify this window keeps `r`, its placed-window count and its in-region capacity, for at most `GEO_OUTAGE_CARRY_WINDOWS` consecutive windows, while `r` would still qualify if every site of `r` with **no** figure for the node were in range. A silent site is one that is down or isn't measuring the node. A site that reports the node out of range is evidence, not silence. A node that qualifies elsewhere is placed there (`geo_site_outage`, `geo_city_site_outage`).
- **Short gaps (revision 2).** A node unplaced for at most `GEO_GAP_WINDOWS` windows and then placed in the same region keeps its placed-window count; it is paid `P_MIN` during the gap.
- **Placed windows.** The windows `n` has been placed in the same region, this one included, counting carried windows and surviving short gaps. Placement elsewhere, or a gap longer than `GEO_GAP_WINDOWS`, starts the count again. It drives probation (`GEO_PROBATION_WINDOWS`).
- **In-region capacity (revision 2).** It comes from **dedicated full-rate in-region tests**, whose team members are all in-range sites of `n`'s region, run with the regular capacity-test cadence (about every 2.5 windows). A test counts only if **its own** lowest RTT is within its site's radius, not merely the site's figure (`geo::in_region_from_tests`). The figure is the lower median of the window's qualifying tests, carried between tests for at most `GEO_INREGION_MAX_AGE_WINDOWS` (`geo_inregion_cadence`). It is pooled within a region per UID and per origin ASN of the endpoint: a simultaneous cohort in-region test caps the group's sum (`geo::pool_in_region`, `geo_shared_inregion_box`). `scoring.md` prices capacity above `P_MIN` only up to this figure. A region is enabled only once its sites' in-region test bandwidth is at least its largest node's capacity (OQ-188).
- **Committed.** The snapshot built at the end of the window carries, so the next window's smoothing, carry and conflict rule read committed values (Invariant 1):
  - each node's region (or none);
  - its placed and carried windows;
  - its in-region capacity;
  - the window's demand shares and price map.

**What a node can and can't do.**
- **It can't look closer.** It can delay or drop any timing, so it can raise any figure. It can't make a box answer before light reaches it and back.
- **One box can only make itself unplaced.** With a valid table, the only placements open to a node with one box are its true region and unplaced (`geo_location_spoof`: 129 delay patterns, 0 placements outside the true region). Unplaced pays the floor.
- **More boxes gain nothing** (T196).
  - **A session front** isn't source-matched (`geo_split_session_front`).
  - **An endpoint front's** credited capacity and carriage are the front box's own (`geo_endpoint_front`).
  - **An anycast front's** capacity counts at the scarce price only up to what in-region tests measured, which is the front box (`geo_anycast_front`).

**Residuals.**
- **Validator site collusion (T187).** Two colluding validators running two sites of one region can place a node there, but in no other region (`geo_site_collusion`). Before enabling: vetted distinct site operators, a light-cone tripwire on site pairs, and a flag for nodes slow to their region's placed peers (OQ-196).
- **Region size (OQ-185).** Per-site radii set the coverage. Europe's 4 ms radius leaves most of Europe unplaced, which costs little while Europe's price is at the floor (ADR-0057 §9).
- **Unplaced honest nodes (OQ-190).** Honest nodes out of range of two independent sites are paid the floor.
- **Endpoint ASN or IXP that doesn't match the region** is a tripwire, not a rule yet (OQ-191).

## Self-reported telemetry (ADR-0039)

Anything a node, its operator or its router reports about itself is for dashboards only and is never a scoring input:
- SNMP counters, sFlow, IPFIX/NetFlow and BMP exported from a miner's box;
- STAMP reflector timestamps (§STAMP probes and probe sessions);
- `LinkReport`s (`routing.md`, "Prototype loop");
- a node's own count of background traffic during a capacity test (§Team capacity tests).

None of these is a `TempoInput` field, an input to any `bwos_core::scoring` function, or a field of a validator-signed object that scoring reads. A validator MAY collect and display them. What validators observe themselves is different, and may be scored:
- their probe agents' timings;
- capacity tests with node-signed acks;
- the BGP sessions validators hold as collectors (PB-07);
- co-signed receipts (`receipts.md`).
