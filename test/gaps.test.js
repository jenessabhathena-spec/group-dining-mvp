// Remaining PRD gaps: next-day rating check, "closed or changed?" reports, organiser answering for a friend,
// tunable weights, veto reasons, the shared budget range, event retention.
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, purgeExpired } from "../server/db.js";
import { createApp } from "../server/app.js";
import { makeSendReminder, reminderText } from "../server/reminders.js";
import { RESTAURANTS } from "../src/data.js";

const IST = (s) => Date.parse(s + "+05:30");

async function setup(opts = {}) {
  const db = openDb(":memory:");
  const clock = { t: IST("2026-11-28T10:00:00") };
  const codes = {};
  const sent = [];
  const sendReminder = "sendReminder" in opts ? opts.sendReminder : Object.assign(async (phone, payload) => void sent.push({ phone, payload }), { supports: new Set(["place", "surprise", "rate"]) });
  const app = createApp({ db, now: () => clock.t, sendOtp: async (p, c) => (codes[p] = c), mapsKey: undefined, adminKey: "adm", publicUrl: "https://dine.example", ...opts, sendReminder });
  const server = app.server();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  const signIn = async (phone = "9876543210", firstName = "Jenessa") => {
    await call("POST", "/api/auth/request-otp", { phone });
    const v = await call("POST", "/api/auth/verify", { phone, code: codes["+91" + phone], firstName });
    return { Authorization: "Bearer " + v.body.token };
  };
  return { db, clock, call, signIn, app, sent, close: () => server.close() };
}
const ans = (name, extra = {}) => ({ name, area: "Koramangala", budget: 1500, mood: "chill", dealbreakers: [], consent: true, ...extra });
const ADMIN = { "x-admin-key": "adm" };
const plan = (s, org, extra = {}) => s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya"], organiserArea: "Koramangala", ...extra }, org).then((r) => r.body.id);
async function decided(s, org, extra) {
  const id = await plan(s, org, extra);
  const k = (await s.call("POST", `/api/plans/${id}/responses`, ans("Riya"))).body.memberKey;
  const pk = (await s.call("GET", `/api/plans/${id}/picks`)).body.picks[0];
  await s.call("POST", `/api/plans/${id}/decide`, { overridePickId: pk.id }, org);
  return { id, k, pk };
}

// ---------- F11: next-day check ----------

test("next-day nudge: one text to the organiser at 11:00 IST the day after, with a link to rate", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const { id, pk } = await decided(s, org);
    const nudges = () => s.sent.filter((x) => x.payload.kind === "rate");
    s.clock.t = IST("2026-11-29T10:59:00");
    await s.app.runReminders();
    assert.equal(nudges().length, 0, "not before 11:00 the next day");
    s.clock.t = IST("2026-11-29T11:00:00");
    await s.app.runReminders();
    assert.equal(nudges().length, 1);
    assert.deepEqual(nudges()[0], { phone: "+919876543210", payload: { kind: "rate", place: pk.name, url: `https://dine.example/?plan=${id}` } });
    s.clock.t = IST("2026-11-29T15:00:00");
    await s.app.runReminders();
    assert.equal(nudges().length, 1, "never twice");
  } finally { s.close(); }
});

test("next-day nudge is skipped if already rated, if texts are off for the plan, without PUBLIC_URL, after 2 days, or when the channel can't send it", async () => {
  // Already rated.
  let s = await setup();
  try {
    const org = await s.signIn();
    const { id } = await decided(s, org);
    s.clock.t = IST("2026-11-28T22:00:00");
    await s.call("POST", `/api/plans/${id}/ratings`, { went: "yes", stars: 5 }, org);
    s.clock.t = IST("2026-11-29T11:30:00");
    await s.app.runReminders();
    assert.equal(s.sent.filter((x) => x.payload.kind === "rate").length, 0);
  } finally { s.close(); }
  // Reminders switched off for the plan.
  s = await setup();
  try {
    const org = await s.signIn();
    await decided(s, org, { reminders: false });
    s.clock.t = IST("2026-11-29T11:30:00");
    await s.app.runReminders();
    assert.equal(s.sent.length, 0);
  } finally { s.close(); }
  // No PUBLIC_URL: no link to send.
  s = await setup({ publicUrl: undefined });
  try {
    const org = await s.signIn();
    await decided(s, org);
    s.clock.t = IST("2026-11-29T11:30:00");
    await s.app.runReminders();
    assert.equal(s.sent.filter((x) => x.payload.kind === "rate").length, 0);
  } finally { s.close(); }
  // Too late (more than 2 days after the nudge time).
  s = await setup();
  try {
    const org = await s.signIn();
    await decided(s, org);
    s.clock.t = IST("2026-12-01T12:00:00");
    await s.app.runReminders();
    assert.equal(s.sent.filter((x) => x.payload.kind === "rate").length, 0);
  } finally { s.close(); }
  // Channel without the rate template.
  const got = [];
  s = await setup({ sendReminder: Object.assign(async (p, payload) => void got.push(payload.kind), { supports: new Set(["place", "surprise"]) }) });
  try {
    const org = await s.signIn();
    await decided(s, org);
    s.clock.t = IST("2026-11-29T11:30:00");
    await s.app.runReminders();
    assert.ok(!got.includes("rate"));
  } finally { s.close(); }
});

test("rate nudge: text, and the MSG91 rate template is optional and pinned", async () => {
  assert.equal(reminderText({ kind: "rate", place: "Sample Dosa Lane", url: "https://x/?plan=1" }), "How was Sample Dosa Lane? Tell us in one tap (did you go, 1-5): https://x/?plan=1");
  const env = { MSG91_AUTHKEY: "k", MSG91_REMINDER_TEMPLATE_ID: "p", MSG91_REMINDER_SURPRISE_TEMPLATE_ID: "s" };
  assert.deepEqual([...makeSendReminder({ provider: "msg91", env }).supports].sort(), ["place", "surprise"]);
  const calls = [];
  const send = makeSendReminder({ provider: "msg91", env: { ...env, MSG91_RATE_TEMPLATE_ID: "r" }, fetchImpl: async (u, i) => (calls.push(JSON.parse(i.body)), { ok: true, status: 200, json: async () => ({ type: "success" }) }) });
  assert.ok(send.supports.has("rate"));
  await send("+919876543210", { kind: "rate", place: "Sample Dosa Lane", url: "https://x/?plan=1" });
  assert.deepEqual(calls[0], { template_id: "r", recipients: [{ mobiles: "919876543210", place: "Sample Dosa Lane", url: "https://x/?plan=1" }] });
  assert.ok(makeSendReminder({ provider: "", env: {} }).supports.has("rate"), "dev mode prints all kinds");
});

// ---------- "Closed or changed?" ----------

test("place reports: from a plan or signed in, validated, rate-limited, grouped for the weekly review", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = await plan(s, org);
    const rep = (b, h = {}) => s.call("POST", "/api/reports", b, h);
    assert.equal((await rep({ restaurantId: "r01", kind: "closed" })).status, 403, "no plan and not signed in");
    assert.equal((await rep({ restaurantId: "nope", kind: "closed", planId: id })).status, 404);
    assert.equal((await rep({ restaurantId: "r01", kind: "haunted", planId: id })).status, 400);
    assert.equal((await rep({ restaurantId: "r01", kind: "closed", planId: id })).status, 200);
    assert.equal((await rep({ restaurantId: "r01", kind: "changed", planId: id, note: "  Prices up a lot " + "x".repeat(300) })).status, 200);
    assert.equal((await rep({ restaurantId: "r02", kind: "other" }, org)).status, 200, "signed in, from solo");
    const r = await s.call("GET", "/api/admin/reports?days=7", null, ADMIN);
    assert.equal(r.body.places[0].restaurantId, "r01");
    assert.deepEqual([r.body.places[0].total, r.body.places[0].closed, r.body.places[0].changed], [2, 1, 1]);
    assert.equal(r.body.places[0].name, "Sample Tandoor House");
    assert.equal(r.body.places[0].notes[0].length, 200, "note trimmed and capped");
    assert.ok(r.body.places[0].notes[0].startsWith("Prices up"));
    assert.equal((await s.call("GET", "/api/admin/reports")).status, 403);
    for (let i = 0; i < 20; i++) await rep({ restaurantId: "r03", kind: "closed", planId: id });
    assert.equal((await rep({ restaurantId: "r03", kind: "closed", planId: id })).status, 429);
  } finally { s.close(); }
});

// ---------- organiser answers for a friend ----------

test("organiser answers for a friend: needs their okay, only for listed friends, no vote key for the organiser", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = await plan(s, org, { friends: ["Riya", "Arjun"] });
    const behalf = (b, h = org) => s.call("POST", `/api/plans/${id}/responses`, { onBehalf: true, name: "Riya", area: "HSR Layout", budget: 1200, ...b }, h);
    assert.equal((await behalf({ organiserConsent: true }, {})).status, 403, "only the organiser");
    assert.equal((await behalf({})).status, 400, "must confirm the friend's okay");
    assert.equal((await behalf({ organiserConsent: true, name: "Stranger" })).status, 400);
    assert.equal((await behalf({ organiserConsent: true, reminderPhone: "9988776655" })).status, 400, "a friend asks for their own reminder");
    const ok = await behalf({ organiserConsent: true });
    assert.equal(ok.status, 200);
    assert.ok(!("memberKey" in ok.body), "the organiser never gets a key to vote with");
    assert.match(ok.body.claimUrl, new RegExp(`^https://dine\\.example/p/${id}#claim=[A-Za-z0-9_-]+$`));
    assert.match(decodeURIComponent(ok.body.whatsapp), /I filled in the dinner plan for you/);
    assert.equal(s.db.prepare("SELECT entered_by_organiser e FROM responses WHERE name = 'Riya'").get().e, 1);
    assert.deepEqual((await s.call("GET", `/api/plans/${id}`)).body.answered, ["Riya"]);
    // The claim link's key identifies Riya, so she can take over.
    const key = ok.body.claimUrl.split("#claim=")[1];
    assert.deepEqual((await s.call("GET", `/api/plans/${id}/me`, null, { "x-member-key": key })).body, { name: "Riya", enteredByOrganiser: true });
    assert.equal((await s.call("GET", `/api/plans/${id}/me`, null, { "x-member-key": "bogus-key-123" })).status, 403);
    // Arjun answers himself; picks generate; Riya votes with the claimed key.
    await s.call("POST", `/api/plans/${id}/responses`, ans("Arjun", { cid: "cid-arjun-01" }));
    const pk = (await s.call("GET", `/api/plans/${id}/picks`)).body.picks[0].id;
    assert.equal((await s.call("POST", `/api/plans/${id}/votes`, { pickId: pk, memberKey: key })).status, 200);
    // Organiser-entered answers don't count as a friend responding to the link.
    const ev = s.db.prepare("SELECT payload FROM events WHERE type = 'response_submitted' ORDER BY id").all().map((r) => JSON.parse(r.payload));
    assert.deepEqual(ev[0], { byOrganiser: true });
  } finally { s.close(); }
});

// ---------- weights ----------

test("engine weights are tunable by admin, validated, and recorded in each plan's log", async () => {
  const s = await setup();
  try {
    assert.deepEqual((await s.call("GET", "/api/admin/weights", null, ADMIN)).body.weights, { taste: 1, fairness: 1, mood: 1, novelty: 1, quality: 1 });
    assert.equal((await s.call("PUT", "/api/admin/weights", { quality: 3 })).status, 403);
    assert.equal((await s.call("PUT", "/api/admin/weights", { quality: 9 }, ADMIN)).status, 400);
    assert.equal((await s.call("PUT", "/api/admin/weights", { vibes: 1 }, ADMIN)).status, 400);
    assert.equal((await s.call("PUT", "/api/admin/weights", { taste: 0, fairness: 0, mood: 0, novelty: 0, quality: 0 }, ADMIN)).status, 400);
    const ok = await s.call("PUT", "/api/admin/weights", { quality: 3, novelty: 0.5 }, ADMIN);
    assert.deepEqual(ok.body.weights, { taste: 1, fairness: 1, mood: 1, novelty: 0.5, quality: 3 });
    const org = await s.signIn();
    const { id } = await decided(s, org);
    const log = (await s.call("GET", `/api/admin/plans/${id}/log`, null, ADMIN)).body.log;
    assert.deepEqual(log.inputs.weights, { taste: 1, fairness: 1, mood: 1, novelty: 0.5, quality: 3 });
  } finally { s.close(); }
});

// ---------- veto reasons ----------

test("veto reasons are optional, allow-listed, and summed in the metrics", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = await plan(s, org, { friends: ["Riya", "Arjun"] });
    const r = (await s.call("POST", `/api/plans/${id}/responses`, ans("Riya"))).body.memberKey;
    const a = (await s.call("POST", `/api/plans/${id}/responses`, ans("Arjun"))).body.memberKey;
    let shown = (await s.call("GET", `/api/plans/${id}/picks`)).body.picks;
    await s.call("POST", `/api/plans/${id}/vetoes`, { pickId: shown[0].id, memberKey: r, reason: "too_far" });
    shown = (await s.call("GET", `/api/plans/${id}/picks`)).body.picks;
    await s.call("POST", `/api/plans/${id}/vetoes`, { pickId: shown[0].id, memberKey: a, reason: "because I said so" });
    shown = (await s.call("GET", `/api/plans/${id}/picks`)).body.picks;
    await s.call("POST", `/api/plans/${id}/vetoes`, { pickId: shown[0].id }, org);
    const m = (await s.call("GET", "/api/admin/metrics", null, ADMIN)).body;
    assert.deepEqual(m.vetoOverrideRate.vetoReasons, { too_far: 1, "none given": 2 });
    const pub = JSON.stringify((await s.call("GET", `/api/plans/${id}/picks`)).body);
    assert.ok(!pub.includes("too_far"), "reasons are never shown to the group");
  } finally { s.close(); }
});

// ---------- shared budget range ----------

test("budget scope comes back with the picks: all, given, or nothing", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const scopeFor = async (planExtra, friendBudget) => {
      const id = await plan(s, org, planExtra);
      await s.call("POST", `/api/plans/${id}/responses`, ans("Riya", { budget: friendBudget }));
      return (await s.call("GET", `/api/plans/${id}/picks`)).body.budgetScope;
    };
    assert.equal(await scopeFor({ organiserBudget: 1500 }, 1500), "all");
    assert.equal(await scopeFor({}, 1500), "given", "the organiser gave none");
    assert.equal(await scopeFor({}, null), "none");
  } finally { s.close(); }
});

// ---------- retention ----------

test("events and place reports are deleted after the retention period", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = await plan(s, org);
    await s.call("POST", "/api/reports", { restaurantId: "r01", kind: "closed", planId: id });
    assert.ok(s.db.prepare("SELECT COUNT(*) n FROM events").get().n > 0);
    purgeExpired(s.db, s.clock.t + 364 * 86400000, 90, 365);
    assert.ok(s.db.prepare("SELECT COUNT(*) n FROM events").get().n > 0, "kept within the period");
    purgeExpired(s.db, s.clock.t + 366 * 86400000, 90, 365);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM place_reports").get().n, 0);
  } finally { s.close(); }
});
