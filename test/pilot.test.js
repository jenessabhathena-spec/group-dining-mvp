// Pilot blockers: curation import (A1), weekday hours, hand-offs (F10), analytics + PRD metrics, privacy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";
import { parseCsv, parseHours, loadCatalogCsv, toCsv, normalisePhoneNumber, COLUMNS } from "../server/catalog.js";
import { isOpen } from "../src/engine.js";
import { RESTAURANTS } from "../src/data.js";

const IST = (s) => Date.parse(s + "+05:30");

// ---------- A1: spreadsheet import ----------

const HEADER = COLUMNS.join(",");
const row = (o = {}) => {
  const d = { id: "p1", name: "Real Cafe", area: "Indiranagar", lat: "12.9784", lng: "77.6408", price_per_head: "800", cuisines: "cafe|continental", diet_options: "veg,non-veg", vibes: "chill", max_group: "8", alcohol: "none", noise: "quiet", hours: "daily 09:00-22:00", partner: "no", rating: "4.2", phone: "", booking_url: "", ...o };
  return COLUMNS.map((c) => (/[",\n]/.test(d[c]) ? `"${d[c].replace(/"/g, '""')}"` : d[c])).join(",");
};

test("CSV parser: quotes, doubled quotes, commas and newlines in cells, CRLF, BOM, blank lines", () => {
  const rows = parseCsv('﻿a,b,c\r\n1,"x, y","he said ""hi"""\r\n\r\n2,"multi\nline",\n');
  assert.deepEqual(rows, [["a", "b", "c"], ["1", "x, y", 'he said "hi"'], ["2", "multi\nline", ""]]);
});

test("hours: daily, ranges, wrap-around day ranges, split shifts, closed, overrides, errors", () => {
  const h = parseHours("daily 12:00-23:00; mon closed; fri-sat 12:00-15:00,19:00-01:00");
  assert.deepEqual(h.weekly.mon, []);
  assert.deepEqual(h.weekly.tue, [["12:00", "23:00"]]);
  assert.deepEqual(h.weekly.sat, [["12:00", "15:00"], ["19:00", "01:00"]]);
  assert.deepEqual(parseHours("fri-mon 18:00-23:00").weekly.sun, [["18:00", "23:00"]]); // wraps through the weekend
  assert.deepEqual(parseHours("fri-mon 18:00-23:00").weekly.tue, []); // days not mentioned are closed
  assert.throws(() => parseHours(""), /empty/);
  assert.throws(() => parseHours("funday 12:00-13:00"), /unknown day/);
  assert.throws(() => parseHours("daily 12-11pm"), /HH:MM-HH:MM/);
  assert.throws(() => parseHours("daily 25:00-26:00"), /HH:MM-HH:MM/);
});

test("phone numbers are normalised to +91 or rejected", () => {
  assert.equal(normalisePhoneNumber("080 4123 4567"), "+918041234567");
  assert.equal(normalisePhoneNumber("98765 43210"), "+919876543210");
  assert.equal(normalisePhoneNumber("+91 98765-43210"), "+919876543210");
  assert.equal(normalisePhoneNumber(""), null);
  assert.throws(() => normalisePhoneNumber("call us"), /bad phone/);
  assert.throws(() => normalisePhoneNumber("12345678"), /bad phone/);
});

test("a valid spreadsheet loads, with lists, weekly hours, phone and booking link", () => {
  const csv = [HEADER, row({ phone: "080 4123 4567", booking_url: "https://example.com/book/real-cafe", hours: "mon closed; tue-sun 09:00-22:00", partner: "yes" })].join("\n");
  const { restaurants, errors } = loadCatalogCsv(csv);
  assert.deepEqual(errors, []);
  const r = restaurants[0];
  assert.deepEqual(r.cuisines, ["cafe", "continental"]);
  assert.deepEqual(r.dietOptions, ["veg", "non-veg"]);
  assert.equal(r.pricePerHead, 800);
  assert.equal(r.phone, "+918041234567");
  assert.equal(r.bookingUrl, "https://example.com/book/real-cafe");
  assert.equal(r.partner, true);
  assert.equal(isOpen(r, "20:00", "2026-11-23"), false); // Monday
  assert.equal(isOpen(r, "20:00", "2026-11-24"), true);
});

test("every bad row is reported with its spreadsheet row number, and nothing is loaded", () => {
  const csv = [HEADER,
    row({ id: "ok1" }),
    row({ id: "ok1" }), // duplicate
    row({ id: "far", lat: "28.6", lng: "77.2" }),
    row({ id: "diet", diet_options: "veg,keto" }),
    row({ id: "hrs", hours: "weekdays 9-5" }),
    row({ id: "ph", phone: "ring ring" }),
    row({ id: "bk", booking_url: "http://insecure.example/book" }),
    row({ id: "pr", price_per_head: "eight hundred" }),
  ].join("\n");
  const { restaurants, errors } = loadCatalogCsv(csv);
  assert.equal(restaurants.length, 0, "a bad file loads nothing");
  const has = (re) => assert.ok(errors.some((e) => re.test(e)), `expected an error matching ${re}: ${errors.join(" | ")}`);
  has(/^Row 3: duplicate id "ok1"/);
  has(/^Row 4: lat\/lng .* not in Bengaluru/);
  has(/^Row 5: diet_options/);
  has(/^Row 6: hours: /);
  has(/^Row 7: bad phone/);
  has(/^Row 8: booking_url must be a full https:\/\/ link/);
  has(/^Row 9: price_per_head/);
  assert.deepEqual(loadCatalogCsv("id,name\nx,y").errors.slice(0, 1), ['Missing column "area"']);
  assert.deepEqual(loadCatalogCsv("").errors, ["The file is empty"]);
  assert.deepEqual(loadCatalogCsv(HEADER).errors, ["No restaurants in the file"]);
});

test("the template written from the sample list round-trips: same places, same opening hours on every day", () => {
  const { restaurants, errors } = loadCatalogCsv(toCsv(RESTAURANTS));
  assert.deepEqual(errors, []);
  assert.deepEqual(restaurants.map((r) => r.id), RESTAURANTS.map((r) => r.id));
  const dates = ["2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28"];
  const times = ["00:30", "08:00", "12:30", "17:00", "20:00", "23:45"];
  for (const [a, b] of RESTAURANTS.map((r, i) => [r, restaurants[i]]))
    for (const d of dates) for (const t of times) assert.equal(isOpen(b, t, d), isOpen(a, t, d), `${a.id} ${d} ${t}`);
  // And the committed template in data/ is exactly that.
  assert.equal(readFileSync(new URL("../data/restaurants.template.csv", import.meta.url), "utf8"), toCsv(RESTAURANTS));
});

// ---------- API helpers ----------

async function setup(opts = {}) {
  const db = openDb(":memory:");
  const clock = { t: IST("2026-11-23T10:00:00") }; // a Monday
  const codes = {};
  const app = createApp({ db, now: () => clock.t, sendOtp: async (p, c) => (codes[p] = c), sendReminder: null, mapsKey: undefined, adminKey: "adm", ...opts });
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
  return { db, clock, call, signIn, base, close: () => server.close() };
}
const ans = (name, extra = {}) => ({ name, area: "Koramangala", budget: 1500, mood: "chill", dealbreakers: [], consent: true, ...extra });
const metrics = async (s) => (await s.call("GET", "/api/admin/metrics", null, { "x-admin-key": "adm" })).body;

// ---------- weekday hours through the API ----------

test("a place closed on Mondays is never picked for a Monday plan, but is for Tuesday", async () => {
  const monClosed = { ...RESTAURANTS[0], id: "monclosed", hours: parseHours("mon closed; tue-sun 12:00-23:00") };
  const s = await setup({ restaurants: [monClosed, { ...RESTAURANTS[1], id: "always" }] });
  try {
    const org = await s.signIn();
    const pick = async (date) => {
      const id = (await s.call("POST", "/api/plans", { date, time: "20:00", friends: ["Riya"], organiserArea: "Koramangala" }, org)).body.id;
      await s.call("POST", `/api/plans/${id}/responses`, ans("Riya"));
      return (await s.call("GET", `/api/plans/${id}/picks`)).body.picks.map((p) => p.id);
    };
    assert.deepEqual(await pick("2026-11-23"), ["always"]);
    assert.deepEqual((await pick("2026-11-24")).sort(), ["always", "monclosed"]);
    // Solo uses today's weekday (the clock says Monday).
    await s.call("PUT", "/api/me/profile", { home: "Koramangala" }, org);
    assert.deepEqual((await s.call("POST", "/api/solo/picks", {}, org)).body.picks.map((p) => p.id), ["always"]);
    assert.ok((await s.call("POST", "/api/solo/picks", { date: "2026-11-24" }, org)).body.picks.some((p) => p.id === "monclosed"));
  } finally { s.close(); }
});

// ---------- F10 hand-offs ----------

test("winner card carries Call and Booking links only when the curated list has them", async () => {
  const withLinks = { ...RESTAURANTS[0], id: "linked", phone: "+918041234567", bookingUrl: "https://example.com/book/x" };
  const bare = { ...RESTAURANTS[1], id: "bare" };
  const s = await setup({ restaurants: [withLinks, bare] });
  try {
    const org = await s.signIn();
    const decideOn = async (rid) => {
      const id = (await s.call("POST", "/api/plans", { date: "2026-11-24", time: "20:00", friends: ["Riya"], organiserArea: "Koramangala" }, org)).body.id;
      await s.call("POST", `/api/plans/${id}/responses`, ans("Riya"));
      return (await s.call("POST", `/api/plans/${id}/decide`, { overridePickId: rid }, org)).body.winner;
    };
    const a = await decideOn("linked");
    assert.equal(a.callUrl, "tel:+918041234567");
    assert.equal(a.bookingUrl, "https://example.com/book/x");
    assert.match(a.directionsUrl, /google\.com\/maps\/dir/);
    const b = await decideOn("bare");
    assert.equal(b.callUrl, null);
    assert.equal(b.bookingUrl, null);
    assert.ok(b.directionsUrl);
    await s.call("PUT", "/api/me/profile", { home: "Koramangala" }, org);
    const soloPick = (await s.call("POST", "/api/solo/picks", { date: "2026-11-24" }, org)).body.picks.find((p) => p.id === "linked");
    assert.equal(soloPick.callUrl, "tel:+918041234567");
  } finally { s.close(); }
});

// ---------- analytics events ----------

test("events: allow-listed types and fields only, organiser-only sharing, no names stored, rate limited", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", { date: "2026-11-24", time: "20:00", friends: ["Riya"], organiserArea: "Koramangala" }, org)).body.id;
    const ev = (b, h = {}) => s.call("POST", `/api/plans/${id}/events`, b, h);
    const types = () => s.db.prepare("SELECT type FROM events WHERE plan_id = ? ORDER BY id").all(id).map((r) => r.type);

    assert.ok(!types().includes("plan_shared"), "creating a plan is not sharing it");
    assert.equal((await ev({ type: "plan_shared", channel: "whatsapp" })).status, 403);
    assert.equal((await ev({ type: "plan_shared", channel: "carrier-pigeon" }, org)).status, 400);
    assert.equal((await ev({ type: "plan_shared", channel: "whatsapp" }, org)).status, 200);
    assert.equal((await ev({ type: "link_opened", cid: "browser-0001" })).status, 200);
    assert.equal((await ev({ type: "response_abandoned", lastField: "budget", cid: "browser-0001" })).status, 200);
    assert.equal((await ev({ type: "response_abandoned", lastField: "secret-field" })).status, 400);
    assert.equal((await ev({ type: "handoff_clicked", kind: "call" })).status, 409); // no winner yet
    assert.equal((await ev({ type: "winner_decided" })).status, 400); // server-only events can't be faked
    assert.equal((await ev({ type: "link_opened", cid: "x", name: "Riya", phone: "9988776655" })).status, 200);
    const stored = s.db.prepare("SELECT payload FROM events WHERE plan_id = ? AND type = 'link_opened'").all(id).map((r) => r.payload).join();
    assert.ok(!stored.includes("Riya") && !stored.includes("99887"), "only allow-listed fields are stored");
    assert.ok(!stored.includes('"x"'), "a malformed cid is dropped");
    assert.equal((await s.call("POST", "/api/plans/nope/events", { type: "link_opened" })).status, 404);

    for (let i = 0; i < 120; i++) await ev({ type: "link_opened" });
    assert.equal((await ev({ type: "link_opened" })).status, 429);
  } finally { s.close(); }
});

test("ratings log visit_reported always and rating_submitted only with stars", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", { date: "2026-11-24", time: "20:00", friends: ["Riya"], organiserArea: "Koramangala" }, org)).body.id;
    const k = (await s.call("POST", `/api/plans/${id}/responses`, ans("Riya"))).body.memberKey;
    const pk = (await s.call("GET", `/api/plans/${id}/picks`)).body.picks[0].id;
    await s.call("POST", `/api/plans/${id}/decide`, { overridePickId: pk }, org);
    s.clock.t = IST("2026-11-24T21:00:00"); // after the meal
    await s.call("POST", `/api/plans/${id}/ratings`, { went: "elsewhere", memberKey: k });
    await s.call("POST", `/api/plans/${id}/ratings`, { went: "yes", stars: 5 }, org);
    const rows = s.db.prepare("SELECT type, payload FROM events WHERE plan_id = ? AND type IN ('visit_reported','rating_submitted') ORDER BY id").all(id);
    assert.deepEqual(rows.map((r) => [r.type, JSON.parse(r.payload)]), [["visit_reported", { went: "elsewhere" }], ["visit_reported", { went: "yes" }], ["rating_submitted", { stars: 5 }]]);
  } finally { s.close(); }
});

// ---------- PRD metrics ----------

test("metrics follow the PRD definitions", async () => {
  const partner = { ...RESTAURANTS[0], id: "partner-place", partner: true }; // the only place, so every winner is a partner
  const s = await setup({ restaurants: [partner] });
  try {
    const plan = async (who, date, friend, extra = {}) => (await s.call("POST", "/api/plans", { date, time: "20:00", friends: [friend], organiserArea: "Koramangala", ...extra }, who)).body.id;
    const decide = async (who, id) => s.call("POST", `/api/plans/${id}/decide`, { overridePickId: "partner-place" }, who);
    const share = (who, id) => s.call("POST", `/api/plans/${id}/events`, { type: "plan_shared", channel: "whatsapp" }, who);
    const ev = (id, b) => s.call("POST", `/api/plans/${id}/events`, b);

    // Organiser 2: one decided plan, 32 days before the metrics date, never another -> counts against return rate.
    s.clock.t = IST("2026-10-28T10:00:00");
    const o2 = await s.signIn("9123456789", "Kabir");
    const c = await plan(o2, "2026-10-28", "Meera");
    await s.call("POST", `/api/plans/${c}/responses`, ans("Meera"));
    await decide(o2, c);

    // Organiser 1: plan A shared and decided 12 minutes after sharing; both members went.
    s.clock.t = IST("2026-11-28T10:00:00");
    const o1 = await s.signIn("9876543210", "Jenessa");
    const a = await plan(o1, "2026-11-28", "Riya");
    await share(o1, a);
    await ev(a, { type: "link_opened", cid: "cid-browser-1" });
    await ev(a, { type: "link_opened", cid: "cid-browser-3" });
    await ev(a, { type: "response_abandoned", lastField: "mood", cid: "cid-browser-1" }); // switched apps, then came back and submitted
    await ev(a, { type: "response_abandoned", lastField: "budget", cid: "cid-browser-3" }); // really left
    const riya = (await s.call("POST", `/api/plans/${a}/responses`, ans("Riya", { cid: "cid-browser-1" }))).body.memberKey;
    s.clock.t += 12 * 60000;
    await decide(o1, a);

    // Organiser 3: decided plan, recent, no second plan yet -> not counted for return rate (30 days not up).
    const o3 = await s.signIn("9000000001", "Asha");
    const d = await plan(o3, "2026-11-28", "Dev");
    await s.call("POST", `/api/plans/${d}/responses`, ans("Dev"));
    await decide(o3, d);

    // Organiser 1 returns the next day with plan B: shared, answered, not decided.
    s.clock.t = IST("2026-11-29T09:00:00");
    const b = await plan(o1, "2026-12-05", "Arjun");
    await share(o1, b);
    await ev(b, { type: "link_opened", cid: "cid-browser-2" });
    await s.call("POST", `/api/plans/${b}/responses`, ans("Arjun", { cid: "cid-browser-2" }));

    // After plan A's evening: both A members say they went.
    s.clock.t = IST("2026-11-29T21:00:00");
    await s.call("POST", `/api/plans/${a}/ratings`, { went: "yes", stars: 4, memberKey: riya });
    await s.call("POST", `/api/plans/${a}/ratings`, { went: "yes", stars: 5 }, o1);

    const m = await metrics(s);
    assert.deepEqual([m.planCompletion.numerator, m.planCompletion.denominator], [1, 2], "A decided of A and B shared; C and D were never shared");
    assert.deepEqual([m.friendResponseRate.numerator, m.friendResponseRate.denominator], [2, 3]);
    assert.equal(m.friendResponseRate.abandoned, 1, "browser 1 came back and submitted, so only browser 3 abandoned");
    assert.deepEqual(m.friendResponseRate.abandonedAtField, { budget: 1 });
    assert.equal(m.timeToDecisionMinutes.value, 12);
    assert.equal(m.timeToDecisionMinutes.plans, 1);
    assert.deepEqual([m.visitRate.numerator, m.visitRate.denominator], [1, 3], "A visited; C and D decided and past but nobody said they went");
    assert.deepEqual([m.returnRate.numerator, m.returnRate.denominator], [1, 2], "Jenessa returned; Kabir's 30 days are up; Asha's are not");
    assert.equal(m.pickSatisfaction.value, 4.5);
    assert.deepEqual([m.shareAtPartners.numerator, m.shareAtPartners.denominator], [1, 1]);
    assert.equal(m.vetoOverrideRate.numerator, 3, "three organiser overrides, no vetoes");
    assert.ok(m.vetoOverrideRate.denominator >= 3);
    assert.equal(m.newOrganisersPerPlan.value, null);
    assert.match(m.newOrganisersPerPlan.note, /Not measurable/);
    assert.equal((await s.call("GET", "/api/admin/metrics")).status, 403);
  } finally { s.close(); }
});

// ---------- privacy ----------

test("privacy policy page is served, marked as a draft, and linked from both forms", async () => {
  const s = await setup();
  try {
    const html = await (await fetch(s.base + "/privacy")).text();
    assert.match(html, /DRAFT, not yet reviewed by a lawyer/);
    assert.match(html, /Delete my answers/);
    assert.match(html, /90 days/);
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", { date: "2026-11-24", time: "20:00", friends: ["Riya"], organiserArea: "Koramangala" }, org)).body.id;
    assert.match(await (await fetch(`${s.base}/p/${id}`)).text(), /href: "\/privacy"/);
    assert.match(await (await fetch(s.base + "/")).text(), /href: "\/privacy"/);
  } finally { s.close(); }
});

test("a friend deletes their answers before picks: everything goes and they can answer again", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", { date: "2026-11-24", time: "20:00", friends: ["Riya", "Arjun"], organiserArea: "Koramangala" }, org)).body.id;
    const k = (await s.call("POST", `/api/plans/${id}/responses`, ans("Riya", { budget: 1777 }))).body.memberKey;
    assert.equal((await s.call("DELETE", `/api/plans/${id}/responses/me`)).status, 403);
    assert.equal((await s.call("DELETE", `/api/plans/${id}/responses/me`, null, { "x-member-key": "not-a-key" })).status, 403);
    assert.equal((await s.call("DELETE", `/api/plans/${id}/responses/me`, null, { "x-member-key": k })).status, 200);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM responses").get().n, 0);
    assert.deepEqual((await s.call("GET", `/api/plans/${id}`)).body.answered, []);
    assert.equal((await s.call("DELETE", `/api/plans/${id}/responses/me`, null, { "x-member-key": k })).status, 403, "the old key is dead");
    assert.equal((await s.call("POST", `/api/plans/${id}/responses`, ans("Riya"))).status, 200, "can answer again");
  } finally { s.close(); }
});

test("a friend deletes their answers after voting: name becomes 'A friend' everywhere, budget and location are gone, the vote still counts", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", { date: "2026-11-24", time: "20:00", friends: ["Riya", "Arjun"], organiserArea: "Koramangala" }, org)).body.id;
    const riya = (await s.call("POST", `/api/plans/${id}/responses`, ans("Riya", { budget: 1777, area: "HSR Layout" }))).body.memberKey;
    const arjun = (await s.call("POST", `/api/plans/${id}/responses`, ans("Arjun"))).body.memberKey;
    const picks = (await s.call("GET", `/api/plans/${id}/picks`)).body;
    assert.ok(JSON.stringify(picks).includes("Riya"));
    await s.call("POST", `/api/plans/${id}/votes`, { pickId: picks.picks[0].id, memberKey: riya });

    assert.equal((await s.call("DELETE", `/api/plans/${id}/responses/me`, null, { "x-member-key": riya })).status, 200);

    const after = (await s.call("GET", `/api/plans/${id}/picks`)).body;
    const row = s.db.prepare("SELECT picks_json, session_json, log_json, winner_json FROM plans WHERE id = ?").get(id);
    const stored = JSON.stringify(row) + JSON.stringify(s.db.prepare("SELECT * FROM events WHERE plan_id = ?").all(id));
    assert.ok(!stored.includes("Riya"), "first name scrubbed from everything stored for the plan");
    assert.ok(!stored.includes("1777"), "budget gone from the plan log");
    assert.ok(after.members.includes("A friend"));
    assert.ok(after.voted.includes("A friend"), "their vote still counts");
    assert.ok(after.picks.every((p) => p.travel.some((t) => t.name === "A friend")));
    assert.ok(after.picks.some((p) => /\(A friend\)|A friend/.test(JSON.stringify(p))));

    // Voting still works and completes with the remaining members.
    await s.call("POST", `/api/plans/${id}/votes`, { pickId: after.picks[0].id }, org);
    const done = await s.call("POST", `/api/plans/${id}/votes`, { pickId: after.picks[0].id, memberKey: arjun });
    assert.equal(done.body.status, "decided");
  } finally { s.close(); }
});
