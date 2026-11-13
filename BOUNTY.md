# Transit Fabric testnet bug bounty and Founding Tester program

> **Opening soon.** The program opens with v0.1.0-tester.3, which adds structured bug reports (`bwos doctor`, `bwos report`) and a red-team pack (the scoring, measurement and threat-model specs, plus the simulator). The [red-team pack](https://transitfabric.xyz/redteam/index.html) is already published. Points start counting on the opening date, which we'll announce here and in the Transit Fabric Discord. Bug and security reports are welcome now. Please send them the same way.

Transit Fabric is a Bittensor subnet for a decentralized network fabric. It is testing on Bittensor **testnet, subnet 611**. We reward early testers who find bugs and exploits in the released software and the testnet network, and who keep nodes and solvers running.

## Scope
- The software released at github.com/transitfabric/releases: the node (kernel and no-root), the router image and packages, the validator, the solver daemon, the `bwos` CLI, and the link page.
- The incentive mechanism as it runs on subnet 611: scoring, measurement, bindings and route tables.
- The design documents we publish with a release.

## Out of scope
- Bittensor/Subtensor itself, wallets, and third-party infrastructure.
- Denial of service against anyone's machines or networks, and spam or flooding of the public testnet.
- Social engineering, phishing, and physical attacks.
- Anything on mainnet (finney). Never use mainnet keys or real TAO.
- Issues already listed in our published threat model as open or accepted, unless you show a new way to exploit them or a bigger payoff.

## Rewards: points, small TAO tips, and recognition

This is a community program for early testers. It isn't a big-money bounty.

**Points for each valid finding**

| Tier | What it means | Points |
|---|---|---|
| Critical | Stop weight-setting for the subnet; make honest validators disagree on weights; take over another operator's nodes or binding; collect most of an emission pool for nothing | 100 |
| High | An incentive exploit worth 2x or more over honest play at low cost; knock honest operators out of credit; crash validators remotely | 40 |
| Medium | A bounded unfair gain; a reliability bug that skews scoring; a leak of private data | 15 |
| Low | Hardening issues, minor bugs, misleading docs | 5 |

- **+25%** for a working reproduction (a sim or a testnet demonstration) plus a suggested fix.
- The first valid report of an issue earns the points. Issues already listed as open in our threat model get credit only, unless you show a new exploit path.
- We assign the tier and the points, and we explain our reasoning.

**Points for taking part**
- Running a node or solver that stays live and scored: points per week it stays up.
- Onboarding feedback, and documentation fixes that get merged.

**Small TAO tips:** the top findings may also get a small tip in real TAO, at our discretion.

**Future alpha:** we intend to recognise points with a discretionary allocation of Transit Fabric alpha after the subnet launches on mainnet. This is an intention, not a promise: the amounts and timing are set at launch and depend on the launch happening.

**Recognition:** a public leaderboard on this repository, a Founding Tester role in our Discord, and credit in the release notes.

## How to report
- **Security issues and exploits:** report them privately through GitHub's "Report a vulnerability" (private security advisory) on github.com/transitfabric/releases. Don't open public issues for them.
- **Ordinary bugs:** open a public Issue on the same repository.
- Include the version, the steps to reproduce, what you expected and what happened, and logs with addresses and keys removed.

## Registering and submitting
- **Register once** on the [claim page](https://transitfabric.xyz/claim.html). You sign one short message with a wallet (signing moves no funds), and we tie your GitHub account to that address. A GitHub account is required for credit.
- **Read first:** the [red-team pack](https://transitfabric.xyz/redteam/index.html) has the specs, the threat model and the simulator, and [how to reproduce a finding in the simulator](https://transitfabric.xyz/redteam/simulator.html).
- **Submit findings** with the [finding template](https://transitfabric.xyz/redteam/FINDING.md). A bug goes in through the Finding [Issue form](https://github.com/transitfabric/releases/issues/new/choose). A security finding goes in privately, through the [private advisory](https://github.com/transitfabric/releases/security/advisories/new) or its API (`POST /repos/transitfabric/releases/security-advisories/reports`).
- **Large artifacts** (simulator output, logs, captures) go in as a zip attachment. Remove keys, seed phrases, machine addresses and hostnames first.
- **No GitHub account?** Upload your finding to the private [findings sandbox](https://submit.transitfabric.xyz) (markdown up to 1 MB, optional zip up to 10 MB). It earns no credit. For agents: `curl -sS -F file=@finding.md https://submit.transitfabric.xyz/upload`.

## Rules
- Testnet only. Use your own nodes, hotkeys and test TAO.
- Points need a reproduction against a named version (a release tag, or the red-team pack tag for a simulator finding).
- Duplicates and reports we can't verify are closed with no points.
- At most 5 open unverified findings per account. Wait for a verdict before you send more.
- Don't disrupt other testers beyond the minimum needed to demonstrate an issue. Stop and report as soon as you've shown it.
- The first valid report of an issue wins the reward.
- Disclosure: keep security findings private until they're fixed. After that we give public credit, with your permission.
- We add a regression test and a threat-model entry for every paid finding.
