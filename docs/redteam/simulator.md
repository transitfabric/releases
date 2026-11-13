# The simulator, and how to reproduce a finding in it

`bwos-sim` is the incentive simulator we use to test the scoring rules against rational, adversarial operators. This page covers what you can download, how to run it, how to read its output and how to turn a finding into a simulator scenario. It was built from source commit `91be12e`, the same commit as the specs in this pack.

## Download and check

The files are assets of the GitHub pre-release [`redteam-pack-91be12e`](https://github.com/transitfabric/releases/releases/tag/redteam-pack-91be12e):

| File | What |
|---|---|
| `bwos-sim-linux-x86_64` | Static binary (musl), Linux x86_64 |
| `bwos-sim-linux-aarch64` | Static binary (musl), Linux aarch64 |
| `sim_50_windows.csv`, `sim_50_windows.svg`, `sim_50_windows.txt` | The sample output of `make sim`: the 50-window CSV, the chart, and the console report |
| `SHA256SUMS` | Checksums of all of the above |

There are no builds for macOS or Windows. On those, run it in a Linux container or VM.

```sh
mkdir bwos-sim-pack && cd bwos-sim-pack
gh release download redteam-pack-91be12e --repo transitfabric/releases
# or download each file from the release page by hand
sha256sum -c SHA256SUMS            # every line must say OK; stop if one does not
chmod +x bwos-sim-linux-x86_64     # use the -aarch64 file on an ARM machine
```

The release is not signed yet, so also compare the hash of `SHA256SUMS` with the one in our announcement.

## Run it

`bwos-sim` has four options. `--help` isn't recognised: any unknown argument prints the usage line and exits with status 2.

```
usage: bwos-sim [--windows N] [--csv path.csv] [--chart path.svg] [--flood]
```

- `--windows N`: how many windows to simulate, 1 to 100000. The default is 50.
- `--csv path.csv`: write the per-window report.
- `--chart path.svg`: write the per-window chart.
- `--flood`: run only the schedule-flood scenarios in full (the worst of 3 seeds over 4 windows). It prints a line per scenario and exits 1 if a bound fails. It is slow: allow a good while.

`make sim` in the source repository runs exactly this, and the sample output in the release comes from it:

```sh
./bwos-sim-linux-x86_64 --windows 50 --csv out.csv --chart out.svg
```

It has no randomness and reads no input, so the same binary gives the same bytes. Compare your `out.csv` with the release's `sim_50_windows.csv` to check your run. The run takes a few minutes: it prints the strategy table, then runs every adversarial scenario one after another.

## Read the output

The console report has two parts.

**1. Strategies.** The simulator runs a fixed population for the windows you asked for:

- 8 honest operators, 1000 Mbps each, declaring what they have;
- an overclaimer, declaring twice its real 1000 Mbps;
- a sybil splitter, one 1000 Mbps box split across 3 UIDs;
- a canary-only operator, which serves probes perfectly and drops 80% of paid traffic;
- a self-dealer, generating 1000 Mbps of its own traffic.

Utilisation rises over the run from 30% to 100%. For each kind of strategy, the table prints its **earnings per real Mbps relative to an honest operator**. Honest is 1.00x by definition. A strategy that prints above 1.00x beats honest play, and that is an exploit. In the release's sample:

```
strategy         earnings per real Mbps vs honest
canary_only        0.03x
honest             1.00x
overclaimer        0.80x
self_dealer        0.30x
sybil_splitter     0.80x
```

**2. Adversarial scenarios.** After the table comes one line per scenario:

```
adversarial scenario     bound  detail
dust_cap_harvester       ok     dust usage share 6 ppm (raw 3 ppm); dust mech0 share 3 ppm
```

Each scenario has an attacker payoff and a bound the payoff must not exceed. The `bound` column says:

| Verdict | Meaning |
|---|---|
| `ok` | The payoff is within the bound. |
| `FAIL` | The payoff exceeds the bound. `bwos-sim` exits with status 1. This is what a finding looks like. |
| `model` | A model-only scenario (not scored yet). It reports a bound and gates nothing. |
| `over` | A model-only scenario whose payoff is over its bound. Known, and listed in the threat model. |

The `detail` text says what was measured, in ppm (parts per million) or as a ratio to honest. The release sample has 220 scenarios: 204 `ok`, 6 `model`, 10 `over` and no `FAIL`. The name of a scenario matches the "Sim / Unit test" column of the [threat model](threat-model.html).

**The CSV** has one row per window. The columns are `window`, `alpha_ppm` (the weight of capacity against usage in Mechanism 0 pay for that window; the run lowers it from 750000 to 550000), `utilization_ppm` (30% rising to 100%), then for each of the five strategies its `*_share_ppm` (its share of the pool, out of 1,000,000) and its `*_ratio_vs_honest` (earnings per real Mbps against honest). To check an exploit over time, look at the `*_ratio_vs_honest` columns: a ratio at or above 1 is a problem.

**The SVG** is a stacked chart, "Total Pool Score Share by Agent Type (%)", one band per strategy across the windows. Open it in a browser. A band that grows against its real capacity is the picture of an exploit.

## Write a new adversarial scenario

Here is the plain situation: the scenarios are compiled into the binary, and the source isn't public yet. You can't add one yourself today. What you can do is describe it precisely, and we will add it, run it and tell you the numbers. A good description is also the best reproduction for a finding that has no testnet demonstration. Put it in the "Simulator scenario" section of the [finding template](FINDING.md), with these parts:

1. **Population.** The simulator's agents have these fields: `uid`; `kind`; `true_mbps` (what the node really has); `declared_mbps` (what it claims); `group` (agents in one group are one box or one operator, as in a sybil split); `drop_paid_ppm` (how much paid traffic it drops, in ppm); `self_deal_mbps` (traffic it generates for itself); and `canary_exempt` (it recognises probes and serves them perfectly). Say how many honest agents there are and what the attacker's agents look like, using those fields. The attacks the simulator models today map onto them: overclaiming (`declared_mbps` above `true_mbps`), sybil splitting (several UIDs in one `group`), canary-only service (`drop_paid_ppm` with `canary_exempt`), self-dealing (`self_deal_mbps`).
2. **The behaviour.** What the attacker does that an honest operator doesn't, and in which windows. If it depends on a rule in a spec, cite the section of the [scoring](scoring.html) or [measurement](measurement.html) spec.
3. **The payoff.** One number that shows the gain: earnings per real Mbps relative to honest, or a share in ppm, with the honest baseline beside it.
4. **The bound.** What you think should hold, and why. For most scenarios it is "no better than honest", 1.00x.
5. **A prediction.** The number you expect the existing simulator, or the spec's arithmetic, to give. Work it out by hand from the parameter table in the scoring spec if you can.

If your scenario is a variation of one the binary already runs, run the binary, find that scenario's line in the report, and say how yours differs and why the existing bound doesn't cover it. Quote the line.

A finding with a scenario in this form earns the +25% for a working reproduction once we have confirmed it. If we can't reproduce it, it is closed with no points.
