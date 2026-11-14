---
name: transit-fabric
description: Use when the user wants to install, run, check or troubleshoot a Transit Fabric node on Bittensor testnet subnet 611, interpret `bwos doctor` output, or file a bug report for Transit Fabric (tester v0.1.0-tester.3.1). Testnet only. Covers verifying downloads, handing key and binding steps to the human, System One (fabric-sense), and filing an Issue.
---

# Transit Fabric testnet (tester v0.1.0-tester.3.1)

Transit Fabric is a network fabric run as a Bittensor subnet. This release is on **testnet, subnet 611** only. The command-line tools are named `bwos`. System One (`fabric-sense`) is the node's watchdog sidecar.

## Hard rules

1. **Testnet only.** Always `--network test --netuid 611`. Never run anything against mainnet (`finney`), never use a wallet that holds real TAO, never buy or move TAO. If the user names a mainnet wallet, stop and say so.
2. **Never handle a coldkey, a seed phrase, a mnemonic or a hotkey file.** Do not ask for one, read one, paste one into a file, Issue, log or chat, or run a command that takes one as an argument. Node keys (`keys/node.key`, `keys/wg.key`) stay on the node and out of every report.
3. **Binding stops here.** Linking a node to a hotkey needs the owner's wallet signing (the link page in a browser, or `bwos bind` on their machine). Declaring capacity (`bwos declare`) also uses the hotkey. When you reach either step, stop, print what the node produced (its link URL) and tell the human exactly what to do. Do not continue past it until they say it is done.
4. **Verify before you run.** Never run a binary or `install.sh` you have not checked (below).
5. Don't pipe a download into a shell. Read `install.sh` before running it; a kernel node needs root, so ask first.

## 1. Install

Work in a new, empty directory. The release is a GitHub pre-release, so there is no "latest" redirect; get the version from the human, from https://transitfabric.xyz/llms.txt, or from the release page.

1. Download `SHA256SUMS`, then the files you need from `https://github.com/transitfabric/releases/releases/download/<version>/`. `latest.json` is at the same place: it lists each asset with its sha256 and url, the SHA256SUMS hash (`sha256sums_sha256`) and `validator_set_not_after_block`. It comes from the same source as the files, so it is a convenience and does not replace the next step.
2. **Verify `SHA256SUMS` against the announced hash.** Releases are not signed yet. Ask the human for the hash from the announcement, then compare it with `sha256sum SHA256SUMS`. If they differ, stop.
3. Run `sha256sum -c --ignore-missing SHA256SUMS`. If any file fails, stop and tell the human. Do not run it.
4. Follow the quick start for the path that fits (https://transitfabric.xyz/quickstart.html, or `QUICKSTART.md` in the release): path A kernel node (Ubuntu 24.04, root, `install.sh` with `--fabric-sense`), path B no-root node (process or container, `--restart unless-stopped`), path D solver. Do not run commands the quick start does not list.
5. Every node needs `validator-set.json` and `network.json` from the release's network slot. With System One on, a stale `validator-set.json` is rebuilt for you.

Peering is interim until stage 2: System One does not peer yet. A node is paid for capacity only with a BGP session to a node of another UID, so the human posts a "Peering request" Issue with the node's peer card (testers.md section 5) or swaps cards with another tester.

## 2. Check a node: `bwos doctor --json`

```
bwos doctor --json --kind kernel
bwos doctor --json --kind noroot --state-dir <state dir>
bwos doctor --json --kind container --state-dir <state dir>
```

`--kind` is `kernel` (the default; state in `/var/lib/bwos`, config in `/etc/bwos`), `noroot` or `container`. `--state-dir` is required for the last two. Doctor only reads files; it changes nothing. The output is JSON with a `checks` list; each check has `code`, `ok`, `detail` and `fix`. The exit code is 0 when every check is `ok` and 1 when any fails. Read the failing checks, look each `code` up below, and tell the human the `fix`. System One's open recommendations also appear as failing checks (`detail.source` is `fabric-sense`).

Every code is in one registry shared by doctor, System One and this skill. Codes are stable and never reused.

### Registry codes

Level 1 is reported automatically, level 2 is reported automatically after a failed fix, level 3 is offered to the operator.

| Code | Level | What it means | What System One does | What you do |
|---|---|---|---|---|
| `attested_object_rejected` | 1 | A security-class check failed on this node. Details are not published. | Reported automatically as a signed fault report that carries only the fixed fields; the details go to the maintainers' private triage, never a public Issue. | Do not retry, and do not file a public Issue. Stop the node if System One or the maintainers say so. Security findings go to the private advisory. |
| `crash` | 1 | A node process exited unexpectedly. | Builds a redacted report (automatic at level 1, if `report.auto` allows). | Send the redacted crash report; the node is restarted by its service manager. |
| `determinism_divergence` | 1 | A security-class check failed on this node. Details are not published. | Reported automatically as a signed fault report that carries only the fixed fields; the details go to the maintainers' private triage, never a public Issue. | Do not retry, and do not file a public Issue. Stop the node if System One or the maintainers say so. Security findings go to the private advisory. |
| `invariant_tripped` | 1 | A security-class check failed on this node. Details are not published. | Reported automatically as a signed fault report that carries only the fixed fields; the details go to the maintainers' private triage, never a public Issue. | Do not retry, and do not file a public Issue. Stop the node if System One or the maintainers say so. Security findings go to the private advisory. |
| `inputs_apply_lock_stuck` | 2 | The signed-inputs apply lock has been held past its bound, so new inputs are not applied. | Fixes it itself (skill `rerun_inputs`), at most 3 runs per code per day, then escalates to a level 2 report. | Re-run the inputs apply step so the stuck holder is replaced. |
| `validator_set_rebuild_failed` | 2 | Rebuilding the validator set anchor failed after an automatic fix. | Builds a redacted report (automatic at level 2, if `report.auto` allows). | Send the redacted report, then replace the validators file by hand. |
| `validator_set_stale` | 2 | The node's validator set has expired and it cannot accept new signed inputs. | Rebuilds a current set (skill `rebuild_anchor`), at most 3 runs per code per day, then escalates to a level 2 report. In a container it applies the new set itself; on a kernel node it writes a candidate and recommends the adopt command. | Kernel node: hand the human `sudo bwos-apply-table --adopt-candidate` (it needs root and changes the node's trust root; never run it yourself without their go). Container: nothing. Either: a human may replace the validators file with a current set. |
| `binding_not_live` | 3 | The node's hotkey binding is not live at the current block. | Records a recommendation that `bwos doctor` shows; changes nothing. | Sign a fresh binding with `bwos bind` on your own machine and install it on the node. |
| `capacity_declaration_lapsed` | 3 | The node's capacity declaration has expired, so it earns no capacity credit. | Records a recommendation that `bwos doctor` shows; changes nothing. | Sign and publish a new capacity declaration with `bwos declare`. |
| `node_not_running` | 3 | The node's state directory has no status, so the node is not running. | Records a recommendation that `bwos doctor` shows; changes nothing. | Start the node's service and check its log for the reason it stopped. |
| `probe_session_down` | 3 | The node's probe session to the validator is not up. | Records a recommendation that `bwos doctor` shows; changes nothing. | Check the node can reach the validator's address and restart the probe unit. |
| `table_below_quorum` | 3 | A route table was refused because too few validators attested it. | Records a recommendation that `bwos doctor` shows; changes nothing. | Wait for the next window's table, and check the node's validator set is current. |

Security-class codes are described only in general terms here on purpose. If doctor shows one, do not investigate it publicly or retry the failing object: file nothing in a public Issue, and follow "Security findings" below.

## 3. What System One does by itself

System One runs on kernel, no-root and container nodes. It never opens a node key, hotkey or coldkey and signs nothing. Each symptom ends in exactly one outcome: `fixed` (it acts), `recommend` (it tells the operator the step) or `report`.

- **Rebuild the anchor (`validator_set_stale`).** It builds a current validator set from the chain and checks it. In a container it writes the new set to the `--validators` file. On a kernel node it only writes a candidate (`/var/lib/bwos-sense/validators.candidate.json`); root never adopts it on its own. The operator adopts it with `sudo bwos-apply-table --adopt-candidate`, which `bwos doctor` names, and which refuses unless the held set is stale, the candidate is newer (by at most 30 days of blocks) and not expired, at least 2/3 of the stake on both sides is with the same validators (same hotkey and attestation key), and it verifies in full. It prints each validator's old and new stake share and a `WARN` for a rise of more than 10 points. This changes the node's trust root: hand it to the human, don't run it yourself. A release anchor more than about a day old is rebuilt by hand before installing (`bwos validator-set build --fetch`). An operator can always replace `/etc/bwos/validators.json` by hand; that overrides everything.
- **Restart-loop guard.** A skill runs at most 3 times per code in 24 hours. If the code is still there, System One stops and escalates to a level 2 report (`validator_set_rebuild_failed`).
- **Automatic reports.** `report.auto` is `off`, `crashes` (level 1 only) or `faults` (levels 1 and 2). The default is `faults` on testnet and `crashes` elsewhere. Kernel: `"report": {"auto": "off"}` in `node.json`; container: `BWOS_REPORT_AUTO`. `BWOS_SENSE=0` turns System One off. An automatic report is a signed fault report that carries only these fields: `code`, `version`, `commit`, `node_kind`, `platform`, `binary`, `assertion_hash`, `window`, `skill` and `skill_result`. Never logs, addresses, keys, peers or free text. Nodes never hold a GitHub token and System One never files a public Issue.
- **Container note.** System One cannot restart PID 1, so a container needs `--restart unless-stopped` (compose: `restart: unless-stopped`), `--state-dir` on a writable volume and `--validators` in a writable place.

## 4. Report a bug: `bwos report`

An automatic report is not an Issue. For a bug a human or agent found, build a redacted bundle:

```
bwos report --kind kernel --out ./bwos-report
bwos report --kind noroot --state-dir <state dir> --log <log file> --out ./bwos-report
```

`--log` may repeat. It writes `report.json` and `issue-body.md` into `--out`. IP addresses, long hex runs, WireGuard keys and runs of seed-phrase words are redacted, but **read both files before posting** and remove anything private that remains. Then:

1. Check https://transitfabric.xyz/known-limits.html; known issues are closed as duplicates.
2. Open https://github.com/transitfabric/releases/issues/new/choose and pick **Bug report**. Fill in the version (`bwos-node --version`), the node kind, the `bwos doctor --json` output and the `issue-body.md` text. Tick **Filed by an agent**: it adds the `agent-filed` label. The human posts it unless they told you to.
3. With the GitHub CLI you cannot fill a form. Use `gh issue create --repo transitfabric/releases --title 'Bug: ...' --body-file ./bwos-report/issue-body.md`, and put the line `- [x] Filed by an agent` in the body; a workflow then adds the label.

### Security findings

Anything that could be an exploit, or a way to earn more than you carry, never goes in a public Issue. Use the private advisory: https://github.com/transitfabric/releases/security/advisories/new, or the API `POST /repos/transitfabric/releases/security-advisories/reports` with `summary` and `description`. The finding template is at https://transitfabric.xyz/redteam/FINDING.md. Do not test against anyone else's machines.

## More

- Agent rules: https://transitfabric.xyz/AGENTS.md
- Index for agents: https://transitfabric.xyz/llms.txt
- Quick start: https://transitfabric.xyz/quickstart.html
