// Transit Fabric findings sandbox: submit.transitfabric.xyz
//
// Takes a markdown finding (and an optional zip) from anyone, with no account,
// and stores it privately for the maintainers. Nothing uploaded is ever served
// back to the public. Uploads here earn no bounty credit: credit needs a
// GitHub account and a signed claim (https://transitfabric.xyz/claim.html).
//
// Bindings (set at deploy, never in this file):
//   SUB       KV namespace holding submissions and rate-limit counters
//   ADMIN_KEY secret: bearer token for the maintainers' read endpoints
//   IP_SALT   secret: salt for hashing client addresses (raw IPs are never stored)

const MAX_MD = 1024 * 1024;           // 1 MiB of markdown
const MAX_ZIP = 10 * 1024 * 1024;     // 10 MiB zip attachment
const MAX_BODY = 12 * 1024 * 1024;    // whole request
const MAX_CONTACT = 200;              // optional contact handle, characters
const PER_IP_PER_DAY = 10;            // uploads per hashed address per UTC day

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

function json(status, obj, extra = {}) {
  return new Response(JSON.stringify(obj, null, 2) + "\n", {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Content-Security-Policy": "default-src 'none'",
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

async function sha256Hex(data) {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function receiptId() {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return "tf-" + [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

function timingSafeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}

function isAdmin(request, env) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer (.+)$/);
  return !!(m && env.ADMIN_KEY && timingSafeEqual(m[1], env.ADMIN_KEY));
}

async function rateLimit(env, ipHash) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${day}:${ipHash}`;
  const n = parseInt((await env.SUB.get(key)) || "0", 10);
  if (n >= PER_IP_PER_DAY) return false;
  await env.SUB.put(key, String(n + 1), { expirationTtl: 2 * 86400 });
  return true;
}

function decodeMarkdown(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { error: "the file is not valid UTF-8 text" };
  }
  if (text.includes("\u0000")) return { error: "the file contains NUL bytes; send markdown text only" };
  if (text.trim().length === 0) return { error: "the file is empty" };
  return { text };
}

async function handleUpload(request, env) {
  const len = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (len > MAX_BODY) return json(413, { error: `request larger than ${MAX_BODY} bytes` });

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = (await sha256Hex((env.IP_SALT || "") + ip)).slice(0, 16);
  if (!(await rateLimit(env, ipHash))) {
    return json(429, { error: `limit of ${PER_IP_PER_DAY} uploads per day reached; try again tomorrow (UTC)` });
  }

  let mdBytes, zipBytes = null, contact = "";
  const ctype = request.headers.get("Content-Type") || "";
  if (ctype.startsWith("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return json(400, { error: "missing form field 'file' (your markdown)" });
    mdBytes = new Uint8Array(await file.arrayBuffer());
    const att = form.get("attachment");
    if (att && typeof att !== "string" && att.size > 0) zipBytes = new Uint8Array(await att.arrayBuffer());
    const c = form.get("contact");
    if (typeof c === "string") contact = c.trim();
  } else if (ctype.startsWith("text/markdown") || ctype.startsWith("text/plain")) {
    mdBytes = new Uint8Array(await request.arrayBuffer());
  } else {
    return json(415, { error: "send multipart/form-data with field 'file', or a text/markdown body" });
  }

  if (mdBytes.length > MAX_MD) return json(413, { error: `markdown larger than ${MAX_MD} bytes` });
  const md = decodeMarkdown(mdBytes);
  if (md.error) return json(400, { error: md.error });
  if (zipBytes) {
    if (zipBytes.length > MAX_ZIP) return json(413, { error: `attachment larger than ${MAX_ZIP} bytes` });
    const pk = zipBytes[0] === 0x50 && zipBytes[1] === 0x4b && zipBytes[2] === 0x03 && zipBytes[3] === 0x04;
    if (!pk) return json(400, { error: "the attachment must be a .zip file" });
  }
  if (contact.length > MAX_CONTACT) return json(400, { error: `contact longer than ${MAX_CONTACT} characters` });

  const receipt = receiptId();
  const receivedAt = new Date().toISOString();
  const sha256 = await sha256Hex(mdBytes);
  const meta = {
    receipt,
    received_at: receivedAt,
    sha256,
    bytes: mdBytes.length,
    has_attachment: !!zipBytes,
    ip_hash: ipHash,
    contact: contact || undefined,
  };
  await env.SUB.put(`sub:${receivedAt}:${receipt}`, md.text, { metadata: meta });
  if (zipBytes) await env.SUB.put(`zip:${receipt}`, zipBytes);

  return json(201, {
    receipt,
    sha256,
    received_at: receivedAt,
    note: "Received. Quote this receipt in the Transit Fabric Discord or a GitHub Issue if you want to follow up. Uploads here are private and earn no bounty credit.",
  });
}

async function handleAdmin(request, env, url) {
  if (!isAdmin(request, env)) return json(404, { error: "not found" });
  if (url.pathname === "/admin/list") {
    const since = url.searchParams.get("since") || "";
    const out = [];
    let cursor;
    do {
      const page = await env.SUB.list({ prefix: "sub:", cursor });
      for (const k of page.keys) if (k.name.slice(4) > since) out.push({ key: k.name, ...k.metadata });
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    out.sort((a, b) => (a.key < b.key ? -1 : 1));
    return json(200, { count: out.length, submissions: out });
  }
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return json(404, { error: "not found" });
  }
  const get = path.match(/^\/admin\/get\/(sub:[^/]+)$/);
  if (get) {
    const v = await env.SUB.get(get[1]);
    if (v === null) return json(404, { error: "not found" });
    return new Response(v, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "default-src 'none'", ...SECURITY_HEADERS },
    });
  }
  const zip = path.match(/^\/admin\/zip\/(tf-[a-z0-9]+)$/);
  if (zip) {
    const v = await env.SUB.get(`zip:${zip[1]}`, "arrayBuffer");
    if (v === null) return json(404, { error: "not found" });
    return new Response(v, {
      headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${zip[1]}.zip"`, ...SECURITY_HEADERS },
    });
  }
  return json(404, { error: "not found" });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Findings Sandbox | Transit Fabric</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#5f5e5a;--line:#d9d8d2;--accent:#3451d1;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a6a59e;--line:#3a3a37;--accent:#8ea0ff;--card:#1d1d1b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}h1{font-size:1.6rem;margin:0 0 8px}
p,li{color:var(--fg)}.muted{color:var(--muted)}a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin:20px 0}
label{display:block;font-weight:600;margin:14px 0 6px}input[type=text]{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button{margin-top:18px;padding:10px 18px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer}
pre{white-space:pre-wrap;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:12px;font-size:.9rem}
.warn{border-left:4px solid var(--accent);padding-left:12px}
</style></head><body><main>
<h1>Findings sandbox</h1>
<p class="muted">For Transit Fabric testnet findings from people without a GitHub account.</p>
<div class="card warn">
<p><strong>Uploads here earn no bounty credit.</strong> Credit needs a GitHub account and a signed claim: see the <a href="https://transitfabric.xyz/bounty.html">bounty page</a>.</p>
<p>Uploads are private. They are read by the maintainers and never shown publicly, so security findings are welcome here too.</p>
<p>Never include a private key, seed phrase or wallet file. Remove IP addresses from logs.</p>
</div>
<form class="card" id="f">
<label for="file">Your finding (markdown, up to 1 MB)</label>
<input id="file" name="file" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" required>
<p class="muted">Use the <a href="https://transitfabric.xyz/redteam/FINDING.md">finding template</a>.</p>
<label for="attachment">Attachment (optional .zip, up to 10 MB)</label>
<input id="attachment" name="attachment" type="file" accept=".zip,application/zip">
<label for="contact">Contact (optional: a Discord name or email, if you want a reply)</label>
<input id="contact" name="contact" type="text" maxlength="200">
<button type="submit">Upload</button>
</form>
<div class="card" id="out" hidden><strong>Result</strong><pre id="res"></pre></div>
<div class="card"><strong>For agents and scripts</strong>
<pre>curl -sS -F file=@finding.md https://submit.transitfabric.xyz/upload
# optional: -F attachment=@repro.zip -F contact=yourname</pre>
<p class="muted">The reply is JSON with a receipt ID. Limit: ${PER_IP_PER_DAY} uploads per day per address.</p></div>
</main><script>
document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();
const out=document.getElementById('out'),res=document.getElementById('res');out.hidden=false;res.textContent='Uploading…';
try{const r=await fetch('/upload',{method:'POST',body:new FormData(e.target)});res.textContent=await r.text();}
catch(err){res.textContent='Upload failed: '+err.message;}});
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/upload") return handleUpload(request, env);
    if (request.method === "GET" && url.pathname.startsWith("/admin/")) return handleAdmin(request, env, url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(PAGE, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'",
          ...SECURITY_HEADERS,
        },
      });
    }
    return json(404, { error: "not found" });
  },
};
