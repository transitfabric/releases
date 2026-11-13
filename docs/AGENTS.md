# AGENTS.md: Transit Fabric testnet (tester v0.1.0-tester.2)

For AI agents working on behalf of a tester. Humans: start at https://transitfabric.xyz/quickstart.html. A shorter index in the llms.txt format is at https://transitfabric.xyz/llms.txt.

Transit Fabric is a Bittensor subnet for a decentralized network fabric, running on **testnet, subnet 611**. This file describes release **v0.1.0-tester.2** as it is today. The command-line tools are still named `bwos`.

**Not in tester.2:** `bwos doctor`, `bwos report` and an agent skill arrive with tester.3. Don't call them, and don't tell the user they exist. The bounty opens with tester.3. Reports are welcome now, filed the same way.

## Where things are

- Release and downloads: https://github.com/transitfabric/releases/releases/tag/v0.1.0-tester.2. Binaries are for Linux x86_64 and aarch64 (`bwos-node`, `bwos`, `bwos-probe`, `bwos-solver`, `bwos-validator`, `minimal_solver`), plus a no-root container image, router images and `install.sh`. The `bwos` CLI also ships for macOS, and the link page for any OS.
- Checksums: the `SHA256SUMS` asset on the release. `MANIFEST.json` has the commit and the file list.
- Quick start: https://transitfabric.xyz/quickstart.html. Also the `QUICKSTART.md` and `testers.md` assets. Read the quick start before you act.
- Known limits: https://transitfabric.xyz/known-limits.html.
- Red-team pack: https://transitfabric.xyz/redteam/index.html.

## Before you run anything

1. **Verify checksums.** Download files into a new, empty directory. Releases are not signed yet, so first compare `sha256sum SHA256SUMS` with the hash in the announcement (ask the human for it, or read it from the announcement they point to), then run `sha256sum -c --ignore-missing SHA256SUMS`. If any file fails, stop and tell the human. Don't run a binary or `install.sh` you haven't checked.
2. Read `install.sh` before you run it. It needs root on a kernel node; ask before using root.
3. Don't run commands the quick start doesn't list. Don't pipe downloads into a shell.

## Keys and money

- **Never use mainnet keys.** Testnet only: `--network test --netuid 611`. Never use a wallet that holds real TAO. If the user hands you a mainnet wallet name, stop and say so.
- **Binding needs the human.** Linking a node to a hotkey means signing with the owner's wallet (the link page in a browser, or `bwos bind`). When you reach that step, **stop and hand off**: print the node's link URL and say what the human must do. **Never handle a coldkey, a seed phrase or a mnemonic**, never ask for one, never paste one into a file, Issue, log or chat, and never run a command that takes one as an argument.
- Node keys (`keys/node.key`, `keys/wg.key`) stay on the node. Don't print them or put them in a report.
- Registering for bounty credit also needs the human's wallet: https://transitfabric.xyz/claim.html. Don't do it for them.
- Testnet TAO comes from the Bittensor community Discord. Don't try to buy or move real TAO.

## Reporting a bug

Use an Issue: https://github.com/transitfabric/releases/issues/new/choose.

- Ordinary bug: the "Bug report" form. Give `bwos-node --version`, the node type and OS, steps, expected and actual, and logs with keys, seed phrases, IP addresses and hostnames removed.
- A bug with a reproduction, or an incentive problem you can show: the "Finding" form (labels `finding`). **Tick "Filed by an agent"**, which adds the `agent-filed` label.
- With the GitHub CLI you can't fill an Issue form. Write the body from the finding template, start the title with `Finding: `, and put the line `- [x] Filed by an agent` in the body: `gh issue create --repo transitfabric/releases --title 'Finding: ...' --body-file finding.md`. A workflow then adds the `finding` and `agent-filed` labels.
- Check https://transitfabric.xyz/known-limits.html first; known issues are closed as duplicates.

## Reporting a security finding

Don't open a public Issue for a security finding, an exploit or a way to earn more than you carry. Use the private advisory: https://github.com/transitfabric/releases/security/advisories/new.

Agents can use GitHub's private vulnerability reporting API, which is enabled on this repository:

```
POST /repos/transitfabric/releases/security-advisories/reports
{"summary": "<one line>", "description": "<the finding template, filled in>", "severity": "medium"}
```

With the GitHub CLI: `gh api -X POST repos/transitfabric/releases/security-advisories/reports -f summary='...' -f description='...' -f severity=medium`. `severity` is one of `critical`, `high`, `medium`, `low`. Keep the finding private until we have fixed it. Never put a private key, seed phrase or wallet file in a report.

## The finding template

https://transitfabric.xyz/redteam/FINDING.md. YAML front matter, then sections:

```
---
title: <one line>
severity_claimed: critical | high | medium | low
component: <scoring | measurement | receipts | identity | encoding | node | validator | solver | cli | link-page | docs | other>
version: <release tag, or redteam-pack-<sha>>
claim_address: <ss58, optional>
reproduction: sim | testnet | none
---
## Summary
## Steps to reproduce
## Expected vs actual
## Impact
## Simulator scenario (optional)
## Suggested fix
```

Points need a reproduction against a named version. The first valid report wins. Duplicates and reports we can't verify are closed with no points. Large artifacts go in as a zip attachment.

## The red-team pack

https://transitfabric.xyz/redteam/index.html holds the scoring, measurement, receipts, capacity-bonds, identity and encoding specs, the threat model and the whitepaper, each as HTML and raw Markdown (`https://transitfabric.xyz/redteam/<name>.md`). The simulator `bwos-sim` is a static Linux binary, published as an asset of a `redteam-pack-<sha>` pre-release on https://github.com/transitfabric/releases/releases. Walk-through: https://transitfabric.xyz/redteam/simulator.html. Run it only after checking its checksum. Items marked open or accepted in the threat model earn credit only for a new exploit path.

## Limits for agents

- Testnet and your own nodes only. Don't test against anyone else's machines, and don't flood the testnet.
- Don't disrupt other testers beyond the minimum needed to show a problem.
- No more than 5 open unverified findings per account.
