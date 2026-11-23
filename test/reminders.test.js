import test from "node:test";
import assert from "node:assert/strict";
import { openDb, purgeExpired } from "../server/db.js";
import { createApp, REMINDER_LEAD_MS } from "../server/app.js";
import { makeSendReminder, reminderText, when12h } from "../server/reminders.js";

const IST = (s) => Date.parse(s + "+05:30");

async function setup(opts = {}) {
  const db = openDb(":memory:");
  const clock = { t: IST("2026-11-28T10:00:00") };
  const codes = {};
  const sent = [];
  const sendReminder = "sendReminder" in opts ? opts.sendReminder : async (phone, payload) => void sent.push({ phone, payload });
  const app = createApp({ db, now: () => clock.t, sendOtp: async (p, c) => (codes[p] = c), mapsKey: undefined, adminKey: "adm", ...opts, sendReminder });
  const server = app.server();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const signIn = async (phone = "9876543210", firstName = "Jenessa") => {
    await call("POST", "/api/auth/request-otp", { phone });
    const v = await call("POST", "/api/auth/verify", { phone, code: codes["+91" + phone], firstName });
    return { Authorization: "Bearer " + v.body.token };
  };
  return { db, clock, call, signIn, app, sent, close: () => server.close() };
}

const ans = (name, extra = {}) => ({ name, area: "Koramangala", budget: 1500, mood: "chill", dealbreakers: [], consent: true, ...extra });

// Plan on 2026-11-28 at 20:00 IST, decided, so reminders are due from 17:00 IST.
async function decidedPlan(s, org, { planExtra = {}, friendExtra = {}, friend = "Riya" } = {}) {
  const id = (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: [friend], organiserArea: "Koramangala", organiserBudget: 1500, ...planExtra }, org)).body.id;
  const r = await s.call("POST", `/api/plans/${id}/responses`, ans(friend, friendExtra));
  const picks = (await s.call("GET", `/api/plans/${id}/picks`)).body;
  await s.call("POST", `/api/plans/${id}/decide`, { overridePickId: picks.picks[0].id }, org);
  return { id, key: r.body.memberKey, winner: picks.picks[0], resp: r };
}

test("when12h and the reminder text", () => {
  assert.equal(when12h("00:15"), "12:15 AM");
  assert.equal(when12h("12:00"), "12:00 PM");
  assert.equal(when12h("13:05"), "1:05 PM");
  assert.equal(when12h("20:00"), "8:00 PM");
  const t = reminderText({ kind: "place", occasion: "Friends hangout", time: "20:00", place: "Sample Dosa Lane", area: "Koramangala", directionsUrl: "https://maps/x" });
  assert.equal(t, "Reminder: Friends hangout today at 8:00 PM. Sample Dosa Lane, Koramangala. Directions: https://maps/x");
  assert.ok(!reminderText({ kind: "surprise", occasion: "Date night", time: "20:00" }).includes("Sample"));
});

test("timing: nothing before 3 hours out, one reminder to the organiser at 3 hours, never twice, nothing after the plan time", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const { winner } = await decidedPlan(s, org);
    assert.equal(REMINDER_LEAD_MS, 3 * 3600000);

    s.clock.t = IST("2026-11-28T16:59:00");
    assert.deepEqual(await s.app.runReminders(), { sent: 0, failed: 0 });
    assert.equal(s.sent.length, 0);

    s.clock.t = IST("2026-11-28T17:00:00");
    assert.deepEqual(await s.app.runReminders(), { sent: 1, failed: 0 });
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0].phone, "+919876543210");
    const p = s.sent[0].payload;
    assert.equal(p.kind, "place");
    assert.equal(p.place, winner.name);
    assert.equal(p.time, "20:00");
    assert.match(p.directionsUrl, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=12\./);

    s.clock.t = IST("2026-11-28T18:30:00"); // later ticks do not repeat it
    await s.app.runReminders();
    assert.equal(s.sent.length, 1);
  } finally { s.close(); }
});

test("no reminder after the plan time, for an undecided plan, or when the plan turned reminders off", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const late = await decidedPlan(s, org);
    s.clock.t = IST("2026-11-28T20:01:00");
    await s.app.runReminders();
    assert.equal(s.sent.length, 0);
    s.clock.t = IST("2026-11-28T10:00:00");

    // Undecided (still voting): never reminded.
    const id = (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Arjun"], organiserArea: "Koramangala" }, org)).body.id;
    await s.call("POST", `/api/plans/${id}/responses`, ans("Arjun"));
    assert.equal((await s.call("GET", `/api/plans/${id}`)).body.status, "voting");

    // Opted out at creation.
    const org2 = await s.signIn("9123456789", "Kabir");
    await decidedPlan(s, org2, { planExtra: { reminders: false }, friend: "Meera" });
    s.clock.t = IST("2026-11-28T18:00:00");
    await s.app.runReminders();
    assert.deepEqual(s.sent.map((x) => x.phone), ["+919876543210"], "only the first organiser's decided, opted-in plan");
    assert.equal((await s.call("GET", `/api/plans/${late.id}`)).body.reminders.enabled, true);
  } finally { s.close(); }
});

test("a plan decided inside the 3-hour window is reminded at once (late, but still useful)", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    s.clock.t = IST("2026-11-28T18:30:00");
    const id = (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya"], organiserArea: "Koramangala" }, org)).body.id;
    await s.call("POST", `/api/plans/${id}/responses`, ans("Riya"));
    const pk = (await s.call("GET", `/api/plans/${id}/picks`)).body.picks[0].id;
    await s.call("POST", `/api/plans/${id}/decide`, { overridePickId: pk }, org);
    assert.deepEqual(await s.app.runReminders(), { sent: 1, failed: 0 });
  } finally { s.close(); }
});

test("friend opt-in: needs its own consent, a valid number, is never exposed, and is erased once sent", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya", "Arjun"], organiserArea: "Koramangala" }, org)).body.id;
    const post = (b) => s.call("POST", `/api/plans/${id}/responses`, b);

    assert.equal((await post(ans("Riya", { reminderPhone: "9988776655" }))).status, 400); // no reminderConsent
    assert.equal((await post(ans("Riya", { reminderPhone: "12345", reminderConsent: true }))).status, 400); // bad number
    const riya = await post(ans("Riya", { reminderPhone: "99887 76655", reminderConsent: true }));
    assert.equal(riya.status, 200);
    assert.equal(riya.body.reminder, true);
    const arjun = await post(ans("Arjun")); // did not opt in
    assert.equal(arjun.body.reminder, false);
    assert.equal(s.db.prepare("SELECT reminder_phone p FROM responses WHERE name = 'Arjun'").get().p, null);

    const picks = (await s.call("GET", `/api/plans/${id}/picks`)).body;
    await s.call("POST", `/api/plans/${id}/decide`, { overridePickId: picks.picks[0].id }, org);
    // The number appears in no API response anyone can reach.
    for (const out of [riya.body, (await s.call("GET", `/api/plans/${id}`, null, org)).body, (await s.call("GET", `/api/plans/${id}/picks`, null, org)).body]) {
      assert.ok(!JSON.stringify(out).includes("9988776655"), "reminder number leaked");
    }

    s.clock.t = IST("2026-11-28T17:30:00");
    assert.deepEqual(await s.app.runReminders(), { sent: 2, failed: 0 }); // organiser + Riya, not Arjun
    assert.deepEqual(s.sent.map((x) => x.phone).sort(), ["+919876543210", "+919988776655"]);
    assert.equal(s.db.prepare("SELECT reminder_phone p FROM responses WHERE name = 'Riya'").get().p, null, "number must be erased after sending");
  } finally { s.close(); }
});

test("retries a failing send up to 3 times then stops; the error log never holds the number; the number is erased on give-up", async () => {
  let n = 0;
  const calls = [];
  const s = await setup({ sendReminder: async (phone, payload) => { calls.push(phone); n++; throw new Error("provider down"); } });
  try {
    const org = await s.signIn();
    const { id } = await decidedPlan(s, org, { friendExtra: { reminderPhone: "9988776655", reminderConsent: true } });
    s.clock.t = IST("2026-11-28T17:00:00");
    for (let i = 0; i < 5; i++) await s.app.runReminders();
    assert.equal(calls.filter((p) => p === "+919876543210").length, 3, "organiser tried exactly 3 times");
    assert.equal(calls.filter((p) => p === "+919988776655").length, 3, "friend tried exactly 3 times");
    const rows = s.db.prepare("SELECT recipient, status, attempts, error FROM reminders WHERE plan_id = ?").all(id);
    assert.ok(rows.every((r) => r.status === "failed" && r.attempts === 3));
    assert.ok(rows.every((r) => !String(r.error).includes("99887") && !String(r.error).includes("98765")));
    assert.equal(s.db.prepare("SELECT reminder_phone p FROM responses WHERE name = 'Riya'").get().p, null);
  } finally { s.close(); }
});

test("a send that fails once and then succeeds is delivered exactly once", async () => {
  let fails = 1;
  const got = [];
  const s = await setup({ sendReminder: async (phone, payload) => { if (fails-- > 0) throw new Error("blip"); got.push(phone); } });
  try {
    const org = await s.signIn();
    await decidedPlan(s, org);
    s.clock.t = IST("2026-11-28T17:00:00");
    await s.app.runReminders();
    await s.app.runReminders();
    await s.app.runReminders();
    assert.deepEqual(got, ["+919876543210"]);
  } finally { s.close(); }
});

test("no reminder channel: nothing is collected or sent, and the plan says reminders are off", async () => {
  const s = await setup({ sendReminder: null });
  try {
    const org = await s.signIn();
    const { id, resp } = await decidedPlan(s, org, { friendExtra: { reminderPhone: "9988776655", reminderConsent: true } });
    assert.equal(resp.body.reminder, false);
    assert.equal(s.db.prepare("SELECT reminder_phone p FROM responses").get().p, null, "do not collect a number we cannot use");
    assert.equal((await s.call("GET", `/api/plans/${id}`)).body.reminders.enabled, false);
    s.clock.t = IST("2026-11-28T17:00:00");
    assert.deepEqual(await s.app.runReminders(), { sent: 0, failed: 0 });
    assert.equal(s.app.hasReminders, false);
  } finally { s.close(); }
});

// ---------- surprises (F12 x F15) ----------

const couple = (extra) => ({ date: "2026-12-05", time: "01:00", friends: ["Priya"], mode: "couple", organiserArea: "Koramangala", organiserBudget: 1500, ...extra });

async function surprisePlan(s, org, surprise, time) {
  const id = (await s.call("POST", "/api/plans", couple({ surprise, time }), org)).body.id;
  const k = (await s.call("POST", `/api/plans/${id}/responses`, ans("Priya", { reminderPhone: "9988776655", reminderConsent: true }))).body.memberKey;
  const picks = (await s.call("GET", `/api/plans/${id}/picks`, null, org)).body;
  const planner = surprise === "partner" ? { headers: org, body: {} } : { headers: {}, body: { memberKey: k } };
  const v = await s.call("POST", `/api/plans/${id}/votes`, { pickId: picks.picks.length ? picks.picks[0].id : (await s.call("GET", `/api/plans/${id}/picks`, null, { "x-member-key": k })).body.picks[0].id, ...planner.body }, planner.headers);
  assert.equal(v.body.status, "decided");
  return { id, k, winner: v.body.winner.pick };
}

test("surprise my partner, reminder fires BEFORE the reveal (plan at 01:00): the partner's text has no place; the organiser's does", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const { winner } = await surprisePlan(s, org, "partner", "01:00"); // reveal Dec 5 00:00, reminder from Dec 4 22:00
    s.clock.t = IST("2026-12-04T22:30:00");
    assert.deepEqual(await s.app.runReminders(), { sent: 2, failed: 0 });
    const toPartner = s.sent.find((x) => x.phone === "+919988776655").payload;
    const toOrganiser = s.sent.find((x) => x.phone === "+919876543210").payload;
    assert.equal(toPartner.kind, "surprise");
    assert.ok(!JSON.stringify(toPartner).includes(winner.name) && !JSON.stringify(toPartner).includes("maps"), "place leaked to the person being surprised");
    assert.equal(toPartner.time, "01:00");
    assert.equal(toOrganiser.kind, "place");
    assert.equal(toOrganiser.place, winner.name);
  } finally { s.close(); }
});

test("surprise me: the organiser is the hidden one before the reveal and gets the no-place text", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const { winner } = await surprisePlan(s, org, "organiser", "01:00");
    s.clock.t = IST("2026-12-04T22:30:00");
    await s.app.runReminders();
    const toOrganiser = s.sent.find((x) => x.phone === "+919876543210").payload;
    const toPartner = s.sent.find((x) => x.phone === "+919988776655").payload;
    assert.equal(toOrganiser.kind, "surprise");
    assert.ok(!JSON.stringify(toOrganiser).includes(winner.name));
    assert.equal(toPartner.kind, "place"); // the partner chose it, so they know
  } finally { s.close(); }
});

test("surprise with an evening plan: by reminder time the day has arrived, so the revealed place is included", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const { winner } = await surprisePlan(s, org, "partner", "20:00"); // reveal Dec 5 00:00, reminder Dec 5 17:00
    s.clock.t = IST("2026-12-05T17:00:00");
    await s.app.runReminders();
    const toPartner = s.sent.find((x) => x.phone === "+919988776655").payload;
    assert.equal(toPartner.kind, "place");
    assert.equal(toPartner.place, winner.name);
  } finally { s.close(); }
});

// ---------- provider adapter ----------

const env = { MSG91_AUTHKEY: "key-123", MSG91_REMINDER_TEMPLATE_ID: "tpl-place", MSG91_REMINDER_SURPRISE_TEMPLATE_ID: "tpl-surprise" };
const okFetch = (calls) => async (url, init) => (calls.push({ url, init }), { ok: true, status: 200, json: async () => ({ type: "success" }) });

test("adapter: dev mode prints; off in production; off for an unknown or half-configured provider", async () => {
  const lines = [];
  await makeSendReminder({ provider: "", env: {}, log: (l) => lines.push(l) })("+919876543210", { kind: "place", occasion: "Dinner", time: "20:00", place: "X", area: "Y", directionsUrl: "u" });
  assert.match(lines[0], /\[dev-reminder\] to \+919876543210: Reminder: Dinner today at 8:00 PM\. X, Y\. Directions: u/);
  assert.equal(makeSendReminder({ provider: "", env: { NODE_ENV: "production" } }), null);
  assert.equal(makeSendReminder({ provider: "carrier-pigeon", env }), null);
  assert.equal(makeSendReminder({ provider: "msg91", env: { MSG91_AUTHKEY: "k", MSG91_REMINDER_TEMPLATE_ID: "t" } }), null); // surprise template missing
  assert.equal(makeSendReminder({ provider: "msg91", env: {} }), null);
});

test("adapter: msg91 request shape (assumptions to verify in MSG91's dashboard) and the right template per kind", async () => {
  const calls = [];
  const send = makeSendReminder({ provider: "msg91", env, fetchImpl: okFetch(calls) });
  await send("+919876543210", { kind: "place", occasion: "Dinner", time: "20:00", place: "Sample Dosa Lane", area: "Koramangala", directionsUrl: "https://maps/x" });
  await send("+919876543210", { kind: "surprise", occasion: "Date night", time: "01:00" });
  const [a, b] = calls.map((c) => ({ url: String(c.url), init: c.init, body: JSON.parse(c.init.body) }));
  assert.equal(a.url, "https://control.msg91.com/api/v5/flow");
  assert.equal(a.init.method, "POST");
  assert.equal(a.init.headers.authkey, "key-123");
  assert.ok(!a.url.includes("key-123") && !a.init.body.includes("key-123"));
  assert.equal(a.body.template_id, "tpl-place");
  assert.deepEqual(a.body.recipients, [{ mobiles: "919876543210", occasion: "Dinner", time: "8:00 PM", place: "Sample Dosa Lane", area: "Koramangala", url: "https://maps/x" }]);
  assert.equal(b.body.template_id, "tpl-surprise");
  assert.deepEqual(b.body.recipients, [{ mobiles: "919876543210", occasion: "Date night", time: "1:00 AM" }]); // no place fields at all
});

test("adapter: msg91 fails closed on rejection, non-success body and network error", async () => {
  const send = (f) => makeSendReminder({ provider: "msg91", env, fetchImpl: f })("+919876543210", { kind: "surprise", occasion: "x", time: "20:00" });
  await assert.rejects(send(async () => ({ ok: false, status: 401, json: async () => ({ type: "error", message: "bad key" }) })), /rejected the reminder \(401: bad key\)/);
  await assert.rejects(send(async () => ({ ok: true, status: 200, json: async () => ({ type: "error" }) })), /rejected/);
  await assert.rejects(send(async () => ({ ok: true, status: 200, json: async () => ({}) })), /rejected/);
  await assert.rejects(send(async () => { throw new Error("ECONNRESET"); }), /unreachable/);
});

test("purge removes a finished plan's reminder rows", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    await decidedPlan(s, org);
    s.clock.t = IST("2026-11-28T17:00:00");
    await s.app.runReminders();
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM reminders").get().n, 1);
    purgeExpired(s.db, s.clock.t + 91 * 86400000);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM reminders").get().n, 0);
  } finally { s.close(); }
});
