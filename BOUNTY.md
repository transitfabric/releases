# Transit Fabric testnet bug bounty and Founding Tester program

> **Not open yet (opening soon).** The public bug bounty and Founding Tester points program are not open yet. We are rolling out scoring version 2 and clearing major pre-audit hardening fixes first, and we will announce the official opening date and baseline release here and in Discord. Private bug and security reports are welcome now via the [plain upload](https://submit.transitfabric.xyz) or [GitHub Security Advisories](https://github.com/transitfabric/releases/security/advisories/new); any credit for reports sent before the official opening is strictly discretionary. Public bounty points start only on the announced opening date. The [red-team pack](https://transitfabric.xyz/redteam/index.html) (the scoring, measurement and threat-model specs, plus the simulator) is already published.

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

## Safe harbor for good-faith security research

When you research security in good faith and within this page's scope and rules, we consider your research:

- **authorized** under the Computer Fraud and Abuse Act and similar laws, and we will not bring legal action against you, or refer you to law enforcement, for it, including for accidental, good-faith breaches of these rules;
- **exempt from the restrictions in our [Terms of Service](https://transitfabric.xyz/terms.html)** that would otherwise forbid it. We waive those restrictions on a limited basis, for research done under these rules only;
- **lawful, helpful to the security of the network, and done in good faith.**

If a third party brings legal action against you for research that followed these rules, we will make it known that your research was authorized by us.

**What this covers.** Testnet subnet 611 and our testnet infrastructure (our validators, the reference solver, our seed nodes, the findings sandbox, the stats API and this site), as [Scope](#scope) defines.

**What it doesn't cover.**
- Bittensor mainnet (finney), and other subnets.
- Other people's nodes, beyond what these rules allow (the minimum needed to demonstrate an issue).
- Denial of service against shared infrastructure.
- Social engineering, phishing and physical attacks.
- Third-party services: Cloudflare, GitHub, Discord and Vultr. Their own rules apply to them, and we can't authorize research against them.

**Your part.**
- Follow these rules and the law that applies to you.
- If you reach data that isn't yours (anyone's keys, personal data, or private submissions), stop, report it to us at once, and don't keep, copy or share it.
- Keep the finding private until it is fixed.
- If you're unsure whether something is in scope, ask through a [private advisory](https://github.com/transitfabric/releases/security/advisories/new) before you go further.

This section is separate from, and not the same as, any whitehat or safe-harbor framework of other organizations. Adapted from the [disclose.io](https://disclose.io) safe harbor terms (CC0 1.0).

## Rewards: points, small TAO tips, and recognition

This is a community program for early testers. It isn't a big-money bounty.

*How we currently intend to size any discretionary reward; not a promise or entitlement.*

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

**Small TAO tips:** the top findings may also receive a small tip in real TAO, as a discretionary reward (see below).

**Future alpha:** what testnet work may earn is set by the [testnet rules](https://transitfabric.xyz/testnet-rules.html) (`TESTNET-RULES.md`). That page is the only place that describes it.

**Recognition:** a public leaderboard on this repository, a Founding Tester role in our Discord, and credit in the release notes.

**No fee.** Registering and submitting are free. Signing moves no funds.

## Who may receive awards, and what they are

- **Age.** You must be **18 or older, or the age of majority where you live, whichever is higher**. Your registration on the claim page says so in the message you sign. We never ask for your date of birth.
- **Only attested registrants.** Points, tips and any mainnet-alpha allocation go only to registrants who signed the current claim message, which carries the age attestation and accepts the [Terms](https://transitfabric.xyz/terms.html) and [Privacy Policy](https://transitfabric.xyz/privacy.html). If you registered before 17 November 2026, your registration is kept, but sign again on the claim page to stay eligible.
- **A discretionary reward.** Any award (points, a tip, an allocation) is a discretionary reward, given at our sole discretion. No entitlement or claim arises, and no contract is formed, from points, a registration or any published schedule.
- **Not guaranteed.** We may withhold, reduce, delay or cancel any award, including for legal, sanctions or compliance reasons, or if we can't confirm you may lawfully receive it.
- **Only where lawful.** Awards go only to people legally able to receive them where they live and under applicable sanctions. You are solely responsible for any taxes and reporting.
- **No warranty** about value, transferability or tax treatment.
- **Network emissions are separate.** Emissions on the subnet are distributed by the Bittensor protocol, under its own consensus, from validators' weights. We don't pay, hold or guarantee them.

## Who can earn points for findings

**Points need a registration.** Register once on the [claim page](https://transitfabric.xyz/claim.html) before you send a finding. You sign one short message with a wallet, and we tie your GitHub account to that address. A GitHub account is required for credit.

**Register your hotkey or coldkey address:** the one your testnet UID uses, or the coldkey that owns it. We find your nodes through that address. If you register some other wallet, we can't link your nodes to you, and you can't become a verified tester.

| | Verified tester | Everyone else |
|---|---|---|
| **Who** | Registered, and a node bound to your claimed account has passed validators' tests on at least 7 days | Registered, without that |
| **What earns points** | Any tier, Critical to Low | Critical or High only, with a working reproduction (a script or a simulator scenario) |
| **Open findings at a time** | Up to 5 | 1 |

- **Your claimed account** is the address you registered.
  - If it is a coldkey, a node counts when it is bound to any of that coldkey's hotkeys on subnet 611.
  - If it is a hotkey, the node must be bound to that hotkey.
- **Passing a test** means validators' published snapshot for the window lists the node with verified capacity above zero.
- **Days** are counted from those published snapshots. They needn't be in a row.
- **Your tier is checked when a finding arrives.** If you claim the verified tier and haven't earned it yet, the finding is treated as from everyone else.
- **Wait for a verdict** before you send more than your limit. A finding stops counting as open when we record a verdict on it.

## How to report

| What | Where | Points |
|---|---|---|
| A finding you want points for, security or not | The [signed finding form](https://submit.transitfabric.xyz/finding) (private) | Yes |
| An ordinary bug, in public | An [Issue](https://github.com/transitfabric/releases/issues/new/choose) | No |
| A security issue, to coordinate a fix | A [private advisory](https://github.com/transitfabric/releases/security/advisories/new). Quote your form receipt if you sent one | Only through the form |
| A finding without a GitHub account | The [plain upload](https://submit.transitfabric.xyz) (private) | No |

Don't open public Issues for security issues or exploits.

**The signed finding form**
- **Every field is required.** They are:
  - the version (a release tag, or the red-team pack tag for a simulator finding)
  - the tier you claim for the finding
  - your eligibility (verified tester or everyone else)
  - the component
  - numbered steps to reproduce
  - what you expected (cite the spec or threat-model section)
  - what happened
  - a proof-of-concept zip: the script, simulator scenario or logs that reproduce it

  Impact and a suggested fix are optional, and worth adding.
- **Sign it with your registered wallet.** The form names your fields by their SHA-256 in one short message, and you sign that message in a browser wallet or with `btcli wallet sign`. We check the signature when the form arrives.
- **Agents** can use `curl`. The form page shows how to build and sign the message.
- **Read first:** the [red-team pack](https://transitfabric.xyz/redteam/index.html) has the specs, the threat model and the simulator. Also see [how to reproduce a finding in the simulator](https://transitfabric.xyz/redteam/simulator.html), and the [finding template](https://transitfabric.xyz/redteam/FINDING.md) for what a good report holds.
- **Clean your attachments.** Remove keys, seed phrases, machine addresses and hostnames from the zip first.

**What happens next**
1. **An automatic first pass** checks four things:
   - that the steps to reproduce and the version are there;
   - whether the finding duplicates an earlier one or an open threat-model row;
   - which eligibility tier you're in;
   - whether the report is obviously low effort, such as template text left in, no real steps or no proof of concept.
2. **A person reads every finding.** The first pass flags reports to close and says why, but it never closes one. We close a flagged report with the reason given, and you can reply.
3. **We assign the tier and the points,** and explain our reasoning.

## Rules
- Testnet only. Use your own nodes, hotkeys and test TAO.
- Points need a reproduction against a named version (a release tag, or the red-team pack tag for a simulator finding).
- Duplicates and reports we can't verify are closed with no points.
- Keep within your open-findings limit: 5 for a verified tester, 1 for everyone else.
- Low-effort reports are closed with a reason.
- Don't disrupt other testers beyond the minimum needed to demonstrate an issue. Stop and report as soon as you've shown it.
- The first valid report of an issue earns the points.
- Disclosure: keep security findings private until they're fixed. After that we give public credit, with your permission.
- We add a regression test and a threat-model entry for every finding that earns points.
- These rules are part of the [Terms of Service](https://transitfabric.xyz/terms.html).
