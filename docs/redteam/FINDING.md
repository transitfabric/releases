---
title: "One line: what breaks, and who gains"
severity: medium                # critical | high | medium | low (tiers on https://transitfabric.xyz/bounty.html)
eligibility: open               # verified | open (see "Who can earn points for findings" on the bounty page)
component: scoring              # scoring | measurement | receipts | identity | encoding | node | validator | solver | cli | link-page | docs | other
version: v0.1.0-tester.5.3.1        # the release tag, or the red-team pack tag (redteam-pack-<sha>) for a simulator finding
---

# Finding template

Use this to write up a bug or an exploit. Where you send it depends on what you want:

- **A finding you want points for, security or not:** the signed form at https://submit.transitfabric.xyz/finding. You must be registered on https://transitfabric.xyz/claim.html and sign with the registered wallet. Its fields match this template, and it needs a proof-of-concept zip.
- **An ordinary bug, in public, with no points:** the Issue forms on https://github.com/transitfabric/releases/issues/new/choose.
- **A security issue, to coordinate a fix:** a private advisory, "Report a vulnerability" on the Security tab. Quote your form receipt if you sent one. Points come only through the form.
- **No GitHub account:** the plain upload at https://submit.transitfabric.xyz. It earns no points.

Never open a public Issue for a security issue or an exploit. Never include a private key, seed phrase or wallet file. Remove addresses of machines and hostnames from logs and zips. Testnet only.

## Summary

Two or three sentences. What can an attacker do, to whom, and what do they gain?

## Steps to reproduce

Numbered, exact. Name the version. For a simulator finding, give the command and the output you saw. For a testnet finding, give the netuid (611), the window or block range, and what you observed on-chain or in a validator's output.

## Expected vs actual

- **Expected:** what the spec or the threat model says should happen (cite the section).
- **Actual:** what happened.

## Impact (optional, worth adding)

Who loses, who gains, and by how much. For an incentive exploit, give the ratio of the attacker's earnings per real Mbps to an honest operator's, and the cost of the attack. Say why you claim this tier.

## Proof of concept

The form requires a zip: the script, simulator scenario or logs that reproduce the finding.

For a simulator scenario, describe it so we can add it to the simulator: the population (honest agents and the attacker, each with a true Mbps and a declared Mbps, their group, and any traffic they drop or generate), what the attacker does, the payoff you measure, and the bound you think should hold. See https://transitfabric.xyz/redteam/simulator.html.

## Suggested fix (optional)

Worth +25% with a working reproduction.
