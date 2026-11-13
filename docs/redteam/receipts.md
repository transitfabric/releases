> Taken from the Transit Fabric source repository at commit 91be12e (91be12ef98b775c7f045124e6b8c686c15439650, main), file docs/specs/receipts.md. Links into the private source tree are shown as plain text.

# Spec: receipts

Status: draft · Implemented in `crates/bwos-core/src/receipts.rs`

## Traffic classes

| Class | Meaning | Default weight |
|---|---|---|
| `paid` | Traffic from a paying customer or a partner session | `W_PAID = 1_000_000` ppm |
| `free` | Free-tier client traffic | `W_FREE = 250_000` ppm |
| `canary` | Validator probe traffic | `W_CANARY = 100_000` ppm |

The ingress node sets the class from the session token. Only the ingress and the egress know it (ADR-0037). Overlay links carry plain inner IPv6 with no class on the packet (`datapath.md`), so a relay sees no class, and hop receipts carry one unsplit total per hop. The class split of a hop's bytes comes only from the ends: client receipts give `paid`, and `[T16]` attestation gives `free` (`scoring.md` §Byte crediting). Hop receipts earn no `canary` credit. Crediting canaries from the validators' own schedule and results is follow-up work (OQ-17). Taking the class off the packet doesn't make canaries indistinguishable: source addresses, timing and size still leak (see the residual list in `datapath.md`).

## Hop receipt

Every `RECEIPT_INTERVAL` (30 s), each pair of adjacent hops on an active path co-signs cumulative counters for that window:

```json
{
  "v": 0,
  "window": 1234,
  "seq": 17,
  "up": "<upstream node pubkey hex>",
  "down": "<downstream node pubkey hex>",
  "total": 128024679,
  "block": 1234560,
  "sig_up": "<ed25519 hex>",
  "sig_down": "<ed25519 hex>"
}
```

- `seq` MUST be `>= 1` (`seq == 0` is invalid), `up != down`, and both `up` and `down` MUST be valid non-weak Ed25519 public keys. `total` is the window's cumulative byte count over every class, since hop receipts carry no class (ADR-0037). It MUST NOT decrease as `seq` increases.
- **`block` (optional, Task 12b, ADR-0039 red team RT4).** The latest block the proposer had seen when it proposed. It's omitted when absent, so a receipt without it keeps its bytes; when present it is signed over like every other field. The co-signer MUST take it only at or one below its own view (`view − 1 <= block <= view`), so a claim never runs ahead of the chain (OQ-106 (a)), and never below the last `block` it took from the same upstream in the window, so `block` never decreases with `seq`. A co-signer with no view of the chain MUST refuse a proposal that carries one (`ReceiptBook::respond_at`; `respond` has no view). A refused proposal changes nothing. A counter-proposal carries the proposal's `block`. Background during capacity tests is read from it (§Receipt runs, `measurement.md` §Background traffic).
- Protocol: upstream proposes its total and signs; downstream signs if its own total is within `RECEIPT_TOLERANCE_PPM` (default 5_000 = 0.5%), otherwise it counter-proposes its own total. The tolerance applies to the **increment** since the stream's last co-signed receipt, each side's own, not to the cumulative total (Task 12b fix round 2, red team M1): 0.5% of a window's cumulative bytes would let a proposer swing a whole interval's worth into one receipt late in a window (sim `tolerance_swing_bracket`). It counter-proposes (capping sequence jumps at `+1_000_000` and binding `(seq, accepted_total)` per window to prevent sequence-gap replay and same-`seq` equivocation). A receipt without both signatures is **disputed** and earns nothing for either hop.
- The highest-`seq` fully signed receipt per (window, up, down) is the one that counts. Validators deduplicate identical uploads first. Any `(window, up, down)` pair whose valid receipts include two different totals for the same `seq`, or totals that decrease as `seq` increases, is rejected for the window (`select_window_receipts`). So is a pair with two receipts at one `seq` that differ only in `block`: none dominates that `seq`.

### Hop receipts from counters (PB-13, Task 12b)

A node's hop receipt `total` is what it counted, not a fixed number of bytes per packet or request (the VPN data plane below bills its client deltas, 4,096 bytes per request, and nothing else uses that).

- **What is counted: forwarded transit only (Task 12b fix round 2, red team H2).** Per BGP peer, in bytes of IPv6 packet, cumulative since the node started (`bwos_net::node::Stats.peers[i]`, `datapath.md` §Counters and receipts): `bytes_in` what came from that peer and was forwarded to another peer, `bytes_out` what went to that peer having come from another. Never the node's own flows, anything to or from its link address (BGP, BFD), its probes, or keepalives. A packet held for a handshake is counted once, when the handshake lets it go. The node's own traffic is in separate `own_in` and `own_out` counters, for the operator, and MUST NOT go in a receipt. Probe peers aren't counted.
- **The receipt.** For the stream `up -> down`, `up`'s proposal carries its `bytes_out` to `down` over the window, and `down` compares it with its own `bytes_in` from `up`. Both count transit, so a hop agrees where both ends relay the flow; at a flow's ingress or egress the end's own share is in no counter receipt (OQ-103) (`bwos_node::receipts::hop_receipt_from_counters(window, seq, up, down, total)` builds the unsigned receipt, and `ReceiptBook` signs and co-signs it). Loss on the link beyond `RECEIPT_TOLERANCE_PPM` makes `down` counter-propose its smaller count, so loss is never credited.
- **Per window.** The counters are cumulative since the node started and `total` is cumulative within the window, so a proposer MUST propose its counter less its value when the window began, and a co-signer compare its own counter the same way. The no-root node doesn't yet exchange receipts with its peers over the overlay; the counters, the receipt builder and the book are what that exchange is built from (OQ-103).
- **Own traffic and junk.** The node's own flows aren't counted at all (sim `own_traffic_burster`). Transit can still be junk a node's sybil UIDs push through assigned hops. For usage crediting, with `attest_free` on, unattested bytes earn nothing (`scoring.md` §Byte crediting 5), and a relay reporting more than its next hop counted is credited no more than what was co-signed (sim `counter_inflater`, a regression guard). That does **not** cover background: junk transit on cross-UID hops would be credited as background, which is why background stays out of `team` until PB-38 credits only canary or digest-verified carriage (`measurement.md` §Background traffic, sim `sybil_uid_background`).

### Receipt runs (Task 12b, round 5 B)

For each capacity test of a node due at block `b` (`measurement.md` §Team capacity tests), the node's receipt batch for the window MUST keep, per stream `(window, up, down)` it is an end of, **every** co-signed receipt from `before` to `after`, not just the latest: `before` is the stream's last receipt with `block <= b`, and `after` its first after `before` with `block >= b + CAP_TEST_BLOCKS - 1` (`receipts::test_bracket`). A stream with no `before` yet keeps its receipts from its first; one with no `after` yet, to its latest. Validators read background from these runs (`measurement.md` §Background traffic); a run with a missing receipt shows a wide interval and adds nothing.

- `ReceiptBook` keeps every co-signed receipt per stream, `seq` ascending, at most `MAX_STREAM_HISTORY` (256; a window holds 144 at `RECEIPT_INTERVAL`), and `ReceiptBook::build_batch_with_runs(key, window, client_receipts, tests)` builds the batch with the latest receipt of each stream and the runs of every test in `tests`.
- A node passes **every** test of the window so far, because each new batch dominates and supersedes the last (§Submission). The batch is sorted by `(up, down, seq)`.
- A batch may therefore hold several receipts of one stream, but at most one per `(up, down, seq)`.
- **Overflow.** A batch holds at most `MAX_BATCH_RECEIPTS` (1,024) hop and client receipts together; a node with many streams and tests in one window can run out of room for its runs, and then `build_batch_with_runs` fails to sign rather than drop receipts silently. Splitting runs across batches is open (OQ-106).
- `ReceiptBook` forgets runs, latest receipts and block views more than `RETENTION_WINDOWS` windows old (`ReceiptBook::prune`, on every co-signed receipt).

### Overlay data plane: hop-by-hop co-signing (`[INCENTIVE-HOP-01]`)

The VPN data plane (`bwos_core::vpn`: `/ingress-tunnel`, `/ingress-stream`, `/ingress-bond-burst` → `/relay-tunnel`, `/relay-stream` → `/exit-tunnel`, `/exit-stream`) MUST produce one co-signed receipt per adjacent hop of the path it forwards over, so a route `[N0, N1, …, Nk]` can pass the chain check below. A single end-to-end `(ingress, exit)` receipt matches no hop of a relayed route and earns nothing.

- **Which chains carry receipts.** Hop receipts are exchanged only on a direct chain (ingress straight to the exit), or on a chain whose node path is the `path` or `backup_path` of a route in the production table installed on the ingress. On any other multi-hop chain the ingress sends no proposal, and the session is billed to the client but earns no transit credit. Examples are ad-hoc bonded-burst stripes and transit hops with no table. Only production routes are rewarded (AGENTS.md invariant 2), and relays refuse to co-sign off-table paths (T30).
- **Who proposes to whom.** Every node proposes only to the node it sends the request to. The ingress proposes `(ingress, first hop)`. Each relay co-signs the proposal addressed to it and proposes `(relay, next node)`. The exit co-signs the proposal from its immediate upstream: the last node on `bgp_path`, or the ingress itself. The ingress-itself case is an end-to-end proposal, sent when the ingress cannot resolve its transit hops' endpoints and therefore sends straight to the exit.
- **Next-hop keys.** Tunnel and stream requests carry `remaining_hop_keys` next to `remaining_hops`. These are the node keys of those endpoints, in the same order, and the last key MUST be `client_receipt.egress`. The field MAY be empty when one hop remains, because the exit's key is then `client_receipt.egress`. A relay pops the next key with the next endpoint.
- **Unit.** On this VPN data plane, `total` is the cumulative client-receipt delta: the increase of the client-signed `client_receipt.bytes`. It is the same delta at every hop. Elsewhere `total` is a node's counted bytes to that peer (§Hop receipts from counters, roadmap PB-13). Hop receipts never count response or forwarded bytes (`bytes_forwarded`, stream tx/rx).
- **Relay checks (before forwarding).**
  - The proposal MUST have the current `window`, `seq >= 1` and `down` = this relay, and its `up` MUST be the last node on `bgp_path` (the ingress when `bgp_path` is empty). It MUST verify.
  - **Production route (T30).** The path `bgp_path + [this relay, next node, remaining keys…]` MUST run from `client_receipt.ingress` to `client_receipt.egress` and MUST be the `path` or `backup_path` of a route in the production table installed on the relay (`POST /exit-route-table` or `bwos-node exit-serve -route-table`, admin). A relay with no table co-signs nothing (`403`). Without this check anyone could push bytes from sessions no route carries onto a hop between two honest relays, and the validator would zero every route through that "inflated" hop.
  - **Registered next hop (T31).** The next node MUST be a peer registered on the relay (`POST /exit-register-node`, `-peer <key>@<ip:port>`), and the request MUST forward to exactly its registered endpoint (`403` otherwise).
  - The next node's key MUST be a valid non-weak key that is neither this relay nor already on `bgp_path`. `remaining_hop_keys` MUST be empty or exactly as long as `remaining_hops`; this is checked even when the request carries no proposal. A proposal with no keys while more than one hop remains is refused (`400`).
  - Its delta over the bytes this relay already accepted from `up` MUST be at least the request payload (and at least 1) and at most `MAX_CLIENT_DELTA_BYTES`.
  - That delta MUST be covered by the increase of `client_receipt.bytes` since this relay last carried the same `(ingress, client, egress)` session.
  - The co-sign MUST succeed as a dry run.
  - A proposal addressed to another node is refused (`400`). A request with no proposal at all is forwarded without any hop receipt.
  - A relay whose per-window client table or a lock table is full (1,024 entries each) refuses new sessions or nodes (`400`/`503`). It holds at most 256 registered peers.
- **Commit.** A relay commits only after the next node answers `200` carrying the co-signed receipt for exactly the relay's own proposal. On commit:
  - it advances its per-downstream `seq` and cumulative `total`;
  - it co-signs the upstream proposal;
  - it stores both receipts for its batch;
  - it returns the upstream receipt in `cosigned_hop_receipt`.

  On any refusal or error before the next node co-signed, nothing is committed, as with TV-30 at the exit. Once the next node has returned a valid co-signed receipt, the relay always advances its downstream counters and stores that receipt, even if co-signing the upstream proposal then fails (the next node has accepted those counters, so the relay's next proposal must continue from them). The upstream then gets `502`.
- **Ordering.**
  - Proposals to one downstream node are serialized: the ingress per first hop, a relay per next node. Concurrent requests therefore never sign the same `seq`.
  - The ingress keeps its `seq` and cumulative `total` per first hop, not per exit.
  - A failover attempt signs a fresh proposal to the backup path's first hop.
  - On a relay, the upstream node's lock and then the next node's lock are held from the check to the commit. For streams this covers only the handshake.
  - Every wait for one of these locks gives up after `HOP_LOCK_WAIT` (10 s): the relay answers `503` and the ingress counts a failed attempt (OQ-27).
- **Bonded bursts (ADR-0020).** Only stripe 0 carries the billed receipt, and it is co-signed hop by hop like a tunnel when its chain carries receipts (see above). Auxiliary stripes carry the proposal as binding evidence only when stripe 0 goes straight to the exit. Their relays get no hop receipt, so a bonded burst's bytes are credited to stripe 0's path.

## Chain check

For a sampled path `A → B → C → D`, validators check that the receipts (A,B), (B,C) and (C,D) agree on their unsplit `total` within tolerance. A hop whose total exceeds both neighbors' by more than the tolerance is zeroed for that window segment (it inflated). A missing middle receipt zeroes that path for the window. A path that visits any node twice is zeroed the same way, so one receipt is never counted for two hops (`verify_path_chain`).

Verified hop bytes are then credited to nodes once per path (`scoring.md` §Byte crediting): each hop's credit is split across the active paths through it by each path's weight bytes, its own `paid` and `free` takes, a path slower than Mechanism 1's regret comparator by more than `ROUTE_REGRET_TOLERANCE_PPM` earns nothing, and nodes on one path that share an operator UID or an endpoint dedupe group are credited for that path at most once (`[T23]`).

## Hop digests (ADR-0038)

Status: specified and spiked, **not scored** (`hop_digest::HOP_DIGESTS_SCORED` is `false`). Nothing below changes a weight until ADR-0038's `incentive-red-team` pass sets it `true`. Implemented in `crates/bwos-core/src/hop_digest.rs`; sampling and keys are in `measurement.md` §Secure sampling.

Hop digests show which packets each hop received, so sampled packets (`measurement.md` §Secure sampling) can be followed along a path. They don't replace hop receipts: pay gating stays on the co-signed totals above.

**What a hop records.** For every packet it accepts for transit, a hop computes `hop_digest(invariant_bytes(packet))` (8 bytes, `measurement.md`). It records the digest when it accepts the packet, before its send, whether or not the send succeeds. A packet it refuses (no route, hop limit, source check, not assigned) is not recorded. A no-root node records in `Node::on_packet` with `--hop-digest`. A kernel node needs an eBPF hook (OQ-65).

**`HopDigestBatch`** (domain `hop-digest-batch`, signed by the hop's node key):

```json
{"v":0,"window":1234,"node":"<node pubkey hex>","epoch":17,"digests":["00a1b2c3d4e5f607","..."],"sig":"<ed25519 hex>"}
```

- One batch per `(window, node, epoch)`, covering the `SAMPLE_EPOCH_MS` epoch `epoch` (`1 ..= SAMPLE_EPOCHS_PER_WINDOW`).
- `digests` are 16-character lowercase hex strings, sorted ascending with no duplicates (a set). A hop records every digest, sampled or not, because it can't tell which are sampled. At most `MAX_HOP_DIGESTS_PER_BATCH` (200_000). A hop with more transit packets in one epoch than that can't commit them all (OQ-64). An empty `digests` is valid: it says the hop accepted no transit packet that epoch.
- `HopDigestBatch::verify` checks `v == 0`, the epoch range, a valid non-weak `node` key, the digest order and count, and the signature over `wire::signing_bytes("hop-digest-batch", batch)`.
- **Order.** As evidence about an ingress's flow, a batch for an epoch whose key that ingress has already revealed MUST be refused (`hop_digest::check_batch_order(batch, ingress, revealed)`). A reveal of `K_e` reveals every earlier key, so the batch for epoch `e` of window `w` is refused once that ingress has a `SampleKeyReveal` for `w` with `epoch >= e`. Revealed keys are kept per ingress (`hop_digest::RevealedKeys`), and a reveal counts only if it verifies under the node key of the ingress it names, so a reveal signed by anyone else refuses nothing (red team RT1, sim `reveal_kill_switch`). A hop therefore publishes each batch within `SAMPLE_REVEAL_DELAY_MS` of its epoch's end. Each receiver applies this at receipt. Agreeing on the order across validators, before batches are scored, is OQ-63.
- Batches go to validators' object stores (`PUT /v0/objects/hop-digest-batch/<hash>`). `hop-digest-batch` is a wire and object-store domain, but it is **not** in `manifest::MANIFEST_OBJECT_DOMAINS`: it is withheld until the activation rule (OQ-45) and what one slot names for a fleet's many per-epoch batches (OQ-64) are settled (red team RT8).

**Loss attribution** (`hop_digest::attribute_loss(ingress, sampled, hops, egress)`, pure). `ingress` is the ingress's name, point 0 of the path. `sampled` is the epoch's sampled digests: the ingress's own batch digests that pass `digest_sampled` under the revealed `K_e`. `hops` is each hop's digest set in path order, and `egress` the egress's. For each sampled digest the last point holding it is found, hops first and the egress last:

- held by the egress: delivered, not lost;
- last held by hop `i`: lost between hop `i` and the next point, and counted against hop `i`;
- held by no hop: lost on the link from the ingress to the first hop, and counted against the ingress, which is point 0. A first hop that drops and leaves the digests out of its batch therefore puts the loss on its own incoming link, not on nobody (review I1, red team RT3, sim `first_hop_omitter`).

The result maps each point (the ingress or a hop) to its count, with zero counts left out; a count is keyed by the point at the upstream end of the link that lost it. Example: hop B holds 100 sampled digests and the egress 90 of them, giving `{B: 10}`. A hop that lacks a digest a later point holds has an incomplete batch, and that loss isn't charged upstream.

A count against point `i` is evidence about the link from point `i` to the next point, not about point `i` alone. A next hop that drops a packet and leaves its digest out of its batch, or withholds its batch, makes the loss look like point `i`'s, and without per-packet acknowledgements the two can't be told apart (ADR-0038 §4, T67, T71). Anything that pays or penalises on attribution MUST charge the link, or corroborate the hop with validator vantage probes as link blame already is (`measurement.md` §Probe vantage, T29).

**Source verification.** A path's sampled delivery counts only digests that both the source's own batch and the egress's batch hold (`hop_digest::verified_delivered`). The source is the node owning the packet's source address, or, for VPN traffic, the ingress a client receipt names. A sampled packet at a hop whose digest the claimed source never committed was injected with a forged source. When digests are scored, such traffic earns nothing on any hop (ADR-0038 §5, T68).

**Evidence.** A failure challenge (Task 16c) may cite `HopDigestBatch` and `SampleKeyReveal` hashes as spoof or link-loss evidence. It is confirmed only if every cited object verifies, the reveals chain to the ingress's anchor, every cited batch passed the order rule, and the objects themselves show the failure. A claim citing no digests is never confirmed. Credit is in the reporter's own mechanism, and none goes to a reporter whose UID owns a node on the reported path. Spoof credit is 0 while `HOP_DIGESTS_SCORED` is `false` (T69).

## Client receipts

Clients sign delivery receipts for paid sessions:

```json
{"v":0,"window":1234,"client":"<client pubkey hex>","ingress":"<node pubkey hex>","egress":"<node pubkey hex>","bytes":987654,"class":"realtime","sig":"<ed25519 hex>"}
```

`bytes` MUST be `>= 1`, and `client`, `ingress`, and `egress` MUST be pairwise-distinct valid non-weak Ed25519 public keys. Validators credit a hop's unsplit `total` as `paid` only as far as client receipts cover it within tolerance, and only when `ingress` and `egress` are bound to **distinct** live operator UIDs (`uid_in != uid_out`). The rest of the total, including intra-UID self-dealing bytes where `uid_in == uid_out`, is credited as `free`. Client receipt `bytes` are cumulative within the window: validators keep the **maximum** per `(window, client, ingress, egress)` across all batches and never sum repeated receipts.

`class` is the session's route class, a `routing::Route.class` value (ADR-0037). It's omitted when empty, and empty means `latency`, the baseline class (`receipts::DEFAULT_CLIENT_CLASS`). So receipts signed without it keep their signing bytes. A non-empty `class` MUST be printable ASCII of at most `MAX_ROUTE_ID_LEN = 128` bytes, as in a route table (`routing.md`). The ingress and egress learn the class from it; relays never see it. Scoring doesn't weight credit by `class` yet (`scoring.md` §Byte crediting 6).

**Per-class counters at the ends (PB-13, Task 12b).** A node counts its own flows by class, as an ingress or egress, and never transit (`bwos_net::node::Stats.classes`, `datapath.md` §Counters and receipts): `bytes_out` is the IPv6 packet bytes its stack sends from its node address (`/128`), `bytes_in` those it takes at it, keyed by the class of the flow's remote address. The node is told a flow's class by whatever holds the session (`Node::set_class(remote, class)`); a flow never classed is `latency` (`DEFAULT_CLIENT_CLASS`). Traffic on the link address (BGP, BFD) and the node's own probes are in no class. `bwos_node::receipts::client_receipt_classes(stats)` gives, per class with any bytes, `bytes_in + bytes_out`: both directions, as a client receipt's `bytes` counts the session. These counters are the node's own view and earn nothing by themselves; credit comes only from client-signed receipts. Where a no-root node learns a flow's class is OQ-103.

## Traffic profile (Task 12b, R9)

`receipts::TrafficProfile { window: u64, class_bytes: BTreeMap<String, u64> }` is the bytes per class in one window's committed client receipts, from `receipts::traffic_profile(window, receipts)`:
- only receipts of `window` that verify count;
- each session `(client, ingress, egress)` counts once, at its largest `bytes` (client receipt `bytes` are cumulative), ties to the lower class;
- an empty class counts as `latency`;
- sums saturate, and the result doesn't depend on the receipts' order.

Task 14's canary plan follows its class mix.

## Bandwidth vouchers (`ADR-0019`)

To authorize `paid` VPN exit and SDN sessions (`W_PAID = 1_000_000` ppm), a registered VPN Provider or Fleet Aggregator signs a `BandwidthVoucher` (domain `bandwidth-voucher`):

```json
{"v":0,"window_from":1,"window_to":48,"client":"<client pubkey hex>","issuer":"<provider pubkey hex>","exit_node":"<optional exit pubkey hex>","max_paid_bytes":1073741824,"cost_ppm":1000000,"alpha_credit_u64":100000,"protocol_burn_ppm":50000,"sig":"<ed25519 hex>"}
```

- `protocol_burn_ppm` MUST be `>= PROTOCOL_VOUCHER_BURN_PPM` (`50_000` ppm = `5%`) as a wash-trading fee. This makes circular self-dealing negative-EV **only if** a floor on the α price per credited byte is enforced on chain. Nodes now enforce the floor below, but `alpha_credit_u64` is a number the issuer signs, not an on-chain burn proof, and the issuer can be the attacker's own exit, so v0 still makes **no** negative-EV guarantee (threat-model T20, open-questions OQ-14).
- **Price floor (`[T20]`, OQ-14, ADR-0025).** A voucher backs at most `effective_max_paid_bytes = min(max_paid_bytes, floor(alpha_credit_u64 * 2^30 / MIN_VOUCHER_ALPHA_PER_GIB))` paid bytes, where `MIN_VOUCHER_ALPHA_PER_GIB` = 1_000 raw α units per GiB (`vpn::MIN_VOUCHER_ALPHA_PER_GIB`, `BandwidthVoucher::effective_max_paid_bytes`, `u128` integer math). A voucher below the floor is **capped, not rejected**: it stays structurally valid and signature-valid, but every node-side quota check uses the effective quota instead of the signed `max_paid_bytes`. This covers `verify_for_session` on every ingress and exit paid path and in `bwos-client`, the choice between the requested and the issued voucher in the tunnel response, and the trusted-issuer gate. A voucher whose effective quota is 0 is refused for every paid session and by `check_trusted_voucher`. Capping keeps already-signed vouchers usable up to what their α pays for, and refusing nothing at signing time means issuers and clients need no new error path. Rejection would also give a clear failure, but it would strand a voucher's backed bytes over one under-backed top-up. Top-ups (`issue_voucher`, `credit_fleet_relay`) add raw `max_paid_bytes` and `alpha_credit_u64`, then the floor applies to the totals, so α added later backs quota granted earlier. The example above (1 GiB for 100_000 α) backs 100 GiB at the floor, so its effective quota is its full `max_paid_bytes`.
- Ingress and exit nodes verify that `client_receipt.bytes <= voucher.effective_max_paid_bytes()` (see the price floor above) and `window in [window_from, window_to]`. Client receipts are cumulative per window, and the node's per-client tables restart each window (below), so at the node `max_paid_bytes` caps each window's usage, not the voucher's lifetime total (OQ-14).
- **Trusted issuers, node side (`[T16]`/`[T20]`).** `ExitProviderState` and `IngressGatewayState` carry `trusted_voucher_issuers` (`BTreeSet` of issuer pubkey hex). When the set is non-empty, every paid session (`/ingress-tunnel`, `/ingress-stream`, `/ingress-bond-burst`, `/exit-tunnel`, `/exit-stream`, `/exit-burst-stripe`) MUST carry a voucher whose `issuer` is in the set (`vpn::check_trusted_voucher`), or it is refused with `403` before any egress. Because `voucher.issuer` MUST equal the target exit (`verify_for_session`), an ingress with a trusted set only carries paid traffic to trusted exits, and an exit that does not list its own key refuses all paid sessions. An empty set keeps v0 behaviour: vouchers stay optional. `bwos-node exit-serve` / `ingress-serve` read the set from `BWOS_TRUSTED_VOUCHER_ISSUERS` (comma-separated issuer pubkey hex, at most `MAX_TRUSTED_VOUCHER_ISSUERS` = 1_024; `vpn::trusted_voucher_issuers_from_env`). A malformed list fails closed: every paid session is refused.
- **Trusted issuers, validator side.** `TempoInput::trusted_voucher_issuers` with `TempoInput::vouchers` (`VoucherPolicy`): when non-empty, a client receipt covers `paid` bytes only up to the quota of trusted-issuer vouchers for that client, for that window, issued by the receipt's `egress`. The node-side set is an honest operator's own policy; it gives validators no assurance, because an attacker's nodes simply leave it empty.
- **Validator voucher quota uses the price floor (`[T20]`, Pass-7).** `trusted_voucher_quotas` sums each trusted voucher's `effective_max_paid_bytes()`, never its signed `max_paid_bytes`, so an under-priced voucher backs only the paid bytes its α pays for in scoring too.
- **Attested `free` bytes (`[T16]`, Pass-7).** With a non-empty `TempoInput::trusted_voucher_issuers`, validators credit `free` bytes (including uncovered `paid` reclassified as `free`) on a route only up to the issuer-attested client coverage of its `(ingress, egress)` pair: client receipts that the trusted egress itself uploaded in its own batch (`batch.node == egress`, `egress` in the allowlist; the same client checks and per-session maximum as for `paid`), less the `paid` bytes already covered on that pair, with `RECEIPT_TOLERANCE_PPM` slack (`VoucherPolicy::attest_free`, `scoring.md` §Byte crediting 5). Hop bytes no trusted issuer attests to earn no `free` credit, so colluding transit UIDs on an assigned route between their own nodes cannot fabricate `free` bytes (sim `unattested_free_fabricator`). Clients SHOULD therefore sign delivery receipts for free sessions too, and trusted exits MUST upload the client receipts they hold. With an empty allowlist `free` is credited without client receipts, as in v0.

### Per-window node state (`OQ-13`)

Exit and ingress daemons keep their replay tables per window: `client_paid_bytes` (1,024 entries), the exit's `burst_stripe_seen`, `latest_client_receipts`, `latest_cosigned` and receipt book, the relay role's `relay_client_bytes`, `downstream_seq` and `downstream_paid_bytes` (1,024 entries each, `[INCENTIVE-HOP-01]`), and the ingress's per-first-hop `seq`/cumulative bytes (`exit_seq`/`exit_paid_bytes`, keyed by the downstream node) and stored co-signed receipts. `advance_window(new_window)` clears them and drops vouchers whose `window_to < new_window`. Before clearing, it keeps the closed window's signed batch in `closed_window_batch` for a late upload. Windows never move backwards.

- Every request, receipt, hop proposal and burst stripe is rejected unless its `window` equals the node's current window, so clearing old windows cannot reopen a replay. Within a window the strictly-increasing `client_receipt.bytes` check and the stripe bitmask are unchanged.
- An ingress session that finishes after a rollover is not committed into the new window (`IngressGatewayState::commit_session`), and an exit commit runs through `process_exit_request`, which re-checks the window.
- With `BWOS_WINDOW_SECS` set (e.g. `4320` = 360 blocks of 12 s), each request first calls `tick_window_clock`, which advances the window from a wall-clock anchor taken at daemon start (`WindowClock`). Without it, the window moves only through an explicit `advance_window`. A chain-driven window source is follow-up work for `bwos-node`.
- Residual: within one window, 1,024 cheap client keys can still fill `client_paid_bytes` until the window ends (at most one window, by default 72 min). A non-empty `trusted_voucher_issuers` limits table slots to clients holding trusted vouchers.

## Submission

Nodes upload receipt batches (domain `receipt-batch`) to validator ingest endpoints (`/v0/receipts`) once per `RECEIPT_UPLOAD_INTERVAL` (default 5 min):

```json
{"v":0,"window":1234,"node":"<node pubkey hex>","hop_receipts":[...],"client_receipts":[...],"sig":"<ed25519 hex>"}
```

Batches are signed by the node key. Validators keep receipts for `RETENTION_WINDOWS` (default 48).

Node side (`[INCENTIVE-HOP-01]`):
- **Upload.** `bwos-node exit-serve` and `ingress-serve` take `-validator <ip:port>` (repeatable, at most 16) and `-receipt-upload-secs <n>` (default `RECEIPT_UPLOAD_INTERVAL`).
  - Each round advances the window clock, then posts the closed window's batch (if any) and the current window's batch to every validator's `POST /v0/receipts`.
  - Empty batches are skipped. A batch already uploaded unchanged to a validator is skipped too, since a stored batch dominates its replay.
  - Errors are logged and retried on the next round (`vpn::upload_receipt_batches`).
- **Pull.** `GET /exit-receipt-batch` and `GET /ingress-receipt-batch` return `{"v":0,"window":w,"current":<signed batch>,"closed":<signed batch or null>}`. They are control-plane endpoints (loopback or a signed admin request, TV-24), because a batch names every client key and its per-window bytes.

Validator side:
- **Ingest allowlist.** `bwos-validator serve --receipt-nodes-file <file>` sets the ingest allowlist: a JSON array of node keys, or an object mapping each node key to its UID (`{"<node key>": <uid>, ...}`), which turns on the per-UID window quota (F1). At most `MAX_RECEIPT_NODES` (3_072) keys. Without the file, `serve` refuses to start unless `--demo` (local network only) selects the demo keys.
- **Window bound (SEC-2).** `serve` takes its current window from its signed inputs: the highest `window` among the directory, table and snapshot in `--signed-inputs`, moving forward on each reload and never back (`routing.md`, "Live reload"). A new upload whose `window` is outside `[current − RECEIPT_PAST_INGEST_WINDOWS, current + RECEIPT_FUTURE_WINDOWS]` (`4` and `2`: nodes up to two windows ahead of the inputs are admitted, and an honest uploader only ever sends its closed and current windows) is refused (N1); stored batches are kept for `RETENTION_WINDOWS`. One reading moves `current` forward by at most `MAX_RECEIPT_WINDOW_STEP` (2); a bigger jump is logged and held until the next window's input confirms it, and `current` never moves back (F6). **At startup (R-I1)**, with `--state-dir`, `current` starts from the window the dump last confirmed (`<state-dir>/receipts/receipt-window.state`, or the newest `window-<w>/` directory less 2), so the step limit applies to the first reading after a restart too, and the dump never prunes a window directory because of a window it hasn't confirmed. A new `--state-dir` has no floor, and the first reading's window is taken as given. With no windowed input yet, every batch is refused (fail closed), except under `--demo`, whose fixed local data has no window clock. Each time the window moves, batches older than `current − RETENTION_WINDOWS` are pruned (`ObjectStore::prune_receipt_batches`), so the store doesn't fill up over time and one bound node can't fill it with made-up window numbers. Until Task 19b's chain loop, the current window is only as fresh as the operator's inputs (OQ-98): the operator MUST refresh `--signed-inputs` every window, and nodes MUST run with the validators' `BWOS_WINDOW_SECS` and a `-window` anchored to the current directory window. Refused uploads are logged on the validator once per `RECEIPT_DUMP_INTERVAL_SECS`, counted by reason; `window_ahead` means the inputs are behind the nodes.
- **Persistence (RB-04, RB-05, F2, F7).** With `--state-dir`, every `RECEIPT_DUMP_INTERVAL_SECS` (30 s) the windows whose batches changed since the last pass are written under `<state-dir>/receipts/window-<w>/`, **one file per batch**, `<node>-<hash>.json`, written once. No file holds a whole window, so none reaches `run-tempo`'s per-file bound however busy the window. The batches are copied out of the store as shared handles under a short lock, and written off it. A dump never truncates a window: a file whose batch the store doesn't hold (a previous run's, or one since superseded) is deleted only when a stored batch from the same `(window, node)` dominates it, which loses nothing. An unparseable file is moved to a unique `<name>.corrupt[.<n>]`; a file too big to read is left in place and logged. Window directories older than `current − RETENTION_WINDOWS` are deleted. A node keeps at most `MAX_BATCHES_PER_NODE_WINDOW` files per window, the highest ranked (highest `seq`, then most bytes); the rest are deleted with a log line (N3). **At startup (N3)**, `serve` reads the retained window directories back into the store, highest ranked first, without verifying them again (it wrote only batches it verified), so the per-node, UID and window quotas count what earlier runs stored and restarts can't pile files up; a file the store refuses stays on disk. A poisoned store lock is recovered and logged rather than stopping the dump.
- **Scoring.** `bwos-validator run-tempo --input <TempoInput JSON> [--receipts-dir <dir>] [--out <file>]` scores one tempo through the same persisted path as the daemon (`local`/`test` only, no chain writes):
  - **Receipts.** It adds the signed batches of the input window found in the directory, and every file in its `window-<w>/` directory: a batch, an array of batches, or a pull body, each file read under `MAX_RECEIPT_FILE_BYTES`. Unreadable files are skipped with a warning, and batches are deduplicated by hash. Past a file-count bound the rest are skipped with a warning, and from the window directory it keeps at most `MAX_BATCHES_PER_NODE_WINDOW` batches per node, the highest ranked: a file count never fails the tempo (N3).
  - **Output.** It checks both weight vectors with `validate_weights` and prints or writes the `TempoOutcome` JSON.
  - **Inputs it overrides.** Like the daemon, it applies the stake, diversity, trusted-issuer, voucher and consent files given on the command line (`M4-07`) over the matching `TempoInput` fields, and with `--state-dir` it merges the persisted capacity, cohort and consent state.
  - **Ingest rules.** It does not apply the ingest allowlist or the batch-dominance rule of `serve`, only signature, window and hash dedupe (OQ-28).

Validator ingest (`ObjectStore`):
- **Order of checks (SEC-1).** An upload is checked cheapest first, and no signature is verified until every check that needs none has passed: the size bound and strict canonical parse; then, under the store lock briefly, the ingest allowlist, the window bound, a byte-identical replay of a stored batch (accepted, nothing to verify), domination by a stored batch, and the per-node, UID and window quotas. Bytes that failed verification before are refused here too, from a bounded cache (`MAX_FAILED_UPLOAD_CACHE`, N4). The quota checks use running counters, so the lock is held `O(log n)`. A refused upload stops here and never takes a verification slot. Then the batch's own signature is checked, once, off the lock, so a forgery with no key never takes a slot (N4). Only then is a slot taken: at most `MAX_CONCURRENT_RECEIPT_VERIFICATIONS` (4) per server and **one per node key**, so a bound key whose uploads fail slowly holds one slot at most; another upload gets `503` unverified. Signatures are checked with the lock released: the batch signature first, then each receipt's (`ReceiptBatch::verify`), so a junk batch signature costs one check, not up to 2,049. The lock is taken again briefly to repeat the cheap checks and insert. Reads therefore never wait behind a signature check. The loopback `PUT /v0/objects/receipt-batch/<hash>` takes the same order.
- A batch is idempotent by its commitment hash.
- A new batch from the same `(window, node)` that **dominates** a stored one supersedes it: every stored hop receipt has a counterpart for the same `(up, down)`, the new batch's highest-`seq` receipt of that stream, with `seq >=` and `total >=`, and any new receipt at the stored one's `seq` has an identical `total` and `block`; every stored client receipt has a counterpart for the same `(client, ingress, egress)` with `bytes >=`. A batch holds at most one hop receipt per `(up, down, seq)`, and may hold several per stream: its receipt runs (§Receipt runs). A batch dominated by a stored one, such as a replayed older upload, is refused. Cumulative uploads (about 15 per 72-minute window at `RECEIPT_UPLOAD_INTERVAL`) therefore keep one batch per node instead of hitting the cap.
- **Quotas (F1).** A node's first batch for a window (counting a dominating batch that replaces its only one) is always admitted from a reserve, unless the node is at `MAX_BATCHES_PER_NODE_WINDOW = 8`. Further, non-dominating batches count against: the window's `MAX_RECEIPT_EXTRA_BATCHES_PER_WINDOW` (1_024); the UID's `RECEIPT_UID_QUOTA_PER_NODE` (2) batches per window per node it has on the allowlist, and at most `RECEIPT_UID_EXTRAS_CAP` (256) of the window's extras (N2), when the allowlist maps keys to UIDs; and the backstop `MAX_STORED_RECEIPT_BATCHES` (208_896) (`docs/specs/scoring.md` parameter table). So one UID with many sybil keys can't fill a window and lock out other nodes' batches (T118).
- Validators SHOULD restrict ingest to live bound node keys (`ObjectStore::set_receipt_node_allowlist`). Otherwise anyone with freshly generated keys can fill the bounded store.
- `PUT /v0/objects/<domain>/<hash>` is write-once. A second, different encoding of the same commitment, such as a different unverifiable `hotkey_sig`, is rejected with an error and never silently dropped.
