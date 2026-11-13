# Red-team pack

Everything you need to look for ways to earn more than you carry on Transit Fabric (Bittensor testnet, subnet 611), and to show them working. The pack was taken from the source repository at commit `91be12e`.

Read the [bounty page](../bounty.html) first: it has the scope, the out-of-scope list, the tiers and the rules. Register once on the [claim page](../claim.html) so credit goes to your address.

## What is in the pack

| What | Why you want it |
|---|---|
| [Scoring spec](scoring.html) ([.md](scoring.md)) | How emission shares are computed, with every parameter and its default. The place to look for something worth gaming. |
| [Measurement spec](measurement.html) ([.md](measurement.md)) | What validators probe and test, and how results are pooled. |
| [Receipts spec](receipts.html) ([.md](receipts.md)) | How bytes are credited, and what a relay can and can't claim. |
| [Capacity bonds spec](capacity-bonds.html) ([.md](capacity-bonds.md)) | The bonds that back declared capacity. |
| [Identity spec](identity.html) ([.md](identity.md)) | Node keys, hotkeys, bindings and consents. |
| [Encoding spec](encoding.html) ([.md](encoding.md)) | Canonical encoding and domain-separated signatures. |
| [Threat model](threat-model.html) ([.md](threat-model.md)) | Every attack we have written down, its mitigation and its status. Read it before you file. |
| [Whitepaper](whitepaper.html) ([.md](whitepaper.md), [PDF](Transit_Fabric_Whitepaper.pdf)) | The design in one document. |
| [The simulator](simulator.html) | `bwos-sim`, static binaries for Linux x86_64 and aarch64, with checksums and sample output. A walk-through of reproducing a finding in it. |
| [Finding template](FINDING.md) | The format we want findings in. The "Finding" Issue form has the same fields. |

The simulator binaries are assets of the GitHub release [`redteam-pack-91be12e`](https://github.com/transitfabric/releases/releases/tag/redteam-pack-91be12e), a pre-release. Download them and check the `SHA256SUMS` file before you run anything.

## What is in scope

The scope, the out-of-scope items and the reward tiers are on the [bounty page](../bounty.html). In short: the released software, the incentive mechanism as it runs on subnet 611, and the design documents. Testnet only. Never use mainnet keys or real TAO.

## Open and accepted threat-model items

The threat model lists attacks we already know about. Items marked open or accepted are known: they earn credit only if you show a new exploit path or a bigger payoff. Items marked mitigated are fair game: if you break a mitigation, that is a finding. There are 66 open and 5 accepted items in the threat model at this commit.

| Item | Status | What |
|---|---|---|
| [T38](threat-model.html#T38) | open | Nothing fills ProbeResultBatch.endpoints in the daemon yet, so in production no node has an underlay |
| [T39](threat-model.html#T39) | open | Nothing fills ProbeResultBatch.endpoints in the daemon yet, so in production no node has an underlay |
| [T41](threat-model.html#T41) | open | Rented burst capacity |
| [T42](threat-model.html#T42) | open | Team-test manipulation |
| [T46](threat-model.html#T46) | open | SRG griefing |
| [T47](threat-model.html#T47) | accepted | Inherited carrier diversity |
| [T58](threat-model.html#T58) | accepted | Signed-input capture |
| [T60](threat-model.html#T60) | open | Equivocating quorum |
| [T62](threat-model.html#T62) | open | Stale evidence re-signed |
| [T67](threat-model.html#T67) | open | Sample favouring and blame by omission |
| [T68](threat-model.html#T68) | open | Forged digests and spoofed sources |
| [T69](threat-model.html#T69) | open | False reports |
| [T70](threat-model.html#T70) | open | The reveal names no egress |
| [T71](threat-model.html#T71) | open | Omission and withholding blame the hop behind |
| [T72](threat-model.html#T72) | open | The egress knows every key |
| [T73](threat-model.html#T73) | open | The two ends have a veto |
| [T74](threat-model.html#T74) | open | Determinism |
| [T78](threat-model.html#T78) | open | Another process of the same user reaches the agent's control socket or its keychain entry and acts a |
| [T79](threat-model.html#T79) | open | The owner is tricked into importing a hotkey, or a coldkey, into the agent |
| [T80](threat-model.html#T80) | open | The binding request is altered between export and signing, binding the node key to another hotkey |
| [T82](threat-model.html#T82) | open | Underlay ambiguity grief |
| [T87](threat-model.html#T87) | open | Anchoring jump |
| [T89](threat-model.html#T89) | accepted | State tampering |
| [T90](threat-model.html#T90) | open | Forged agreed underlay |
| [T94](threat-model.html#T94) | open | A node gives its probe sessions priority over real traffic, and looks better to vantage |
| [T105](threat-model.html#T105) | open | Test target not bound to the endpoint |
| [T107](threat-model.html#T107) | open | Cohort ceilings and chunk steering |
| [T113](threat-model.html#T113) | open | (a) A late-queue node started at its last chance with three on 31-62% of tests, so T42's one-collude |
| [T116](threat-model.html#T116) | open | (a) Cohort credit is kept for 8 history entries, but a cohort falls due about once per 2.5 windows,  |
| [T123](threat-model.html#T123) | open | Restore crash loop |
| [T125](threat-model.html#T125) | open | A co-located group's pool is the max over its chunk cohorts of each cohort's lower median of few sam |
| [T126](threat-model.html#T126) | open | (a) Rider keys split across many UIDs get one front cohort turn per UID, charged to the fleet too |
| [T130](threat-model.html#T130) | open | Latch split brain |
| [T131](threat-model.html#T131) | open | Hop receipts from real counters and background from receipt runs |
| [T135](threat-model.html#T135) | open | Same-block clone griefing |
| [T140](threat-model.html#T140) | open | Perturbed production leech |
| [T143](threat-model.html#T143) | open | Damping shadows a node from validators |
| [T144](threat-model.html#T144) | open | Damage spreads past the flapping link |
| [T145](threat-model.html#T145) | open | Public canary pairs |
| [T146](threat-model.html#T146) | open | A validator's plan is secret from nodes, not from the validator |
| [T147](threat-model.html#T147) | open | Splitting above the canary weight cap |
| [T148](threat-model.html#T148) | open | Canary packet shape |
| [T153](threat-model.html#T153) | open | Mechanism 0 credits transit on current_prod_table, not the table as updated |
| [T157](threat-model.html#T157) | open | Validators holding more than a third of stake can withhold attestations and stop updates |
| [T200](threat-model.html#T200) | open | The participation controller ratchets |
| [T201](threat-model.html#T201) | open | Quality drag on the controller |
| [T202](threat-model.html#T202) | open | A teammate's zero report |
| [T203](threat-model.html#T203) | accepted | The own-fleet rule avoided with a second coldkey |
| [T204](threat-model.html#T204) | open | k depends on the full history |
| [T205](threat-model.html#T205) | open | Too few independent recorders |
| [T165](threat-model.html#T165) | open | Peer-load collusion |
| [T167](threat-model.html#T167) | open | Hidden slices identified |
| [T169](threat-model.html#T169) | open | Peer pool and duty |
| [T170](threat-model.html#T170) | open | usable over-credits |
| [T171](threat-model.html#T171) | open | Long burst credits |
| [T172](threat-model.html#T172) | open | The coordinator leaks |
| [T173](threat-model.html#T173) | open | Flood framing |
| [T217](threat-model.html#T217) | open | Hidden-slice tells and relay drops |
| [T187](threat-model.html#T187) | open | Validator site collusion |
| [T189](threat-model.html#T189) | open | Unusable capacity paid at a scarce price |
| [T190](threat-model.html#T190) | open | Herding: every operator moves to the same scarce region at once, on the same price map, and prices o |
| [T193](threat-model.html#T193) | open | Burst-rented capacity in a scarce region |
| [T195](threat-model.html#T195) | open | Atlas anchor forgery |
| [T197](threat-model.html#T197) | open | Carry abuse |
| [T221](threat-model.html#T221) | open | Version split |
| [T226](threat-model.html#T226) | open | ASN grinding and churn by recommit |
| [T257](threat-model.html#T257) | open | Placement steering |
| [T259](threat-model.html#T259) | open | Allocation starvation |
| [T230](threat-model.html#T230) | open | Selective serving |
| [T264](threat-model.html#T264) | open | A validator feeds a solver a forged snapshot |
| [T300](threat-model.html#T300) | accepted | Unmatched probe sessions feed batches |

## How to file

1. Reproduce it against a named version. Points need a reproduction.
2. Check the threat model above and [known limits](../known-limits.html). The first valid report wins, and duplicates are closed with no points.
3. Use the [finding template](FINDING.md). A bug goes in through the "Finding" Issue form. A security finding or exploit goes in privately, through the advisory or its API. Large artifacts go in as a zip attachment.
