// Transit Fabric findings sandbox: submit.transitfabric.xyz
//
// Two ways in, both private: nothing uploaded is ever served back to the public.
//
//   POST /upload   a markdown finding (and an optional zip) from anyone, with no account.
//                  Earns no bounty credit.
//   POST /finding  the signed finding form, the only way a finding earns points. Every field
//                  is required (version, severity, eligibility tier, component, steps to
//                  reproduce, expected, actual) and so is a proof-of-concept zip. The registered
//                  wallet signs "Transit Fabric finding: github=<user>, address=<ss58>,
//                  sha256=<digest>, date=<YYYY-MM-DD>", where <digest> is the SHA-256 of the
//                  fields' canonical JSON (lib/finding.mjs), and this worker checks the signature
//                  the way the claim page and tools/verify-claim.mjs do (lib/sig.mjs).
//
// Both need the age attestation (lib/terms.mjs): the form field `age_attested` ticked and
// `terms_version` naming a published version (for a raw markdown body, the headers
// X-TF-Age-Attested and X-TF-Terms-Version). Without them the request is refused before any KV
// access. Stored with the submission: only `{ age_attested: true, terms_version, ts }`, never a
// date of birth.
//
// Maintainers read both with a bearer token: GET /admin/list, /admin/get/<key>,
// /admin/zip/<receipt>; record a decision with POST /admin/verdict/<receipt>; and replace the
// registered-accounts list (from the claim Issues and the pass history) with PUT /admin/registered.
// A finding from an address not on that list is refused (review M2).
//
// Bindings (set at deploy, never in this file):
//   SUB          KV namespace: submissions, the registered-accounts list, open-finding hints, daily counters
//   ADMIN_KEY    secret: bearer token for the maintainers' endpoints
//   IP_SALT      secret: salt for the daily rate-limit keys; without it intake refuses (fails closed)
//   RATE_LIMITER optional Rate Limiting binding: the per-minute burst limit, checked before any KV access
//
// Order of checks (security review 2026-11-16, M1): the salt, the burst limit, Content-Length,
// the content type and the body, every field, the date and the signature, all before any KV
// write; then KV reads (registration, duplicates, the open hint); the daily counter is written
// only for a request that passed all of them. Clients are bucketed by IPv4 address or IPv6 /64.
import { accountId, verifyWalletSignature } from '../lib/sig.mjs';
import {
  COMPONENTS, GITHUB_RE, MAX_OPEN, OPEN_SEVERITIES, PAGE_CANON_JS, SEVERITIES, canonicalFinding, dateAccepted,
  fieldProblems, findingMessage, normalizeField,
} from '../lib/finding.mjs';
import { ATTESTED_VALUES, FORM_ATTESTATION, PRIVACY_URL, TERMS_URL, TERMS_VERSION, TERMS_VERSIONS } from '../lib/terms.mjs';

const MAX_MD = 1024 * 1024;           // 1 MiB of markdown
const MAX_ZIP = 10 * 1024 * 1024;     // 10 MiB zip attachment
const MAX_BODY = 12 * 1024 * 1024;    // whole request
const MAX_CONTACT = 200;              // optional contact handle, characters
const PER_IP_PER_DAY = 40;            // uploads per hashed address per UTC day (raised from 10 on 2026-11-24: testers hit it)
const VERDICTS = ['valid', 'invalid', 'duplicate', 'closed'];
const FORM_FIELDS = ['github', 'address', 'title', 'version', 'severity', 'eligibility', 'component', 'repro', 'expected', 'actual', 'details'];

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

function isZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * The client's rate-limit bucket: an IPv4 address as is, an IPv6 address by its /64 in canonical
 * form (one host gets a whole /64, so keying on /128 would give it 2^64 buckets; review M1).
 */
export function clientBucket(ip) {
  const s = String(ip || "").trim().toLowerCase();
  if (!s.includes(":")) return s || "unknown";
  let v = s.replace(/^\[|\]$/g, "").split("%")[0];
  const v4 = v.match(/:(\d+\.\d+\.\d+\.\d+)$/); // an embedded IPv4 tail counts as the last 32 bits
  if (v4) {
    const o = v4[1].split(".").map(Number);
    v = v.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, tail] = v.includes("::") ? v.split("::") : [v, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return "unknown-v6";
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}

/**
 * The daily counter's key: the bucket hashed with the salt and the day, so a stored key can't be
 * matched across days, and is useless without IP_SALT. Route-specific (review L1).
 */
async function dailyKey(route, bucket, env, now) {
  const day = now.toISOString().slice(0, 10);
  return `rl:${route}:${day}:${(await sha256Hex(`${env.IP_SALT}|${day}|${bucket}`)).slice(0, 16)}`;
}

/** The burst limit: the Rate Limiting binding, when the Worker has one. It touches no KV. */
async function burstAllowed(env, route, bucket) {
  if (!env.RATE_LIMITER || typeof env.RATE_LIMITER.limit !== "function") return true;
  const { success } = await env.RATE_LIMITER.limit({ key: `${route}:${bucket}` });
  return success;
}

/** The daily backstop in KV, counted only for a request that passed every cheap check. */
async function dailyAllowed(env, route, bucket, now) {
  const key = await dailyKey(route, bucket, env, now);
  const n = parseInt((await env.SUB.get(key)) || "0", 10);
  if (n >= PER_IP_PER_DAY) return false;
  // Read then write on eventually consistent KV: a burst can pass the limit by a few. The
  // Rate Limiting binding is the real burst guard.
  await env.SUB.put(key, String(n + 1), { expirationTtl: 2 * 86400 });
  return true;
}

class Refused extends Error {
  constructor(status, body) {
    super(body.error);
    this.status = status;
    this.body = body;
  }
}

/**
 * The checks every intake request passes before the Worker reads a byte of body or touches KV:
 * the salt is set (review L3), the burst limit, a declared length within MAX_BODY (411 without
 * one, review L2), and the content type. Then the body, parsed without throwing.
 */
async function admit(request, env, route, types) {
  if (!env.IP_SALT) throw new Refused(503, { error: "intake is not configured; try again later" });
  const bucket = clientBucket(request.headers.get("CF-Connecting-IP"));
  if (!(await burstAllowed(env, route, bucket))) throw new Refused(429, { error: "too many requests; wait a minute" });
  const lenHeader = request.headers.get("Content-Length");
  if (lenHeader === null || !/^\d+$/.test(lenHeader)) throw new Refused(411, { error: "send a Content-Length" });
  if (parseInt(lenHeader, 10) > MAX_BODY) throw new Refused(413, { error: `request larger than ${MAX_BODY} bytes` });
  const ctype = request.headers.get("Content-Type") || "";
  if (!types.some((t) => ctype.startsWith(t))) {
    throw new Refused(415, { error: route === "finding" ? "send multipart/form-data (see GET /finding)" : "send multipart/form-data with field 'file', or a text/markdown body" });
  }
  let body;
  try {
    body = ctype.startsWith("multipart/form-data") ? await request.formData() : new Uint8Array(await request.arrayBuffer());
  } catch {
    throw new Refused(400, { error: "the request body could not be read" });
  }
  return { bucket, ctype, body };
}

/**
 * The age attestation a request carries: `{ attestation }` when the box was ticked and a published
 * terms version named, or `{ error }`. Only these three values are ever stored; no date of birth.
 */
function readAttestation(ticked, version, now) {
  const t = typeof ticked === "string" ? ticked.trim().toLowerCase() : "";
  if (!ATTESTED_VALUES.includes(t)) {
    return { error: `confirm the age attestation: ${FORM_ATTESTATION} (form field age_attested=yes)` };
  }
  const v = typeof version === "string" ? version.trim() : "";
  if (!TERMS_VERSIONS.includes(v)) {
    return { error: `name the Terms and Privacy Policy version you accept (form field terms_version=${TERMS_VERSION}); see ${TERMS_URL}` };
  }
  return { attestation: { age_attested: true, terms_version: v, ts: now.toISOString() } };
}

async function handleUpload(request, env, now) {
  const { bucket, ctype, body } = await admit(request, env, "upload", ["multipart/form-data", "text/markdown", "text/plain"]);
  let mdBytes, zipBytes = null, contact = "";
  const multipart = ctype.startsWith("multipart/form-data");
  const att = multipart
    ? readAttestation(body.get("age_attested"), body.get("terms_version"), now)
    : readAttestation(request.headers.get("X-TF-Age-Attested"), request.headers.get("X-TF-Terms-Version"), now);
  if (att.error) return json(400, { error: att.error });
  if (multipart) {
    const file = body.get("file");
    if (!file || typeof file === "string") return json(400, { error: "missing form field 'file' (your markdown)" });
    mdBytes = new Uint8Array(await file.arrayBuffer());
    const zipFile = body.get("attachment");
    if (zipFile && typeof zipFile !== "string" && zipFile.size > 0) zipBytes = new Uint8Array(await zipFile.arrayBuffer());
    const c = body.get("contact");
    if (typeof c === "string") contact = c.trim();
  } else {
    mdBytes = body;
  }
  if (mdBytes.length > MAX_MD) return json(413, { error: `markdown larger than ${MAX_MD} bytes` });
  const md = decodeMarkdown(mdBytes);
  if (md.error) return json(400, { error: md.error });
  if (zipBytes) {
    if (zipBytes.length > MAX_ZIP) return json(413, { error: `attachment larger than ${MAX_ZIP} bytes` });
    if (!isZip(zipBytes)) return json(400, { error: "the attachment must be a .zip file" });
  }
  if (contact.length > MAX_CONTACT) return json(400, { error: `contact longer than ${MAX_CONTACT} characters` });

  // Every cheap check has passed: only now does the request cost a KV write.
  if (!(await dailyAllowed(env, "upload", bucket, now))) {
    return json(429, { error: `limit of ${PER_IP_PER_DAY} uploads per day reached; try again tomorrow (UTC)` });
  }
  const receipt = receiptId();
  const receivedAt = now.toISOString();
  const sha256 = await sha256Hex(mdBytes);
  const meta = {
    receipt,
    received_at: receivedAt,
    kind: "upload",
    sha256,
    bytes: mdBytes.length,
    has_attachment: !!zipBytes,
    contact: contact || undefined,
    attestation: att.attestation,
  };
  await env.SUB.put(`sub:${receivedAt}:${receipt}`, md.text, { metadata: meta });
  if (zipBytes) await env.SUB.put(`zip:${receipt}`, zipBytes);

  return json(201, {
    receipt,
    sha256,
    received_at: receivedAt,
    note: "Received. Quote this receipt in the Transit Fabric Discord or a GitHub Issue if you want to follow up. Plain uploads are private and earn no bounty credit; for points use the signed form at /finding.",
  });
}

async function readOpen(env, account) {
  try {
    const v = JSON.parse((await env.SUB.get(`open:${account}`)) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * The registered accounts, `{ <account id hex>: { github, tier } }`, which the maintainers' tools
 * rebuild from the claim Issues and the pass history and push with PUT /admin/registered
 * (review M2). `null` when there is no list: the form then refuses everything (fails closed).
 */
async function readRegistered(env) {
  const raw = await env.SUB.get("reg:accounts");
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v.accounts === "object" ? v.accounts : null;
  } catch {
    return null;
  }
}

function bountyOpen(env) {
  return String(env?.BOUNTY_OPEN || "").trim().toLowerCase() === "true";
}

async function handleFinding(request, env, now) {
  if (!bountyOpen(env)) {
    return json(503, {
      error: "The public bug bounty is not open yet. Private bug and security reports are welcome via POST /upload (plain upload) or GitHub Security Advisories; any pre-opening credit is strictly discretionary. We will announce the opening date on https://transitfabric.xyz/bounty.html and in Discord.",
    });
  }
  const { bucket, body: form } = await admit(request, env, "finding", ["multipart/form-data"]);
  const fields = {};
  for (const k of FORM_FIELDS) {
    const v = form.get(k);
    fields[k] = typeof v === "string" ? normalizeField(v) : "";
  }
  const att = readAttestation(form.get("age_attested"), form.get("terms_version"), now);
  if (att.error) return json(400, { error: att.error, problems: [att.error] });
  const poc = form.get("poc");
  if (!poc || typeof poc === "string" || poc.size === 0) {
    return json(400, { error: "a proof-of-concept zip is required (form field 'poc')", problems: ["a proof-of-concept attachment is required"] });
  }
  if (poc.size > MAX_ZIP) return json(413, { error: `the proof of concept is larger than ${MAX_ZIP} bytes` });
  const pocBytes = new Uint8Array(await poc.arrayBuffer());
  if (!isZip(pocBytes)) return json(400, { error: "the proof of concept must be a .zip file" });
  fields.poc_sha256 = await sha256Hex(pocBytes);

  const problems = fieldProblems(fields);
  const account = accountId(fields.address);
  if (!account) problems.push("address is not a valid ss58 address");
  if (problems.length) return json(400, { error: "the finding is incomplete", problems });

  const date = normalizeField(form.get("date"));
  if (!dateAccepted(date, now)) {
    return json(400, { error: "date must be today's or yesterday's date (UTC), as YYYY-MM-DD, the date in the signed message" });
  }
  const digest = await sha256Hex(canonicalFinding(fields));
  const message = findingMessage({ github: fields.github, address: fields.address, digest, date });
  const signature = normalizeField(form.get("signature"));
  const verification = verifyWalletSignature(message, fields.address, signature);
  if (!verification.ok) {
    return json(401, { error: `signature check failed: ${verification.reason}`, message_to_sign: message, sha256: digest, poc_sha256: fields.poc_sha256 });
  }

  // KV reads from here on; still no writes.
  const registered = await readRegistered(env);
  if (registered === null) return json(503, { error: "the registration list is unavailable; try again later" });
  const reg = registered[account];
  if (!reg) {
    return json(403, { error: "this address is not registered. Register it on https://transitfabric.xyz/claim.html (your hotkey or coldkey address); registrations are picked up within the hour." });
  }
  if (String(reg.github).toLowerCase() !== fields.github.toLowerCase()) {
    return json(403, { error: "this address is registered to another GitHub account" });
  }
  // The tier is the lower of the one claimed and the one the maintainers pushed (review M2).
  const tier = reg.tier === "verified" && fields.eligibility === "verified" ? "verified" : "open";
  if (tier === "open" && !OPEN_SEVERITIES.includes(fields.severity)) {
    return json(403, { error: "you're not a verified tester yet, so only critical or high findings earn points" });
  }
  // Dedupe on the account's key bytes, not the address string, so another ss58 prefix is the
  // same finding (review L4). The signature stays over the address as the submitter wrote it.
  const dedupe = await sha256Hex(canonicalFinding({ ...fields, address: account, github: fields.github.toLowerCase() }));
  let earlier = await env.SUB.get(`dig:${dedupe}`);
  if (earlier === null && fields.github !== fields.github.toLowerCase()) {
    // Keys written before the case-insensitive dedupe (2026-11-25) used the handle as typed.
    // TODO(PB-71): drop this fallback after 2026-12-26.
    earlier = await env.SUB.get(`dig:${await sha256Hex(canonicalFinding({ ...fields, address: account }))}`);
  }
  if (earlier !== null) return json(409, { error: "this finding was already submitted", receipt: earlier });
  const open = await readOpen(env, account);
  const cap = MAX_OPEN[tier];
  if (open.length >= cap) {
    return json(429, {
      error: `${open.length} of your findings are still open; the ${tier} tier allows ${cap} at a time. Wait for a verdict first.`,
      open,
    });
  }
  if (!(await dailyAllowed(env, "finding", bucket, now))) {
    return json(429, { error: `limit of ${PER_IP_PER_DAY} submissions per day reached; try again tomorrow (UTC)` });
  }

  const receipt = receiptId();
  const receivedAt = now.toISOString();
  const key = `fnd:${receivedAt}:${receipt}`;
  const reattest = reg.needs_reattest === true;
  const record = { v: 1, receipt, received_at: receivedAt, fields, date, message, digest, signature, verification, tier, poc_bytes: pocBytes.length, attestation: att.attestation, needs_reattest: reattest };
  const meta = {
    receipt,
    received_at: receivedAt,
    kind: "finding",
    sha256: digest,
    bytes: pocBytes.length,
    has_attachment: true,
    github: fields.github,
    account,
    severity: fields.severity,
    eligibility: tier,
    component: fields.component,
    title: fields.title.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80),
    attestation: att.attestation,
    needs_reattest: reattest || undefined,
  };
  await env.SUB.put(`zip:${receipt}`, pocBytes);
  await env.SUB.put(key, JSON.stringify(record), { metadata: meta });
  await env.SUB.put(`dig:${dedupe}`, receipt);
  await env.SUB.put(`rcpt:${receipt}`, JSON.stringify({ key, account }));
  // A hint, not the truth: KV has no compare-and-set, so concurrent submissions (or a verdict
  // racing a submission, review L5) can lose an entry here. Triage recounts open findings from the
  // fnd: listing minus recorded verdicts and flags anything over the cap.
  await env.SUB.put(`open:${account}`, JSON.stringify([...open, receipt]));

  return json(201, {
    receipt,
    sha256: digest,
    received_at: receivedAt,
    signed_by: fields.address,
    tier,
    note: "Received and signature verified. A first pass checks the reproduction, duplicates and your eligibility tier, then a maintainer reviews it. Quote this receipt to follow up.",
    ...(reattest ? { needs_reattest: true, reattest_note: "Your registration was signed before the age attestation was added. Sign the current message on https://transitfabric.xyz/claim.html to stay eligible for rewards; nothing you sent is lost." } : {}),
  });
}

/** Checks and normalises a pushed registered-accounts list; returns `{ accounts }` or `{ error }`. */
function parseRegistered(body) {
  if (!body || !Array.isArray(body.accounts)) return { error: "send JSON {accounts: [{address or account, github, tier}]}" };
  if (body.accounts.length > 5000) return { error: "too many accounts" };
  const accounts = {};
  for (const [i, a] of body.accounts.entries()) {
    const id = typeof a?.account === "string" && /^[0-9a-f]{64}$/.test(a.account) ? a.account : accountId(a?.address);
    if (!id) return { error: `entry ${i}: no valid account id or ss58 address` };
    if (!GITHUB_RE.test(String(a.github || ""))) return { error: `entry ${i}: github is not a GitHub username` };
    if (!["verified", "open"].includes(a.tier)) return { error: `entry ${i}: tier must be verified or open` };
    if (a.needs_reattest !== undefined && typeof a.needs_reattest !== "boolean") return { error: `entry ${i}: needs_reattest must be true or false` };
    accounts[id] = { github: a.github.toLowerCase(), tier: a.tier, ...(a.needs_reattest ? { needs_reattest: true } : {}) };
  }
  return { accounts };
}

async function handleAdmin(request, env, url, now) {
  if (!isAdmin(request, env)) return json(404, { error: "not found" });
  if (url.pathname === "/admin/registered") {
    if (request.method === "PUT") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json(400, { error: "send JSON {accounts: [...]}" });
      }
      const r = parseRegistered(body);
      if (r.error) return json(400, { error: r.error });
      await env.SUB.put("reg:accounts", JSON.stringify({ v: 1, updated_at: now.toISOString(), accounts: r.accounts }));
      return json(200, { accounts: Object.keys(r.accounts).length, updated_at: now.toISOString() });
    }
    if (request.method === "GET") {
      const raw = await env.SUB.get("reg:accounts");
      return raw === null ? json(404, { error: "no list" }) : json(200, JSON.parse(raw));
    }
    return json(404, { error: "not found" });
  }
  if (request.method === "GET" && url.pathname === "/admin/list") {
    const since = url.searchParams.get("since") || "";
    const out = [];
    for (const prefix of ["sub:", "fnd:"]) {
      let cursor;
      do {
        const page = await env.SUB.list({ prefix, cursor });
        for (const k of page.keys) {
          if (k.name.slice(4) > since) out.push({ key: k.name, kind: prefix === "fnd:" ? "finding" : "upload", ...k.metadata });
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }
    out.sort((a, b) => (a.key.slice(4) < b.key.slice(4) ? -1 : a.key.slice(4) > b.key.slice(4) ? 1 : a.key < b.key ? -1 : 1));
    return json(200, { count: out.length, submissions: out });
  }
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return json(404, { error: "not found" });
  }
  const verdict = path.match(/^\/admin\/verdict\/(tf-[a-z0-9]+)$/);
  if (verdict && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "send JSON {status, reason}" });
    }
    if (!VERDICTS.includes(body?.status)) return json(400, { error: `status must be one of ${VERDICTS.join(", ")}` });
    const rc = await env.SUB.get(`rcpt:${verdict[1]}`);
    if (rc === null) return json(404, { error: "not found" });
    const { account } = JSON.parse(rc);
    // Read-modify-write, like a submission's: one racing it can put this receipt back (review L5).
    // Posting the verdict again removes it; triage's open count doesn't depend on this list.
    const open = (await readOpen(env, account)).filter((r) => r !== verdict[1]);
    await env.SUB.put(`open:${account}`, JSON.stringify(open));
    const v = { status: body.status, reason: String(body.reason || "").slice(0, 2000), at: now.toISOString() };
    await env.SUB.put(`verdict:${verdict[1]}`, JSON.stringify(v));
    return json(200, { receipt: verdict[1], ...v, open_for_account: open.length });
  }
  if (request.method !== "GET") return json(404, { error: "not found" });
  const get = path.match(/^\/admin\/get\/((?:sub|fnd):[^/]+)$/);
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
  const vget = path.match(/^\/admin\/verdict\/(tf-[a-z0-9]+)$/);
  if (vget) {
    const v = await env.SUB.get(`verdict:${vget[1]}`);
    return v === null ? json(404, { error: "no verdict" }) : json(200, JSON.parse(v));
  }
  return json(404, { error: "not found" });
}

const STYLE = `<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#5f5e5a;--line:#d9d8d2;--accent:#3451d1;--card:#fff;--bad:#b3261e;--ok:#1e7b34}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a6a59e;--line:#3a3a37;--accent:#8ea0ff;--card:#1d1d1b;--bad:#ff8a80;--ok:#7bd88f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}h1{font-size:1.6rem;margin:0 0 8px}h2{font-size:1.15rem;margin:0 0 6px}
p,li{color:var(--fg)}.muted{color:var(--muted)}a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin:20px 0}
label{display:block;font-weight:600;margin:14px 0 6px}
input[type=text],select,textarea{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
textarea{min-height:110px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9rem}
button{margin-top:18px;margin-right:8px;padding:10px 18px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
pre{white-space:pre-wrap;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:12px;font-size:.9rem}
.warn{border-left:4px solid var(--accent);padding-left:12px}.bad{color:var(--bad)}.ok{color:var(--ok)}
label.check{display:flex;gap:10px;align-items:flex-start;font-weight:600}label.check input{margin-top:5px;flex:none}
footer{max-width:720px;margin:0 auto;padding:0 16px 40px;color:var(--muted);font-size:.9rem}
</style>`;

/** The attestation box and the terms version, the same on both forms. */
const ATTEST_FIELDS = `<label class="check" for="age_attested"><input id="age_attested" name="age_attested" type="checkbox" value="yes" required><span>${FORM_ATTESTATION} (<a href="${TERMS_URL}">Terms</a>, <a href="${PRIVACY_URL}">Privacy Policy</a>, version ${TERMS_VERSION}).</span></label>
<input type="hidden" name="terms_version" value="${TERMS_VERSION}">`;

const FOOTER = `<footer>Testnet subnet 611 only. <a href="${TERMS_URL}">Terms</a> · <a href="${PRIVACY_URL}">Privacy</a> · <a href="https://transitfabric.xyz/bounty.html">Bounty rules</a></footer>`;

function renderPage(open) {
  const banner = open
    ? `<p><strong>For points, use the <a href="/finding">signed finding form</a>.</strong> It needs a registration on the <a href="https://transitfabric.xyz/claim.html">claim page</a>, a reproduction, the version, and a proof-of-concept zip, and your registered wallet signs it. See the <a href="https://transitfabric.xyz/bounty.html">bounty page</a>.</p>
<p>The plain upload below needs no account and <strong>earns no credit</strong>. Both are private: read by the maintainers and never shown publicly, so security findings are welcome.</p>`
    : `<p><strong>Bug bounty: not open yet.</strong> The public bug bounty and signed finding form (<code>/finding</code>) are paused while we roll out scoring version 2 and clear major pre-audit hardening fixes. We will announce the official opening date on the <a href="https://transitfabric.xyz/bounty.html">bounty page</a> and in Discord.</p>
<p>Private bug and security reports are still welcome through the plain upload below (or <a href="https://github.com/transitfabric/releases/security/advisories/new">GitHub Security Advisories</a>). Uploads are read privately by maintainers and never shown publicly; any credit before the official opening is strictly discretionary.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Findings Sandbox | Transit Fabric</title>
${STYLE}</head><body><main>
<h1>Findings sandbox</h1>
<p class="muted">Private intake for Transit Fabric testnet findings.</p>
<div class="card warn">
${banner}
<p>Never include a private key, seed phrase or wallet file. Remove IP addresses from logs.</p>
</div>
<form class="card" id="f">
<h2>Plain upload${open ? " (no credit)" : " (private report)"}</h2>
<label for="file">Your finding (markdown, up to 1 MB)</label>
<input id="file" name="file" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" required>
<p class="muted">Use the <a href="https://transitfabric.xyz/redteam/FINDING.md">finding template</a>.</p>
<label for="attachment">Attachment (optional .zip, up to 10 MB)</label>
<input id="attachment" name="attachment" type="file" accept=".zip,application/zip">
<label for="contact">Contact (optional: a Discord name or email, if you want a reply)</label>
<input id="contact" name="contact" type="text" maxlength="200">
${ATTEST_FIELDS}
<button type="submit">Upload</button>
</form>
<div class="card" id="out" hidden><strong>Result</strong><pre id="res"></pre></div>
<div class="card"><strong>For agents and scripts</strong>
<pre>curl -sS -F file=@finding.md -F age_attested=yes -F terms_version=${TERMS_VERSION} https://submit.transitfabric.xyz/upload
# optional: -F attachment=@repro.zip -F contact=yourname</pre>
<p class="muted"><code>age_attested=yes</code> confirms: ${FORM_ATTESTATION}. Without it the upload is refused.</p>
<p class="muted">The reply is JSON with a receipt ID. Limit: ${PER_IP_PER_DAY} uploads per day per address.${open ? ' For the signed form from a script, see <a href="/finding">/finding</a>.' : ""}</p></div>
</main><script>
document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();
const out=document.getElementById('out'),res=document.getElementById('res');out.hidden=false;res.textContent='Uploading…';
try{const r=await fetch('/upload',{method:'POST',body:new FormData(e.target)});res.textContent=await r.text();}
catch(err){res.textContent='Upload failed: '+err.message;}});
</script>${FOOTER}</body></html>`;
}

const opts = (list) => list.map((v) => `<option value="${v}">${v}</option>`).join("");

function renderFormPage(open) {
  if (!open) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signed Finding (Not Open Yet) | Transit Fabric</title>
${STYLE}</head><body><main>
<h1>Signed finding — not open yet</h1>
<p class="muted">Rules: <a href="https://transitfabric.xyz/bounty.html">bounty page</a>.</p>
<div class="card warn">
<p><strong>The public bug bounty is not open yet.</strong> The signed finding form (<code>POST /finding</code>) is paused while we finish scoring version 2 and major pre-audit hardening fixes. We will announce the official opening date and baseline release on the <a href="https://transitfabric.xyz/bounty.html">bounty page</a> and in Discord.</p>
<p>Private bug and security reports are still welcome through the <a href="/">plain upload form</a> or <a href="https://github.com/transitfabric/releases/security/advisories/new">GitHub Security Advisories</a>. Any credit for reports sent before the official opening is strictly discretionary.</p>
</div>
</main>${FOOTER}</body></html>`;
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signed Finding | Transit Fabric</title>
${STYLE}</head><body><main>
<h1>Signed finding</h1>
<p class="muted">The way a Transit Fabric finding earns points. Rules: <a href="https://transitfabric.xyz/bounty.html">bounty page</a>.</p>
<div class="card warn">
<p><strong>Before you start:</strong> points need a registration. Register once on the <a href="https://transitfabric.xyz/claim.html">claim page</a> with your hotkey or coldkey address (the one your testnet UID uses, or its coldkey), so we can find your nodes. This form must be signed by that same address.</p>
<p><strong>Verified testers</strong> (a node bound to your claimed account has passed validators' tests on at least 7 days) may report any severity, with up to 5 findings open. <strong>Everyone else</strong> may report Critical or High findings with a working reproduction, one open at a time.</p>
<p>Signing moves no funds. Never paste a seed phrase or private key. Remove machine addresses and hostnames from logs.</p>
</div>
<form class="card" id="f">
<label for="github">GitHub username (as registered)</label><input id="github" name="github" type="text" maxlength="39" required>
<label for="address">Registered address (ss58)</label><input id="address" name="address" type="text" maxlength="60" required>
<label for="title">Title: what breaks, and who gains</label><input id="title" name="title" type="text" maxlength="200" required>
<label for="version">Version: a release tag, or redteam-pack-&lt;sha&gt; for a simulator finding</label><input id="version" name="version" type="text" maxlength="64" placeholder="v0.1.0-tester.3.1" required>
<label for="severity">Severity you claim</label><select id="severity" name="severity">${opts(SEVERITIES)}</select>
<label for="eligibility">Your tier</label><select id="eligibility" name="eligibility"><option value="verified">verified tester</option><option value="open">everyone else (critical or high only)</option></select>
<label for="component">Component</label><select id="component" name="component">${opts(COMPONENTS)}</select>
<label for="repro">Steps to reproduce (numbered, exact commands, against the version above)</label><textarea id="repro" name="repro" required></textarea>
<label for="expected">Expected (cite the spec or threat-model section)</label><textarea id="expected" name="expected" required></textarea>
<label for="actual">Actual</label><textarea id="actual" name="actual" required></textarea>
<label for="details">Impact, simulator scenario, suggested fix (optional, markdown)</label><textarea id="details" name="details"></textarea>
<label for="poc">Proof of concept (.zip, up to 10 MB: the script, sim scenario or logs that reproduce it)</label><input id="poc" name="poc" type="file" accept=".zip,application/zip" required>
${ATTEST_FIELDS}
<button type="button" id="prep">1. Prepare the message</button>
</form>
<div class="card" id="sigcard" hidden>
<h2>2. Sign</h2>
<p>Message to sign (it names your fields by their SHA-256):</p><pre id="msg"></pre>
<button type="button" id="wallet">Sign with a browser wallet</button>
<p class="muted">Or with btcli, then paste the signature below:</p><pre id="btcli"></pre>
<label for="signature">Signature (hex)</label><input id="signature" type="text">
<button type="button" id="send" disabled>3. Submit</button>
<p id="status"></p>
</div>
<div class="card" id="out" hidden><strong>Result</strong><pre id="res"></pre></div>
<div class="card"><strong>For agents and scripts</strong>
<p class="muted">Compute the message with <code>node deploy/bounty/bin/finding-message.mjs --fields finding.json --poc repro.zip</code> (the bounty tools), sign it with <code>btcli wallet sign --no-use-hotkey --message '&lt;message&gt;'</code>, then:</p>
<pre>curl -sS https://submit.transitfabric.xyz/finding \\
  -F github=... -F address=... -F title=... -F version=... -F severity=... \\
  -F eligibility=... -F component=... -F 'repro=<repro.txt' -F expected=... -F actual=... \\
  -F 'details=<details.md' -F poc=@repro.zip -F date=YYYY-MM-DD -F signature=0x... \\
  -F age_attested=yes -F terms_version=${TERMS_VERSION}</pre>
<p class="muted"><code>age_attested=yes</code> confirms: ${FORM_ATTESTATION}. Without it the finding is refused.</p>
<p class="muted">A wrong signature gets a 401 that names the exact message the server expected.</p></div>
</main><script>
(function(){'use strict';
var $=function(i){return document.getElementById(i);};
${PAGE_CANON_JS}
var state={message:null,date:null};
function hex(buf){return Array.from(new Uint8Array(buf)).map(function(b){return b.toString(16).padStart(2,'0');}).join('');}
async function sha(bytes){return hex(await crypto.subtle.digest('SHA-256',bytes));}
function say(t,c){var s=$('status');s.textContent=t;s.className=c||'';}
function fields(){var f={};['github','address','title','version','severity','eligibility','component','repro','expected','actual','details'].forEach(function(k){f[k]=normalizeField($(k).value);});return f;}
$('prep').addEventListener('click',async function(){
  var file=$('poc').files[0];
  if(!file){alert('Attach the proof-of-concept zip first.');return;}
  if(!$('age_attested').checked){alert('Confirm the age attestation first.');return;}
  var f=fields();
  if(!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(f.github)||!/^[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(f.address)){alert('Check your GitHub username and ss58 address first.');return;}f.poc_sha256=await sha(await file.arrayBuffer());
  var digest=await sha(new TextEncoder().encode(canonicalFinding(f)));
  state.date=new Date().toISOString().slice(0,10);
  state.message='Transit Fabric finding: github='+f.github+', address='+f.address+', sha256='+digest+', date='+state.date;
  $('msg').textContent=state.message;
  $('btcli').textContent="btcli wallet sign --wallet-name <your wallet> --no-use-hotkey --message '"+state.message+"'";
  $('sigcard').hidden=false;$('send').disabled=false;$('signature').value='';
  say('Fields are fixed by this message. If you edit the form, prepare it again.');
});
$('wallet').addEventListener('click',async function(){
  try{
    var inj=window.injectedWeb3||{},names=Object.keys(inj);
    if(!names.length){say('No wallet extension found. Use btcli instead.','bad');return;}
    var addr=normalizeField($('address').value),signed=null;
    for(var i=0;i<names.length&&!signed;i++){
      var ext=await inj[names[i]].enable('Transit Fabric findings');
      var accts=await ext.accounts.get();
      if(accts.some(function(a){return a.address===addr;})&&ext.signer&&ext.signer.signRaw){
        var data='0x'+hex(new TextEncoder().encode(state.message));
        signed=(await ext.signer.signRaw({address:addr,data:data,type:'bytes'})).signature;
      }
    }
    if(!signed){say('No connected wallet holds '+addr+'. Choose the registered account, or use btcli.','bad');return;}
    $('signature').value=signed;say('Signed. No funds moved. Now submit.','ok');
  }catch(e){say('Not signed: '+(e&&e.message||e),'bad');}
});
$('send').addEventListener('click',async function(){
  var fd=new FormData($('f'));fd.append('date',state.date);fd.append('signature',normalizeField($('signature').value));
  var out=$('out'),res=$('res');out.hidden=false;res.textContent='Submitting…';
  try{var r=await fetch('/finding',{method:'POST',body:fd});res.textContent=await r.text();}
  catch(e){res.textContent='Submit failed: '+e.message;}
});
})();
</script>${FOOTER}</body></html>`;
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'";

function page(html) {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP, ...SECURITY_HEADERS },
  });
}

export default {
  async fetch(request, env, _ctx, now = new Date()) {
    try {
      return await route(request, env, now);
    } catch (e) {
      if (e instanceof Refused) return json(e.status, e.body);
      // Never a 500 with internals (review L2): the client learns only that it failed.
      console.error("tf-submit: unhandled", e && e.name);
      return json(503, { error: "the request could not be handled; try again later" });
    }
  },
};

async function route(request, env, now) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-TF-Age-Attested, X-TF-Terms-Version",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method === "POST" && url.pathname === "/upload") return handleUpload(request, env, now);
  if (request.method === "POST" && url.pathname === "/finding") return handleFinding(request, env, now);
  if (url.pathname.startsWith("/admin/")) return handleAdmin(request, env, url, now);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return page(renderPage(bountyOpen(env)));
  if (request.method === "GET" && url.pathname === "/finding") return page(renderFormPage(bountyOpen(env)));
  return json(404, { error: "not found" });
}
