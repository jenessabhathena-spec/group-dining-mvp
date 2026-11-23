// Deploy hardening: headers + CSP, client IP behind a proxy, abuse limits, secrets at rest, config, backups.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openDb, hashLegacySecrets } from "../server/db.js";
import { createApp } from "../server/app.js";
import { cspFor, scriptHashes, clientIp, accessLine } from "../server/security.js";
import { checkProductionConfig } from "../server/config.js";
import { backupDb } from "../server/backup.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");

async function setup(opts = {}) {
  const db = openDb(":memory:");
  const clock = { t: Date.parse("2026-11-28T10:00:00+05:30") };
  const codes = {};
  const lines = [];
  const app = createApp({ db, now: () => clock.t, sendOtp: async (p, c) => (codes[p] = c), sendReminder: null, mapsKey: undefined, adminKey: "adm", accessLog: (l) => lines.push(l), ...opts });
  const server = app.server();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  const signIn = async (phone = "9876543210", firstName = "Jenessa", headers = {}) => {
    await call("POST", "/api/auth/request-otp", { phone }, headers);
    const v = await call("POST", "/api/auth/verify", { phone, code: codes["+91" + phone], firstName }, headers);
    return { auth: { Authorization: "Bearer " + v.body.token }, token: v.body.token };
  };
  return { db, clock, call, signIn, base, lines, server, close: () => server.close() };
}

// ---------- headers and CSP ----------

test("CSP lists exactly the page's inline scripts by hash; other directives lock everything else down", () => {
  const html = "<html><script>alert(1)</script><script src='/x.js'></script><SCRIPT type='module'>go()</SCRIPT></html>";
  const hashes = scriptHashes(html);
  assert.deepEqual(hashes, [
    `'sha256-${createHash("sha256").update("alert(1)").digest("base64")}'`,
    `'sha256-${createHash("sha256").update("go()").digest("base64")}'`,
  ], "external scripts are not hashed");
  const csp = cspFor(html);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.match(cspFor("<p>no scripts</p>"), /script-src 'none'/);
});

test("every page's CSP matches its own scripts, and security headers are on every response", async () => {
  const s = await setup();
  try {
    const { auth } = await s.signIn();
    const id = (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya"], organiserArea: "Koramangala" }, auth)).body.id;
    for (const path of ["/", `/p/${id}`, "/privacy", "/prototype"]) {
      const r = await s.call("GET", path);
      assert.equal(r.status, 200, path);
      const csp = r.headers.get("content-security-policy");
      for (const hsh of scriptHashes(r.text)) assert.ok(csp.includes(hsh), `${path}: CSP must allow its own script`);
      assert.equal(r.headers.get("x-frame-options"), "DENY");
      assert.equal(r.headers.get("referrer-policy"), "no-referrer");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.match(r.headers.get("permissions-policy"), /geolocation=\(self\)/);
      assert.equal(r.headers.get("strict-transport-security"), null, "no HSTS outside production");
    }
    const api = await s.call("GET", "/api/me");
    assert.equal(api.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
    assert.equal(api.headers.get("cache-control"), "no-store");
  } finally { s.close(); }
});

test("production: HSTS on, fictional prototype off; health check works", async () => {
  const s = await setup({ hsts: true, servePrototype: false });
  try {
    const r = await s.call("GET", "/healthz");
    assert.deepEqual(r.body, { ok: true });
    assert.match(r.headers.get("strict-transport-security"), /max-age=31536000/);
    assert.equal((await s.call("GET", "/prototype")).status, 404);
  } finally { s.close(); }
});

test("access log: method, path, status and time only, never the query string", async () => {
  const s = await setup();
  try {
    const { auth } = await s.signIn();
    await s.call("GET", "/api/places/search?q=Flat%204B%20Secret%20Apartments&token=abcdefgh12345678", null, auth);
    const line = s.lines.find((l) => l.startsWith("GET /api/places/search"));
    assert.match(line, /^GET \/api\/places\/search 200 \d+ms$/);
    assert.ok(!s.lines.join("\n").includes("Secret") && !s.lines.join("\n").includes("abcdefgh"));
    assert.equal(accessLine("POST", "/x", 201, 5), "POST /x 201 5ms");
  } finally { s.close(); }
});

// ---------- client IP ----------

test("client IP: X-Forwarded-For only counts behind a trusted proxy", () => {
  const req = (xff) => ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: "10.0.0.2" } });
  assert.equal(clientIp(req("1.2.3.4"), false), "10.0.0.2", "not trusted: header ignored");
  assert.equal(clientIp(req("1.2.3.4"), true), "1.2.3.4");
  assert.equal(clientIp(req("6.6.6.6, 1.2.3.4"), true), "1.2.3.4", "a client-supplied value before the proxy's is ignored");
  assert.equal(clientIp(req(""), true), "10.0.0.2");
});

test("a forged X-Forwarded-For doesn't dodge the sign-in limit unless the proxy is trusted", async () => {
  const s = await setup({ trustProxy: false });
  try {
    for (let i = 0; i < 5; i++) await s.call("POST", "/api/auth/request-otp", { phone: `98765432${10 + i}` }, { "x-forwarded-for": `9.9.9.${i}` });
    const r = await s.call("POST", "/api/auth/request-otp", { phone: "9876543299" }, { "x-forwarded-for": "9.9.9.99" });
    assert.equal(r.status, 429);
  } finally { s.close(); }
  const t = await setup({ trustProxy: true });
  try {
    for (let i = 0; i < 6; i++) {
      const r = await t.call("POST", "/api/auth/request-otp", { phone: `98765432${10 + i}` }, { "x-forwarded-for": `9.9.9.${i}` });
      assert.equal(r.status, 200, "behind the proxy each real client has its own bucket");
    }
  } finally { t.close(); }
});

// ---------- abuse limits ----------

test("sign-in: per-IP limit, then a daily ceiling on codes sent; the ceiling resets at midnight IST", async () => {
  const s = await setup({ limits: { otpDailyCap: 3 }, trustProxy: true });
  try {
    const req = (n, ip) => s.call("POST", "/api/auth/request-otp", { phone: `98765432${n}` }, { "x-forwarded-for": ip });
    for (let i = 0; i < 3; i++) assert.equal((await req(10 + i, `1.1.1.${i}`)).status, 200);
    const capped = await req(20, "1.1.1.50");
    assert.equal(capped.status, 503);
    assert.match(capped.body.error, /busy/);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'otp_sent'").get().n, 3);
    assert.ok(!JSON.stringify(s.db.prepare("SELECT payload FROM events WHERE type = 'otp_sent'").all()).includes("98765"), "no numbers in the counter");
    s.clock.t = Date.parse("2026-11-29T00:01:00+05:30");
    assert.equal((await req(21, "1.1.1.51")).status, 200, "a new day");
  } finally { s.close(); }
});

test("code verification is limited per IP as well as per code", async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 20; i++) await s.call("POST", "/api/auth/verify", { phone: "9876543210", code: "000000" });
    const r = await s.call("POST", "/api/auth/verify", { phone: "9876543210", code: "000000" });
    assert.equal(r.status, 429);
  } finally { s.close(); }
});

test("plans per organiser per day, answers per plan (8 people max) and per IP are capped", async () => {
  const s = await setup({ limits: { plansPerDay: 2, answersPerIp: 5 } });
  try {
    const { auth } = await s.signIn();
    const mk = () => s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", organiserArea: "Koramangala" }, auth); // no friends list: free names
    const id = (await mk()).body.id;
    // Per IP: 5 answers per 10 minutes (before the plan's 2-hour answer deadline).
    const ans = (name) => s.call("POST", `/api/plans/${id}/responses`, { name, area: "Koramangala", consent: true });
    for (const n of ["Aa", "Bb", "Cc", "Dd", "Ee"]) assert.equal((await ans(n)).status, 200);
    assert.equal((await ans("Ff")).status, 429);
    await mk();
    assert.equal((await mk()).status, 429);
    s.clock.t += 86400000 + 1000;
    assert.equal((await mk()).status, 200, "the next day");
  } finally { s.close(); }
  const t = await setup();
  try {
    const { auth } = await t.signIn();
    const id = (await t.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", organiserArea: "Koramangala", deadlineHours: 24 }, auth)).body.id;
    for (const n of ["Aa", "Bb", "Cc", "Dd", "Ee", "Ff", "Gg"]) assert.equal((await t.call("POST", `/api/plans/${id}/responses`, { name: n, area: "Koramangala", consent: true })).status, 200);
    const full = await t.call("POST", `/api/plans/${id}/responses`, { name: "Hh", area: "Koramangala", consent: true });
    assert.equal(full.status, 409);
    assert.match(full.body.error, /full/);
  } finally { t.close(); }
});

// ---------- secrets at rest, sessions ----------

test("session tokens are stored hashed, expire after 30 days, and sign-out ends them on the server", async () => {
  const s = await setup();
  try {
    const { auth, token } = await s.signIn();
    const stored = s.db.prepare("SELECT token FROM sessions").get().token;
    assert.notEqual(stored, token);
    assert.equal(stored, sha(token));
    assert.equal((await s.call("GET", "/api/me", null, auth)).status, 200);
    assert.equal((await s.call("GET", "/api/me", null, { Authorization: "Bearer " + stored })).status, 401, "the stored hash is not a usable token");
    s.clock.t += 30 * 86400000 + 1000;
    assert.equal((await s.call("GET", "/api/me", null, auth)).status, 401, "expired");
    s.clock.t -= 30 * 86400000 + 1000;
    const second = await s.signIn("9123456789", "Kabir");
    assert.equal((await s.call("POST", "/api/auth/logout", null, second.auth)).status, 200);
    assert.equal((await s.call("GET", "/api/me", null, second.auth)).status, 401, "signed out on the server");
    assert.equal((await s.call("GET", "/api/me", null, { Authorization: "Bearer not a token!" })).status, 401);
  } finally { s.close(); }
});

test("friends' member keys are stored hashed; keys saved before hashing still work", async () => {
  const s = await setup();
  try {
    const { auth } = await s.signIn();
    const id = (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya", "Arjun"], organiserArea: "Koramangala" }, auth)).body.id;
    const key = (await s.call("POST", `/api/plans/${id}/responses`, { name: "Riya", area: "Koramangala", consent: true })).body.memberKey;
    const row = s.db.prepare("SELECT member_key FROM responses WHERE name = 'Riya'").get();
    assert.equal(row.member_key, sha(key));
    assert.equal((await s.call("GET", `/api/plans/${id}/me`, null, { "x-member-key": key })).body.name, "Riya");
    assert.equal((await s.call("GET", `/api/plans/${id}/me`, null, { "x-member-key": row.member_key })).status, 403, "the stored hash is not a usable key");
    // An answer and a session stored before hashing (plain text) are converted when the database opens:
    // the old key and token keep working, and what's stored is no longer usable.
    s.db.prepare("INSERT INTO responses (plan_id, name, member_key, start_lat, start_lng, start_label, budget, dealbreakers, mood, created) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, "Arjun", "legacy-plain-key-123", 12.93, 77.62, null, null, "[]", null, s.clock.t);
    s.db.prepare("INSERT INTO sessions (token, phone, created) VALUES (?,?,?)").run("legacyPlainSessionToken123456", "+919876543210", s.clock.t);
    assert.equal((await s.call("GET", `/api/plans/${id}/me`, null, { "x-member-key": "legacy-plain-key-123" })).status, 403, "plain text is never compared");
    assert.equal(hashLegacySecrets(s.db), 2);
    assert.equal(s.db.prepare("SELECT member_key FROM responses WHERE name = 'Arjun'").get().member_key, sha("legacy-plain-key-123"));
    assert.equal((await s.call("GET", `/api/plans/${id}/me`, null, { "x-member-key": "legacy-plain-key-123" })).body.name, "Arjun");
    assert.equal((await s.call("GET", "/api/me", null, { Authorization: "Bearer legacyPlainSessionToken123456" })).status, 200);
    assert.equal(hashLegacySecrets(s.db), 0, "running it again changes nothing");
  } finally { s.close(); }
});

// ---------- production config ----------

test("production config: missing or unsafe settings are errors, risky ones warnings; dev is never blocked", () => {
  assert.deepEqual(checkProductionConfig({}), { errors: [], warnings: [] });
  const bad = checkProductionConfig({ NODE_ENV: "production", PUBLIC_URL: "http://plans.example.in/", ADMIN_KEY: "short", SMS_PROVIDER: "msg91" });
  const has = (list, re) => assert.ok(list.some((e) => re.test(e)), `${re} in ${list.join(" | ")}`);
  has(bad.errors, /PUBLIC_URL must be https/);
  has(bad.errors, /RESTAURANTS_CSV is required/);
  has(bad.errors, /needs MSG91_AUTHKEY/);
  has(bad.errors, /ADMIN_KEY must be at least 24/);
  has(bad.errors, /DB_PATH is required/);
  has(bad.warnings, /TRUST_PROXY/);
  const good = checkProductionConfig({ NODE_ENV: "production", PUBLIC_URL: "https://plans.example.in", RESTAURANTS_CSV: "/c.csv", SMS_PROVIDER: "msg91", MSG91_AUTHKEY: "k", MSG91_TEMPLATE_ID: "t", ADMIN_KEY: "x".repeat(32), DB_PATH: "/data/db.sqlite", TRUST_PROXY: "1", GOOGLE_MAPS_API_KEY: "g", BACKUP_DIR: "/data/b", MSG91_REMINDER_TEMPLATE_ID: "r", MSG91_REMINDER_SURPRISE_TEMPLATE_ID: "s" });
  assert.deepEqual(good, { errors: [], warnings: [] });
});

// ---------- backups ----------

test("backups are consistent copies, made while the app is running, and rotate to the newest N", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gd-backup-"));
  const dbFile = join(dir, "live.sqlite");
  const db = openDb(dbFile);
  db.prepare("INSERT INTO users (phone, first_name, created) VALUES (?,?,?)").run("+919876543210", "Jenessa", 1);
  const t0 = Date.parse("2026-11-20T00:00:00Z");
  let last;
  for (let d = 0; d < 9; d++) last = backupDb(db, join(dir, "b"), { keep: 7, now: t0 + d * 86400000 });
  const files = readdirSync(join(dir, "b")).sort();
  assert.equal(files.length, 7);
  assert.equal(files[0], "group-dining-20261122T000000Z.sqlite", "the two oldest were removed");
  assert.equal(last.removed.length, 1);
  const copy = new DatabaseSync(last.file, { readOnly: true });
  assert.equal(copy.prepare("SELECT first_name FROM users").get().first_name, "Jenessa");
  copy.close();
  writeFileSync(join(dir, "b", "notes.txt"), "keep me");
  backupDb(db, join(dir, "b"), { keep: 7, now: t0 + 20 * 86400000 });
  assert.ok(readdirSync(join(dir, "b")).includes("notes.txt"), "rotation only touches backup files");
  db.close();
});
