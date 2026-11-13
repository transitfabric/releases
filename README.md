# Transit Fabric releases

Release files for **Transit Fabric** testers on Bittensor **testnet, subnet 611**. Transit Fabric is an open network fabric:
- nodes carry transit over an encrypted overlay;
- route solvers compete on the route table;
- validators measure both and set weights.

This repository holds release files, documentation and the testers' site. It has no source code.

**Site:** https://transitfabric.xyz (quickstart, known limits, bug bounty, leaderboard)
- **Red-team pack:** https://transitfabric.xyz/redteam/index.html (specs, threat model, simulator). **Register for bounty credit:** https://transitfabric.xyz/claim.html. **For agents:** https://transitfabric.xyz/llms.txt and https://transitfabric.xyz/AGENTS.md.

- **Download** from [Releases](https://github.com/transitfabric/releases/releases). Before installing, check the files with `sha256sum -c SHA256SUMS`.
- **Install guide:** each release ships one as `testers.md`. The site has the short version.
- **Bugs and peering requests:** open an [Issue](https://github.com/transitfabric/releases/issues) using the templates.
- **Security findings and exploits:** use [Report a vulnerability](https://github.com/transitfabric/releases/security/advisories/new), which opens a private advisory. Never use a public Issue for these. See [SECURITY.md](SECURITY.md) and the [bug bounty](BOUNTY.md).
- **Contributing:** fixes to the docs and the guide are welcome as pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md).

**Testnet only.** Running these builds doesn't earn real TAO. The bug bounty's rewards are described in [BOUNTY.md](BOUNTY.md).

The command-line tools are still named `bwos` in this testnet. BandwidthOS is the company that develops the stack, and it's one of the network's resellers.
