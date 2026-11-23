import test from "node:test";
import assert from "node:assert/strict";
import { openDb, purgeExpired } from "../server/db.js";
import { createApp } from "../server/app.js";
import { generatePicksWithMaps } from "../server/maps.js";
import { generatePicks } from "../src/engine.js";
import { AREAS, RESTAURANTS } from "../src/data.js";

async function setup(opts = {}) {
  const db = openDb(":memory:");
  const clock = { t: Date.parse("2026-11-28T10:00:00+05:30") };
  const codes = {};
  const app = createApp({ db, now: () => clock.t, sendOtp: async (p, c) => (codes[p] = c), mapsKey: undefined, adminKey: "adm", ...opts });
  const server = app.server();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null), text: null };
  };
  const signIn = async (phone = "9876543210", firstName = "Jenessa") => {
    await call("POST", "/api/auth/request-otp", { phone });
    const v = await call("POST", "/api/auth/verify", { phone, code: codes["+91" + phone], firstName });
    return { Authorization: "Bearer " + v.body.token };
  };
  return { db, clock, call, signIn, base, close: () => server.close(), codes };
}

const planBody = { date: "2026-11-28", time: "20:00", area: "anywhere", occasion: "Friends hangout", friends: ["Riya", "Arjun", "Meera"], organiserArea: "Koramangala", organiserBudget: 1500 };
const answer = (name, area, budget, extra = {}) => ({ name, area, budget, mood: "chill", dealbreakers: [], consent: true, ...extra });

test("OTP sign-in: wrong code rejected, right code gives a session, resend throttled", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("POST", "/api/auth/request-otp", { phone: "12345" })).status, 400);
    assert.equal((await s.call("POST", "/api/auth/request-otp", { phone: "98765 43210" })).status, 200);
    assert.equal((await s.call("POST", "/api/auth/request-otp", { phone: "9876543210" })).status, 429);
    assert.equal((await s.call("POST", "/api/auth/verify", { phone: "9876543210", code: "000000" })).status, 400);
    const ok = await s.call("POST", "/api/auth/verify", { phone: "9876543210", code: s.codes["+919876543210"], firstName: "Jenessa" });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    assert.equal((await s.call("POST", "/api/plans", planBody)).status, 401); // no session
  } finally { s.close(); }
});

test("OTP locks after 5 wrong attempts", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/auth/request-otp", { phone: "9876543210" });
    for (let i = 0; i < 5; i++) await s.call("POST", "/api/auth/verify", { phone: "9876543210", code: "111111" });
    const r = await s.call("POST", "/api/auth/verify", { phone: "9876543210", code: s.codes["+919876543210"] });
    assert.equal(r.status, 429);
  } finally { s.close(); }
});

test("full flow: plan -> friend answers (no sign-in) -> picks -> votes -> winner -> ratings", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const plan = await s.call("POST", "/api/plans", planBody, org);
    assert.equal(plan.status, 200);
    assert.match(plan.body.whatsapp, /^https:\/\/wa\.me\/\?text=/);
    const id = plan.body.id;

    const riya = await s.call("POST", `/api/plans/${id}/responses`, answer("Riya", "Koramangala", 1400));
    const arjun = await s.call("POST", `/api/plans/${id}/responses`, answer("Arjun", "HSR Layout", 1200, { dealbreakers: ["no-loud"] }));
    assert.equal(riya.status, 200);

    // Organiser tracker: who answered, not what.
    const status = await s.call("GET", `/api/plans/${id}`, null, org);
    assert.deepEqual(status.body.answered, ["Riya", "Arjun"]);
    assert.deepEqual(status.body.pending, ["Meera"]);
    assert.equal(status.body.isOrganiser, true);

    // Early picks by organiser once 2+ answered.
    assert.equal((await s.call("POST", `/api/plans/${id}/picks`, {})).status, 403);
    const picks = await s.call("POST", `/api/plans/${id}/picks`, {}, org);
    assert.equal(picks.status, 200);
    assert.equal(picks.body.status, "voting");
    assert.ok(picks.body.picks.length >= 1);
    assert.deepEqual(picks.body.members, ["Jenessa", "Riya", "Arjun"]);

    const pick = picks.body.picks[0].id;
    assert.equal((await s.call("POST", `/api/plans/${id}/votes`, { pickId: pick })).status, 403); // stranger
    await s.call("POST", `/api/plans/${id}/votes`, { pickId: pick }, org);
    await s.call("POST", `/api/plans/${id}/votes`, { pickId: pick, memberKey: riya.body.memberKey });
    const last = await s.call("POST", `/api/plans/${id}/votes`, { pickId: pick, memberKey: arjun.body.memberKey });
    assert.equal(last.body.status, "decided");
    assert.equal(last.body.winner.pick.id, pick);
    assert.match(last.body.winner.directionsUrl, /google\.com\/maps\/dir/);

    const early = await s.call("POST", `/api/plans/${id}/ratings`, { went: "yes", stars: 4, memberKey: riya.body.memberKey });
    assert.equal(early.status, 409, "no 'did you go' before the plan's time");
    assert.match(early.body.error, /after the meal/);
    s.clock.t = Date.parse("2026-11-28T20:30:00+05:30");
    const rate = await s.call("POST", `/api/plans/${id}/ratings`, { went: "yes", stars: 4, memberKey: riya.body.memberKey });
    assert.equal(rate.status, 200);
    assert.equal((await s.call("POST", `/api/plans/${id}/ratings`, { went: "maybe", memberKey: riya.body.memberKey })).status, 400);

    // PRD visit rate: only plans whose time has passed, and only when MOST members say they went.
    const metrics = async () => (await s.call("GET", "/api/admin/metrics", null, { "x-admin-key": "adm" })).body;
    s.clock.t = Date.parse("2026-11-29T10:00:00+05:30");
    assert.equal((await metrics()).visitRate.value, 0, "1 of 3 is not most");
    await s.call("POST", `/api/plans/${id}/ratings`, { went: "yes" }, org);
    const m = await metrics();
    assert.equal(m.visitRate.value, 1, "2 of 3 went");
    assert.equal(m.pickSatisfaction.value, 4);
    assert.equal(m.pickSatisfaction.ratings, 1, "a 'did you go' answer without stars is not a rating");
  } finally { s.close(); }
});

test("budget secrecy: no endpoint a friend or organiser can reach ever returns an individual budget", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", { ...planBody, organiserBudget: 1999 }, org)).body.id;
    const r1 = await s.call("POST", `/api/plans/${id}/responses`, answer("Riya", "Koramangala", 733));
    const r2 = await s.call("POST", `/api/plans/${id}/responses`, answer("Arjun", "HSR Layout", 2777));
    const seen = [JSON.stringify(r1.body), JSON.stringify(r2.body)];
    seen.push(JSON.stringify((await s.call("GET", `/api/plans/${id}`, null, org)).body));
    seen.push(JSON.stringify((await s.call("GET", `/api/plans/${id}`)).body));
    seen.push(JSON.stringify((await s.call("POST", `/api/plans/${id}/picks`, {}, org)).body));
    seen.push(JSON.stringify((await s.call("GET", `/api/plans/${id}/picks`)).body));
    for (const out of seen) for (const secret of ["733", "2777", "1999"]) assert.ok(!out.includes(secret), `leaked ${secret}`);
    // But the admin plan log (A2) keeps full inputs for weekly review.
    const log = await s.call("GET", `/api/admin/plans/${id}/log`, null, { "x-admin-key": "adm" });
    assert.ok(JSON.stringify(log.body).includes("733"));
    assert.equal((await s.call("GET", `/api/admin/plans/${id}/log`)).status, 403);
  } finally { s.close(); }
});

test("response validation: consent, duplicate, unknown name, bad start point, locked after picks", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", planBody, org)).body.id;
    const post = (b) => s.call("POST", `/api/plans/${id}/responses`, b);
    assert.equal((await post(answer("Riya", "Koramangala", 1000, { consent: false }))).status, 400);
    assert.equal((await post(answer("Stranger", "Koramangala", 1000))).status, 400);
    assert.equal((await post({ ...answer("Riya", undefined, 1000), area: undefined, start: { lat: 28.6, lng: 77.2 } })).status, 400); // Delhi
    assert.equal((await post({ ...answer("Riya", undefined, 1000), area: undefined, start: { lat: 12.95, lng: 77.62, label: "Home" } })).status, 200);
    assert.equal((await post(answer("riya", "Koramangala", 1000))).status, 409);
    assert.equal((await post(answer("Arjun", "HSR Layout", 1000, { mood: "angry" }))).status, 400);
    assert.equal((await post(answer("Arjun", "HSR Layout", 1000, { dealbreakers: ["hates-fun"] }))).status, 400);
    await post(answer("Arjun", "HSR Layout", 1000));
    await s.call("POST", `/api/plans/${id}/picks`, {}, org);
    assert.equal((await post(answer("Meera", "Indiranagar", 1000))).status, 409);
  } finally { s.close(); }
});

test("auto-generates when all friends answered", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", planBody, org)).body.id;
    for (const [n, a] of [["Riya", "Koramangala"], ["Arjun", "HSR Layout"], ["Meera", "Koramangala"]]) {
      const r = await s.call("POST", `/api/plans/${id}/responses`, answer(n, a, 1200));
      assert.equal(r.status, 200, JSON.stringify(r.body)); // the last submit triggers generation
    }
    assert.equal((await s.call("GET", `/api/plans/${id}`)).body.status, "voting");
  } finally { s.close(); }
});

test("generates at the response deadline with whoever answered; voting closes at its deadline", async () => {
  const s = await setup({ voteWindowMs: 3600000 });
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", planBody, org)).body.id;
    const r = await s.call("POST", `/api/plans/${id}/responses`, answer("Riya", "Koramangala", 1200));
    assert.equal((await s.call("GET", `/api/plans/${id}`)).body.status, "open");
    s.clock.t += 3 * 3600000; // past the 2h default deadline
    const st = await s.call("GET", `/api/plans/${id}`);
    assert.equal(st.body.status, "voting");
    const pk = await s.call("GET", `/api/plans/${id}/picks`);
    assert.ok(pk.body.notes.some((n) => /Planned without Arjun/.test(n)));
    await s.call("POST", `/api/plans/${id}/votes`, { pickId: pk.body.picks[0].id, memberKey: r.body.memberKey });
    s.clock.t += 2 * 3600000;
    const done = await s.call("GET", `/api/plans/${id}/picks`);
    assert.equal(done.body.status, "decided");
    assert.equal(done.body.winner.pick.id, pk.body.picks[0].id);
  } finally { s.close(); }
});

test("veto via API swaps the pick; second veto by same person is refused", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", planBody, org)).body.id;
    const a = await s.call("POST", `/api/plans/${id}/responses`, answer("Riya", "Koramangala", 1500));
    await s.call("POST", `/api/plans/${id}/responses`, answer("Arjun", "Koramangala", 1500));
    const picks = (await s.call("POST", `/api/plans/${id}/picks`, {}, org)).body;
    const [p1, p2] = picks.picks;
    const after = await s.call("POST", `/api/plans/${id}/vetoes`, { pickId: p1.id, memberKey: a.body.memberKey });
    assert.equal(after.status, 200);
    assert.ok(!after.body.picks.some((p) => p.id === p1.id));
    assert.equal((await s.call("POST", `/api/plans/${id}/vetoes`, { pickId: p2.id, memberKey: a.body.memberKey })).status, 409);
  } finally { s.close(); }
});

test("organiser override is logged; only the organiser can decide early", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", planBody, org)).body.id;
    const a = await s.call("POST", `/api/plans/${id}/responses`, answer("Riya", "Koramangala", 1500));
    await s.call("POST", `/api/plans/${id}/responses`, answer("Arjun", "Koramangala", 1500));
    const picks = (await s.call("POST", `/api/plans/${id}/picks`, {}, org)).body;
    assert.equal((await s.call("POST", `/api/plans/${id}/decide`, {}, {})).status, 403);
    const d = await s.call("POST", `/api/plans/${id}/decide`, { overridePickId: picks.picks[1].id }, org);
    assert.equal(d.body.winner.overridden, true);
    const log = await s.call("GET", `/api/admin/plans/${id}/log`, null, { "x-admin-key": "adm" });
    assert.ok(log.body.events.some((e) => e.type === "organiser_override"));
  } finally { s.close(); }
});

test("organiser can list only their own plans; pages are served", async () => {
  const s = await setup();
  try {
    const a = await s.signIn("9876543210", "Jenessa");
    const b = await s.signIn("9123456789", "Kabir");
    await s.call("POST", "/api/plans", { ...planBody, occasion: "A" }, a);
    await s.call("POST", "/api/plans", { ...planBody, occasion: "B" }, b);
    const mine = await s.call("GET", "/api/plans", null, a);
    assert.deepEqual(mine.body.plans.map((p) => p.occasion), ["A"]);
    assert.equal(mine.body.firstName, "Jenessa");
    assert.equal((await s.call("GET", "/api/plans")).status, 401);
    const home = await fetch(s.base + "/");
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Plan with friends/);
  } finally { s.close(); }
});

test("taste profile: all fields skippable, editable, validated, and removed with the account", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const me0 = await s.call("GET", "/api/me", null, org);
    assert.equal(me0.body.profile, null);
    assert.ok(me0.body.options.cuisines.includes("pan-asian"));
    assert.equal((await s.call("GET", "/api/me")).status, 401);

    const empty = await s.call("PUT", "/api/me/profile", {}, org); // skip everything
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.profile.cuisines, []);
    assert.equal(empty.body.profile.diet, null);

    const full = { cuisines: ["pan-asian", "italian"], diet: "veg", spice: "hot", budgetBand: "500-800", vibe: ["chill", "quiet"], home: "HSR Layout", work: "Indiranagar" };
    assert.deepEqual((await s.call("PUT", "/api/me/profile", full, org)).body.profile, full);
    assert.deepEqual((await s.call("GET", "/api/me", null, org)).body.profile, full);
    assert.deepEqual((await s.call("PUT", "/api/me/profile", { ...full, diet: "vegan" }, org)).body.profile.diet, "vegan"); // editable later

    for (const bad of [{ cuisines: ["pizza-planet"] }, { diet: "carnivore" }, { budgetBand: "free" }, { vibe: ["angry"] }, { home: "Mumbai" }, { cuisines: "pan-asian" }])
      assert.equal((await s.call("PUT", "/api/me/profile", bad, org)).status, 400, JSON.stringify(bad));
    assert.equal((await s.call("PUT", "/api/me/profile", full)).status, 401);

    assert.equal((await s.call("DELETE", "/api/me", null, org)).status, 200);
    const again = await s.signIn();
    assert.equal((await s.call("GET", "/api/me", null, again)).body.profile, null);
  } finally { s.close(); }
});

test("with a profile, a plan needs no start point or budget and the profile shapes the picks", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const noProfile = await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya", "Arjun"] }, org);
    assert.equal(noProfile.status, 400); // nothing to default from

    await s.call("PUT", "/api/me/profile", { cuisines: ["south-indian"], diet: "veg", budgetBand: "500-800", vibe: ["quick"], home: "Koramangala" }, org);
    const plan = await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya", "Arjun"] }, org); // 3 fields, nothing else
    assert.equal(plan.status, 200);
    const id = plan.body.id;
    for (const n of ["Riya", "Arjun"]) await s.call("POST", `/api/plans/${id}/responses`, answer(n, "Koramangala", 2000));

    const picks = await s.call("GET", `/api/plans/${id}/picks`);
    assert.ok(picks.body.picks.length > 0);
    for (const p of picks.body.picks) assert.ok(p.pricePerHead <= 800, "band ceiling applied"); // 500-800 -> 800
    const log = (await s.call("GET", `/api/admin/plans/${id}/log`, null, { "x-admin-key": "adm" })).body.log;
    const me = log.inputs.members[0];
    assert.deepEqual(me.dealbreakers, ["needs-veg"]); // diet became a dealbreaker
    assert.deepEqual(me.cuisines, ["south-indian"]);
    assert.deepEqual(me.mood, ["quick"]);
    assert.equal(me.budget, 800);
    // The profile is snapshotted: editing it afterwards does not change a running plan.
    await s.call("PUT", "/api/me/profile", { diet: "vegan", budgetBand: "under-500" }, org);
    const same = (await s.call("GET", `/api/admin/plans/${id}/log`, null, { "x-admin-key": "adm" })).body.log;
    assert.equal(same.inputs.members[0].budget, 800);
  } finally { s.close(); }
});

test("explicit plan fields override profile defaults; 1200+ band adds no ceiling", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    await s.call("PUT", "/api/me/profile", { budgetBand: "1200-plus", home: "HSR Layout" }, org);
    const id = (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya"], organiserArea: "Indiranagar", organiserBudget: 600 }, org)).body.id;
    await s.call("POST", `/api/plans/${id}/responses`, answer("Riya", "Indiranagar", 2000));
    await s.call("POST", `/api/plans/${id}/picks`, {}, org).catch(() => {});
    const row = s.db.prepare("SELECT organiser_budget, organiser_start FROM plans WHERE id = ?").get(id);
    assert.equal(row.organiser_budget, 600);
    assert.equal(JSON.parse(row.organiser_start).lat, AREAS.Indiranagar.lat);
    const id2 = (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya"] }, org)).body.id;
    assert.equal(s.db.prepare("SELECT organiser_budget b FROM plans WHERE id = ?").get(id2).b, null);
  } finally { s.close(); }
});

test("places the organiser rated 'went: yes' count as not new in later plans", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    await s.call("PUT", "/api/me/profile", { home: "Koramangala" }, org);
    const mk = async () => {
      const id = (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya"] }, org)).body.id;
      const r = await s.call("POST", `/api/plans/${id}/responses`, answer("Riya", "Koramangala", 1500));
      return { id, key: r.body.memberKey };
    };
    const p1 = await mk();
    const winner = (await s.call("GET", `/api/plans/${p1.id}/picks`)).body.picks[0];
    await s.call("POST", `/api/plans/${p1.id}/decide`, { overridePickId: winner.id }, org);
    s.clock.t = Date.parse("2026-11-28T21:00:00+05:30"); // after the meal
    await s.call("POST", `/api/plans/${p1.id}/ratings`, { went: "yes", stars: 5 }, org);
    const p2 = await mk();
    await s.call("GET", `/api/plans/${p2.id}/picks`);
    const log = (await s.call("GET", `/api/admin/plans/${p2.id}/log`, null, { "x-admin-key": "adm" })).body.log;
    assert.deepEqual(log.inputs.members[0].visited, [winner.id]);
    const shown = log.ranked.find((r) => r.id === winner.id);
    assert.ok(shown.factors.novelty < 1, "visited place is less novel for the group");
  } finally { s.close(); }
});

// ---------- Couples mode (F12) ----------

const couple = (extra = {}) => ({ date: "2026-12-05", time: "20:00", friends: ["Priya"], mode: "couple", organiserArea: "Koramangala", organiserBudget: 1500, occasion: "Date night", ...extra });
const withKey = (key) => ({ "x-member-key": key });
const REVEAL = Date.parse("2026-12-05T00:00:00+05:30");

test("couples: validation (exactly one partner, surprise only for date night, known filters)", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const post = (b) => s.call("POST", "/api/plans", b, org);
    assert.equal((await post(couple({ friends: ["A", "B"] }))).status, 400);
    assert.equal((await post(couple({ friends: [] }))).status, 400);
    assert.equal((await post({ ...couple(), mode: "friends", friends: ["A"], surprise: "partner" })).status, 400);
    assert.equal((await post(couple({ surprise: "both" }))).status, 400);
    assert.equal((await post(couple({ noise: "deafening" }))).status, 400);
    assert.equal((await post(couple({ ambience: ["spooky"] }))).status, 400);
    assert.equal((await post(couple({ noise: "quiet", ambience: ["chill"], surprise: "partner" }))).status, 200);
  } finally { s.close(); }
});

test("couples: noise and ambience filters apply, and the plan generates as soon as the partner answers", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", couple({ noise: "quiet", ambience: ["chill", "quiet"] }), org)).body.id;
    const r = await s.call("POST", `/api/plans/${id}/responses`, answer("Priya", "Koramangala", 1500));
    assert.equal(r.status, 200);
    const picks = (await s.call("GET", `/api/plans/${id}/picks`)).body;
    assert.equal(picks.status, "voting");
    assert.ok(picks.picks.length > 0);
    for (const p of picks.picks) {
      const rest = RESTAURANTS.find((x) => x.id === p.id);
      assert.equal(rest.noise, "quiet");
      assert.ok(rest.vibes.some((v) => ["chill", "quiet"].includes(v)));
    }
    assert.deepEqual(picks.members, ["Jenessa", "Priya"]); // no surprise: both vote
    const log = (await s.call("GET", `/api/admin/plans/${id}/log`, null, { "x-admin-key": "adm" })).body.log;
    assert.ok(log.filtered.some((f) => f.rules.includes("noise")));
  } finally { s.close(); }
});

test("couples: no surprise means both partners vote and agree", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", couple(), org)).body.id;
    const k = (await s.call("POST", `/api/plans/${id}/responses`, answer("Priya", "Koramangala", 1500))).body.memberKey;
    const picks = (await s.call("GET", `/api/plans/${id}/picks`, null, withKey(k))).body;
    assert.equal(picks.surprise, null);
    const first = picks.picks[0].id;
    await s.call("POST", `/api/plans/${id}/votes`, { pickId: first }, org);
    const done = await s.call("POST", `/api/plans/${id}/votes`, { pickId: first, memberKey: k });
    assert.equal(done.body.status, "decided");
    assert.equal(done.body.winner.pick.id, first);
  } finally { s.close(); }
});

test("surprise my partner: the partner learns nothing until the day; the organiser alone decides", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", couple({ surprise: "partner" }), org)).body.id;
    const k = (await s.call("POST", `/api/plans/${id}/responses`, answer("Priya", "Koramangala", 1500))).body.memberKey;
    const seen = []; // every response the hidden partner (or a stranger) can get
    const partnerView = async () => { const r = await s.call("GET", `/api/plans/${id}/picks`, null, withKey(k)); seen.push(JSON.stringify(r.body)); return r.body; };

    const before = await partnerView();
    assert.equal(before.hidden, true);
    assert.deepEqual(before.picks, []);
    assert.equal(before.winner, null);
    seen.push(JSON.stringify((await s.call("GET", `/api/plans/${id}/picks`)).body)); // stranger / missing key: also hidden
    assert.equal((await s.call("GET", `/api/plans/${id}/picks`)).body.hidden, true);
    seen.push(JSON.stringify((await s.call("GET", `/api/plans/${id}`, null, withKey(k))).body));

    const mine = (await s.call("GET", `/api/plans/${id}/picks`, null, org)).body; // the organiser sees everything
    assert.ok(!mine.hidden && mine.picks.length > 0);
    assert.equal(mine.surprise.hiddenFrom, "Priya");
    assert.deepEqual(mine.members, ["Jenessa"]); // only the organiser votes

    // The hidden partner cannot vote, veto or probe.
    for (const kind of ["votes", "vetoes"]) {
      const r = await s.call("POST", `/api/plans/${id}/${kind}`, { pickId: mine.picks[0].id, memberKey: k });
      assert.equal(r.status, 409);
      seen.push(JSON.stringify(r.body));
    }

    const winner = mine.picks[0];
    const voted = await s.call("POST", `/api/plans/${id}/votes`, { pickId: winner.id }, org);
    assert.equal(voted.body.status, "decided"); // one vote decides
    assert.equal(voted.body.winner.pick.id, winner.id);

    const after = await partnerView(); // decided, but still hidden from the partner
    assert.equal(after.hidden, true);
    assert.equal(after.status, "decided");
    assert.equal(after.winner, null);
    for (const out of seen) {
      assert.ok(!out.includes("Sample"), "restaurant name leaked");
      assert.ok(!out.includes(winner.id), "pick id leaked");
    }

    s.clock.t = REVEAL + 1000; // the day arrives
    const reveal = await partnerView();
    assert.ok(!reveal.hidden);
    assert.equal(reveal.winner.pick.id, winner.id);
    assert.equal((await s.call("GET", `/api/plans/${id}/picks`)).body.hidden, undefined); // unknown viewers see it too once revealed
    s.clock.t = REVEAL - 1000;
  } finally { s.close(); }
});

test("surprise me: the organiser is the one kept in the dark; the partner chooses; organiser cannot decide or probe", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", couple({ surprise: "organiser" }), org)).body.id;
    const k = (await s.call("POST", `/api/plans/${id}/responses`, answer("Priya", "Koramangala", 1500))).body.memberKey;
    const seen = [];
    const orgView = async () => { const r = await s.call("GET", `/api/plans/${id}/picks`, null, org); seen.push(JSON.stringify(r.body)); return r.body; };

    assert.equal((await orgView()).hidden, true);
    const hers = (await s.call("GET", `/api/plans/${id}/picks`, null, withKey(k))).body;
    assert.ok(!hers.hidden && hers.picks.length > 0);
    assert.equal(hers.surprise.hiddenFrom, "Jenessa");
    assert.deepEqual(hers.members, ["Priya"]);

    // Organiser cannot vote, close, override, or regenerate their way to a peek.
    const v = await s.call("POST", `/api/plans/${id}/votes`, { pickId: hers.picks[0].id }, org);
    assert.equal(v.status, 409); seen.push(JSON.stringify(v.body));
    const d1 = await s.call("POST", `/api/plans/${id}/decide`, {}, org);
    const d2 = await s.call("POST", `/api/plans/${id}/decide`, { overridePickId: hers.picks[0].id }, org);
    assert.equal(d1.status, 403); assert.equal(d2.status, 403);
    seen.push(JSON.stringify(d1.body), JSON.stringify(d2.body));

    const done = await s.call("POST", `/api/plans/${id}/votes`, { pickId: hers.picks[1] ? hers.picks[1].id : hers.picks[0].id, memberKey: k });
    assert.equal(done.body.status, "decided");
    const chosen = done.body.winner.pick;
    const after = await orgView();
    assert.equal(after.hidden, true);
    assert.equal(after.winner, null);
    for (const out of seen) assert.ok(!out.includes("Sample") && !out.includes(chosen.id), "leaked to the hidden organiser");

    s.clock.t = REVEAL + 1000;
    assert.equal((await orgView()).winner.pick.id, chosen.id);
    s.clock.t = REVEAL - 1000;
  } finally { s.close(); }
});

test("couples: the planner can loosen filters when nothing fits", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", couple({ noise: "quiet", ambience: ["lively"] }), org)).body.id; // no quiet+lively place exists
    await s.call("POST", `/api/plans/${id}/responses`, answer("Priya", "Koramangala", 1500));
    assert.equal((await s.call("GET", `/api/plans/${id}`)).body.status, "no_picks");
    const retry = await s.call("POST", `/api/plans/${id}/picks`, { noise: "medium", ambience: ["lively", "chill"] }, org);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.status, "voting");
  } finally { s.close(); }
});

// ---------- Solo "find something new" (F13) ----------

const solo = (s, org, body = {}) => s.call("POST", "/api/solo/picks", body, org);
const allIds = (b) => [...b.picks, ...b.nearMisses].map((p) => p.id);

test("solo: needs sign-in and a start point; returns 3 picks from the profile with solo wording and directions", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("POST", "/api/solo/picks", {})).status, 401);
    const org = await s.signIn();
    assert.equal((await solo(s, org)).status, 400); // nothing to start from
    await s.call("PUT", "/api/me/profile", { home: "Koramangala", cuisines: ["south-indian"], budgetBand: "800-1200" }, org);
    const r = await solo(s, org);
    assert.equal(r.status, 200);
    assert.equal(r.body.picks.length, 3);
    assert.ok(r.body.picks.some((p) => p.id === "r02"), "south-indian favourite should surface");
    for (const p of r.body.picks) {
      assert.ok(p.pricePerHead <= 1200);
      assert.match(p.directionsUrl, /google\.com\/maps\/dir\/\?api=1&destination=12\./);
      assert.match(p.reason, /new to you/);
      assert.match(p.reason, /min away/);
      assert.equal(p.travel.length, 1);
    }
    assert.ok(!JSON.stringify(r.body).includes("Jenessa"), "no personal name in solo output");
    // Start area can be given per request instead of the profile.
    assert.equal((await solo(s, org, { startArea: "Indiranagar", area: "Indiranagar" })).status, 200);
    assert.equal((await solo(s, org, { startArea: "Mumbai" })).status, 400);
    assert.equal((await solo(s, org, { time: "8pm" })).status, 400);
  } finally { s.close(); }
});

test("solo: a place marked 'been there' never appears, not even as a near miss; unmarking brings it back", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    await s.call("PUT", "/api/me/profile", { home: "Koramangala" }, org);
    assert.equal((await s.call("POST", "/api/me/places", { restaurantId: "nope" }, org)).status, 404);
    assert.equal((await s.call("POST", "/api/me/places", { restaurantId: "r02" })).status, 401);

    const marked = new Set();
    // Keep marking whatever is offered until the pool runs dry: no marked id may ever come back.
    for (let i = 0; i < 20; i++) {
      const r = (await solo(s, org)).body;
      for (const id of allIds(r)) assert.ok(!marked.has(id), `${id} was marked 'been there' but came back`);
      if (!r.picks.length) break;
      for (const p of r.picks) {
        await s.call("POST", "/api/me/places", { restaurantId: p.id, been: true }, org);
        marked.add(p.id);
      }
    }
    assert.ok(marked.size >= 6, "should have worked through several rounds");
    const list = (await s.call("GET", "/api/me/places", null, org)).body.been;
    assert.deepEqual(list.map((p) => p.id).sort(), [...marked].sort());
    assert.equal((await solo(s, org)).body.beenCount, marked.size);

    const back = [...marked][0];
    await s.call("POST", "/api/me/places", { restaurantId: back, been: false }, org); // changed my mind
    // Everything else is still marked, so the one place we un-marked is the only one left to offer.
    assert.deepEqual((await solo(s, org)).body.picks.map((p) => p.id), [back]);
    assert.ok(!(await s.call("GET", "/api/me/places", null, org)).body.been.some((p) => p.id === back));
  } finally { s.close(); }
});

test("solo: marks are per person, and a place rated 'went: yes' on a group plan also counts as been there", async () => {
  const s = await setup();
  try {
    const a = await s.signIn("9876543210", "Jenessa");
    const b = await s.signIn("9123456789", "Kabir");
    for (const who of [a, b]) await s.call("PUT", "/api/me/profile", { home: "Koramangala" }, who);
    const first = (await solo(s, a)).body.picks[0].id;
    await s.call("POST", "/api/me/places", { restaurantId: first }, a);
    assert.ok(!allIds((await solo(s, a)).body).includes(first));
    assert.ok(allIds((await solo(s, b)).body).includes(first), "Kabir has not been there");

    // Group plan: win + rate 'went yes' -> also excluded from solo.
    const id = (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya"] }, b)).body.id;
    await s.call("POST", `/api/plans/${id}/responses`, answer("Riya", "Koramangala", 1500));
    const w = (await s.call("GET", `/api/plans/${id}/picks`)).body.picks[0].id;
    await s.call("POST", `/api/plans/${id}/decide`, { overridePickId: w }, b);
    s.clock.t = Date.parse("2026-11-28T21:00:00+05:30"); // after the meal
    await s.call("POST", `/api/plans/${id}/ratings`, { went: "yes", stars: 4 }, b);
    assert.ok(!allIds((await solo(s, b)).body).includes(w));
    // Kabir's rating is Kabir's: Jenessa's been-there list holds only what Jenessa marked.
    assert.deepEqual((await s.call("GET", "/api/me/places", null, a)).body.been.map((p) => p.id), [first]);
  } finally { s.close(); }
});

test("solo: profile shapes the result (budget ceiling, diet), few matches come with labelled near misses, and 'been there' feeds group novelty", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    await s.call("PUT", "/api/me/profile", { home: "Koramangala", budgetBand: "under-500" }, org);
    const r = (await solo(s, org, { area: "Koramangala" })).body;
    for (const p of r.picks) assert.ok(p.pricePerHead <= 500);
    assert.ok(r.picks.length < 3 && r.nearMisses.length > 0);
    for (const m of r.nearMisses) assert.ok(m.broken.length > 0 && m.broken.every((x) => ["travel", "budget"].includes(x.rule)));

    // A "been there" mark also makes a place less novel in this organiser's group plans.
    await s.call("POST", "/api/me/places", { restaurantId: "r07" }, org);
    const id = (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya"] }, org)).body.id;
    await s.call("POST", `/api/plans/${id}/responses`, answer("Riya", "Koramangala", 1500));
    await s.call("GET", `/api/plans/${id}/picks`);
    const log = (await s.call("GET", `/api/admin/plans/${id}/log`, null, { "x-admin-key": "adm" })).body.log;
    assert.ok(log.inputs.members[0].visited.includes("r07"));
  } finally { s.close(); }
});

// ---------- Want-to-try list (F14) ----------

const mark = (s, who, restaurantId, status) => s.call("POST", "/api/me/places", { restaurantId, status }, who);
const subset = (...ids) => RESTAURANTS.filter((r) => ids.includes(r.id));

test("want-to-try: save, move to been, remove, and the conflict rule", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    assert.equal((await s.call("POST", "/api/me/places", { restaurantId: "r01", status: "want" })).status, 401);
    assert.equal((await mark(s, org, "nope", "want")).status, 404);
    assert.equal((await mark(s, org, "r01", "maybe")).status, 400);

    await mark(s, org, "r01", "want");
    await mark(s, org, "r02", "want");
    const l1 = (await s.call("GET", "/api/me/places", null, org)).body;
    assert.deepEqual(l1.want.map((p) => p.id), ["r02", "r01"]); // newest first
    assert.deepEqual(l1.been, []);
    assert.equal(l1.want[0].pricePerHead, 350);

    await mark(s, org, "r01", "been"); // went: it leaves the want list
    const l2 = (await s.call("GET", "/api/me/places", null, org)).body;
    assert.deepEqual(l2.want.map((p) => p.id), ["r02"]);
    assert.deepEqual(l2.been.map((p) => p.id), ["r01"]);

    assert.equal((await mark(s, org, "r01", "want")).status, 409); // can't quietly un-visit
    assert.equal((await mark(s, org, "r01", null)).status, 200); // explicit remove, then it can be wanted again
    assert.equal((await mark(s, org, "r01", "want")).status, 200);
    assert.equal((await s.call("POST", "/api/me/places", { restaurantId: "r02", been: false }, org)).status, 200); // legacy shape
    assert.deepEqual((await s.call("GET", "/api/me/places", null, org)).body.want.map((p) => p.id), ["r01"]);
  } finally { s.close(); }
});

test("solo marks saved places so the card can show 'Saved'; saved places are not excluded (only been-there is)", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    await s.call("PUT", "/api/me/profile", { home: "Koramangala" }, org);
    const first = (await solo(s, org)).body.picks[0].id;
    await mark(s, org, first, "want");
    const again = (await solo(s, org)).body.picks.find((p) => p.id === first);
    assert.ok(again && again.saved === true);
  } finally { s.close(); }
});

test("candidates: saved places join the plan even outside the chosen area, and are labelled", async () => {
  const s = await setup({ restaurants: subset("r01", "r09") }); // r01 Koramangala, r09 HSR Layout
  try {
    const org = await s.signIn();
    await mark(s, org, "r09", "want");
    const mk = async (extra) => {
      const id = (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", area: "Koramangala", friends: ["Riya"], organiserArea: "Koramangala", organiserBudget: 1500, ...extra }, org)).body.id;
      await s.call("POST", `/api/plans/${id}/responses`, answer("Riya", "Koramangala", 1500));
      return { id, picks: (await s.call("GET", `/api/plans/${id}/picks`)).body };
    };
    const plain = await mk({});
    assert.deepEqual(plain.picks.picks.map((p) => p.id), ["r01"]); // HSR place is outside the area

    const withCand = await mk({ candidateIds: ["r09"] });
    assert.deepEqual(withCand.picks.picks.map((p) => p.id).sort(), ["r01", "r09"]);
    const c = withCand.picks.picks.find((p) => p.id === "r09");
    assert.equal(c.fromWantList, true);
    assert.match(c.reason, /on Jenessa's want-to-try list$/);
    assert.ok(!withCand.picks.picks.find((p) => p.id === "r01").fromWantList);
  } finally { s.close(); }
});

test("candidates get no ranking boost and face every filter (and the drop reason stays private)", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    await mark(s, org, "r09", "want"); // in the pool anyway when area is 'anywhere'
    await mark(s, org, "r14", "want"); // 1800 a head: over the 1013 ceiling below
    const run2 = async (extra) => {
      // Distinctive budgets so a leak cannot be mistaken for a restaurant price.
      const id = (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya", "Arjun"], organiserArea: "Koramangala", organiserBudget: 1511, ...extra }, org)).body.id;
      await s.call("POST", `/api/plans/${id}/responses`, answer("Riya", "Koramangala", 1013));
      await s.call("POST", `/api/plans/${id}/responses`, answer("Arjun", "HSR Layout", 2027));
      const pk = (await s.call("GET", `/api/plans/${id}/picks`)).body;
      const log = (await s.call("GET", `/api/admin/plans/${id}/log`, null, { "x-admin-key": "adm" })).body.log;
      return { pk, log };
    };
    const a = await run2({});
    const b = await run2({ candidateIds: ["r09", "r14"] });
    assert.deepEqual(a.log.ranked, b.log.ranked, "candidates must not change any score or the ranking");
    assert.ok(!b.log.ranked.some((r) => r.id === "r14"), "over-budget candidate is filtered like any place");
    assert.ok(!b.pk.picks.some((p) => p.id === "r14"));
    const out = JSON.stringify(b.pk);
    assert.ok(!/too (pricey|expensive)|over budget/i.test(out), "no per-person budget hint");
    for (const secret of ["1013", "2027", "1511"]) assert.ok(!out.includes(secret), `budget ${secret} leaked`);
  } finally { s.close(); }
});

test("candidates: validation", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const other = await s.signIn("9123456789", "Kabir");
    await mark(s, org, "r01", "want");
    await mark(s, org, "r02", "been");
    await mark(s, other, "r03", "want");
    const post = (b, who = org) => s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya"], organiserArea: "Koramangala", ...b }, who);
    assert.equal((await post({ candidateIds: ["r01"] })).status, 200);
    assert.equal((await post({ candidateIds: ["r05"] })).status, 400); // not on the list
    assert.equal((await post({ candidateIds: ["r02"] })).status, 400); // been there, not a wish
    assert.equal((await post({ candidateIds: ["r03"] })).status, 400); // someone else's list
    assert.equal((await post({ candidateIds: "r01" })).status, 400);
    assert.equal((await post({ candidateIds: 5 })).status, 400);
    for (const id of ["r04", "r05", "r06", "r07", "r08", "r09"]) await mark(s, org, id, "want");
    assert.equal((await post({ candidateIds: ["r01", "r04", "r05", "r06", "r07", "r08"] })).status, 400); // max 5
  } finally { s.close(); }
});

test("rating 'went: yes' on a want-to-try winner moves it to been-there; friends' ratings don't", async () => {
  const s = await setup({ restaurants: subset("r09") });
  try {
    const org = await s.signIn();
    await mark(s, org, "r09", "want");
    const id = (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", area: "HSR Layout", friends: ["Riya"], organiserArea: "HSR Layout", candidateIds: ["r09"] }, org)).body.id;
    const k = (await s.call("POST", `/api/plans/${id}/responses`, answer("Riya", "HSR Layout", 1500))).body.memberKey;
    await s.call("POST", `/api/plans/${id}/decide`, { overridePickId: "r09" }, org);
    s.clock.t = Date.parse("2026-11-28T21:00:00+05:30"); // after the meal
    await s.call("POST", `/api/plans/${id}/ratings`, { went: "yes", stars: 5, memberKey: k });
    assert.deepEqual((await s.call("GET", "/api/me/places", null, org)).body.want.map((p) => p.id), ["r09"]); // Riya's yes is not mine
    await s.call("POST", `/api/plans/${id}/ratings`, { went: "yes", stars: 5 }, org);
    const l = (await s.call("GET", "/api/me/places", null, org)).body;
    assert.deepEqual(l.want, []);
    assert.deepEqual(l.been.map((p) => p.id), ["r09"]);
  } finally { s.close(); }
});

test("deleting the account removes 'been there' marks", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    await s.call("POST", "/api/me/places", { restaurantId: "r01" }, org);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM user_places").get().n, 1);
    await s.call("DELETE", "/api/me", null, org);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM user_places").get().n, 0);
  } finally { s.close(); }
});

test("friend link page has link-preview tags with plan name and date, escaped", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", { ...planBody, occasion: 'A "party" <b>' }, org)).body.id;
    const html = await (await fetch(`${s.base}/p/${id}`)).text();
    assert.match(html, /og:title" content="A &quot;party&quot; &lt;b&gt; on 2026-11-28"/);
    assert.ok(!html.includes("<b>"));
  } finally { s.close(); }
});

test("DELETE /api/me removes the organiser's data; purge removes responses 90 days after the plan", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = (await s.call("POST", "/api/plans", planBody, org)).body.id;
    await s.call("POST", `/api/plans/${id}/responses`, answer("Riya", "Koramangala", 1200));
    assert.equal(purgeExpired(s.db, s.clock.t), 0);
    assert.equal(purgeExpired(s.db, s.clock.t + 91 * 86400000), 1);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM responses").get().n, 0);
    assert.equal((await s.call("DELETE", "/api/me", null, org)).status, 401); // purge also expired the old session
    const again = await s.signIn();
    assert.equal((await s.call("DELETE", "/api/me", null, again)).status, 200);
    assert.equal((await s.call("GET", `/api/plans/${id}`)).status, 404);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM users").get().n, 0);
  } finally { s.close(); }
});

// ---------- Maps adapter (mocked fetch; no real Google calls) ----------

const mapsInput = () => ({
  plan: { time: "20:00" },
  members: [
    { name: "Riya", start: AREAS.Koramangala, budget: 1500, dealbreakers: [], mood: null, cuisines: [], visited: [] },
    { name: "Arjun", start: AREAS["HSR Layout"], budget: 1500, dealbreakers: [], mood: null, cuisines: [], visited: [] },
  ],
  restaurants: RESTAURANTS,
});

test("maps: no API key behaves exactly like the plain engine", async () => {
  const db = openDb(":memory:");
  const a = await generatePicksWithMaps(mapsInput(), { db });
  const b = generatePicks(mapsInput());
  assert.deepEqual(a.picks.map((p) => p.id), b.picks.map((p) => p.id));
});

test("maps: uses Google minutes, only fetches places that pass hard filters, and caches", async () => {
  const db = openDb(":memory:");
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const dests = url.searchParams.get("destinations").split("|");
    return { ok: true, json: async () => ({ status: "OK", rows: [{ elements: dests.map(() => ({ status: "OK", duration_in_traffic: { value: 17 * 60 } })) }] }) };
  };
  const res = await generatePicksWithMaps(mapsInput(), { db, apiKey: "test-key", fetchImpl });
  assert.equal(res.travelFallback, false);
  assert.ok(res.picks.every((p) => p.travel.every((t) => t.minutes === 17)));
  const hardPassing = res.log.filtered.length; // closed/dealbreaker/seating never get a lookup
  const requested = urls.reduce((n, u) => n + u.searchParams.get("destinations").split("|").length, 0);
  assert.equal(requested, 2 * (RESTAURANTS.length - hardPassing)); // 2 members x surviving places
  assert.ok(urls.every((u) => u.searchParams.get("key") === "test-key" && u.searchParams.has("departure_time")));
  const before = urls.length;
  await generatePicksWithMaps(mapsInput(), { db, apiKey: "test-key", fetchImpl });
  assert.equal(urls.length, before); // second plan served from cache
});

test("maps: service failure falls back to straight-line and says so on the cards", async () => {
  const db = openDb(":memory:");
  const fetchImpl = async () => ({ ok: false, status: 503 });
  const res = await generatePicksWithMaps(mapsInput(), { db, apiKey: "k", fetchImpl });
  assert.equal(res.travelFallback, true);
  assert.ok(res.picks.length > 0);
  assert.ok(res.picks.every((p) => p.travelEstimate));
  assert.ok(res.notes.includes("Travel times are straight-line estimates"));
});
