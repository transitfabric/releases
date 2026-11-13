# verify-claim

Checks a bounty registration from the [claim page](https://transitfabric.xyz/claim.html): a signature over the message `Transit Fabric bounty: github=<user>, address=<ss58>, date=<YYYY-MM-DD>`. It prints `valid` or `invalid` and exits 0 or 1. It makes no network requests.

It uses `signatureVerify` from `@polkadot/util-crypto` (pinned to 14.0.3). A browser wallet signs `<Bytes>` + message + `</Bytes>`, and so does `btcli wallet sign` (checked with btcli 9.23.2); a signature over the bare message is accepted too.

## Run it with npx

From a clone of this repository:

```sh
npx -y -p @polkadot/util-crypto@14.0.3 -p @polkadot/util@14.0.3 -p @polkadot/keyring@14.0.3 \
  node tools/verify-claim.mjs --message 'Transit Fabric bounty: github=octocat, address=<ss58>, date=2026-11-12' \
  --address <ss58> --signature 0x<hex>
```

Or give it the claim block the page produced (three lines: `message: ...`, `address: ...`, `signature: ...`):

```sh
pbpaste | npx -y -p @polkadot/util-crypto@14.0.3 -p @polkadot/util@14.0.3 -p @polkadot/keyring@14.0.3 \
  node tools/verify-claim.mjs --claim -
```

Without npx: `cd tools && npm ci && node verify-claim.mjs --claim claim.txt`.

## Test it

`--self-test` makes a throwaway sr25519 key (never stored), signs a message the way the extension does, and checks that the right signature passes and that a changed name, a changed date, another account, a flipped byte and a malformed message all fail:

```sh
npx -y -p @polkadot/util-crypto@14.0.3 -p @polkadot/util@14.0.3 -p @polkadot/keyring@14.0.3 \
  node tools/verify-claim.mjs --self-test
```
