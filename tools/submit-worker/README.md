# Findings sandbox (submit.transitfabric.xyz)

A Cloudflare Worker that accepts Transit Fabric findings from people without a GitHub account. The source is `worker.js`, published here so anyone can see what it does with an upload.

- **Accepts:** markdown (UTF-8, up to 1 MiB) as form field `file`, an optional `.zip` up to 10 MiB as `attachment`, and an optional `contact` of up to 200 characters. A raw `text/markdown` body also works.
- **Stores:** privately in Cloudflare KV. Nothing uploaded is ever served back to the public. Client addresses are stored only as a salted hash, used for the limit of 10 uploads a day.
- **Replies with:** JSON giving a receipt ID, the file's SHA-256 and the time received.
- **Credit:** none. Bounty credit needs a GitHub account and a signed claim (see `docs/claim.html`).
- **Maintainers** read submissions through bearer-authenticated `/admin/*` endpoints. The token is a Worker secret, never in this repository.
