# Run a shadow validator on testnet

A shadow validator checks our validators' arithmetic. Every window it recomputes the weights from public, committed data, with the same code path `bwos-validator live` uses, and compares them byte for byte with the weights each validator revealed on chain. If they differ, scoring isn't deterministic (Invariant 1 in the source repository's `AGENTS.md`), and that is a bug we pay for.

A shadow is a spectator. It holds only a throwaway in-memory key that can't sign for any registered hotkey. It never writes to the chain, serves nothing and probes nothing, so it never counts as a validator. You need a Linux machine that stays up and two testnet RPC endpoints. You don't need a wallet, a UID or any TAO.

## What it does and doesn't do

Each window `w`, the shadow:

1. Reads the chain at the same fixed blocks as `live` (`A(w)`, `S(w)`, `D(w)`, the path-probe draw at `S + 36`), from **two named read sources**. Every fixed-block read is taken from both by block hash. If they disagree, the shadow abstains, as a validator would (ADR-0078 R3-4, R3-6).
2. Fetches the committed objects (manifests, probe batches, attestation records, bindings, declarations, route tables) from each committer's own store, at the axon on chain, and from any `--peer-validators` you name. It only sends `GET` requests, and backs off for twice as long as a validator does.
3. Scores `w` once window `w + 1` has begun, through `Live::score_window_as`, the same function `live` runs. It keeps the weights `live` would have submitted instead of sending them.
4. Watches every block for `SubtensorModule::TimelockedWeightsRevealed` events on the subnet. For each one it finds the commit the block revealed: the hotkey's `TimelockedWeightCommits` entry that the block removed. That commit's block names the window, because a validator commits window `w`'s weights in `w + 1`. The shadow then reads the revealed row from `Weights` at that block. These reads also come from both sources.
5. Compares the rows and closes the window's record at `S(w + 3) + 10`, after every reveal has landed. On 611 on 2026-11-17, validators committed window `w` at about `S(w + 1) + 24`. The chain revealed the commit either in the next block or at about `S(w + 2) + 24`, one tempo later. Either way it lands well before the record closes.

What it never does is enforced in its code and covered by its tests:

- **No usable keys.** It refuses `--hotkey`, `--wallet`, `--wallet-name`, `--wallet-hotkey`, `--coldkey` and `--attestation-key`. It holds only a throwaway in-memory key that can't sign for any registered hotkey. The key fills the live loop's own-identity slots, and is never saved and never handed to the chain client.
- **No chain writes.** The shadow's chain client has no signer at all. A wrapper in front of it keeps the weights that scoring would submit and refuses every other write (commitment, axon).
- **Nothing served or published.** It runs no object store listener, publisher or axon, and makes no `PUT`. It refuses `--listen` and `--axon`.
- **No probing.** It runs no probe agent, plan, pool, fault or geo input, and makes no evidence commitment. It refuses those flags.

**You can't run a shadow on a permit-holding hotkey.** The shadow takes no hotkey, and its chain client can't sign, so it can't create a validator permit, a commitment, an axon or a weight row. It doesn't appear in the metagraph, the validator set, the stats API or any validator's list, so it doesn't count as a validator anywhere. To validate, run `bwos-validator live` with your own hotkey. That is a different job.

## Install from the tester release

The tester release has `bwos-validator-<v>-linux-<arch>` (x86_64 and aarch64), a static binary. Check the download as for every path ([quick start](../quickstart.html), step 2):

```bash
sha256sum -c --ignore-missing SHA256SUMS
chmod +x bwos-validator-<v>-linux-<arch>
./bwos-validator-<v>-linux-<arch> --version
```

It is in every tester release from v0.1.0-tester.4.1 on ([releases](https://github.com/transitfabric/releases/releases)).

## The two read sources

A shadow needs two independent testnet RPC endpoints:

- **`--chain-endpoint <url>`**: the first source. It is used for the head and for the reads that aren't pinned to a block.
- **`--second-read-source <url>`**: the second. Repeat the flag for more.

On testnet, use the same pair our validators use (the release's `network.json` lists them as `chain_endpoints`):

- `wss://test.finney.opentensor.ai:443`, the public archive node;
- `wss://rpc-test.transitfabric.xyz`, the fleet's lite node, which keeps 50,000 blocks of state.

**The fleet's node has a gap in its history.** It was warp-synced, so it holds no blocks below 8,453,375. A fresh shadow, like a fresh validator, reads back through its lookback, and on 611 today that reaches below that block. The shadow reads through the same code as `live` (`RpcReads`, ADR-0078), including H8's bounded testnet deep-read exception. A read below block 8,453,375 that the public archive serves, and the fleet's node provably can't, is taken from the archive alone. The shadow logs it as a `single_source_deep_read` event. The exception ended once the fleet node's head passed block 8,513,640 (2026-11-24). Every read is two-source again. A shadow started now, whose lookback still reaches into the gap, retries those reads until the gap leaves its lookback, at about block 8,530,060 (2026-11-26). Until then, run it with the public archive as both sources. If you run your own node as one of the two sources, sync it with full history (`--sync full`, or archive) so it covers the lookback.

Better still, make one of them your own subtensor testnet node. That makes the two-source check independent of us. Each endpoint passes the network's endpoint and genesis checks before anything is read, so a mainnet endpoint is refused whatever its URL says. `--network` takes `test` or `local` only.

## Run it

```bash
./bwos-validator-<v>-linux-<arch> shadow \
  --network test --netuid 611 \
  --state-dir ~/bwos-shadow \
  --chain-endpoint wss://test.finney.opentensor.ai:443 \
  --second-read-source wss://rpc-test.transitfabric.xyz \
  --peer-validators "$(jq -r '.validator_urls | join(",")' network.json)" \
  --first-party-hotkey 5Hga9xxu3F41axn4Lq47GeEZ1AWpBfXJ6CWqopZeDcHQN6Dz \
  --miss-allowlist "$(jq -r '[.validators[].hotkey] | join(",")' validator-set.json)"
```

`network.json` and `validator-set.json` come with the tester release. If the release's `network.json` has `chain_endpoints`, you can use them as the two read sources. The first-party hotkey above is the one the 611 fleet pins (`BWOS_TN_FIRST_PARTY_HOTKEY` in the fleet's configuration). If a release note names another, use that one.

`bwos-validator live --shadow <the same flags>` does the same thing.

| Flag | Default | What it does |
|---|---|---|
| `--network local\|test` | required | Anything else, `finney` included, is refused. |
| `--netuid <n>` | required | 611 on testnet. |
| `--state-dir <dir>` | required | The shadow's own directory. A directory that holds a validator's state is refused. |
| `--chain-endpoint <url>` | required | The first read source. On `local`, a loopback `ws://` URL. |
| `--second-read-source <url>` | required | The second read source. Repeat it for more. |
| `--peer-validators <url,...>` | none | Extra stores to fetch committed objects from, besides each committer's axon (`validator_urls` in `network.json`). Fetches only. |
| `--first-party-hotkey <ss58>` | none | The first party our validators pin for Mechanism 1. It must match theirs, or Mechanism 1 differs. |
| `--miss-allowlist <ss58,...>` | none | The validator hotkeys whose missing inputs gate ADR-0078 1b, as our validators pass it. |
| `--windows <n>` | forever | Stop after scoring `n` windows. |
| `--scoring-v1-block <block>` | shipped | `local` only, as for `live`. |

Run it under systemd or `tmux`. It logs to stderr. Give it a few windows. The first window it scores is the last one that finished before it started: a shadow started in window `w` scores `w - 1` once `w` is 10 blocks old.

## Reading the results

Every window gets one log line. It gives the window's status, which is the worse of its two mechanisms' statuses, and each mechanism's own status:

```text
bwos-validator shadow: window 4821: MATCH validators=4 mech0=MATCH mech1=MATCH inputs=3f9a0c1d2e4b5a69
bwos-validator shadow: window 4822: MISMATCH uid=3 mech=1 first_diff=#0 shadow uid 2:65535 chain uid 5:65535 (lengths 1/1) (1 of 4 differ) (mech0=MATCH mech1=MISMATCH)
bwos-validator shadow: window 4823: MISMATCH_INPUTS_INCOMPLETE uid=3 mech=0 first_diff=#5 ... ; uncommitted inputs the shadow never has: receipt batches ... (mech0=MISMATCH_INPUTS_INCOMPLETE mech1=MATCH)
bwos-validator shadow: window 4824: ABSTAIN reason=not scored: read A(4824) at block 1736650: read sources disagree: ...
```

Each window also gets a record, `<state-dir>/shadow/<window>.json`:

```json
{
  "window": 4822,
  "inputs_hash": "<sha256 of the TempoInput the shadow scored>",
  "computed": {"mech0": [[17, 40211], ...], "mech1": [[2, 65535]]},
  "validators": [
    {"uid": 3, "hotkey_short": "5Fh3x9…Qk2w", "mech": 1, "match": false,
     "diff_summary": "#0 shadow uid 2:65535 chain uid 5:65535 (lengths 1/1)", "reveal_block": 1736190}
  ],
  "uncommitted_inputs": ["receipt batches (...; OQ-393)"],
  "warmup": false,
  "mechs": {"mech0": {"status": "MATCH"}, "mech1": {"status": "MISMATCH", "reason": "uid=3 mech=1 ..."}},
  "status": "MISMATCH",
  "final": true
}
```

The record can also hold these fields:

- `abstained_reason`, when the whole window isn't compared;
- `held_back`, the mechanisms the shadow set no weights for, why, and whether the reason is the shadow's own (`shadow_only`);
- `missing_inputs`, committed inputs it scored without;
- `uncommitted_inputs`, inputs the validators may have had that the shadow never can;
- `unchecked`, revealed rows it didn't compare.

Each mechanism is judged on its own, so a missing input on one never hides the other's verdict.

- **MATCH.** Every revealed row for the mechanism equals the shadow's, byte for byte.
- **MISMATCH.** A validator's revealed row differs from the shadow's, and nothing was missing from the shadow's inputs. The line names the first differing check. This includes a validator that revealed a row in a window where the scoring itself sets none, for example when `submittable_mechanisms` refuses unassigned weight. Every honest validator reaches the same refusal, so that row is a difference.
- **MISMATCH_INPUTS_INCOMPLETE.** A row differs, but the shadow may have lacked an input the validators had. Any one of these is enough:
  - a committed input it couldn't fetch;
  - for Mechanism 0, receipt batches;
  - its warm-up.

  It is never bounty-eligible on its own. It is still worth a look if it repeats with complete-looking inputs.
- **ABSTAIN.** The shadow makes no claim for the mechanism or the window. That happens when:
  - its two read sources disagreed, or a read failed after its retry window;
  - `live` would have computed nothing for the window (a catch-up pass, or a window that passed while it scored);
  - the shadow held the mechanism back for its own reason (a missed path-probe draw, a carry gap, an abstained window);
  - no reveal for the mechanism was seen.

  The same rules make a validator abstain.
- **`[warm-up]`.** The windows a fresh shadow scores first: at least three (`SHADOW_WARMUP_WINDOWS`), and up to the end of the capacity-declaration cooldown epoch it started in (`CAP_CHANGE_WINDOWS`, 24 windows, about 29 hours), unless it started on an epoch's first window. The shadow's carried state starts empty: last window's metrics, capacity and failure history, the declaration epoch and the incumbent solver. The validators' was carried from when each of them started. Until carried state can be resynced from state the validators attest (ADR-0078 1b-iii), a difference in a warm-up window is `MISMATCH_INPUTS_INCOMPLETE`. Keep the shadow's state directory between restarts. A restart catches up like `live`, doesn't start a new warm-up, and resumes reading reveals from the last block it read (`shadow/meta.json`).

### Receipts are an uncommitted input (OQ-393)

Nodes upload receipt batches straight to each validator's store, and each validator scores the batches it received. No manifest or commitment names them, and no store lists them, so a shadow never has them. Two honest validators can also score different receipt sets.

Receipts feed only Mechanism 0. So in any window whose snapshot has live nodes, which could upload receipts, a Mechanism 0 difference is `MISMATCH_INPUTS_INCOMPLETE`, never `MISMATCH`. Mechanism 1 has no uncommitted input, and its differences are findings. How to make receipts a committed input is OQ-393.

## The report

```bash
./bwos-validator-<v>-linux-<arch> shadow-report --state-dir ~/bwos-shadow --last 20
```

The report prints:

- the version;
- a table: window, status, warm-up, checks, differing checks, input hash and the verdict line;
- the number of `MISMATCH` windows;
- the records as JSON for a bug report.

It holds no IP address, URL or host name. The shadow strips them from every reason it records, and the report strips them again.

**Share only the `shadow-report` output.** Don't paste the shadow's raw log or files from its state directory. They can hold endpoint names and fetch errors that name hosts.

## File a mismatch

A **`MISMATCH`** is a determinism finding and is bounty-eligible ([bounty page](../bounty.html)). `MISMATCH_INPUTS_INCOMPLETE` and `ABSTAIN` aren't.

1. Register once on the [claim page](https://transitfabric.xyz/claim.html) if you haven't.
2. Send it through the [signed finding form](https://submit.transitfabric.xyz/finding). Name the release tag (`bwos-validator --version`), claim your tier, and paste the `shadow-report` output for the window and the two windows around it.
3. Add how long the shadow had been running, and whether other validators matched in the same window. A window where some validators match the shadow and one doesn't points at that validator. A window where all validators agree with each other and not with the shadow points at the shadow's own inputs or code.
4. Never send a private key, a seed phrase or a wallet file. The shadow holds none worth sending.

## Load on the read sources

The shadow is polite to the RPC endpoints:

- It reads the head about every 6 s on `test`.
- It caches each block's hash per source.
- It reads `LastUpdate` once a window.
- It waits 1 to 3 s, with jitter, before it reconnects a dropped source.
- It retries a rate limit (HTTP 429, "too many requests") with backoff.

Reading reveals costs a few calls a block per source.

## Known limits

- **Carried state starts empty.** See warm-up above. A shadow that has been running alongside the validators since a window they all started from is the strongest witness.
- **Kept validator sets are built once (ADR-0078 1d).** A record the shadow fetched later than a validator did can leave a member out of its set for that window, and the weights then differ. The shadow logs `set_member_dropped` events when this happens. Treat a mismatch that follows one as doubtful.
- **Path-probe draws.** If the shadow misses a window's draw (`S + 36` to `S + 48`), it holds Mechanism 1 back for that window, as a validator would. That is a shadow-only reason, so those rows are listed in `unchecked`, not compared.
- **Restarts and path-probe draws.** From tester.5.2 a shadow keeps each window's draw on disk under `<state-dir>/draws/`. A restart after the `S + 36` to `S + 48` draw puts it back, so the shadow carries the same state as one that never restarted. A shadow that is down during the draw still misses it. Restart a shadow only right after a window has been scored and before block 36 of the next one.
- **Receipts.** See OQ-393 above.
