# Testnet rewards: rules

> **Final, version 2.2, effective 2026-11-21.** The rules were proposed on 14 November 2026 and open for feedback until 17 November, 12:00 UTC. What changed since the proposal is listed under [What changed from the proposal](#what-changed-from-the-proposal-2026-11-14). Any later change follows the [Changes](#changes) rules.
>
> **Questions, or a case these rules don't cover:**
> - open a [Testnet rules feedback](https://github.com/transitfabric/releases/issues/new?template=rules-feedback.yml) Issue; or
> - upload a note to the [findings sandbox](https://submit.transitfabric.xyz) if you have no GitHub account.

**Rules, version 2.2** (2.2, 2026-11-21: adds the fleet-outage void windows under Fairness rules; it only raises credit. 2.1, 2026-11-17: adds the owner-forwarder measurement correction; it only raises credit). This page is the only place that says what testnet work may earn. Other pages link here and don't restate it.

## In short

- **What you get.** Testnet work earns credit, and we intend to convert the credit to a discretionary reward of Transit Fabric **alpha on mainnet**. Every number, formula, split and schedule on this page is how we currently intend to size any discretionary reward; not a promise or entitlement. It is not paid in TAO, in dollars or in testnet alpha. Testnet alpha has no value.
- **How much.** It's meant to be modest: an average active node operator's share is worth about **one mainnet registration**, so you can start on mainnet.
- **What it rewards.** It rewards what the testnet has too little of: honest, live sites in new networks and environments, such as a router at home or a node behind NAT. Capacity above a small floor earns nothing extra.
- **What it is.** We intend to make these allocations if mainnet launches. They are discretionary rewards, not a contract or a debt: see [What an allocation is](#what-an-allocation-is). If mainnet doesn't launch, no allocation follows, and the ledger stays public.
- **When it counts.**
  - Credit counts from the **tester.2 release (12 November 2026) until mainnet starts**.
  - Enrolment never closes. Joining late only costs you the weeks you missed.

## What an allocation is

- **A discretionary reward.** Any allocation, point or tip under these rules is a discretionary reward, given at our sole discretion. No entitlement or claim arises, and no contract is formed, from points, a registration, a ledger, or any schedule, formula or example on this page. This page describes how we intend to exercise that discretion.
- **Not guaranteed.** We may withhold, reduce, delay or cancel any allocation, including for legal, sanctions or compliance reasons, or if we can't confirm the recipient may lawfully receive it.
- **Only where lawful.** Allocations go only to people legally able to receive them where they live and under applicable sanctions. The recipient is solely responsible for any taxes and reporting.
- **No warranty** about value, transferability or tax treatment.
- **Network emissions are separate.** Emissions on the subnet are distributed by the Bittensor protocol, under its own consensus, from validators' weights. We don't pay, hold or guarantee them.
- These rules are part of the [Terms of Service](terms.html).

## The pool

*How we currently intend to size any discretionary reward; not a promise or entitlement.*

- **Size.** The pool is two mainnet registrations for every eligible node operator, so the node half averages one registration each.
  - It is capped at the alpha the subnet owner receives in mainnet's first 14 days.
  - If the formula comes to more than the cap, every share is scaled down by the same factor.
- **What "one registration" is worth.** It's the subnet's mainnet registration price in TAO, including the part the chain locks as collateral, converted to alpha at the subnet's price.
  - Both numbers are the median over the first 24 hours after mainnet starts, so the rush of registrations at launch doesn't set the price.
- **Eligible node operator.** A claimant who held base (below) on at least one site for at least one week by mainnet start.

| Track | Share of the pool | Rewards |
|---|---|---|
| Nodes | 50% | Sites that stay up, declare honestly and are peered, weighted toward the networks and environments the testnet lacks |
| Findings | 30% | Valid findings, by the tiers in the [bounty page](bounty.html) |
| Solvers | 10% | Route tables that beat the reference solver |
| Docs and onboarding | 10% | Merged fixes, and first onboarding reports from a new environment |

A track's unspent share moves to the node track.

## Who can earn

- **Claimants.** A claimant is one person or team, registered once on the [claim page](claim.html). You list your testnet hotkeys by signing one message with each. Signing a hotkey on the claim page is coming; your points count from tester.2 whenever you add it. Allocations go to your claim address.
- **Age and attestation.** You must be **18 or older, or the age of majority where you live, whichever is higher**. The claim message you sign says so and accepts the [Terms](terms.html) and [Privacy Policy](privacy.html). Allocations go **only to attested registrants**. If you registered before 17 November 2026, your registration and points are kept, but sign again on the claim page to stay eligible.
- **At most 3 UIDs per claimant.** For example, one for a single node, one for an OpenWrt router and one for a fleet. One UID can hold all three. A fourth UID, or a UID nobody has claimed, earns nothing. Testnet has only 128 seats.
- **Credit follows the claimant, not the UID.** Losing a UID to pruning, re-registering or changing hotkeys never erases points you've earned.
- **Who doesn't earn.**
  - Nodes run by the team, or by anyone the project pays, earn nothing from the pool.
  - Anyone with access to the project's private source can't earn from the findings track.
  - Someone paid for a specific piece of work, such as a commissioned audit, earns node points like any operator. The paid work itself isn't a finding.

## Node points

*How we currently intend to size any discretionary reward; not a promise or entitlement.*

Points are counted per **site** each week (140 windows), then summed per claimant. A site is a group of one claimant's nodes whose probed endpoints share an IPv4 /24. Every input comes from what validators already commit each window.

### Base: 10 points per site a week

A site holds base for the week when all four of these hold:
- **Uptime.** It was up in at least 90% of the week's non-void windows. From 50% to 90%, it earns 5 points instead.
- **A capacity test.** It passed at least one capacity test, verified at 20 Mb/s or more, or 5 Mb/s for a router or a node behind NAT.
  - A site counts only with a live binding and consent, a fresh signed declaration, and a BGP session to another UID's node.
- **Honest declarations.** In no window was its verified capacity under half of what it declared. Verified capacity here is the figure after any measurement correction (Fairness rules, "Measurement corrections").
- **A current release.** It ran the current release, or the previous one for at most 48 hours after a new one. This counts only once it is measured: nodes report a signed version that validators publish per node and window. Until then base points don't depend on the release, and the fast-upgrade role isn't scored. The reported version is self-declared, so it counts for testnet points only, never for scoring or emissions.

### Diversity: up to 6 points per site

```
D = 6 / n_asn
```

- `n_asn` counts all sites holding base that week in the same origin ASN, the team's included.
- The only site in its ASN earns 6. The tenth site at one provider earns 0.6.
- The formula needs no table, however large the network grows.
- **Country isn't used yet.** Validators can't commit a node's country today, and a location a node declares can be faked for free.
  - A country term, `6 / n_country`, comes only with a measured location signal under its own ADR.
  - Like any change, it is announced 7 days before it applies.

### Environment: one bonus per site, the highest that applies

| Environment | Points |
|---|---|
| OpenWrt router on the supported image | 15 |
| Node on a home or mobile line behind NAT | 8 |
| Another platform we list as wanted (for example an ARM board or a new OpenWrt target) | 5 |
| Datacenter VM | 0 |

- **Why these bonuses.** The home, NAT and router bonuses reward early testnet coverage and engagement. They taper as those sites reach their targets, and mainnet favours datacenter capacity.
- **How the bonus scales.** The first 10 sites of a kind in a week get the bonus in full. Beyond that, each gets it scaled by 10 / n.
- **Evidence for a router:**
  - the `ubus call system board` output;
  - a photo showing the claim ID;
  - one live check on request.
- **NAT and a home line** are read from the validators' own data: the node dialled out, and the ASN's type.
- **Router nodes aren't measured yet** ([Known limits](known-limits.html)). The router package has no probe sessions, so validators can't test a router or credit it. Router points, base included, count from the release that adds router measurement. We're building it before the bounty opens.

### Roles: added to the site

| Role | Points a week | Condition |
|---|---|---|
| Open peer | 4 | Peered with nodes of at least 2 other claimants during their first 14 days |
| Fast upgrade | 3 | On a new release within 24 hours of its announcement (scored only once versions are measured; see "A current release") |

A data-server role comes with phase F. Solvers have their own track.

### Fleet: per claimant

| Fleet | Points |
|---|---|
| One hotkey binding 3 or more sites in at least 2 ASNs, all holding base | 10 a week |
| The first working binding of more than 7 nodes under one hotkey | 30, once |

### Duplication

- **One /24 counts once.** A second node in the same /24 earns nothing, whichever UID or claimant it belongs to.
- **Points are per site, not per key.** Three UIDs on one machine earn what one UID earns.
- **Limits per claimant.** One claimant earns base on at most:
  - one single-node site;
  - one router site;
  - 5 fleet sites;
  - and no more than 2 sites in one ASN.

  Further sites earn nothing.
- **Merged claims.** Claims found to have one operator behind them are merged, and the week in which that was hidden earns nothing.
- **Idle UIDs.** A UID with no site holding base for 14 days is listed as idle, and we ask its claimant to release it. While it is listed, the claimant earns no fleet points.

### A week, worked through

| Site or claimant | Base | Diversity | Environment | Roles | Fleet | Total |
|---|---|---|---|---|---|---|
| VM, 5 sites at its provider | 10 | 1.2 | 0 | | | 11.2 |
| VM, the only site in its ASN, open peer | 10 | 6 | 0 | 4 | | 20 |
| OpenWrt router at home, alone in its ASN | 10 | 6 | 15 | | | 31 |
| Fleet of 3 VMs in 3 ASNs (1, 2 and 6 sites each) | 30 | 6 + 3 + 1 | 0 | | 10 | 50 |

Capacity above the base floor appears nowhere. A home router earns almost 3 times a VM at a crowded provider.

## How points become alpha

*How we currently intend to size any discretionary reward; not a promise or entitlement.*

```
claimant's alpha = track pool × claimant's points / all points in that track
```

- **Counted once.** Points are summed over the whole program and counted once, at the block mainnet starts. There are no weekly slices.
- **Separate tracks.** Each track has its own pool, so a point for a finding never competes with a point for a week of uptime.
- **The ceiling.** One claimant receives at most **15% of a track**.
  - What is above the ceiling is shared among the others in proportion to their points.
  - If nobody in the track is under the ceiling, it moves to the node track.
- **The ledger.** It shows running totals every week. What a point is worth is known only at the end, because it depends on everyone's points.
- **Example.** 40 claimants hold 30,000 node points together. A claimant with 900 receives 3% of the node pool.

## Solvers, findings, docs

*How we currently intend to size any discretionary reward; not a promise or entitlement.*

- **Solvers.** You earn 1 point for each window your table is fetched on time and graded at least 2% better than the reference, plus 1 point for the best table of the window.
- **Findings.**
  - Points use the [bounty page](bounty.html) tiers. The public bug bounty is not open yet; public bounty points start only on the announced opening date. Private bug and security reports are welcome now, and any pre-opening credit is strictly discretionary.
  - The first valid private report of an exploit earns its tier, even if your own nodes profited from it first. Only that profit is removed.
- **Docs and onboarding.** Each of these earns 5 points:
  - a merged doc fix;
  - a merged fix to the agent skill;
  - the first full onboarding report from an environment we haven't covered yet, with `bwos doctor --json` output.

## Fairness rules

- **Void windows.** If fewer than three of the four validators set weights, or a team-side outage or release defect kept nodes from being measured, the window is void for everyone.
  - A void window counts as up for the uptime test, and nobody's points move.
  - We list void windows within 48 hours.
  - A release that needs a restart counts as full uptime for the window it's announced in and the next one.
  - **The fleet outage (2026-11-20).** An automated cost guard on our side deleted the whole testnet fleet at about 22:30 UTC on 20 November 2026, in window 23,581. We rebuilt it with new validator keys and addresses, and tester.4.4 moves nodes onto it.
    - **The outage.** From window 23,581 until the rebuilt validators score again, every window is void for everyone, as above.
    - **The grace.** From then until 48 hours after tester.4.4 is published, a site that was measured in at least one of the 20 windows before the deletion is covered until the rebuilt validators first measure it: those windows are void for that site, as above. From the first window they measure it, its windows count as usual.
    - **Declarations.** The honest-declaration test doesn't read a window of the outage or the grace in which the rebuilt validators hadn't yet completed a capacity test of the node.
    - **Nobody gains.** Only what validators measured earns anything. Nothing is filled in for a window nobody measured, and no figure from before the outage is carried into one. The bounty's verified tier counts only days with a passing node, as always. It keeps the snapshot the validators attested for window 23,581 before the deletion, because that snapshot holds only earlier tests.
    - **The windows.** The outage is windows 23,581 and 23,582: the rebuilt validators scored 23,582, with no tester node yet able to reach them. The grace runs from window 23,583 to window 23,624. tester.4.4 was published at 02:16 UTC on 21 November 2026, so the grace ends at 02:16 UTC on 23 November.
- **Exploits.**
  - Points earned through an exploit are removed, whoever found it.
  - If you report it privately first, you keep your honest points and earn the finding.
  - If you use an exploit and don't report it, you lose the affected weeks' node points.
  - A second time, you're removed from the node and solver tracks.
- **Measurement corrections.** When a team-side measurement fault under-read nodes, the ledger corrects the nodes it hit instead of voiding the window. Each correction is listed here, and the ledger names it and lists every node-window it changed.
  - **The owner forwarder (2026-11-17).** From window 23,500 until the owner forwarder is removed (scheduled Tue 2026-11-24), one of our validators reached some nodes only through a forwarder. That path was capped at 100 Mb/s with about 240 ms of delay. Because that validator holds most of the stake, its low readings set those nodes' capacity. For those windows:
    - **Who it covers.** A node is covered in a window when every test that validator ran on it in that window went through the forwarder.
    - **The credit.** A covered node is credited the larger of two figures: its published combined capacity, and its capacity recomputed from the other validators' results alone, under the same rules.
    - **Honest declarations.** The corrected figure is the one the honest-declaration test reads.
    - **The overclaim cut.** A 20% overclaim cut that came from forwarder-capped results is void. A cut stands only if the other validators' results alone would also have triggered it.
    - **What it never does.** It only raises credit. It never lowers anyone's points, and it doesn't change the published scores or past weights.
- **Multiple accounts.** Before the count we check the largest claimants for one operator behind several claims. Merged claims share one ceiling. We tell you why, and you have 14 days to answer.

## Ledger and appeals

- **The ledger.** We publish it weekly in the releases repository, within 48 hours of the week's last window. The first ledger, covering everything since tester.2, comes after the rules are final.
  - It covers each site's points and each claimant's running total.
  - It contains no IP addresses.
- **The script.** We publish the script that computes it from the validators' committed values, so you can recompute your own line.
- **Appeals.** Open an Issue within 14 days of a ledger. We answer publicly within 7 days.

## Payout schedule

*How we currently intend to size any discretionary reward; not a promise or entitlement.* Every part is a discretionary reward (see [What an allocation is](#what-an-allocation-is)).

- **The first part,** within 7 days of mainnet start, is **one registration's worth** (or your whole share, if that's smaller). You can use it to register on mainnet: unstake it to TAO for the registration.
- **The rest** follows in three equal parts, at 30, 60 and 90 days after mainnet start.
- **Founding operators.** A founding operator is a claimant who, before mainnet starts:
  - held base on a site for 6 weeks; and
  - has an accepted finding, or a site with an environment bonus.

  If your first part was less than the burned half of your first mainnet registration, we intend to give the difference after that UID passes its first mainnet capacity test.
  - The burned half is read from chain and capped at half of one registration's worth.
  - This offer is open for 30 days from the opening of registration.
  - It comes from the subnet owner's share, not from the pool.
- **Unclaimed shares.** A share unclaimed 180 days after mainnet start goes to the other node-track claimants, pro rata.

## Changes

- **Lowering credit.** A change that lowers anyone's future credit is announced 7 days before the first window it applies to. It never applies to past windows.
  - Any new bonus divides the same pool, so adding one counts as lowering credit.
- **Closing an exploit.** A change that closes an exploit applies at once, going forward.
- **Lowering a bonus.** When a kind of site reaches its target, its bonus can be lowered with 7 days' notice.
- **Versioning.** This page has a version number, and each ledger names the version it used.
- **Coming later: a location bonus** for sites that add a new country or region. It needs a measured location signal under its own ADR, and it comes with the customer front end. Its rule is published here before it applies.

### What changed from the proposal (2026-11-14)

- **Router nodes (2026-11-14).** Router points, base included, count from the release that adds router measurement.
- **Environment bonuses taper (2026-11-14).** The home, NAT and router bonuses reward early coverage and engagement, and taper as those sites reach their targets.
- **What an allocation is (2026-11-16).** Allocations are discretionary rewards, go only to people who may lawfully receive them, and come with no warranty. These rules are part of the [Terms of Service](terms.html).
- **Age and attestation (2026-11-16).** Claimants must be 18 or older, or the age of majority where they live, and sign an attestation on the claim page. Earlier registrants keep their points but sign again.
- **A current release (2026-11-16).** It counts, and the fast-upgrade role is scored, only once versions are measured.
- **Measurement corrections (2026-11-17, version 2.1).** The owner-forwarder correction under Fairness rules. It only raises credit.
- **The fleet outage (2026-11-21, version 2.2).** The 2026-11-20 outage and the grace after it, under Fairness rules, "Void windows". It only raises credit.
- **Final values (2026-11-17).** The values marked *proposed value* are final as proposed: the 20 Mb/s capacity floor, the first 10 sites of a kind with the full environment bonus, 5 fleet sites per claimant, and 6 weeks of base for a founding operator.
