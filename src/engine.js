// Fair-pick engine (PRD section 6): transparent rules, no ML.
// Pure functions. Travel-time lookup is injected so Google Maps can replace the fallback later.

export const DEFAULT_WEIGHTS = { taste: 1, fairness: 1, mood: 1, novelty: 1, quality: 1 };
export const DEFAULTS = {
  travelLimitMin: 40,
  travelRelaxStepMin: 10,
  travelRelaxMaxSteps: 3,
  budgetRelaxSteps: [1.05, 1.1, 1.15], // up to 15% over the lowest budget
  pickCount: 3,
  smallGroupMax: 3, // groups of 2-3: no budget relaxation, generic budget labels (budget secrecy)
};

// ---------- travel ----------

export function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Straight-line fallback (PRD section 8, Reliability). Road factor + rough Bengaluru speeds.
export function fallbackTravelMinutes(from, to, hour) {
  const peak = (hour >= 8 && hour < 11) || (hour >= 17 && hour < 22);
  const kmh = peak ? 14 : 24;
  return Math.round(((haversineKm(from, to) * 1.4) / kmh) * 60) + 5;
}

// ---------- helpers ----------

const toMin = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round2 = (x) => Math.round(x * 100) / 100;

// ---------- opening hours ----------
// hours is either { open, close } (same every day) or { weekly: { mon: [["12:00","15:00"],["19:00","23:00"]], ... } }.
// A window that closes after midnight ("17:00"-"01:00") belongs to the day it opens on.
export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export function dayOf(date) {
  const [y, m, d] = date.split("-").map(Number);
  return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
const windowsOn = (r, day) => (r.hours.weekly ? r.hours.weekly[day] || [] : [[r.hours.open, r.hours.close]]);

// With a date, the day of the week counts (closed on Mondays means closed on Mondays). Without one the
// weekday is unknown, so a place counts as open if it is open at that time on any day.
export function isOpen(restaurant, time, date) {
  const x = toMin(time);
  const days = date ? [dayOf(date)] : DAYS;
  return days.some((day) => {
    const prev = DAYS[(DAYS.indexOf(day) + 6) % 7];
    const today = windowsOn(restaurant, day).some(([o, c]) => {
      const O = toMin(o), C = toMin(c);
      return C > O ? x >= O && x < C : x >= O; // wrapping window: open from O until midnight today
    });
    const spill = windowsOn(restaurant, prev).some(([o, c]) => {
      const O = toMin(o), C = toMin(c);
      return C <= O && x < C; // yesterday's late window still open after midnight
    });
    return today || spill;
  });
}

export const NOISE_RANK = { quiet: 0, medium: 1, loud: 2 };

const DEALBREAKERS = {
  "needs-veg": (r) => !r.dietOptions.includes("veg"),
  "needs-vegan": (r) => !r.dietOptions.includes("vegan"),
  "needs-jain": (r) => !r.dietOptions.includes("jain"),
  "no-alcohol": (r) => r.alcohol === "bar",
  "no-loud": (r) => r.noise === "loud",
};

function profileToMember(m) {
  const p = m.profile;
  return {
    name: m.name,
    start: p.start,
    budget: null,
    dealbreakers: p.dealbreakers || [],
    mood: null,
    cuisines: p.cuisines || [],
    visited: p.visited || [],
    fromProfile: true,
  };
}

// ---------- stage 1 + 2: filters ----------

function evaluate(r, members, groupSize, plan, ceiling, travelFn) {
  const hard = [];
  if (!isOpen(r, plan.time, plan.date)) hard.push({ rule: "closed", detail: "Closed at the plan time" });
  for (const m of members) {
    for (const d of m.dealbreakers || []) {
      if (DEALBREAKERS[d] && DEALBREAKERS[d](r)) {
        hard.push({ rule: "dealbreaker", detail: "Breaks a dealbreaker" });
        break;
      }
    }
    if (hard.some((h) => h.rule === "dealbreaker")) break;
  }
  if (groupSize > r.maxGroup) hard.push({ rule: "seating", detail: "Cannot seat the group" });
  // Couples mode filters (F12): noise ceiling and ambience, both optional.
  const f = plan.filters || {};
  if (f.maxNoise && NOISE_RANK[r.noise] > NOISE_RANK[f.maxNoise]) hard.push({ rule: "noise", detail: "Louder than wanted" });
  if (f.ambience && f.ambience.length && !r.vibes.some((v) => f.ambience.includes(v))) hard.push({ rule: "ambience", detail: "Not the ambience wanted" });
  if (hard.length) return { r, hard, times: null };

  // One travel lookup per member per candidate, only after the hard filters (cost control).
  const hour = Number(plan.time.split(":")[0]);
  const times = members.map((m) => ({ name: m.name, minutes: travelFn(m.start, r, hour) }));
  const worst = times.reduce((a, b) => (b.minutes > a.minutes ? b : a));
  return {
    r,
    hard,
    times,
    worst,
    budgetRatio: r.pricePerHead / ceiling, // Infinity ceiling -> 0
  };
}

// ---------- stage 3: scoring ----------

function scoreRestaurant(r, members, times, limit, weights) {
  const n = members.length;
  const tasteHits = [];
  let taste = 0;
  for (const m of members) {
    if (!m.cuisines || m.cuisines.length === 0) taste += 0.5;
    else if (r.cuisines.some((c) => m.cuisines.includes(c))) {
      taste += 1;
      tasteHits.push(m);
    }
  }
  taste /= n;

  const minutes = times.map((t) => t.minutes);
  const spread = Math.max(...minutes) - Math.min(...minutes);
  const fairness = clamp01(1 - spread / limit);

  // A member's mood may be one vibe or several (taste profile); any match counts.
  let mood = 0;
  const moodHits = [];
  const vibeCount = {};
  for (const m of members) {
    const moods = [].concat(m.mood || []);
    if (!moods.length) mood += 0.5;
    else {
      const hit = moods.find((v) => r.vibes.includes(v));
      if (hit) {
        mood += 1;
        moodHits.push(m);
        vibeCount[hit] = (vibeCount[hit] || 0) + 1;
      }
    }
  }
  mood /= n;
  const moodVibe = Object.entries(vibeCount).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];

  const newFor = members.filter((m) => !(m.visited || []).includes(r.id));
  const novelty = newFor.length / n;
  const quality = clamp01((r.rating - 1) / 4);

  const factors = { taste, fairness, mood, novelty, quality };
  const wsum = Object.values(weights).reduce((a, b) => a + b, 0);
  const total = Object.keys(factors).reduce((s, k) => s + factors[k] * weights[k], 0) / wsum;
  return {
    factors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, round2(v)])),
    total: round2(total),
    _hits: { taste: tasteHits.length, mood: moodHits.length, novelty: newFor.length, moodVibe },
  };
}

const byRank = (a, b) =>
  b.total - a.total || b.factors.fairness - a.factors.fairness || (a.r.id < b.r.id ? -1 : 1);

// ---------- stage 4: diversity ----------

function selectDiverse(ranked, count) {
  const chosen = [];
  const same = (a, b) => a.r.cuisines[0] === b.r.cuisines[0] && a.r.vibes[0] === b.r.vibes[0];
  for (const c of ranked) {
    if (chosen.length === count) break;
    if (!chosen.some((s) => same(s, c))) chosen.push(c);
  }
  for (const c of ranked) {
    if (chosen.length === count) break;
    if (!chosen.includes(c)) chosen.push(c);
  }
  return chosen.sort(byRank);
}

// ---------- stage 5: explain ----------

function explain(c, members, budgetRelaxed) {
  const parts = [];
  const n = members.length;
  const solo = n === 1; // "find something new" speaks to one person
  const withBudget = members.filter((m) => m.budget != null).length;
  if (withBudget > 0) {
    // Only claim "all N" when everyone gave a budget; otherwise say what is true.
    const everyone = withBudget === n;
    parts.push(budgetRelaxed ? "Slightly above the shared budget" : solo ? "Within your budget" : everyone ? `Fits all ${withBudget} budgets` : withBudget === 1 ? "Within the budget given" : `Within the ${withBudget} budgets given`);
  }
  parts.push(solo ? `${c.worst.minutes} min away` : `longest trip ${c.worst.minutes} min (${c.worst.name})`);

  const opts = [];
  if (c._hits.taste > 0) {
    const cuisine = c.r.cuisines.find((cu) => members.some((m) => (m.cuisines || []).includes(cu)));
    opts.push({ v: c.factors.taste, t: solo ? `your kind of food: ${cuisine}` : `${c._hits.taste} of ${n} wanted ${cuisine}`, o: 0 });
  }
  if (c._hits.novelty > 0) opts.push({ v: c.factors.novelty, t: solo ? "new to you" : `new for ${c._hits.novelty}`, o: 1 });
  if (c._hits.mood > 0)
    opts.push({ v: c.factors.mood, t: solo ? `fits your ${c._hits.moodVibe} mood` : `${c._hits.mood} of ${n} in the mood for ${c._hits.moodVibe}`, o: 2 });
  opts.sort((a, b) => b.v - a.v || a.o - b.o);
  for (const o of opts.slice(0, 2)) parts.push(o.t);
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

// ---------- main ----------

/**
 * @param input {
 *   plan: { time:'20:00', travelLimitMin? },
 *   members: [{ name, start:{lat,lng}, budget, dealbreakers, mood, cuisines, visited }],
 *   unanswered?: [{ name, profile? }],
 *   restaurants: [...],
 *   weights?, travelFn?
 * }
 */
export function generatePicks(input) {
  const { plan, restaurants } = input;
  const weights = { ...DEFAULT_WEIGHTS, ...(input.weights || {}) };
  const baseLimit = plan.travelLimitMin ?? DEFAULTS.travelLimitMin;
  const notes = [];

  const answered = input.members;
  const fromProfile = [];
  for (const u of input.unanswered || []) {
    if (u.profile) {
      fromProfile.push(profileToMember(u));
      notes.push(`Used ${u.name}'s saved profile (no answer yet)`);
    } else {
      notes.push(`Planned without ${u.name}`);
    }
  }
  const members = [...answered, ...fromProfile];
  const groupSize = members.length + (input.unanswered || []).filter((u) => !u.profile).length;

  const budgets = members.map((m) => m.budget).filter((b) => b != null);
  const baseCeiling = budgets.length ? Math.min(...budgets) : Infinity;
  // Budget secrecy in small groups (2-3 people): saying a place is "above the shared budget", or stretching the
  // budget and saying so, tells a member roughly what another member's budget is. So in small groups the budget
  // is never relaxed, and budget near misses get a generic label. (Solo: it's your own budget, no secret.)
  const smallGroup = groupSize >= 2 && groupSize <= DEFAULTS.smallGroupMax;
  // For the "₹800-1,200 a head works for all" line (PRD content rules): did everyone in the plan give a budget?
  const missing = (input.unanswered || []).some((u) => !u.profile);
  const budgetScope = !budgets.length ? "none" : budgets.length === members.length && !missing ? "all" : "given";

  // Travel: injected fn with straight-line fallback if it throws.
  let travelFallback = false;
  const userFn = input.travelFn || fallbackTravelMinutes;
  const travelFn = (a, b, h) => {
    try {
      return userFn(a, b, h);
    } catch {
      travelFallback = true;
      return fallbackTravelMinutes(a, b, h);
    }
  };
  if (!input.travelFn) travelFallback = true;

  const evals = restaurants.map((r) => evaluate(r, members, groupSize, plan, baseCeiling, travelFn));
  // Checked after the lookups: the service may fail part-way through.
  if (travelFallback) notes.push("Travel times are straight-line estimates");
  const candidates = evals.filter((e) => e.hard.length === 0);

  const passing = (mul, limit) =>
    candidates.filter((e) => e.budgetRatio <= mul && e.worst.minutes <= limit);

  // Relaxation order: travel limit first, then budget ceiling up to +15%.
  let limit = baseLimit;
  let budgetMul = 1;
  let passes = passing(budgetMul, limit);
  let relaxation = null;
  if (passes.length === 0) {
    const steps = [];
    for (let i = 1; i <= DEFAULTS.travelRelaxMaxSteps; i++)
      steps.push({ limit: baseLimit + i * DEFAULTS.travelRelaxStepMin, mul: 1 });
    const maxLimit = baseLimit + DEFAULTS.travelRelaxMaxSteps * DEFAULTS.travelRelaxStepMin;
    if (!smallGroup) for (const mul of DEFAULTS.budgetRelaxSteps) steps.push({ limit: maxLimit, mul });
    for (const s of steps) {
      const p = passing(s.mul, s.limit);
      if (p.length) {
        passes = p;
        limit = s.limit;
        budgetMul = s.mul;
        relaxation = {
          travel: limit > baseLimit ? { from: baseLimit, to: limit } : null,
          budget: budgetMul > 1,
        };
        break;
      }
    }
  }

  const scored = passes
    .map((e) => ({ ...e, ...scoreRestaurant(e.r, members, e.times, limit, weights) }))
    .sort(byRank);
  const chosen = selectDiverse(scored, DEFAULTS.pickCount);
  const reserve = scored.filter((c) => !chosen.includes(c)).map((c) => shape(c, members, baseLimit, baseCeiling, budgetMul, notes));
  const picks = chosen.map((c) => shape(c, members, baseLimit, baseCeiling, budgetMul, notes));

  // Near misses when fewer than 3 passed.
  let nearMisses = [];
  if (picks.length < DEFAULTS.pickCount) {
    const passIds = new Set(passes.map((e) => e.r.id));
    nearMisses = candidates
      .filter((e) => !passIds.has(e.r.id))
      .map((e) => {
        const travelOver = Math.max(0, e.worst.minutes - limit);
        const budgetOver = Math.max(0, e.budgetRatio - budgetMul);
        const broken = [];
        if (travelOver > 0) broken.push({ rule: "travel", detail: `Trip over the limit: ${e.worst.minutes} min for ${e.worst.name}` });
        if (budgetOver > 0) broken.push(smallGroup ? { rule: "fit", detail: "Doesn't suit everyone" } : { rule: "budget", detail: "Above the group's shared budget" });
        return { e, broken, gap: travelOver / limit + budgetOver };
      })
      .sort((a, b) => a.broken.length - b.broken.length || a.gap - b.gap || (a.e.r.id < b.e.r.id ? -1 : 1))
      .slice(0, DEFAULTS.pickCount - picks.length + 2)
      .map(({ e, broken }) => ({
        id: e.r.id,
        name: e.r.name,
        area: e.r.area,
        pricePerHead: e.r.pricePerHead,
        partner: !!e.r.partner,
        travel: e.times,
        broken,
        nearMiss: true,
      }));
  }

  const log = {
    // A2 plan log: logged in full for weekly review (budgets stay server-side).
    inputs: {
      plan,
      members: members.map((m) => ({ ...m })),
      unanswered: input.unanswered || [],
      weights,
    },
    filtered: evals.filter((e) => e.hard.length).map((e) => ({ id: e.r.id, rules: e.hard.map((h) => h.rule) })),
    relaxation,
    ranked: scored.map((c) => ({ id: c.r.id, total: c.total, factors: c.factors })),
    picks: picks.map((p) => p.id),
  };

  return { picks, reserve, nearMisses, relaxation, notes, travelFallback, budget: { scope: budgetScope, relaxed: budgetMul > 1 }, log };
}

function shape(c, members, baseLimit, baseCeiling, budgetMul, notes) {
  const tradeoffs = [];
  if (c.worst.minutes > baseLimit) {
    const over = c.worst.minutes - baseLimit;
    tradeoffs.push(
      `${over} min past the ${baseLimit}-min limit for ${c.worst.name}` +
        (c.r.pricePerHead <= baseCeiling ? " but fits every budget" : "")
    );
  }
  if (c.budgetRatio > 1) tradeoffs.push("A little above the shared budget");
  return {
    id: c.r.id,
    name: c.r.name,
    area: c.r.area,
    pricePerHead: c.r.pricePerHead,
    partner: !!c.r.partner, // badge only; never an input to filtering or scoring
    travel: c.times, // per person, by first name
    total: c.total,
    factors: c.factors,
    reason: explain(c, members, budgetMul > 1 && c.budgetRatio > 1),
    tradeoffs,
    notes: notes.filter((n) => !n.startsWith("Travel times")), // member notes shown on the cards
    travelEstimate: notes.some((n) => n.startsWith("Travel times")),
  };
}
