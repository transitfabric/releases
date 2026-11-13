# Transit Fabric testnet bug bounty and Founding Tester program

> **Opening soon.** The program opens with v0.1.0-tester.3, which adds structured bug reports (`bwos doctor`, `bwos report`) and a red-team pack (the scoring, measurement and threat-model specs, plus the simulator). Points start counting on the opening date, which we'll announce here and in the Transit Fabric Discord. Bug and security reports are welcome now. Please send them the same way.

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
- The first valid report of an issue earns the points. Duplicates, and issues already listed as open in our threat model, get credit only.
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

## Rules
- Testnet only. Use your own nodes, hotkeys and test TAO.
- Don't disrupt other testers beyond the minimum needed to demonstrate an issue. Stop and report as soon as you've shown it.
- The first valid report of an issue gets the reward. Duplicates don't.
- Disclosure: keep security findings private until they're fixed. After that we give public credit, with your permission.
- We add a regression test and a threat-model entry for every paid finding.
