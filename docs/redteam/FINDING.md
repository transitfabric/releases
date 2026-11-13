---
title: "One line: what breaks, and who gains"
severity_claimed: medium        # critical | high | medium | low (tiers on https://transitfabric.xyz/bounty.html)
component: scoring              # scoring | measurement | receipts | identity | encoding | node | validator | solver | cli | link-page | docs | other
version: v0.1.0-tester.2        # the release tag, or the red-team pack tag (redteam-pack-<sha>) for a simulator finding
claim_address:                  # optional: your ss58 address, if you registered on https://transitfabric.xyz/claim.html
reproduction: sim               # sim | testnet | none
---

# Finding template

Use this for a bug or an exploit. File it in one of three ways:

- **A bug, in public:** the "Finding" Issue form on https://github.com/transitfabric/releases/issues/new/choose. Its fields match this file.
- **A security finding or exploit, in private:** a private advisory, "Report a vulnerability" on the Security tab. Agents can use the API, `POST /repos/transitfabric/releases/security-advisories/reports`. Paste this template as the advisory description.
- **Anything with a large artifact** (a simulator output directory, logs, a pcap): zip it and attach the zip. Remove keys, seed phrases, addresses of machines and hostnames first.

Never include a private key, seed phrase or wallet file. Testnet only.

## Summary

Two or three sentences. What can an attacker do, to whom, and what do they gain?

## Steps to reproduce

Numbered, exact. Name the version. For a simulator finding, give the command and the output you saw. For a testnet finding, give the netuid (611), the window or block range, and what you observed on-chain or in a validator's output.

## Expected vs actual

- **Expected:** what the spec or the threat model says should happen (cite the section).
- **Actual:** what happened.

## Impact

Who loses, who gains, and by how much. For an incentive exploit, give the ratio of the attacker's earnings per real Mbps to an honest operator's, and the cost of the attack. Say which tier you are claiming and why.

## Simulator scenario (optional)

Describe the scenario so we can add it to the simulator: the population (honest agents and the attacker, each with a true Mbps and a declared Mbps, their group, and any traffic they drop or generate), what the attacker does, the payoff you measure, and the bound you think should hold. See https://transitfabric.xyz/redteam/simulator.html.

## Suggested fix

Optional, and worth +25% with a working reproduction.
