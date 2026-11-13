> Taken from the Transit Fabric source repository at commit 91be12e (91be12ef98b775c7f045124e6b8c686c15439650, main), file docs/specs/encoding.md. Links into the private source tree are shown as plain text.

# Spec: encoding and signing (v0)

Status: draft · Implemented in `crates/bwos-core/src/wire.rs` · Vectors: `testdata/vectors/canonical.json`

## Canonical JSON

All signed or hashed objects use canonical JSON:

1. UTF-8, **ASCII-only string contents** in v0 (reject non-ASCII on encode and decode). This avoids escaping differences across implementations.
2. Object keys sorted by byte order. Duplicate keys are invalid.
3. No insignificant whitespace: separators are `,` and `:`.
4. **Integers only.** No floats anywhere in signed objects. Use integer units: bytes, microseconds (`_us`), parts per million (`_ppm`), block numbers. Integers MUST lie in `[-2^63, 2^64 - 1]` and use the shortest decimal form: no leading zeros, no `+`, no `-0`, no exponent.
5. Byte strings (keys, hashes, signatures) are lowercase hex without a `0x` prefix.
6. Absent optional fields are omitted, never `null`.
7. HTML characters (`<`, `>`, `&`) are not escaped.
8. String escapes are fixed: `"` → `\"`, `\` → `\\`, U+0008/U+000C/U+000A/U+000D/U+0009 → `\b` `\f` `\n` `\r` `\t`, every other control character U+0000–U+001F → `\u00xx` with **lowercase** hex. `/` and U+007F are emitted raw. Any other spelling (`\/`, `\u0041`, `\u001F`, `\u0008`) is non-canonical and rejected on decode. Pinned by the escape vector in `canonical.json`.

## Signing bytes

```
signing_bytes(domain, obj) = "BWOS-v0/" || domain || 0x00 || canonical_json(obj_without_signature_fields)
```

Top-level signature fields (`sig`, `sig_up`, `sig_down`, `hotkey_sig`) are removed before encoding.

A hotkey's sr25519 `hotkey_sig` on a `commitment-manifest` may instead be over exactly `<Bytes>` || `signing_bytes` || `</Bytes>`, the form a browser wallet's `signRaw` signs (ADR-0054, `identity::verify_sr25519_hotkey_sig`). No other wrapping, and no other domain, is accepted (an SS58 `node-binding` signature is checked nowhere until OQ-131; if it is, the same rule applies). Vectors: `testdata/vectors/wallet_link.json`.

## Domains

| Domain | Object | Signed by |
|---|---|---|
| `node-binding` | Hotkey → node keys binding | Hotkey (sr25519) |
| `wg-binding` | Node key → WireGuard key | Node key (ed25519) |
| `hop-receipt` | Hop receipt | Both hops' node keys |
| `client-receipt` | Client delivery receipt | Client key (ed25519) |
| `probe-result` | Probe result batch | Validator hotkey |
| `route-table` | Route table | Solver hotkey |
| `capacity-declaration` | Declared capacity per node | Operator hotkey |
| `edge-config` | Transit Fabric Edge appliance config (edge/provisioning) | Operator hotkey |
| `link-capability` | Link class capabilities (datapath.md) | Node key |
| `receipt-batch` | Batch of hop and client receipts uploaded to validators (`receipts.md`) | Node key (ed25519) |
| `bandwidth-voucher` | Prepaid or earned $\alpha$ bandwidth quota voucher (`receipts.md`, `ADR-0019`) | VPN Provider / Aggregator key (ed25519) |
| `fleet-enrollment` | Prosumer sub-node enrollment into a Fleet Aggregator UID (`identity.md`, `ADR-0019`) | Prosumer node key (ed25519) |
| `private-fabric-seed` | **Deprecated, reserved (Pass-5 CLI-2).** Formerly derived Private Fabric node & WireGuard seeds from public input, which made the private keys derivable. Nothing produces it any more; it stays listed so the string is never reused for another object | — |
| `node-join-ticket` | Self-signed Zero-Config Node Join Ticket (`fabric-ticket://<hex>`, `provisioning.rs`, `ADR-0022`) | Node key (ed25519) |
| `node-consent` | Node key's consent to be bound to `(hotkey, netuid)`: proof of possession for `node-binding` (`identity.md`, `T14`) | Node key (ed25519) |
| `cap-test-ack` | Capacity-test delivery acknowledgement: node under test, prober validator, window, validator-chosen `test_id`, `CapTestDigest` of the stream and byte count (`measurement.md`, `probe::CapTestAck`, `RT2-3`). Distinct from the raw labels `cap-test` and `cap-test-stream` (the `0x00` terminator separates them) | Node key of the node under test (ed25519) |
| `link-echo` | A node's echo of a validator's link probe that reached it from one of its BGP peers (PB-48, `probe::LinkEcho`): `{"v": 0, "from": <peer's node key>, "to": <this node's key>, "nonce": <16-byte hex>}`, the nonce the validator's agent drew. Signed only, never stored; 64 raw signature bytes ride in the reply datagram | Node key of the echoing node, `to` (ed25519) |
| `admin-request` | Single-use control-plane authorization: admin key, target node, method, path, body SHA-256, timestamp (±300 s), nonce (`traffic-verification.md` TV-24) | Operator admin key, or forwarding ingress node key (ed25519) |
| `partner-payment-channel` | Signed $\alpha \text{ unstake} \rightarrow \text{TAO} \rightarrow (\text{XMR} \mid \text{BTC-LN} \mid \text{BTC} \mid \text{MYST})$ payment channel order funding zero-KYC partner VPN exits (`partner_exits.rs`, `ADR-0028`) | Client or operator Ed25519 key |
| `node-quarantine-vote` | Stake-weighted validator vote to quarantine an `fc00::/128` node key for universal-consensus network abuse (`overlay_web.rs`, `ADR-0031`) | Validator hotkey (ed25519) |
| `fabric-name-record` | Self-certifying `.fabric` East–West overlay service name & optional static-IP exit gateway binding (`overlay_web.rs`, `ADR-0031`) | Origin node key (ed25519) |
| `attestation-key-pop` | The ed25519 key's proof of possession inside an `AttestationKeyRecord`. It signs `{hotkey, not_after, probe_wg_pub}` (`probe_wg_pub` omitted when absent), so a hotkey can't claim a key it doesn't hold. `probe_wg_pub` must be the X25519 form of the same ed25519 key (`measurement.md` §Team capacity tests, "Validator identity", red team RT1, `signed::AttestationKeyRecord`) | The attested ed25519 key itself |
| `attestation-key` | `AttestationKeyRecord`: SS58 `hotkey`, `ed25519` key, `not_after`, optional `probe_wg_pub`, `attest` flag and the `ed25519_sig` proof of possession, which `hotkey_sig` covers (`signed.rs`, ADR-0042, ADR-0039). Its hash is the sealed hash (see Hashing) | Hotkey (sr25519) |
| `validator-set` | Identity hash of a `ValidatorSet` with `attestations` stripped (`ValidatorSet::hash_hex`, ADR-0042). Nothing signs under it | — |
| `validator-set-attestation` | A validator's attestation of a `ValidatorSet` without its `attestations`, counted by the current set's quorum in `signed::accept_next_set` | Validator attestation key (ed25519) |
| `snapshot-attestation` | A validator's attestation of a topology `Snapshot` (`SignedSnapshot`) | Validator attestation key (ed25519) |
| `table-attestation` | A validator's attestation of a route `Table` (`SignedTable`), over the table without the solver's `hotkey_sig`. It is never the solver's `route-table` bytes (D9) | Validator attestation key (ed25519) |
| `peer-directory-attestation` | A validator's attestation of a `PeerDirectory` without its `attestations` | Validator attestation key (ed25519) |
| `signed-snapshot` | Publication domain: object-store key of a whole `SignedSnapshot`, attestations included. "Latest" is the highest `snapshot.window` (`signed::latest_key`, Task 11b) | — (carries attestations) |
| `signed-table` | Publication domain: a whole `SignedTable`. "Latest" is the highest `table.window` | — (carries attestations) |
| `signed-directory` | Publication domain: a whole `PeerDirectory`. "Latest" is the highest `window` | — (carries attestations) |
| `signed-validator-set` | Publication domain: a whole `ValidatorSet`. "Latest" is the highest `block` | — (carries attestations) |
| `commitment-manifest` | The object a hotkey's one on-chain commitment points at: `netuid`, `hotkey`, `window`, the `node-binding` hash and an `objects` map from domain to hash (`identity.md`, `manifest::CommitmentManifest`, ADR-0036). Its hash is the sealed hash (see Hashing) | Hotkey (sr25519) |
| `hop-digest-batch` | `HopDigestBatch`: `window`, `node`, `epoch` and the sorted 8-byte hop digests (16-character lowercase hex strings) of every packet the hop accepted for transit in that epoch (`receipts.md` §Hop digests, `hop_digest::HopDigestBatch`, ADR-0038) | Node key of the hop (ed25519) |
| `sample-key-reveal` | `SampleKeyReveal`: `window`, `epoch`, the epoch's 32-byte sampling `key` (64 lowercase hex) and the `ingress` that sampled with it. Epoch 0 is the window's key-chain anchor (`measurement.md` §Secure sampling, `hop_digest::SampleKeyReveal`, ADR-0038) | Node key of the ingress (ed25519) |
| `outside-evidence` | `OutsideEvidence`: one validator's snapshot of one outside source (`rpki`, `aspa`, `peering_db`, `ris`, `route_views` or `atlas`) for `window`, with `fetched_block` and records sorted and unique by canonical bytes. It is committed in the manifest slot `outside-evidence` and its hash is the plain hash (`measurement.md` §Outside evidence, `evidence::OutsideEvidence`, ADR-0039) | Validator hotkey (sr25519) |
| `canary-plan` | `CanaryReveal`: `v`, a validator's `plan` (`CanaryPlan`: `v`, `window`, the validator's SS58 `validator` and its sorted `entries` of `ingress`, `dst`, `start_ms`, `class` and `bytes`) and the 32-byte `secret` (64 lowercase hex) its timing and sizes were drawn from. Its plain hash is the plan's commitment, put in the manifest slot `canary-plan` at window open, and the object-store key it is revealed under after the window ends (`measurement.md` §Canary plans, `probe::CanaryReveal`, `probe::plan_commitment`, ADR-0051, Task 14) | — (bound by the validator's hotkey-signed manifest) |
| `table-update` | `TableUpdate`: an incremental update to the production table, with `window`, `block`, `seq`, `prev`, `changes`, `removed` (`routing.md` §Incremental updates, `table_update.rs`, Task 16b). A manifest slot may name it | Incumbent solver hotkey (sr25519) |
| `table-update-attestation` | A validator's attestation of a `TableUpdate` **with** its `hotkey_sig` kept (`wire::sealed_bytes` framing, unlike `table-attestation`), so the next update's `prev` is fixed by what the quorum signed. Listed in `SEALED_HASH_DOMAINS` so its vector pins `sealed_hash` | Validator attestation key (ed25519) |
| `signed-table-update` | Publication domain: a whole `SignedTableUpdate`. "Latest" is the highest `(update.window, update.seq)` | — (carries attestations) |
| `route-table-bundle` | **Proposed (ADR-0059), not yet in code (PB-46).** A solver's bundle of at most one route `Table` per shard, sorted by `shard`, committed and revealed whole. Used only under a shard plan with two or more shards; with one shard the commitment stays `route-table` | Solver hotkey |
| `shard-plan` | **Proposed (ADR-0059), not yet in code (PB-46).** The committed `ShardPlan` (`routing.md` §Proposed (ADR-0059)), hashed into the tempo's committed inputs and published on ADR-0049's scheduled-change path | — (hashed, not signed) |
| `shard-merge-record-attestation` | **Proposed (ADR-0059), not yet in code (PB-46).** A validator's attestation of a `MergeRecord`: the window's plan hash, merged table hash and, per shard, the winner or reference, its table hash, weight and fallbacks | Validator attestation key (ed25519) |
| `signed-shard-merge-record` | **Proposed (ADR-0059), not yet in code (PB-46).** Publication domain: a whole attested `MergeRecord`. "Latest" is the highest `window` | — (carries attestations) |
| `shard-allocations` | **Proposed (ADR-0059), not yet in code (PB-46).** A validator's attestation of the window's per-shard allocations (node, relay and link Mbps per shard), published before the commit deadline so solvers read their shard view | Validator attestation key (ed25519) |

`wire::ALL_DOMAINS` lists exactly these domains, except rows marked "not yet in code", which the named task adds; they MUST be unique.

### Receipt shapes (ADR-0037)

The canonical encodings of the two receipts, keys sorted, signature fields shown (they're removed before signing). Field rules are in `receipts.md`; `canonical.json` pins one vector of each, and a second hop receipt with `block`.

```
hop-receipt:    {"down":"<hex>","seq":17,"sig_down":"<hex>","sig_up":"<hex>","total":15,"up":"<hex>","v":0,"window":1234}
hop-receipt:    {"block":1234567,"down":"<hex>","seq":18,"sig_down":"<hex>","sig_up":"<hex>","total":15,"up":"<hex>","v":0,"window":1234}
client-receipt: {"bytes":987654,"class":"realtime","client":"<hex>","egress":"<hex>","ingress":"<hex>","sig":"<hex>","v":0,"window":1234}
```

- `hop-receipt` carries one unsplit `total` (u64) and no class. The v0 `bytes: {paid, free, canary}` object is gone, and a receipt in that shape fails canonical decoding.
- `hop-receipt` `block` (u64, Task 12b) is optional and omitted when absent (rule 6), so a receipt without it encodes and signs as before; `canonical.json` pins one with it.
- `client-receipt` `class` is omitted when empty (rule 6), so a receipt with no class encodes exactly as before ADR-0037 and keeps its signing bytes.

### Commitment fields and the inline node binding (ADR-0058)

Not JSON and not a signing domain. These are the raw bytes of a hotkey's Bittensor commitment fields, authenticated by the hotkey-signed extrinsic, so Invariant 7 has no Transit Fabric signature to frame (`identity.md` §Inline node binding).

```
field 0 : Sha256(commitment-manifest commitment_hash) | None
payload : 0x00 || u32be(not_before) || u32be(not_after) || node_1 .. node_n     (n = 1..=7, keys strictly ascending)
field 1 : Raw<k>(payload[0 .. min(len, 128)])
field 2 : Raw<len-128>(payload[128 ..])                                          (only when len > 128)
```

- A registration is Transit Fabric's only as `[Sha256]` or `[Sha256 | None, Raw, Raw?]` with the canonical split.
- Decoding is exact: no trailing bytes, version `0`, valid non-weak Ed25519 keys and `not_before <= not_after`.
- Vectors: `testdata/vectors/inline_binding.json`, with payloads and field splits for 1, 3, 4 and 7 nodes, the equivalent `node-binding` and its hash, layouts that are and aren't Transit Fabric's, and refused payloads with their error text. Both `bwos-core` and the link page are tested against it.

## Reserved derivation labels

These labels are used for raw (non-JSON) `BWOS-v0/<label>` hash and KDF inputs outside `signing_bytes`. They MUST NOT be used as signing domains; `wire::signing_bytes` and `wire::hash_hex` reject them (`wire::RESERVED_DERIVATION_LABELS`). Rows marked "not yet in code" are registered here first, and the named task adds them to that list.

| Label | Used by |
|---|---|
| `probe-seed` | Probe schedule seed (`measurement.md`, `probe.rs`) |
| `cap-test` | Capacity-test lottery (`probe.rs`) |
| `cap-test-stream` | Capacity-test random payload stream and delivery-proof hash (`measurement.md`, `probe.rs`, `[SCR-3]`) |
| `cap-cohort` | Cohort id of a simultaneous capacity test: `SHA-256("BWOS-v0/cap-cohort" \|\| 0x00 \|\| u32be(n) \|\| node_pubkey_1 .. node_pubkey_n)` over the sorted member keys (`measurement.md` §Cohort capacity tests, `probe::cap_cohort_id`, `[T28]`) |
| `cap-cohort-test` | Per-member `test_id` of a cohort test: `SHA-256("BWOS-v0/cap-cohort-test" \|\| 0x00 \|\| cohort_id \|\| nonce \|\| node_pubkey)` (`probe::cap_cohort_test_id`, `[T28]`) |
| `cap-team` | **ADR-0039, in code (Task 4Dc): `probe::cap_team_seed`, `probe::draw_team`.** Team draw seed for a team capacity test: `SHA-256("BWOS-v0/cap-team" \|\| 0x00 \|\| block_hash(b-1) \|\| subject)`, where the subject is the node key or `cohort_id`; draw `j` uses `SHA-256(seed \|\| u32be(j))` (`measurement.md` §Team capacity tests) |
| `cap-slot` | **ADR-0039, in code (Task 4Dc): `probe::cap_slot_key`.** Slot order of due tests within a tier: `SHA-256("BWOS-v0/cap-slot" \|\| 0x00 \|\| block_hash(b-1) \|\| subject)`, ascending, so no one can grind a key for slot order |
| `cap-team-test` | **ADR-0039, in code (Task 4Dc): `probe::cap_team_test_id`, `CapTeamTest::test_id`.** A team member's `test_id`: `SHA-256("BWOS-v0/cap-team-test" \|\| 0x00 \|\| node_pubkey \|\| u64be(b) \|\| nonce)` |
| `cap-peer-call` | **ADR-0056 revision 1, specified, not in code (Phase 2).** A peer-load call's secret block draw: called at `b` when `u64be(SHA-256("BWOS-v0/cap-peer-call" \|\| 0x00 \|\| plan_secret \|\| node_pubkey \|\| u64be(b))[0:8]) mod CAP_CALL_PERIOD == 0`; retest blocks are drawn the same way with `u64be(b_call)` appended (`measurement.md` §Peer-load capacity tests) |
| `cap-peer-coord` | **ADR-0056 revision 1, specified, not in code (Phase 2).** Seed of the stake draw of a node's coordinator for a window: `SHA-256("BWOS-v0/cap-peer-coord" \|\| 0x00 \|\| window_seed \|\| node_pubkey)` |
| `cap-peer-hidden` | **ADR-0056 revision 1, specified, not in code (Phase 2).** VRF input of a validator's hidden-slot self-selection: `"BWOS-v0/cap-peer-hidden" \|\| call_id`, `call_id = SHA-256(plan_secret \|\| node_pubkey \|\| u64be(b))`; the validator holds a slot when the output is below `stake_v × m / Σ stake` |
| `cap-peer-inner` | **ADR-0056 revision 1, specified, not in code (Phase 2, PB-43e).** AEAD associated data of a slice packet's inner header sealed to its `R_out` (sink blinding): `ChaCha20-Poly1305` under the X25519 key the source agrees with `R_out` for the call |
| `cap-peer-slice` | **ADR-0056 revision 1, specified, not in code (Phase 2).** Seed of a peer-load call's secret endpoint draw: `SHA-256("BWOS-v0/cap-peer-slice" \|\| 0x00 \|\| plan_secret \|\| node_pubkey \|\| u64be(b))`, `plan_secret` committed by the coordinator before the window and revealed after it; draw `j` reads `u64be(SHA-256(seed \|\| u32be(j))[0..8])`, first a UID uniformly, then a node in it |
| `claim-code` | Edge claim code (`provisioning.rs`) |
| `macsec-cak`, `macsec-ckn` | MACsec key derivation (`datapath.md`) |
| `ipsec-esp-gcm-a2b`, `ipsec-esp-gcm-b2a` | IPsec ESP key derivation (`datapath.md`) |
| `packet-class-mask` | Overlay header class-byte pad: `SHA-256("BWOS-v0/packet-class-mask" \|\| 0x00 \|\| mask_key \|\| src \|\| dst \|\| u64be(flow_id) \|\| u32be(payload_len) \|\| payload)[0] & 0x03` (`datapath.md`, `dataplane::class_mask_pad`, ADR-0024) |
| `packet-class-tag` | Masked overlay class tag (MAC over the class): `SHA-256("BWOS-v0/packet-class-tag" \|\| 0x00 \|\| mask_key \|\| mask_digest \|\| u8(class))[0] & 0x3f`, where `mask_digest` is the full `packet-class-mask` digest (`datapath.md`, `dataplane::class_tag`, ADR-0026) |
| `node-asn` | Node ASN: `4_200_000_000 + (first 4 bytes BE of SHA-256("BWOS-v0/node-asn" \|\| 0x00 \|\| node_pubkey)) % 94_967_295`, the RFC 6996 private 4-octet range (defined by `identity::node_asn_from_public`, which `bwos_net::asn::node_asn` delegates to; ADR-0033 item 4, the approved design). Kernel and no-root nodes peer with it (PB-04, `datapath.md`) |
| `asn-tie` | ASN collision tie-break: `SHA-256("BWOS-v0/asn-tie" \|\| 0x00 \|\| block_hash_after \|\| node_pubkey)`, lower wins, where `block_hash_after` is the 32-byte hash of the block after the one that included the node's binding commitment (`identity::asn_tie`; ADR-0033 item 4 amendment; `scoring.md` §Snapshot inputs). In the address vectors against `block_hash_after = SHA-256("pipe-test-block-after")` |
| `node-link` | Link address: `0xfc \|\| SHA-256("BWOS-v0/node-link" \|\| 0x00 \|\| node_pubkey)[0..15]`, the address a node holds BGP sessions on and gives as next hop for its `/128` (`datapath.md`, `identity::link_address_from_public`). ADR-0033 item 2, accepted by controller ruling |
| `partner-exit-node` | Partner relay node identity: `SHA-256("BWOS-v0/partner-exit-node" \|\| 0x00 \|\| provider \|\| 0x00 \|\| relay_id \|\| 0x00 \|\| wg_pubkey)` (`partner_exits::derive_partner_node_identity`, ADR-0028; not on the launch path) |
| `hop-digest` | Hop digest of a packet: `SHA-256("BWOS-v0/hop-digest" \|\| 0x00 \|\| invariant_bytes)[0..8]`, where `invariant_bytes` is the IPv6 header with traffic class and hop limit zeroed and the first 32 payload bytes (`measurement.md` §Secure sampling, `hop_digest::hop_digest`, ADR-0038) |
| `packet-sample` | Sampling tag: `HMAC-SHA-256(K_e, "BWOS-v0/packet-sample" \|\| 0x00 \|\| hop_digest)`; sampled when `u32be(tag[0..4]) < rate_ppm * 4294` (`hop_digest::digest_sampled`, ADR-0038) |
| `sample-key` | Last key of a window's sampling key chain: `K_N = SHA-256("BWOS-v0/sample-key" \|\| 0x00 \|\| mask_key \|\| u64be(window))`, `N = SAMPLE_EPOCHS_PER_WINDOW` (`hop_digest::sample_keys`, ADR-0038) |
| `sample-key-chain` | Sampling key chain step: `K_e = SHA-256("BWOS-v0/sample-key-chain" \|\| 0x00 \|\| K_{e+1})` (`hop_digest::chain_step`, `check_reveal_chain`, ADR-0038) |
| `canary-alloc` | Canary allocation draw (Task 14): a node's ticket `SHA-256("BWOS-v0/canary-alloc" \|\| 0x00 \|\| seed \|\| snapshot_hash \|\| u64be(window) \|\| u32be(len(n)) \|\| n)` and its draw `j`, the same with `\|\| u32be(j)` appended, read as `u128be` of the first 16 bytes (`measurement.md` §Canary plans, `probe::canary_allocation_deduped`) |
| `canary-draw` | A validator's secret plan draws: `SHA-256("BWOS-v0/canary-draw" \|\| 0x00 \|\| secret \|\| u64be(window) \|\| u64be(i))[0..8]` as `u64be` (`probe::canary_plan`) |

## Decoding & Depth Bounds

`wire::from_canonical_bytes` and `wire::canonical` enforce:
- Maximum serialized payload size `MAX_WIRE_BYTES = 4_194_304` (`4 MiB`).
- Pre-parse structural depth bound `MAX_JSON_DEPTH = 16` (`depth <= 16`, root object = depth 1) and ASCII validation before heap deserialization, with exact round-trip verification (`canonical(decoded) == raw_bytes`) so duplicate keys, unsorted keys, whitespace, `-0`, or floats are rejected.
- `wire::signing_bytes` requires `domain` to be `1..=64` printable non-whitespace ASCII bytes (`0x21..=0x7e`) and not a reserved derivation label.

## Hashing

`hash(domain, obj) = SHA-256(signing_bytes(domain, obj))`, hex encoded. Commitments use this hash, except for the sealed domains below.

```
sealed_bytes(domain, obj) = "BWOS-v0/" || domain || 0x00 || canonical_json(obj)
sealed_hash(domain, obj)  = SHA-256(sealed_bytes(domain, obj))
```

`sealed_bytes` is the signing framing with the signature fields kept. For a domain in `wire::SEALED_HASH_DOMAINS` (`commitment-manifest`, `attestation-key` and `table-update-attestation`), the on-chain commitment and the object-store key (`/v0/objects/<domain>/<sealed_hash>`) are the sealed hash (`wire::object_hash_hex`), so one commitment names exactly one encoding. Without this, a copy with the same body and a different or invalid `hotkey_sig` would have the same hash and could take the store slot first (ADR-0036, ADR-0042). The signature is still made and checked over `signing_bytes`. The `commitment-manifest` and `attestation-key` vectors in `canonical.json` carry a `sealed_hash` field; no other vector does.

The publication domains (`signed-snapshot`, `signed-table`, `signed-directory`, `signed-validator-set`, `signed-table-update`) hash with `hash(domain, obj)`. Their objects have no top-level signature field, so the hash covers the whole object, attestations included (ADR-0042).
