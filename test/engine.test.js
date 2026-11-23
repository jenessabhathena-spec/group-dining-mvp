import test from "node:test";
import assert from "node:assert/strict";
import { generatePicks, isOpen } from "../src/engine.js";
import { createSession, vote, veto, decide, isComplete, override } from "../src/voting.js";
import { AREAS, RESTAURANTS } from "../src/data.js";

const mem = (name, area, o = {}) => ({
  name,
  start: AREAS[area],
  budget: 1500,
  dealbreakers: [],
  mood: null,
  cuisines: [],
  visited: [],
  ...o,
});
const plan = { time: "20:00" };
const group = () => [
  mem("Riya", "Koramangala", { cuisines: ["pan-asian"], mood: "lively" }),
  mem("Arjun", "HSR Layout", { cuisines: ["north-indian"], mood: "chill" }),
  mem("Meera", "Indiranagar", { cuisines: ["pan-asian", "italian"] }),
];
const run = (extra = {}) =>
  generatePicks({ plan, members: group(), restaurants: RESTAURANTS, travelFn: undefined, ...extra });

test("isOpen handles closing after midnight", () => {
  const r8 = RESTAURANTS.find((r) => r.id === "r08"); // 17:00-01:00
  assert.equal(isOpen(r8, "23:30"), true);
  assert.equal(isOpen(r8, "00:30"), true);
  assert.equal(isOpen(r8, "03:00"), false);
});

test("weekday hours: closed days, split shifts, late windows spill into the next day", () => {
  const weekly = { hours: { weekly: { mon: [], tue: [["12:00", "15:00"], ["19:00", "23:00"]], fri: [["17:00", "01:00"]], sat: [["12:00", "23:00"]] } } };
  // 2026-11-23 is a Monday; 2026-11-24 Tuesday; 2026-11-27 Friday; 2026-11-28 Saturday.
  assert.equal(isOpen(weekly, "20:00", "2026-11-23"), false, "closed on Mondays");
  assert.equal(isOpen(weekly, "13:00", "2026-11-24"), true);
  assert.equal(isOpen(weekly, "16:30", "2026-11-24"), false, "between the lunch and dinner shifts");
  assert.equal(isOpen(weekly, "20:00", "2026-11-24"), true);
  assert.equal(isOpen(weekly, "23:30", "2026-11-27"), true, "Friday late");
  assert.equal(isOpen(weekly, "00:30", "2026-11-28"), true, "Friday's window spills past midnight into Saturday");
  assert.equal(isOpen(weekly, "01:30", "2026-11-28"), false);
  assert.equal(isOpen(weekly, "00:30", "2026-11-25"), false, "Tuesday's window does not spill");
  // No date: weekday unknown, lenient.
  assert.equal(isOpen(weekly, "20:00"), true);
  // The engine uses the plan date.
  const r = { ...RESTAURANTS[4], id: "mon-closed", ...weekly };
  const members = [mem("A", "HSR Layout"), mem("B", "HSR Layout")];
  assert.equal(generatePicks({ plan: { time: "20:00", date: "2026-11-23" }, members, restaurants: [r] }).picks.length, 0);
  assert.equal(generatePicks({ plan: { time: "20:00", date: "2026-11-24" }, members, restaurants: [r] }).picks.length, 1);
});

test("returns 3 picks with a reason, per-person travel time and a Partner flag", () => {
  const res = run();
  assert.equal(res.picks.length, 3);
  for (const p of res.picks) {
    assert.equal(p.travel.length, 3);
    assert.ok(p.reason.length > 10);
    assert.equal(typeof p.partner, "boolean");
  }
});

test("same inputs always give the same picks and winner", () => {
  const a = run();
  const b = run();
  assert.deepEqual(a.picks.map((p) => p.id), b.picks.map((p) => p.id));
  const sa = vote(vote(createSession(a, ["Riya", "Arjun"]), "Riya", a.picks[0].id), "Arjun", a.picks[1].id);
  const sb = vote(vote(createSession(b, ["Riya", "Arjun"]), "Riya", b.picks[0].id), "Arjun", b.picks[1].id);
  assert.equal(decide(sa).winner.id, decide(sb).winner.id);
});

test("hard filters: closed, dealbreaker, seating", () => {
  const rs = [
    { ...RESTAURANTS[0], id: "closed", hours: { open: "07:00", close: "11:00" } },
    { ...RESTAURANTS[1], id: "tiny", maxGroup: 2 },
    { ...RESTAURANTS[2], id: "loud-one" }, // r03 is loud
    { ...RESTAURANTS[4], id: "ok" },
  ];
  const members = [mem("A", "Koramangala", { dealbreakers: ["no-loud"] }), mem("B", "HSR Layout"), mem("C", "Koramangala")];
  const res = generatePicks({ plan, members, restaurants: rs });
  assert.deepEqual(res.picks.map((p) => p.id), ["ok"]);
  const reasons = Object.fromEntries(res.log.filtered.map((f) => [f.id, f.rules]));
  assert.deepEqual(reasons.closed, ["closed"]);
  assert.deepEqual(reasons.tiny, ["seating"]);
  assert.deepEqual(reasons["loud-one"], ["dealbreaker"]);
});

test("a vegetarian dealbreaker removes places without veg options", () => {
  const rs = [{ ...RESTAURANTS[0], id: "nonveg", dietOptions: ["non-veg"] }, { ...RESTAURANTS[4], id: "veg" }];
  const members = [mem("A", "Koramangala", { dealbreakers: ["needs-veg"] }), mem("B", "HSR Layout")];
  assert.deepEqual(generatePicks({ plan, members, restaurants: rs }).picks.map((p) => p.id), ["veg"]);
});

test("budget ceiling is the lowest budget and is never revealed", () => {
  const members = [
    mem("Riya", "Koramangala", { budget: 733 }),
    mem("Arjun", "HSR Layout", { budget: 2777 }),
    mem("Meera", "Indiranagar", { budget: 1999 }),
  ];
  const res = generatePicks({ plan, members, restaurants: RESTAURANTS });
  assert.ok(res.picks.length > 0);
  for (const p of res.picks) assert.ok(p.pricePerHead <= 733);
  const out = JSON.stringify({ picks: res.picks, reserve: res.reserve, nearMisses: res.nearMisses, notes: res.notes });
  for (const secret of ["733", "2777", "1999"]) assert.ok(!out.includes(secret), `leaked ${secret}`);
});

test("travel fairness: nobody exceeds the limit when places exist", () => {
  const res = run();
  for (const p of res.picks) for (const t of p.travel) assert.ok(t.minutes <= 40, `${t.name} ${t.minutes}`);
});

test("organiser can change the travel limit", () => {
  const tight = run({ plan: { time: "20:00", travelLimitMin: 15 } });
  for (const p of [...tight.picks, ...tight.reserve]) for (const t of p.travel) assert.ok(t.minutes <= 15 || tight.relaxation);
});

test("partner flag never affects filtering or scoring", () => {
  const flip = RESTAURANTS.map((r) => ({ ...r, partner: !r.partner }));
  const a = run();
  const b = generatePicks({ plan, members: group(), restaurants: flip });
  assert.deepEqual(a.picks.map((p) => [p.id, p.total, p.factors]), b.picks.map((p) => [p.id, p.total, p.factors]));
  assert.deepEqual(a.log.ranked, b.log.ranked);
  const badge = (res) => Object.fromEntries(res.picks.map((p) => [p.id, p.partner]));
  const ba = badge(a), bb = badge(b);
  for (const id of Object.keys(ba)) assert.equal(ba[id], !bb[id]); // only the badge changes
});

test("couples filters: noise ceiling and ambience are hard filters", () => {
  const rs = [
    { ...RESTAURANTS[5], id: "quiet-chill", noise: "quiet", vibes: ["chill"] },
    { ...RESTAURANTS[5], id: "mid-chill", noise: "medium", vibes: ["chill"] },
    { ...RESTAURANTS[5], id: "loud-lively", noise: "loud", vibes: ["lively"] },
    { ...RESTAURANTS[5], id: "quiet-fancy", noise: "quiet", vibes: ["fancy"] },
  ];
  const two = [mem("A", "HSR Layout"), mem("B", "HSR Layout")];
  const ids = (filters) => generatePicks({ plan: { time: "20:00", filters }, members: two, restaurants: rs }).picks.map((p) => p.id).sort();
  assert.equal(ids(undefined).length, 3); // no filters: 3 picks, loud places allowed
  assert.ok(ids(undefined).includes("loud-lively"));
  assert.deepEqual(ids({ maxNoise: "quiet" }), ["quiet-chill", "quiet-fancy"]);
  assert.deepEqual(ids({ maxNoise: "medium" }).includes("loud-lively"), false);
  assert.deepEqual(ids({ ambience: ["fancy"] }), ["quiet-fancy"]);
  assert.deepEqual(ids({ maxNoise: "quiet", ambience: ["chill", "lively"] }), ["quiet-chill"]);
  const none = generatePicks({ plan: { time: "20:00", filters: { maxNoise: "quiet", ambience: ["lively"] } }, members: two, restaurants: rs });
  assert.equal(none.picks.length, 0);
  assert.deepEqual(none.log.filtered.find((f) => f.id === "loud-lively").rules, ["noise"]);
});

test("budget wording only claims 'all N' when every member gave a budget", () => {
  const rs = [RESTAURANTS[5]];
  const both = generatePicks({ plan, members: [mem("A", "HSR Layout"), mem("B", "HSR Layout")], restaurants: rs }).picks[0].reason;
  const one = generatePicks({ plan, members: [mem("A", "HSR Layout"), mem("B", "HSR Layout", { budget: null })], restaurants: rs }).picks[0].reason;
  assert.match(both, /^Fits all 2 budgets/);
  assert.match(one, /^Within the budget given/);
});

test("a member can have several vibes; any match counts and the reason names the matched vibe", () => {
  const r = { ...RESTAURANTS[5], id: "calm", vibes: ["quiet", "chill"] };
  const members = [mem("A", "HSR Layout", { mood: ["lively", "quiet"] }), mem("B", "HSR Layout", { mood: "quiet" })];
  const res = generatePicks({ plan, members, restaurants: [r] });
  assert.equal(res.picks[0].factors.mood, 1);
  assert.match(res.picks[0].reason, /2 of 2 in the mood for quiet/);
  const none = generatePicks({ plan, members: [mem("A", "HSR Layout", { mood: ["fancy", "lively"] })], restaurants: [r] });
  assert.equal(none.picks[0].factors.mood, 0);
});

test("picks differ in cuisine or vibe, never three of a kind", () => {
  const clones = ["a", "b", "c", "d"].map((id, i) => ({ ...RESTAURANTS[4], id, name: id, rating: 4.5 - i * 0.1 }));
  const odd = { ...RESTAURANTS[5], id: "odd", rating: 3.0 }; // HSR, different cuisine and vibe
  const members = [mem("A", "HSR Layout"), mem("B", "HSR Layout"), mem("C", "Koramangala")];
  const res = generatePicks({ plan, members, restaurants: [...clones, odd] });
  assert.ok(res.picks.some((p) => p.id === "odd"), "diverse option must be included");
  assert.equal(res.picks.length, 3);
});

test("nothing passes: travel limit relaxes first, trade-off shown openly", () => {
  const far = { ...RESTAURANTS[4], id: "far" };
  // Jayanagar -> HSR is ~45 min by the fallback model: over 40, within 50.
  const members = [mem("Arjun", "Jayanagar"), mem("Riya", "HSR Layout")];
  const res = generatePicks({ plan, members, restaurants: [far] });
  assert.equal(res.picks.length, 1);
  assert.ok(res.relaxation.travel);
  assert.match(res.picks[0].tradeoffs[0], /min past the 40-min limit for Arjun but fits every budget/);
});

test("budget relaxes only after travel, by at most 15% (groups of 4+)", () => {
  const r = { ...RESTAURANTS[4], id: "pricey", pricePerHead: 1100 };
  const members = [mem("A", "HSR Layout", { budget: 1000 }), mem("B", "HSR Layout", { budget: 1200 }), mem("C", "HSR Layout", { budget: 1300 }), mem("D", "HSR Layout", { budget: 1400 })];
  const res = generatePicks({ plan, members, restaurants: [r] });
  assert.equal(res.picks.length, 1);
  assert.ok(res.relaxation.budget);
  assert.match(res.picks[0].tradeoffs.join(" "), /above the shared budget/i);
  const too = generatePicks({ plan, members, restaurants: [{ ...r, pricePerHead: 1200 }] });
  assert.equal(too.picks.length, 0); // 20% over: not relaxed that far
});

test("fewer than 3 pass: nearest misses are labelled with the rule they broke (groups of 4+)", () => {
  const members = ["A", "B", "C", "D"].map((n) => mem(n, "HSR Layout", { budget: 500 }));
  const res = generatePicks({ plan, members, restaurants: RESTAURANTS });
  assert.ok(res.picks.length < 3);
  assert.ok(res.nearMisses.length > 0);
  for (const m of res.nearMisses) {
    assert.ok(m.nearMiss);
    assert.ok(m.broken.every((b) => ["travel", "budget"].includes(b.rule)));
  }
});

test("small groups (2-3) keep budgets secret: no budget stretching, and budget misses are labelled generically", () => {
  const r = { ...RESTAURANTS[4], id: "pricey", pricePerHead: 1100 };
  const two = [mem("A", "HSR Layout", { budget: 1000 }), mem("B", "HSR Layout", { budget: 3000 })];
  const res = generatePicks({ plan, members: two, restaurants: [r] });
  assert.equal(res.picks.length, 0, "not stretched: B would learn A's budget is under 1100");
  assert.equal(res.budget.relaxed, false);
  assert.deepEqual(res.nearMisses[0].broken, [{ rule: "fit", detail: "Doesn't suit everyone" }]);
  assert.ok(!JSON.stringify(res.nearMisses).includes("budget"));
  // An unanswered friend counts towards group size: 2 answered + 2 missing = 4, normal rules.
  const four = generatePicks({ plan, members: two, unanswered: [{ name: "C" }, { name: "D" }], restaurants: [r] });
  assert.equal(four.picks.length, 1);
  // Solo: your own budget, so stretching it and saying so is fine.
  const solo = generatePicks({ plan, members: [mem("A", "HSR Layout", { budget: 1000 })], restaurants: [r] });
  assert.equal(solo.picks.length, 1);
  assert.equal(solo.budget.relaxed, true);
});

test("budget scope for the shared range line: all, given, or none", () => {
  const rs = [RESTAURANTS[5]];
  const scope = (members, unanswered) => generatePicks({ plan, members, unanswered, restaurants: rs }).budget.scope;
  assert.equal(scope([mem("A", "HSR Layout"), mem("B", "HSR Layout")]), "all");
  assert.equal(scope([mem("A", "HSR Layout"), mem("B", "HSR Layout", { budget: null })]), "given");
  assert.equal(scope([mem("A", "HSR Layout")], [{ name: "Z" }]), "given", "someone never answered, so not 'all'");
  assert.equal(scope([mem("A", "HSR Layout", { budget: null })]), "none");
});

test("unanswered member: saved profile is used, otherwise planned without and said so", () => {
  const withProfile = run({
    unanswered: [{ name: "Kabir", profile: { start: AREAS.Domlur, cuisines: ["italian"] } }],
  });
  assert.ok(withProfile.picks[0].travel.some((t) => t.name === "Kabir"));
  assert.ok(withProfile.notes.some((n) => /Kabir's saved profile/.test(n)));
  const without = run({ unanswered: [{ name: "Kabir" }] });
  assert.ok(without.picks[0].notes.includes("Planned without Kabir"));
  assert.ok(!without.picks[0].travel.some((t) => t.name === "Kabir"));
});

test("travel service failure falls back to straight-line and flags it", () => {
  const res = generatePicks({
    plan,
    members: group(),
    restaurants: RESTAURANTS,
    travelFn: () => {
      throw new Error("maps down");
    },
  });
  assert.equal(res.travelFallback, true);
  assert.ok(res.picks.length > 0);
  assert.ok(res.picks.every((p) => p.travelEstimate));
});

test("veto swaps in the next-best pick once, voids votes for it, one veto each", () => {
  const res = run();
  const names = ["Riya", "Arjun", "Meera"];
  let s = createSession(res, names);
  const [p1, p2] = s.shown;
  const next = s.reserve[0];
  s = vote(s, "Riya", p1.id);
  s = veto(s, "Arjun", p1.id);
  assert.ok(!s.shown.some((p) => p.id === p1.id));
  assert.equal(s.shown[0].id, next.id);
  assert.equal(s.shown.length, 3);
  assert.ok(!("Riya" in s.votes)); // Riya's vote was for the vetoed pick
  assert.throws(() => veto(s, "Arjun", p2.id), /already used/); // one veto each
  assert.throws(() => veto(s, "Meera", p1.id), /already replaced/); // replaced once only
});

test("tie goes to the higher fairness score", () => {
  const res = run();
  let s = createSession(res, ["Riya", "Arjun"]);
  const [a, b] = s.shown;
  s = vote(s, "Riya", a.id);
  s = vote(s, "Arjun", b.id);
  const expected = [a, b].sort((x, y) => y.factors.fairness - x.factors.fairness || y.total - x.total || (x.id < y.id ? -1 : 1))[0];
  assert.equal(decide(s).winner.id, expected.id);
});

test("voting closes when all voted or at the deadline", () => {
  const res = run();
  let s = createSession(res, ["Riya", "Arjun"]);
  assert.equal(isComplete(s), false);
  assert.equal(isComplete(s, { deadlinePassed: true }), true);
  s = vote(s, "Riya", s.shown[0].id);
  s = vote(s, "Arjun", s.shown[0].id);
  assert.equal(isComplete(s), true);
});

test("organiser override is allowed and logged", () => {
  const res = run();
  const s = createSession(res, ["Riya"]);
  const { session, winner, overridden } = override(s, "Riya", s.shown[2].id);
  assert.equal(overridden, true);
  assert.equal(winner.id, s.shown[2].id);
  assert.equal(session.events.at(-1).type, "organiser_override");
});
