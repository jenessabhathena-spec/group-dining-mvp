import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";
import { makePlaces, roundCoord, inBengaluru, BENGALURU } from "../server/places.js";
import { AREAS } from "../src/data.js";

const KEY = "AIza-test-key-9f3";
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
const TOKEN = "3f1c2a9e-77aa-4c1d-9b0e-5d2f6a8c1b44";

const autocompleteBody = {
  suggestions: [
    { placePrediction: { placeId: "ChIJ-aaaaaaaa1", text: { text: "Third Wave Coffee, 100 Feet Road, Indiranagar, Bengaluru" }, structuredFormat: { mainText: { text: "Third Wave Coffee" }, secondaryText: { text: "100 Feet Road, Indiranagar, Bengaluru" } } } },
    { placePrediction: { placeId: "bad id with spaces", text: { text: "Junk" } } }, // filtered: not a valid id
    { queryPrediction: { text: { text: "coffee near me" } } }, // filtered: not a place
    { placePrediction: { placeId: "ChIJ-bbbbbbbb2", text: { text: "Only Full Text, Koramangala" } } }, // no structuredFormat: falls back to text
  ],
};

test("roundCoord and bounds", () => {
  assert.equal(roundCoord(12.93527), 12.935);
  assert.equal(roundCoord(77.62451), 77.625);
  assert.ok(inBengaluru(12.97, 77.6));
  assert.ok(!inBengaluru(28.6, 77.2));
  assert.ok(!inBengaluru("12.9", 77.6));
  assert.ok(!inBengaluru(undefined, undefined));
  assert.deepEqual(Object.keys(BENGALURU), ["low", "high"]);
});

test("no key: built-in area search and details, rounded", async () => {
  const p = makePlaces({ areas: AREAS });
  assert.equal(p.hasGoogle, false);
  const r = await p.search("hsr");
  assert.equal(r.source, "local");
  assert.deepEqual(r.results, [{ id: "area:HSR Layout", label: "HSR Layout", secondary: "Bengaluru" }]);
  assert.equal((await p.search("a")).results.length > 1, true);
  assert.deepEqual(await p.details("area:HSR Layout"), { lat: 12.912, lng: 77.647, label: "HSR Layout" });
  await assert.rejects(p.details("area:Atlantis"), /Unknown area/);
  await assert.rejects(p.details("ChIJ-aaaaaaaa1"), /not configured/);
});

test("google search: request shape from Google's docs, results mapped and filtered", async () => {
  const calls = [];
  const p = makePlaces({ apiKey: KEY, areas: AREAS, fetchImpl: async (u, i) => (calls.push({ u, i }), json(autocompleteBody)) });
  const r = await p.search("third wave", TOKEN);
  assert.equal(r.source, "google");
  assert.equal(String(calls[0].u), "https://places.googleapis.com/v1/places:autocomplete");
  assert.equal(calls[0].i.method, "POST");
  assert.equal(calls[0].i.headers["X-Goog-Api-Key"], KEY); // key in a header, not the URL or body
  assert.ok(!String(calls[0].u).includes(KEY) && !calls[0].i.body.includes(KEY));
  const body = JSON.parse(calls[0].i.body);
  assert.equal(body.input, "third wave");
  assert.equal(body.sessionToken, TOKEN);
  assert.deepEqual(body.includedRegionCodes, ["in"]);
  assert.deepEqual(body.locationRestriction, { rectangle: BENGALURU }); // Bengaluru only
  assert.deepEqual(r.results, [
    { id: "ChIJ-aaaaaaaa1", label: "Third Wave Coffee", secondary: "100 Feet Road, Indiranagar, Bengaluru" },
    { id: "ChIJ-bbbbbbbb2", label: "Only Full Text, Koramangala", secondary: "" },
  ]);
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test("google search: a malformed session token is dropped rather than forwarded", async () => {
  const bodies = [];
  const p = makePlaces({ apiKey: KEY, areas: AREAS, fetchImpl: async (u, i) => (bodies.push(JSON.parse(i.body)), json({ suggestions: [] })) });
  await p.search("x y", "bad token!!");
  await p.search("x y", undefined);
  assert.ok(bodies.every((b) => !("sessionToken" in b)));
});

test("google search fails soft: outage, error status or junk falls back to areas and says degraded", async () => {
  for (const f of [async () => { throw new Error("ECONNRESET"); }, async () => json({}, 403), async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })]) {
    const p = makePlaces({ apiKey: KEY, areas: AREAS, fetchImpl: f });
    const r = await p.search("hsr", TOKEN);
    assert.equal(r.source, "local");
    assert.equal(r.degraded, true);
    assert.equal(r.results[0].label, "HSR Layout");
  }
});

test("google details: field mask, sessionToken query param, coordinates rounded (the two docs gaps are pinned here)", async () => {
  const calls = [];
  const p = makePlaces({ apiKey: KEY, areas: AREAS, fetchImpl: async (u, i) => (calls.push({ u: new URL(u), i }), json({ location: { latitude: 12.97841, longitude: 77.64083 }, displayName: { text: "Third Wave Coffee", languageCode: "en" }, formattedAddress: "100 Feet Rd, Indiranagar" })) });
  const d = await p.details("ChIJ-aaaaaaaa1", TOKEN);
  assert.deepEqual(d, { lat: 12.978, lng: 77.641, label: "Third Wave Coffee" });
  assert.equal(calls[0].u.origin + calls[0].u.pathname, "https://places.googleapis.com/v1/places/ChIJ-aaaaaaaa1");
  assert.equal(calls[0].u.searchParams.get("sessionToken"), TOKEN); // ASSUMED: query parameter
  assert.equal(calls[0].i.headers["X-Goog-FieldMask"], "location,displayName,formattedAddress");
  assert.equal(calls[0].i.headers["X-Goog-Api-Key"], KEY);
  assert.ok(!calls[0].u.href.includes(KEY));
  assert.ok(!JSON.stringify(d).includes("100 Feet Rd"), "full address must not be passed on");
});

test("google details: bad ids never reach the URL, and missing or failed lookups throw", async () => {
  let called = 0;
  const f = (res) => async () => (called++, res);
  await assert.rejects(makePlaces({ apiKey: KEY, areas: AREAS, fetchImpl: f(json({})) }).details("../../admin?x=1"), /Bad place id/);
  assert.equal(called, 0);
  await assert.rejects(makePlaces({ apiKey: KEY, areas: AREAS, fetchImpl: f(json({ displayName: { text: "x" } })) }).details("ChIJ-aaaaaaaa1"), /no location/);
  await assert.rejects(makePlaces({ apiKey: KEY, areas: AREAS, fetchImpl: f(json({}, 500)) }).details("ChIJ-aaaaaaaa1"), /error \(500\)/);
});

// ---------- API ----------

async function setup(opts = {}) {
  const db = openDb(":memory:");
  const clock = { t: Date.parse("2026-11-28T10:00:00+05:30") };
  const codes = {};
  const app = createApp({ db, now: () => clock.t, sendOtp: async (p, c) => (codes[p] = c), sendReminder: null, adminKey: "adm", ...opts });
  const server = app.server();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  const signIn = async () => {
    await call("POST", "/api/auth/request-otp", { phone: "9876543210" });
    const v = await call("POST", "/api/auth/verify", { phone: "9876543210", code: codes["+919876543210"], firstName: "Jenessa" });
    return { Authorization: "Bearer " + v.body.token };
  };
  return { db, clock, call, signIn, close: () => server.close() };
}
const googleMock = (extra = {}) => async (u) => {
  const url = String(u);
  if (url.includes("places:autocomplete")) return json(autocompleteBody);
  if (url.includes("/v1/places/")) return json(extra.details || { location: { latitude: 12.97841, longitude: 77.64083 }, displayName: { text: "Third Wave Coffee" }, formattedAddress: "Flat 4B, Secret Apartments, 100 Feet Rd" });
  return json({}, 404);
};

const mkPlan = async (s, org, extra = {}) => (await s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya"], organiserArea: "Koramangala", ...extra }, org)).body.id;

test("API gate: needs a plan that is collecting answers, or a signed-in organiser", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("GET", "/api/places/search?q=hsr")).status, 403);
    assert.equal((await s.call("GET", "/api/places/search?q=hsr&plan=nope")).status, 403);
    const org = await s.signIn();
    const id = await mkPlan(s, org);
    const open = await s.call("GET", `/api/places/search?q=hsr&plan=${id}`);
    assert.equal(open.status, 200);
    assert.deepEqual(open.body.results.map((r) => r.label), ["HSR Layout"]);
    assert.equal((await s.call("GET", "/api/places/search?q=hsr", null, org)).status, 200); // organiser, no plan yet
    assert.equal((await s.call("GET", `/api/places/details?id=${encodeURIComponent("area:HSR Layout")}&plan=${id}`)).status, 200);
    // Once picks exist the plan stops collecting answers, so friends lose access.
    await s.call("POST", `/api/plans/${id}/responses`, { name: "Riya", area: "Koramangala", consent: true });
    assert.equal((await s.call("GET", `/api/places/search?q=hsr&plan=${id}`)).status, 403);
  } finally { s.close(); }
});

test("API: short queries return nothing without a lookup, long ones are rejected", async () => {
  let looked = 0;
  const s = await setup({ mapsKey: KEY, fetchImpl: async (...a) => (looked++, googleMock()(...a)) });
  try {
    const org = await s.signIn();
    assert.deepEqual((await s.call("GET", "/api/places/search?q=h", null, org)).body.results, []);
    assert.equal(looked, 0);
    assert.equal((await s.call("GET", `/api/places/search?q=${"x".repeat(81)}`, null, org)).status, 400);
  } finally { s.close(); }
});

test("API rate limit: 60 per minute per client, then 429, then it recovers", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    let last;
    for (let i = 0; i < 60; i++) last = await s.call("GET", "/api/places/search?q=hsr", null, org);
    assert.equal(last.status, 200);
    assert.equal((await s.call("GET", "/api/places/search?q=hsr", null, org)).status, 429);
    s.clock.t += 61000;
    assert.equal((await s.call("GET", "/api/places/search?q=hsr", null, org)).status, 200);
  } finally { s.close(); }
});

test("API with Google: results come through, the key never appears, and an outage degrades to areas", async () => {
  let down = false;
  const s = await setup({ mapsKey: KEY, fetchImpl: async (...a) => (down ? json({}, 503) : googleMock()(...a)) });
  try {
    const org = await s.signIn();
    const ok = await s.call("GET", `/api/places/search?q=third&token=${TOKEN}`, null, org);
    assert.equal(ok.body.source, "google");
    assert.equal(ok.body.results[0].label, "Third Wave Coffee");
    assert.ok(!ok.text.includes(KEY));
    const det = await s.call("GET", `/api/places/details?id=ChIJ-aaaaaaaa1&token=${TOKEN}`, null, org);
    assert.deepEqual(det.body, { lat: 12.978, lng: 77.641, label: "Third Wave Coffee" });
    assert.ok(!det.text.includes(KEY) && !det.text.includes("Secret Apartments"));
    down = true;
    const fell = await s.call("GET", "/api/places/search?q=hsr", null, org);
    assert.equal(fell.body.source, "local");
    assert.equal(fell.body.degraded, true);
    const bad = await s.call("GET", "/api/places/details?id=ChIJ-aaaaaaaa1", null, org);
    assert.equal(bad.status, 502);
    assert.ok(!bad.text.includes("503") && !bad.text.includes("places.googleapis"), "no upstream detail leaked");
  } finally { s.close(); }
});

test("API: a place outside Bengaluru is refused", async () => {
  const s = await setup({ mapsKey: KEY, fetchImpl: googleMock({ details: { location: { latitude: 28.6139, longitude: 77.209 }, displayName: { text: "India Gate" } } }) });
  try {
    const org = await s.signIn();
    const r = await s.call("GET", "/api/places/details?id=ChIJ-delhi00001", null, org);
    assert.equal(r.status, 422);
    assert.match(r.body.error, /outside Bengaluru/);
  } finally { s.close(); }
});

test("a friend's pinned or searched start is stored rounded, without any address text", async () => {
  const s = await setup({ mapsKey: KEY, fetchImpl: googleMock() });
  try {
    const org = await s.signIn();
    const id = await mkPlan(s, org);
    const det = (await s.call("GET", `/api/places/details?id=ChIJ-aaaaaaaa1&plan=${id}`)).body; // label "Third Wave Coffee"
    const r = await s.call("POST", `/api/plans/${id}/responses`, { name: "Riya", start: { lat: 12.97841, lng: 77.64083, label: "Flat 4B, Secret Apartments" }, budget: 1000, consent: true });
    assert.equal(r.status, 200);
    const row = s.db.prepare("SELECT start_lat, start_lng, start_label FROM responses").get();
    assert.equal(row.start_lat, 12.978);
    assert.equal(row.start_lng, 77.641);
    assert.equal(row.start_label, null);
    assert.ok(!JSON.stringify(s.db.prepare("SELECT * FROM responses").all()).includes("Secret Apartments"));
    assert.equal(det.lat, row.start_lat);
  } finally { s.close(); }
});

test("start points are validated: outside Bengaluru, wrong types and missing coordinates are rejected", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const id = await mkPlan(s, org);
    const post = (start) => s.call("POST", `/api/plans/${id}/responses`, { name: "Riya", start, consent: true });
    assert.equal((await post({ lat: 28.6, lng: 77.2 })).status, 400);
    assert.equal((await post({ lat: "12.9", lng: "77.6" })).status, 400);
    assert.equal((await post({ lat: 12.9 })).status, 400);
    assert.equal((await post(undefined)).status, 400);
    assert.equal((await post({ lat: 12.95, lng: 77.62 })).status, 200);
  } finally { s.close(); }
});

test("organiser start search: stored rounded; a start outside Bengaluru is rejected", async () => {
  const s = await setup();
  try {
    const org = await s.signIn();
    const mk = (os) => s.call("POST", "/api/plans", { date: "2026-11-28", time: "20:00", friends: ["Riya"], organiserStart: os }, org);
    assert.equal((await mk({ lat: 28.6, lng: 77.2 })).status, 400);
    const ok = await mk({ lat: 12.93527, lng: 77.62451 });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(s.db.prepare("SELECT organiser_start s FROM plans").get().s), { lat: 12.935, lng: 77.625 });
  } finally { s.close(); }
});
