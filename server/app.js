import http from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes, randomInt, createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AREAS, RESTAURANTS } from "../src/data.js";
import { createSession, vote, veto, decide, isComplete, override } from "../src/voting.js";
import { generatePicksWithMaps } from "./maps.js";
import { makeSendOtp } from "./otp.js";
import { makeSendReminder } from "./reminders.js";
import { makePlaces, inBengaluru, roundCoord, PlacesError } from "./places.js";
import { cspFor, baseHeaders, clientIp, accessLine } from "./security.js";

export const REMINDER_LEAD_MS = 3 * 3600000; // F15: sent 3 hours before the plan time

const here = dirname(fileURLToPath(import.meta.url));
const MOODS = ["lively", "chill", "fancy", "quick", "quiet"];
const DEALBREAKERS = ["needs-veg", "needs-vegan", "needs-jain", "no-alcohol", "no-loud"];
const WENT = ["yes", "no", "elsewhere"];
const NOISE = ["quiet", "medium", "loud"];
const CID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const VETO_REASONS = ["too_far", "too_pricey", "not_my_food", "other"];
const REPORT_KINDS = ["closed", "changed", "other"];
// Analytics events the browser reports (PRD section 9). Everything else is logged by the server itself.
const FORM_FIELDS = ["none", "name", "start", "budget", "dealbreakers", "mood", "reminder", "consent"];
const CLIENT_EVENTS = {
  link_opened: { who: "anyone" },
  response_abandoned: { who: "anyone", field: "lastField", allowed: FORM_FIELDS },
  handoff_clicked: { who: "anyone", field: "kind", allowed: ["call", "directions", "booking"], needs: "decided" },
  plan_shared: { who: "organiser", field: "channel", allowed: ["whatsapp", "copy"] },
};
const DIETS = ["any", "veg", "vegan", "jain"];
const SPICES = ["mild", "medium", "hot"];
// Budget band -> private per-person ceiling. "1200+" has no cap, so it adds no ceiling.
const BANDS = { "under-500": 500, "500-800": 800, "800-1200": 1200, "1200-plus": null };
const DIET_DEALBREAKER = { veg: "needs-veg", vegan: "needs-vegan", jain: "needs-jain" };
const PROFILE_AREAS = ["Koramangala", "HSR Layout", "Indiranagar", "Domlur", "BTM Layout", "Jayanagar", "Marathahalli"];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);
const id = (n = 9) => randomBytes(n).toString("base64url");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

function normalisePhone(p) {
  const d = String(p || "").replace(/[^\d]/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 10 ? d : null;
  if (!ten || !/^[6-9]/.test(ten)) throw bad("Enter a valid 10-digit Indian mobile number");
  return "+91" + ten;
}
const cleanName = (n) => {
  const s = String(n || "").trim().replace(/\s+/g, " ");
  if (!/^[\p{L}][\p{L} .'-]{0,29}$/u.test(s)) throw bad("Name must be 1-30 letters");
  return s;
};
const lc = (s) => s.toLowerCase();

export function createApp({
  db,
  now = () => Date.now(),
  sendOtp = makeSendOtp(),
  sendReminder = makeSendReminder(), // null = no reminder channel configured: reminders are off, and the UI says so
  restaurants = RESTAURANTS,
  mapsKey = process.env.GOOGLE_MAPS_API_KEY,
  fetchImpl = globalThis.fetch,
  adminKey = process.env.ADMIN_KEY,
  publicUrl = process.env.PUBLIC_URL,
  voteWindowMs = 2 * 3600000,
  trustProxy = process.env.TRUST_PROXY === "1", // behind Caddy/a load balancer: use X-Forwarded-For for limits
  hsts = process.env.NODE_ENV === "production", // HTTPS-only once deployed
  accessLog = null, // fn(line); server/index.js passes console.log
  servePrototype = process.env.NODE_ENV !== "production", // the click-through demo uses fictional places
  limits = {},
} = {}) {
  const generating = new Set();
  // Abuse limits. SMS costs money per code, so sign-in has per-IP limits and a daily ceiling on sends.
  const L = {
    otpPerIp: 5, // per 10 minutes
    otpDailyCap: Number(process.env.OTP_DAILY_CAP) || 300, // whole service, per IST day
    verifyPerIp: 20, // per 10 minutes
    plansPerDay: 20, // per organiser
    answersPerIp: 30, // per 10 minutes
    answersPerPlan: 7, // groups of 8+ are out of scope
    ...limits,
  };
  const places = makePlaces({ apiKey: mapsKey, fetchImpl, areas: AREAS });

  // Engine weights (PRD section 6: "tuned weekly from votes, vetoes and ratings"). Stored in settings so the
  // weekly review can change them without a deploy; every plan log records the weights it used.
  const WEIGHT_KEYS = ["taste", "fairness", "mood", "novelty", "quality"];
  const getWeights = () => {
    const row = q("SELECT value FROM settings WHERE key = 'weights'");
    return row ? JSON.parse(row.value) : { taste: 1, fairness: 1, mood: 1, novelty: 1, quality: 1 };
  };

  // F10 hand-off links for a restaurant. Phone and booking link come from the curated spreadsheet (A1).
  const handoffs = (r) => ({
    directionsUrl: r ? `https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}` : null,
    callUrl: r && r.phone ? `tel:${r.phone}` : null,
    bookingUrl: r && r.bookingUrl && /^https:\/\//.test(r.bookingUrl) ? r.bookingUrl : null,
  });

  // A start point from the client: must be in Bengaluru, and is stored coarsely (~110 m) with no address text.
  const cleanPoint = (pt) => {
    if (!pt || !inBengaluru(pt.lat, pt.lng)) throw bad("Start point must be in Bengaluru");
    return { lat: roundCoord(pt.lat), lng: roundCoord(pt.lng) };
  };

  // Tiny in-memory rate limiter for the search endpoints (they cost money when Google is on).
  const hits = new Map();
  const limited = (key, max, win = 60000) => {
    const t = now();
    const arr = (hits.get(key) || []).filter((x) => t - x < win);
    if (arr.length >= max) { hits.set(key, arr); return true; }
    arr.push(t); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < win)) hits.delete(k);
    return false;
  };
  const CUISINES = [...new Set(restaurants.flatMap((r) => r.cuisines))].sort();

  // Taste profile (F2): every field optional and skippable. Unknown values are rejected, not stored.
  const pick = (v, allowed, label) => {
    if (v == null || v === "") return null;
    if (!allowed.includes(v)) throw bad(`Unknown ${label}`);
    return v;
  };
  const pickMany = (v, allowed, label) => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.length > 12 || v.some((x) => !allowed.includes(x))) throw bad(`Unknown ${label}`);
    return [...new Set(v)];
  };
  const cleanProfile = (b) => ({
    cuisines: pickMany(b.cuisines, CUISINES, "cuisine"),
    diet: pick(b.diet, DIETS, "diet"),
    spice: pick(b.spice, SPICES, "spice level"),
    budgetBand: pick(b.budgetBand, Object.keys(BANDS), "budget band"),
    vibe: pickMany(b.vibe, MOODS, "vibe"),
    home: pick(b.home, PROFILE_AREAS, "home area"),
    work: pick(b.work, PROFILE_AREAS, "work area"),
  });

  const q = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const logEvent = (planId, type, payload = {}) =>
    run("INSERT INTO events (plan_id, type, payload, at) VALUES (?,?,?,?)", planId, type, JSON.stringify(payload), now());

  // ---------- auth ----------
  // Session tokens are stored only as SHA-256 hashes, so a copied database can't be used to sign in.
  // Sessions last 30 days from sign-in.
  const SESSION_MS = 30 * 86400000;
  const authPhone = (req) => {
    const m = /^Bearer ([A-Za-z0-9_-]{16,64})$/.exec(req.headers.authorization || "");
    if (!m) return null;
    const s = q("SELECT phone, created FROM sessions WHERE token = ?", sha(m[1]));
    return s && now() - s.created < SESSION_MS ? s.phone : null;
  };
  // Friends' member keys are also stored hashed, and only a key whose hash matches is accepted. (Keys saved
  // before hashing are converted when the database opens: see hashLegacySecrets in db.js. There is no
  // plain-text fallback, because that would let a copied hash be used as a key.)
  const memberByKey = (planId, key) => {
    if (!key || typeof key !== "string") return null;
    const h = sha(key);
    return responsesOf(planId).find((x) => safeEq(x.member_key, h)) || null;
  };
  const requireAuth = (req) => {
    const p = authPhone(req);
    if (!p) throw new HttpError(401, "Sign in required");
    return p;
  };

  // ---------- plan helpers ----------
  const loadPlan = (planId) => {
    const p = q("SELECT * FROM plans WHERE id = ?", planId);
    if (!p) throw new HttpError(404, "Plan not found");
    p.data = JSON.parse(p.data);
    return p;
  };
  const responsesOf = (planId) => all("SELECT * FROM responses WHERE plan_id = ? ORDER BY created, rowid", planId);
  const userProfile = (phone) => {
    const u = q("SELECT profile FROM users WHERE phone = ?", phone);
    return u && u.profile ? JSON.parse(u.profile) : null;
  };
  // Places this person has already been to: rated "went: yes" on their own plans, or marked "been there".
  // They count as not new in group plans, and are never offered by "find something new".
  const visitedBy = (phone) => {
    const rated = all("SELECT p.winner_json FROM ratings r JOIN plans p ON p.id = r.plan_id WHERE p.organiser_phone = ? AND r.name = p.organiser_name AND r.went = 'yes' AND p.winner_json IS NOT NULL", phone)
      .map((row) => JSON.parse(row.winner_json).pick?.id)
      .filter(Boolean);
    const marked = all("SELECT restaurant_id FROM user_places WHERE phone = ? AND status = 'been'", phone).map((r) => r.restaurant_id);
    return [...new Set([...rated, ...marked])];
  };
  // The profile is snapshotted onto the plan at creation, so later edits never change a running plan.
  const organiserMember = (p) => {
    const prof = p.data.organiserProfile || {};
    return {
      name: p.organiser_name,
      start: JSON.parse(p.organiser_start),
      budget: p.organiser_budget,
      dealbreakers: prof.diet && DIET_DEALBREAKER[prof.diet] ? [DIET_DEALBREAKER[prof.diet]] : [],
      mood: prof.vibe && prof.vibe.length ? prof.vibe : null,
      cuisines: prof.cuisines || [],
      visited: visitedBy(p.organiser_phone),
    };
  };
  const toMember = (r) => ({
    name: r.name,
    start: { lat: r.start_lat, lng: r.start_lng },
    budget: r.budget,
    dealbreakers: JSON.parse(r.dealbreakers),
    mood: r.mood,
    cuisines: [],
    visited: [],
  });
  const identity = (req, body, p) => {
    if (authPhone(req) === p.organiser_phone) return { name: p.organiser_name, organiser: true };
    const key = body.memberKey || req.headers["x-member-key"];
    if (key) {
      const r = memberByKey(p.id, key);
      if (r) return { name: r.name, organiser: false };
    }
    throw new HttpError(403, "Not a member of this plan");
  };

  async function generate(p, trigger) {
    if (generating.has(p.id)) return;
    if (!["open", "no_picks"].includes(p.status)) return;
    generating.add(p.id);
    try {
      const rs = responsesOf(p.id);
      const answeredNames = new Set(rs.map((r) => lc(r.name)));
      const members = [organiserMember(p), ...rs.map(toMember)];
      const unanswered = (p.data.friends || []).filter((f) => !answeredNames.has(lc(f))).map((name) => ({ name }));
      // Candidates from the organiser's want-to-try list join the pool even outside the chosen area, but they
      // face exactly the same filters and fairness as every other place. No ranking boost.
      const cand = new Set(p.data.candidateIds || []);
      const inArea = p.data.area === "anywhere" ? restaurants : restaurants.filter((r) => r.area === p.data.area);
      const pool = [...inArea, ...restaurants.filter((r) => cand.has(r.id) && !inArea.includes(r))];
      const result = await generatePicksWithMaps(
        { plan: { date: p.data.date, time: p.data.time, travelLimitMin: p.data.travelLimitMin, filters: p.data.filters }, members, unanswered, restaurants: pool, weights: getWeights() },
        { db, apiKey: mapsKey, fetchImpl, now: now() }
      );
      for (const pk of [...result.picks, ...result.reserve]) {
        if (cand.has(pk.id)) {
          pk.fromWantList = true;
          pk.reason += ` · on ${p.organiser_name}'s want-to-try list`;
        }
      }
      const stored = { picks: result.picks, reserve: result.reserve, nearMisses: result.nearMisses, notes: result.notes, travelFallback: result.travelFallback, relaxation: result.relaxation, budget: result.budget };
      const status = result.picks.length ? "voting" : "no_picks";
      // Surprise plans: only the planning partner votes (their vote decides); the other is kept in the dark.
      const planner = !p.data.surprise ? null : p.data.surprise === "partner" ? p.organiser_name : rs[0].name;
      const session = createSession(result, planner ? [planner] : members.map((m) => m.name));
      p.data.voting_ends = now() + voteWindowMs;
      run("UPDATE plans SET status=?, picks_json=?, session_json=?, log_json=?, data=? WHERE id=?",
        status, JSON.stringify(stored), JSON.stringify(session), JSON.stringify(result.log), JSON.stringify(p.data), p.id);
      logEvent(p.id, "picks_generated", { trigger, picks: result.picks.map((x) => x.id) });
      p.status = status;
    } finally {
      generating.delete(p.id);
    }
  }

  // Lazy triggers (no background worker needed for the MVP): all answered, or response deadline passed.
  async function tick(p) {
    if (p.status === "open") {
      const n = responsesOf(p.id).length;
      const friends = p.data.friends || [];
      if (n >= 1 && ((friends.length && n >= friends.length) || now() >= p.deadline_at)) {
        await generate(p, n >= friends.length && friends.length ? "all_answered" : "deadline");
        p = loadPlan(p.id); // generate() wrote new columns; don't keep using the stale row
      }
    }
    if (p.status === "voting") {
      const s = JSON.parse(p.session_json);
      if (isComplete(s, { deadlinePassed: now() >= p.data.voting_ends })) finish(p, s, "all_voted_or_deadline");
    }
    return loadPlan(p.id);
  }

  function finish(p, session, trigger, forced) {
    const d = forced || decide(session);
    const winner = { pick: d.winner, counts: d.counts || {}, overridden: !!d.overridden };
    run("UPDATE plans SET status='decided', winner_json=?, session_json=? WHERE id=?", JSON.stringify(winner), JSON.stringify(session), p.id);
    logEvent(p.id, "winner_decided", { id: d.winner && d.winner.id, trigger });
  }

  const publicPlan = (p) => {
    const rs = responsesOf(p.id);
    const answered = rs.map((r) => r.name); // who answered, never what they said
    const friends = p.data.friends || [];
    const pending = friends.filter((f) => !answered.some((a) => lc(a) === lc(f)));
    return {
      id: p.id, status: p.status, organiser: p.organiser_name, occasion: p.data.occasion, date: p.data.date, time: p.data.time,
      area: p.data.area, deadlineAt: p.deadline_at, answered, pending,
      mode: p.data.mode || "friends", surpriseFor: p.data.surprise || null, revealAt: p.data.surprise ? p.data.revealAt : null,
      reminders: { enabled: p.data.reminders !== false && !!sendReminder, at: p.plan_at - REMINDER_LEAD_MS },
    };
  };

  // ---- Day-of reminders (F15) ----
  // Runs on a timer (server/index.js) and from tests. A plan is due once its time is within 3 hours and not past.
  // At most one reminder per plan per recipient (reminders table); failures retry up to 3 times, then stop.
  let reminding = false;
  async function runReminders() {
    if (!sendReminder || reminding) return { sent: 0, failed: 0 };
    reminding = true;
    let sent = 0, failed = 0;
    try {
      const t = now();
      const due = all("SELECT * FROM plans WHERE status = 'decided' AND plan_at <= ? AND plan_at > ?", t + REMINDER_LEAD_MS, t);
      for (const p of due) {
        p.data = JSON.parse(p.data);
        if (p.data.reminders === false || !p.winner_json) continue;
        const w = JSON.parse(p.winner_json).pick;
        const rest = w && restaurants.find((r) => r.id === w.id);
        if (!rest) continue;
        const recipients = [{ key: "org", phone: p.organiser_phone, name: p.organiser_name }];
        for (const r of responsesOf(p.id)) if (r.reminder_phone) recipients.push({ key: "r:" + r.name, phone: r.reminder_phone, name: r.name, friend: true });
        for (const rc of recipients) {
          const row = q("SELECT status, attempts FROM reminders WHERE plan_id = ? AND recipient = ?", p.id, rc.key);
          if (row && (row.status === "sent" || row.status === "failed")) continue;
          // If the reveal has not happened yet, the person being surprised never gets the place, only the time.
          const payload = isHidden(p, rc.name)
            ? { kind: "surprise", occasion: p.data.occasion, date: p.data.date, time: p.data.time }
            : { kind: "place", occasion: p.data.occasion, date: p.data.date, time: p.data.time, place: w.name, area: w.area, directionsUrl: `https://www.google.com/maps/dir/?api=1&destination=${rest.lat},${rest.lng}` };
          const attempts = (row ? row.attempts : 0) + 1;
          try {
            await sendReminder(rc.phone, payload);
            run("INSERT OR REPLACE INTO reminders (plan_id, recipient, status, attempts, error, sent_at) VALUES (?,?,?,?,NULL,?)", p.id, rc.key, "sent", attempts, now());
            sent++;
          } catch (e) {
            const final = attempts >= 3;
            run("INSERT OR REPLACE INTO reminders (plan_id, recipient, status, attempts, error, sent_at) VALUES (?,?,?,?,?,NULL)", p.id, rc.key, final ? "failed" : "pending", attempts, String(e.message).slice(0, 200));
            console.error(`Reminder failed for plan ${p.id} (attempt ${attempts}): ${e.message}`); // never the number
            failed++;
          }
          // Data minimisation: a friend's opt-in number is erased once we are done with it.
          const done = q("SELECT status FROM reminders WHERE plan_id = ? AND recipient = ?", p.id, rc.key);
          if (rc.friend && done && (done.status === "sent" || done.status === "failed")) run("UPDATE responses SET reminder_phone = NULL WHERE plan_id = ? AND name = ?", p.id, rc.name);
        }
      }

      // F11 "post-visit check the next day": one text to the organiser at 11:00 IST the day after, with a link
      // straight to the rating. Friends' numbers are already erased by then, so the organiser can pass the
      // question on to the group from the winner screen ("Ask the group"). Needs PUBLIC_URL for the link.
      const supports = (k) => !sendReminder.supports || sendReminder.supports.has(k);
      if (publicUrl && supports("rate")) {
        const DAY = 86400000;
        for (const p of all("SELECT * FROM plans WHERE status = 'decided' AND plan_at <= ? AND plan_at > ?", t, t - 4 * DAY)) {
          p.data = JSON.parse(p.data);
          if (p.data.reminders === false || !p.winner_json) continue;
          const [y, m, d] = p.data.date.split("-").map(Number);
          const rateAt = Date.parse(new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10) + "T11:00:00+05:30");
          if (t < rateAt || t >= rateAt + 2 * DAY) continue;
          if (q("SELECT 1 x FROM ratings WHERE plan_id = ? AND name = ?", p.id, p.organiser_name)) continue; // already answered
          const row = q("SELECT status, attempts FROM reminders WHERE plan_id = ? AND recipient = 'org:rate'", p.id);
          if (row && (row.status === "sent" || row.status === "failed")) continue;
          const attempts = (row ? row.attempts : 0) + 1;
          try {
            await sendReminder(p.organiser_phone, { kind: "rate", place: JSON.parse(p.winner_json).pick.name, url: `${publicUrl}/?plan=${p.id}` });
            run("INSERT OR REPLACE INTO reminders (plan_id, recipient, status, attempts, error, sent_at) VALUES (?,?,?,?,NULL,?)", p.id, "org:rate", "sent", attempts, now());
            sent++;
          } catch (e) {
            run("INSERT OR REPLACE INTO reminders (plan_id, recipient, status, attempts, error, sent_at) VALUES (?,?,?,?,?,NULL)", p.id, "org:rate", attempts >= 3 ? "failed" : "pending", attempts, String(e.message).slice(0, 200));
            failed++;
          }
        }
      }
    } finally {
      reminding = false;
    }
    return { sent, failed };
  }

  // ---- Couples surprise (F12): the hidden partner learns nothing about the picks until the day. ----
  // Who is asking? The organiser (Bearer) or a friend/partner (x-member-key header); anyone else is unknown.
  const viewerName = (req, p) => {
    if (authPhone(req) === p.organiser_phone) return p.organiser_name;
    const key = req.headers["x-member-key"];
    const r = memberByKey(p.id, key);
    return r ? r.name : null;
  };
  const hiddenName = (p) => (p.data.surprise === "partner" ? (responsesOf(p.id)[0] || {}).name || null : p.organiser_name);
  // Unknown viewers are treated as hidden: a missing key must never reveal a surprise.
  const isHidden = (p, viewer) => !!p.data.surprise && now() < p.data.revealAt && (viewer === null || viewer === hiddenName(p));

  const publicPicks = (p, viewer) => {
    if (isHidden(p, viewer)) {
      return { status: p.status, hidden: true, revealAt: p.data.revealAt, mode: "couple", surpriseFor: p.data.surprise, picks: [], nearMisses: [], notes: [], travelFallback: false, members: [], voted: [], vetoUsed: [], votingEnds: null, winner: null };
    }
    const stored = p.picks_json ? JSON.parse(p.picks_json) : null;
    const s = p.session_json ? JSON.parse(p.session_json) : null;
    const w = p.winner_json ? JSON.parse(p.winner_json) : null;
    const rest = w && w.pick ? restaurants.find((r) => r.id === w.pick.id) : null;
    return {
      status: p.status,
      mode: p.data.mode || "friends",
      surprise: p.data.surprise ? { hiddenFrom: hiddenName(p), revealAt: p.data.revealAt, revealed: now() >= p.data.revealAt } : null,
      picks: s ? s.shown : [],
      nearMisses: stored ? stored.nearMisses : [],
      // PRD content rule: budgets show only as a shared range. The page builds "₹low-high a head" from the cards;
      // this says what may honestly follow: "works for all" (everyone gave a budget), "within every budget given",
      // or nothing (no budgets, or the budget was stretched, which the cards' trade-offs already say).
      budgetScope: stored && stored.budget && !stored.budget.relaxed ? stored.budget.scope : null,
      notes: stored ? stored.notes : [],
      travelFallback: stored ? stored.travelFallback : false,
      members: s ? s.members : [],
      voted: s ? Object.keys(s.votes) : [],
      vetoUsed: s ? Object.keys(s.vetoes) : [],
      votingEnds: p.data.voting_ends || null,
      // F10 hand-offs: call, directions, booking app. Only links the curated list actually has are sent.
      winner: w && w.pick ? { ...w, ...handoffs(rest) } : null,
    };
  };

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn });

  route("POST", "/api/auth/request-otp", async (req, body, ctx) => {
    const phone = normalisePhone(body.phone);
    // SMS pumping defence: per-IP limit, then a service-wide daily ceiling on codes sent.
    if (limited("otp:" + ctx.ip, L.otpPerIp, 10 * 60000)) throw new HttpError(429, "Too many codes requested. Try again in a few minutes.");
    const istMidnight = Date.parse(new Date(now() + 5.5 * 3600000).toISOString().slice(0, 10) + "T00:00:00+05:30");
    if (q("SELECT COUNT(*) n FROM events WHERE type = 'otp_sent' AND at >= ?", istMidnight).n >= L.otpDailyCap) {
      console.error(`ALERT: daily sign-in code cap (${L.otpDailyCap}) reached; refusing new codes until midnight IST`);
      throw new HttpError(503, "Sign-in is busy right now. Please try again later.");
    }
    const prev = q("SELECT sent FROM otps WHERE phone = ?", phone);
    if (prev && now() - prev.sent < 30000) throw new HttpError(429, "Wait 30 seconds before asking for another code");
    const code = String(randomInt(100000, 1000000));
    run("INSERT OR REPLACE INTO otps (phone, code_hash, expires, attempts, sent) VALUES (?,?,?,0,?)", phone, sha(phone + code), now() + 10 * 60000, now());
    try {
      await sendOtp(phone, code);
    } catch (e) {
      console.error("OTP send failed:", e.message); // never log the code or number
      run("DELETE FROM otps WHERE phone = ?", phone); // let them retry immediately rather than wait out the throttle
      throw new HttpError(502, "We couldn't send the code. Please try again in a minute.");
    }
    logEvent(null, "otp_sent", {}); // counted for the daily ceiling; no number stored
    return { sent: true };
  });

  route("POST", "/api/auth/verify", async (req, body, ctx) => {
    if (limited("verify:" + ctx.ip, L.verifyPerIp, 10 * 60000)) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
    const phone = normalisePhone(body.phone);
    const o = q("SELECT * FROM otps WHERE phone = ?", phone);
    if (!o || now() > o.expires) throw new HttpError(400, "Code expired. Ask for a new one");
    if (o.attempts >= 5) throw new HttpError(429, "Too many attempts. Ask for a new code");
    run("UPDATE otps SET attempts = attempts + 1 WHERE phone = ?", phone);
    if (!safeEq(o.code_hash, sha(phone + String(body.code || "")))) throw new HttpError(400, "Wrong code");
    run("DELETE FROM otps WHERE phone = ?", phone);
    const name = body.firstName ? cleanName(body.firstName) : null;
    const u = q("SELECT * FROM users WHERE phone = ?", phone);
    if (!u) run("INSERT INTO users (phone, first_name, created) VALUES (?,?,?)", phone, name, now());
    else if (name) run("UPDATE users SET first_name = ? WHERE phone = ?", name, phone);
    const token = id(24);
    run("INSERT INTO sessions (token, phone, created) VALUES (?,?,?)", sha(token), phone, now()); // only the hash is kept
    return { token, firstName: name || (u && u.first_name) || null };
  });

  // Sign out: the session stops working on the server, not just in this browser.
  route("POST", "/api/auth/logout", async (req) => {
    const m = /^Bearer ([A-Za-z0-9_-]{16,64})$/.exec(req.headers.authorization || "");
    if (m) run("DELETE FROM sessions WHERE token = ?", sha(m[1]));
    return { signedOut: true };
  });

  route("GET", "/api/me", async (req) => {
    const phone = requireAuth(req);
    const u = q("SELECT first_name FROM users WHERE phone = ?", phone);
    return {
      firstName: u ? u.first_name : null,
      profile: userProfile(phone), // null until they save one; editable any time
      options: { cuisines: CUISINES, diets: DIETS, spices: SPICES, budgetBands: Object.keys(BANDS), vibes: MOODS, areas: PROFILE_AREAS },
    };
  });

  route("PUT", "/api/me/profile", async (req, body) => {
    const phone = requireAuth(req);
    const profile = cleanProfile(body);
    run("UPDATE users SET profile = ? WHERE phone = ?", JSON.stringify(profile), phone);
    // Completion time feeds the "median under 2 minutes" target. Not tied to a plan.
    run("INSERT INTO events (plan_id, type, payload, at) VALUES (NULL, ?, ?, ?)", "profile_completed", JSON.stringify({ seconds: Number(body.secondsTaken) || null, answered: Object.values(profile).filter((v) => (Array.isArray(v) ? v.length : v)).length }), now());
    return { profile };
  });

  // ---- Want-to-try list and "been there" marks (F14). One status per place: 'want' or 'been'. ----
  const placesWith = (phone, status) =>
    all("SELECT restaurant_id FROM user_places WHERE phone = ? AND status = ? ORDER BY at DESC, rowid DESC", phone, status)
      .map((r) => restaurants.find((x) => x.id === r.restaurant_id))
      .filter(Boolean)
      .map((r) => ({ id: r.id, name: r.name, area: r.area, pricePerHead: r.pricePerHead }));
  const placeStatus = (phone, rid) => (q("SELECT status FROM user_places WHERE phone = ? AND restaurant_id = ?", phone, rid) || {}).status || null;

  route("GET", "/api/me/places", async (req) => {
    const phone = requireAuth(req);
    return { been: placesWith(phone, "been"), want: placesWith(phone, "want") };
  });

  // Body: {restaurantId, status: "want" | "been" | null}. Legacy {been: true|false} still works.
  route("POST", "/api/me/places", async (req, body) => {
    const phone = requireAuth(req);
    if (!restaurants.some((r) => r.id === body.restaurantId)) throw new HttpError(404, "Unknown place");
    const status = body.status !== undefined ? body.status : body.been === false ? null : "been";
    if (![null, "want", "been"].includes(status)) throw bad("status must be want, been or null");
    // Having been there ends the wish; but a visited place can't be quietly turned back into a wish.
    if (status === "want" && placeStatus(phone, body.restaurantId) === "been") throw new HttpError(409, "You've marked this as been there. Remove that first.");
    if (status === null) run("DELETE FROM user_places WHERE phone = ? AND restaurant_id = ?", phone, body.restaurantId);
    else run("INSERT OR REPLACE INTO user_places (phone, restaurant_id, status, at) VALUES (?,?,?,?)", phone, body.restaurantId, status, now());
    return { status, been: status === "been" };
  });

  // ---- Solo "find something new" (F13): 3 places the person has not been to, from their profile ----
  route("POST", "/api/solo/picks", async (req, body) => {
    const phone = requireAuth(req);
    const prof = userProfile(phone) || {};
    const startName = body.startArea || prof.home;
    const start = AREAS[startName];
    if (!start) throw bad("Choose where you're starting from (or set a home area in your taste profile)");
    const time = body.time || "20:00";
    // Opening hours depend on the weekday: default to today in Bengaluru.
    const date = body.date || new Date(now() + 5.5 * 3600000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad("date must be YYYY-MM-DD");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad("time must be HH:MM");
    const area = body.area || "anywhere";
    if (area !== "anywhere" && !["Koramangala", "HSR Layout", "Indiranagar"].includes(area)) throw bad("Unknown area");

    const visited = new Set(visitedBy(phone));
    // Hard rule: a place marked "been there" never appears, not even as a near miss or spare.
    const pool = (area === "anywhere" ? restaurants : restaurants.filter((r) => r.area === area)).filter((r) => !visited.has(r.id));
    const me = {
      name: "You", start,
      budget: prof.budgetBand ? BANDS[prof.budgetBand] : null,
      dealbreakers: prof.diet && DIET_DEALBREAKER[prof.diet] ? [DIET_DEALBREAKER[prof.diet]] : [],
      mood: prof.vibe && prof.vibe.length ? prof.vibe : null,
      cuisines: prof.cuisines || [],
      visited: [...visited],
    };
    const result = await generatePicksWithMaps(
      { plan: { date, time, travelLimitMin: Number(body.travelLimitMin) || 40 }, members: [me], restaurants: pool, weights: getWeights() },
      { db, apiKey: mapsKey, fetchImpl, now: now() }
    );
    const saved = new Set(placesWith(phone, "want").map((p) => p.id));
    const withLinks = (list) => list.map((p) => {
      const r = restaurants.find((x) => x.id === p.id);
      return { ...p, saved: saved.has(p.id), ...handoffs(r) };
    });
    logEvent(null, "solo_picks_generated", { count: result.picks.length });
    return { picks: withLinks(result.picks), nearMisses: result.nearMisses, notes: result.notes, travelFallback: result.travelFallback, beenCount: visited.size, hasProfile: !!userProfile(phone) };
  });

  route("DELETE", "/api/me", async (req) => {
    const phone = requireAuth(req);
    run("DELETE FROM user_places WHERE phone = ?", phone);
    for (const pl of all("SELECT id FROM plans WHERE organiser_phone = ?", phone)) run("DELETE FROM reminders WHERE plan_id = ?", pl.id);
    for (const p of all("SELECT id FROM plans WHERE organiser_phone = ?", phone)) {
      run("DELETE FROM responses WHERE plan_id = ?", p.id);
      run("DELETE FROM ratings WHERE plan_id = ?", p.id);
      run("DELETE FROM events WHERE plan_id = ?", p.id);
    }
    run("DELETE FROM plans WHERE organiser_phone = ?", phone);
    run("DELETE FROM sessions WHERE phone = ?", phone);
    run("DELETE FROM otps WHERE phone = ?", phone);
    run("DELETE FROM users WHERE phone = ?", phone);
    return { deleted: true };
  });

  route("POST", "/api/plans", async (req, body, ctx) => {
    const phone = requireAuth(req);
    if (q("SELECT COUNT(*) n FROM plans WHERE organiser_phone = ? AND created > ?", phone, now() - 86400000).n >= L.plansPerDay)
      throw new HttpError(429, "That's a lot of plans for one day. Try again tomorrow.");
    const user = q("SELECT first_name FROM users WHERE phone = ?", phone);
    const organiserName = cleanName(body.organiserName || (user && user.first_name));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || "") || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time || "")) throw bad("date (YYYY-MM-DD) and time (HH:MM) required");
    const area = body.area || "anywhere";
    if (area !== "anywhere" && !["Koramangala", "HSR Layout", "Indiranagar"].includes(area)) throw bad("Unknown area");
    const prof = userProfile(phone); // with a profile, start point and budget default from it
    const start = body.organiserStart ? cleanPoint(body.organiserStart) : AREAS[body.organiserArea] || (prof && prof.home && AREAS[prof.home]);
    if (!start) throw bad("Choose where you're starting from (or set a home area in your taste profile)");
    const budget = body.organiserBudget ? Number(body.organiserBudget) : prof && prof.budgetBand ? BANDS[prof.budgetBand] : null;
    const friends = (body.friends || []).map(cleanName);
    if (new Set(friends.map(lc)).size !== friends.length || friends.map(lc).includes(lc(organiserName))) throw bad("Friend names must be unique");
    if (friends.length > 7) throw bad("Groups of 8+ are out of scope for the MVP");

    // Couples mode (F12): exactly one partner, optional noise ceiling and ambience, optional surprise.
    const mode = body.mode === "couple" ? "couple" : "friends";
    const surprise = body.surprise || null;
    if (mode === "couple" && friends.length !== 1) throw bad("Date night is a 2-person plan: add your partner's first name");
    if (surprise && (mode !== "couple" || !["partner", "organiser"].includes(surprise))) throw bad("Surprise is only for date night: 'partner' or 'organiser'");
    if (body.noise && !NOISE.includes(body.noise)) throw bad("Unknown noise level");
    // Want-to-try places added as candidates (F14): must be on this organiser's own list.
    if (body.candidateIds != null && !Array.isArray(body.candidateIds)) throw bad("candidateIds must be a list");
    const candidateIds = [...new Set(body.candidateIds || [])];
    if (candidateIds.length > 5) throw bad("Add up to 5 places from your want-to-try list");
    for (const rid of candidateIds) if (placeStatus(phone, rid) !== "want") throw bad("Candidates must come from your want-to-try list");
    const filters = mode === "couple" ? { maxNoise: body.noise || null, ambience: pickMany(body.ambience, MOODS, "ambience") } : null;
    const hours = Math.min(24, Math.max(0.25, Number(body.deadlineHours ?? 2)));
    const planAt = Date.parse(`${body.date}T${body.time}:00+05:30`);
    const pid = id();
    run("INSERT INTO plans (id, organiser_phone, organiser_name, organiser_budget, organiser_start, data, status, created, deadline_at, plan_at, shared_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      pid, phone, organiserName, budget, JSON.stringify({ lat: start.lat, lng: start.lng }),
      JSON.stringify({ date: body.date, time: body.time, area, occasion: String(body.occasion || "Dinner").slice(0, 40), friends, travelLimitMin: Number(body.travelLimitMin) || 40,
        reminders: body.reminders !== false, candidateIds, mode, filters, surprise, revealAt: Date.parse(`${body.date}T00:00:00+05:30`), // "the day" = midnight IST of the plan date
        organiserProfile: prof ? { cuisines: prof.cuisines, diet: prof.diet, vibe: prof.vibe } : null }),
      "open", now(), now() + hours * 3600000, planAt, now());
    logEvent(pid, "plan_created");
    const base = publicUrl || ctx.origin;
    const url = `${base}/p/${pid}`;
    const message = `Dinner plan: ${body.occasion || "Dinner"}, ${body.date} at ${body.time}. 30 seconds, no sign-in, your budget stays private: ${url}`;
    // plan_shared is logged when the organiser actually taps Share or Copy link (POST /api/plans/:id/events).
    return { id: pid, url, whatsapp: `https://wa.me/?text=${encodeURIComponent(message)}`, message };
  });

  // ---- Start-point search (F5). Friends have no account, so the gate is "a plan that is still collecting
  // answers" (or a signed-in organiser). That stops this being an open, billable proxy. ----
  const placesGate = (req, ctx) => {
    const planId = ctx.query.get("plan");
    const ok = authPhone(req) || (planId && q("SELECT 1 x FROM plans WHERE id = ? AND status IN ('open','no_picks')", planId));
    if (!ok) throw new HttpError(403, "Search is available while a plan is collecting answers");
    if (limited("ip:" + ctx.ip, 60) || (planId && limited("plan:" + planId, 200))) throw new HttpError(429, "Too many searches. Wait a moment.");
  };

  route("GET", "/api/places/search", async (req, body, ctx) => {
    placesGate(req, ctx);
    const text = (ctx.query.get("q") || "").trim();
    if (text.length < 2) return { source: places.hasGoogle ? "google" : "local", results: [] };
    if (text.length > 80) throw bad("Search text is too long");
    const r = await places.search(text, ctx.query.get("token"));
    return { source: r.source, degraded: !!r.degraded, results: r.results.slice(0, 6) };
  });

  route("GET", "/api/places/details", async (req, body, ctx) => {
    placesGate(req, ctx);
    const pid = ctx.query.get("id") || "";
    if (!pid || pid.length > 300) throw bad("id required");
    let pt;
    try {
      pt = await places.details(pid, ctx.query.get("token"));
    } catch (e) {
      if (e instanceof PlacesError) throw new HttpError(502, "We couldn't look that place up. Try another or choose an area.");
      throw e;
    }
    if (!inBengaluru(pt.lat, pt.lng)) throw new HttpError(422, "That place is outside Bengaluru");
    return pt;
  });

  // ---- Client analytics events (PRD section 9). No names, no personal data: type, one enum field, a random cid. ----
  route("POST", "/api/plans/:id/events", async (req, body, ctx) => {
    const p = loadPlan(ctx.params.id);
    const spec = CLIENT_EVENTS[body.type];
    if (!spec) throw bad("Unknown event");
    if (limited("ev:" + ctx.ip, 120)) throw new HttpError(429, "Too many events");
    if (spec.who === "organiser" && authPhone(req) !== p.organiser_phone) throw new HttpError(403, "Organiser only");
    if (spec.needs === "decided" && p.status !== "decided") throw new HttpError(409, "No winner yet");
    const payload = {};
    if (spec.field) {
      if (!spec.allowed.includes(body[spec.field])) throw bad(`${spec.field} must be one of ${spec.allowed.join(", ")}`);
      payload[spec.field] = body[spec.field];
    }
    if (CID_RE.test(body.cid || "")) payload.cid = body.cid;
    logEvent(p.id, body.type, payload);
    return { ok: true };
  });

  // ---- "Closed or changed?" link on every card (PRD risk: curated list goes stale). Feeds the weekly review. ----
  route("POST", "/api/reports", async (req, body, ctx) => {
    if (!restaurants.some((r) => r.id === body.restaurantId)) throw new HttpError(404, "Unknown place");
    if (!REPORT_KINDS.includes(body.kind)) throw bad(`kind must be one of ${REPORT_KINDS.join(", ")}`);
    const planOk = body.planId && q("SELECT 1 x FROM plans WHERE id = ?", body.planId);
    if (!planOk && !authPhone(req)) throw new HttpError(403, "Report from a plan or while signed in");
    if (limited("rep:" + ctx.ip, 20)) throw new HttpError(429, "Thanks, that's plenty for now");
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";
    run("INSERT INTO place_reports (restaurant_id, plan_id, kind, note, at) VALUES (?,?,?,?,?)", body.restaurantId, planOk ? body.planId : null, body.kind, note || null, now());
    return { thanks: true };
  });

  route("GET", "/api/plans", async (req) => {
    const phone = requireAuth(req);
    const rows = all("SELECT id, data, status, plan_at FROM plans WHERE organiser_phone = ? ORDER BY created DESC, rowid DESC LIMIT 20", phone);
    const user = q("SELECT first_name FROM users WHERE phone = ?", phone);
    return { firstName: user ? user.first_name : null, plans: rows.map((r) => { const d = JSON.parse(r.data); return { id: r.id, occasion: d.occasion, date: d.date, time: d.time, status: r.status }; }) };
  });

  route("GET", "/api/plans/:id", async (req, body, ctx) => {
    const p = await tick(loadPlan(ctx.params.id));
    return { ...publicPlan(p), isOrganiser: authPhone(req) === p.organiser_phone };
  });

  route("POST", "/api/plans/:id/responses", async (req, body, ctx) => {
    const p = loadPlan(ctx.params.id);
    if (p.status !== "open") throw new HttpError(409, "This plan has already moved on to picks");
    if (limited("ans:" + ctx.ip, L.answersPerIp, 10 * 60000)) throw new HttpError(429, "Too many answers from this connection. Try again shortly.");
    // Without a friends list, names are free text: cap the answers so a leaked link can't be flooded.
    if (responsesOf(p.id).length >= L.answersPerPlan) throw new HttpError(409, "This plan is full (groups of up to 8)");
    // PRD risk mitigation: "the organiser can enter answers for a friend" who ignores the link. The organiser
    // confirms they have that friend's okay; the friend can take the answers over later with a claim link.
    const onBehalf = body.onBehalf === true;
    if (onBehalf) {
      if (authPhone(req) !== p.organiser_phone) throw new HttpError(403, "Only the organiser can answer for a friend");
      if (body.organiserConsent !== true) throw bad("Confirm your friend is okay with you answering for them");
      if (body.reminderPhone) throw bad("A friend has to ask for a reminder themselves");
    } else if (body.consent !== true) throw bad("Consent is required");
    const name = cleanName(body.name);
    if (onBehalf && !(p.data.friends || []).some((f) => lc(f) === lc(name))) throw bad("You can only answer for a friend on this plan's list");
    if (lc(name) === lc(p.organiser_name) || responsesOf(p.id).some((r) => lc(r.name) === lc(name))) throw new HttpError(409, "That name has already answered");
    const friends = p.data.friends || [];
    if (friends.length && !friends.some((f) => lc(f) === lc(name))) throw bad("Pick your name from the list");
    let start;
    if (body.area) {
      if (!AREAS[body.area]) throw bad("Unknown area");
      start = { ...AREAS[body.area], label: body.area };
    } else {
      // A searched address or a pinned location. Coordinates only, rounded: the address text is never stored.
      start = { ...cleanPoint(body.start), label: null };
    }
    const budget = body.budget == null || body.budget === "" ? null : Math.round(Number(body.budget));
    if (budget != null && !(budget >= 0 && budget <= 100000)) throw bad("Budget out of range");
    const db_ = body.dealbreakers || [];
    if (!Array.isArray(db_) || db_.some((d) => !DEALBREAKERS.includes(d))) throw bad("Unknown dealbreaker");
    const mood = body.mood || null;
    if (mood && !MOODS.includes(mood)) throw bad("Unknown mood");
    const key = id(18);
    // Optional reminder opt-in (F15): a number needs its own explicit consent, and is only collected when we
    // can actually send. It is erased as soon as the reminder is sent (see runReminders).
    let reminderPhone = null;
    const canRemind = p.data.reminders !== false && !!sendReminder;
    if (body.reminderPhone) {
      if (body.reminderConsent !== true) throw bad("Tick the box to allow one reminder text");
      if (canRemind) reminderPhone = normalisePhone(body.reminderPhone);
    }
    run("INSERT INTO responses (plan_id, name, member_key, start_lat, start_lng, start_label, budget, dealbreakers, mood, created, reminder_phone, entered_by_organiser) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      p.id, name, sha(key), start.lat, start.lng, start.label, budget, JSON.stringify(db_), mood, now(), reminderPhone, onBehalf ? 1 : 0); // only the hash is kept
    // cid: a random per-browser id (no personal data) so opens, abandons and submits can be matched up.
    // Organiser-entered answers carry no cid, so they never count towards the friend response rate.
    logEvent(p.id, "response_submitted", onBehalf ? { byOrganiser: true } : { seconds: Number(body.secondsTaken) || null, cid: CID_RE.test(body.cid || "") ? body.cid : null });
    await tick(loadPlan(p.id));
    if (onBehalf) {
      // The organiser never gets the friend's member key to vote with; only a link to forward to the friend.
      const claimUrl = `${publicUrl || ctx.origin}/p/${p.id}#claim=${key}`;
      return { entered: true, claimUrl, whatsapp: `https://wa.me/?text=${encodeURIComponent(`I filled in the dinner plan for you (${p.data.occasion}, ${p.data.date}). Tap to check it, vote, or change your mind: ${claimUrl}`)}` };
    }
    return { memberKey: key, reminder: !!reminderPhone }; // budget and phone are never echoed back or exposed anywhere else
  });

  // Who am I on this plan? Used by a claim link (#claim=<member key>) to take over answers entered for you.
  route("GET", "/api/plans/:id/me", async (req, body, ctx) => {
    const p = loadPlan(ctx.params.id);
    const key = req.headers["x-member-key"];
    const r = memberByKey(p.id, key);
    if (!r) throw new HttpError(403, "Not a member of this plan");
    return { name: r.name, enteredByOrganiser: !!r.entered_by_organiser };
  });

  // ---- Right to erasure for friends (DPDP). Authenticated by the member key only their browser holds. ----
  // Deletes the response (start point, budget, choices, reminder number) and their ratings and reminder rows.
  // If picks already exist, their first name is replaced by "A friend" everywhere it was stored (travel lists,
  // reason lines, votes, plan log) so the plan still works and the vote count stays correct.
  route("DELETE", "/api/plans/:id/responses/me", async (req, body, ctx) => {
    const p = loadPlan(ctx.params.id);
    const key = req.headers["x-member-key"];
    const r = memberByKey(p.id, key);
    if (!r) throw new HttpError(403, "This browser has no answers on this plan");
    const name = r.name;
    run("DELETE FROM responses WHERE plan_id = ? AND name = ?", p.id, name);
    run("DELETE FROM ratings WHERE plan_id = ? AND name = ?", p.id, name);
    run("DELETE FROM reminders WHERE plan_id = ? AND recipient = ?", p.id, "r:" + name);

    if (p.picks_json || p.session_json || p.log_json) {
      const taken = new Set(p.session_json ? JSON.parse(p.session_json).members : []);
      let label = "A friend";
      for (let k = 2; taken.has(label); k++) label = `A friend ${k}`;
      const text = (s) => (typeof s === "string" ? s.split(`(${name})`).join(`(${label})`).split(` for ${name}`).join(` for ${label}`).split(`without ${name}`).join(`without ${label}`) : s);
      const fixPick = (pk) => pk && ({ ...pk, travel: (pk.travel || []).map((t) => (t.name === name ? { ...t, name: label } : t)), reason: text(pk.reason), tradeoffs: (pk.tradeoffs || []).map(text), notes: (pk.notes || []).map(text), broken: pk.broken && pk.broken.map((b) => ({ ...b, detail: text(b.detail) })) });
      const renameKeys = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k === name ? label : k, v]));
      const upd = {};
      if (p.picks_json) {
        const s = JSON.parse(p.picks_json);
        upd.picks_json = JSON.stringify({ ...s, picks: s.picks.map(fixPick), reserve: s.reserve.map(fixPick), nearMisses: (s.nearMisses || []).map(fixPick), notes: (s.notes || []).map(text) });
      }
      if (p.session_json) {
        const s = JSON.parse(p.session_json);
        upd.session_json = JSON.stringify({ ...s, members: s.members.map((m) => (m === name ? label : m)), shown: s.shown.map(fixPick), reserve: s.reserve.map(fixPick), votes: renameKeys(s.votes), vetoes: renameKeys(s.vetoes), events: (s.events || []).map((e) => (e.member === name ? { ...e, member: label } : e)) });
      }
      if (p.winner_json) {
        const w = JSON.parse(p.winner_json);
        upd.winner_json = JSON.stringify({ ...w, pick: fixPick(w.pick) });
      }
      if (p.log_json) {
        const l = JSON.parse(p.log_json);
        l.inputs.members = l.inputs.members.map((m) => (m.name === name ? { name: label, deleted: true } : m)); // budget and location gone
        l.inputs.unanswered = (l.inputs.unanswered || []).map((u) => (u.name === name ? { name: label } : u));
        upd.log_json = JSON.stringify(l);
      }
      for (const [col, val] of Object.entries(upd)) run(`UPDATE plans SET ${col} = ? WHERE id = ?`, val, p.id);
      // Events that named them.
      for (const e of all("SELECT id, payload FROM events WHERE plan_id = ?", p.id)) {
        const pl = JSON.parse(e.payload || "{}");
        if (pl.by === name) run("UPDATE events SET payload = ? WHERE id = ?", JSON.stringify({ ...pl, by: label }), e.id);
      }
    }
    // The friends list the organiser typed keeps the name (the organiser wrote it), but it no longer counts as answered.
    logEvent(p.id, "response_deleted", {});
    return { deleted: true };
  });

  route("POST", "/api/plans/:id/picks", async (req, body, ctx) => {
    const p = loadPlan(ctx.params.id);
    if (authPhone(req) !== p.organiser_phone) throw new HttpError(403, "Organiser only");
    if (!["open", "no_picks"].includes(p.status)) throw new HttpError(409, "Picks already generated");
    const need = p.data.mode === "couple" ? 1 : 2;
    if (responsesOf(p.id).length < need) throw new HttpError(409, need === 1 ? "Your partner needs to answer first" : "Need 2+ friends to answer first");
    let changed = false;
    if (body.travelLimitMin) {
      p.data.travelLimitMin = Number(body.travelLimitMin);
      changed = true;
    }
    if (p.data.mode === "couple" && ("noise" in body || "ambience" in body)) { // loosen filters after "no place fits"
      if (body.noise && !NOISE.includes(body.noise)) throw bad("Unknown noise level");
      p.data.filters = { maxNoise: body.noise || null, ambience: pickMany(body.ambience, MOODS, "ambience") };
      changed = true;
    }
    if (changed) run("UPDATE plans SET data = ? WHERE id = ?", JSON.stringify(p.data), p.id);
    await generate(p, "early");
    return publicPicks(loadPlan(p.id), p.organiser_name);
  });

  route("GET", "/api/plans/:id/picks", async (req, body, ctx) => {
    const p = await tick(loadPlan(ctx.params.id));
    return publicPicks(p, viewerName(req, p));
  });

  const voteAction = (kind) => async (req, body, ctx) => {
    let p = await tick(loadPlan(ctx.params.id));
    if (p.status !== "voting") throw new HttpError(409, "Voting is not open");
    const who = identity(req, body, p);
    let s = JSON.parse(p.session_json);
    try {
      s = kind === "vote" ? vote(s, who.name, body.pickId) : veto(s, who.name, body.pickId);
    } catch (e) {
      throw new HttpError(409, e.message);
    }
    run("UPDATE plans SET session_json = ? WHERE id = ?", JSON.stringify(s), p.id);
    // PRD open question: "should a veto ask for a reason?" Optional, never shown to the group, used for tuning.
    const reason = kind === "veto" && VETO_REASONS.includes(body.reason) ? body.reason : undefined;
    logEvent(p.id, kind === "vote" ? "vote_cast" : "pick_vetoed", { by: who.name, pickId: body.pickId, ...(reason ? { reason } : {}) });
    if (isComplete(s)) finish(p, s, "all_voted");
    return publicPicks(loadPlan(p.id), who.name);
  };
  route("POST", "/api/plans/:id/votes", voteAction("vote"));
  route("POST", "/api/plans/:id/vetoes", voteAction("veto"));

  route("POST", "/api/plans/:id/decide", async (req, body, ctx) => {
    const p = loadPlan(ctx.params.id);
    if (authPhone(req) !== p.organiser_phone) throw new HttpError(403, "Organiser only");
    if (p.status !== "voting") throw new HttpError(409, "Voting is not open");
    // A hidden organiser must not be able to close, override or probe the choice before the day.
    if (isHidden(p, p.organiser_name)) throw new HttpError(403, "Your partner is choosing. The surprise stays hidden until the day.");
    let s = JSON.parse(p.session_json);
    if (body.overridePickId) {
      let o;
      try {
        o = override(s, p.organiser_name, body.overridePickId);
      } catch (e) {
        throw bad(e.message);
      }
      s = o.session;
      logEvent(p.id, "organiser_override", { pickId: body.overridePickId });
      finish(p, s, "override", { winner: o.winner, counts: {}, overridden: true });
    } else finish(p, s, "organiser_closed");
    return publicPicks(loadPlan(p.id), p.organiser_name);
  });

  route("POST", "/api/plans/:id/ratings", async (req, body, ctx) => {
    const p = loadPlan(ctx.params.id);
    if (p.status !== "decided") throw new HttpError(409, "Plan has no winner yet");
    // F11 is a post-visit check: "did you go" only makes sense once the plan's time has come.
    if (now() < p.plan_at) throw new HttpError(409, "Tell us how it was after the meal");
    const who = identity(req, body, p);
    if (!WENT.includes(body.went)) throw bad("went must be yes, no or elsewhere");
    const stars = body.stars == null ? null : Number(body.stars);
    if (stars != null && !(Number.isInteger(stars) && stars >= 1 && stars <= 5)) throw bad("stars must be 1-5");
    run("INSERT OR REPLACE INTO ratings (plan_id, name, went, stars, created) VALUES (?,?,?,?,?)", p.id, who.name, body.went, stars, now());
    // The organiser went to a place on their want-to-try list: it moves to been-there.
    if (who.organiser && body.went === "yes" && p.winner_json) {
      const wid = JSON.parse(p.winner_json).pick?.id;
      if (wid && placeStatus(p.organiser_phone, wid) === "want") run("UPDATE user_places SET status = 'been', at = ? WHERE phone = ? AND restaurant_id = ?", now(), p.organiser_phone, wid);
    }
    // PRD events: visit_reported for "did you go", rating_submitted only when stars were given.
    logEvent(p.id, "visit_reported", { went: body.went });
    if (stars != null) logEvent(p.id, "rating_submitted", { stars });
    return { saved: true };
  });

  // Admin (A2 plan log + metrics). Disabled unless ADMIN_KEY is set.
  const requireAdmin = (req) => {
    if (!adminKey || !safeEq(req.headers["x-admin-key"] || "", adminKey)) throw new HttpError(403, "Forbidden");
  };
  route("GET", "/api/admin/plans/:id/log", async (req, body, ctx) => {
    requireAdmin(req);
    const p = loadPlan(ctx.params.id);
    return { log: p.log_json ? JSON.parse(p.log_json) : null, events: all("SELECT type, payload, at FROM events WHERE plan_id = ? ORDER BY id", p.id), ratings: all("SELECT name, went, stars FROM ratings WHERE plan_id = ?", p.id) };
  });
  route("GET", "/api/admin/weights", async (req) => {
    requireAdmin(req);
    return { weights: getWeights() };
  });
  route("PUT", "/api/admin/weights", async (req, body) => {
    requireAdmin(req);
    const w = {};
    for (const k of WEIGHT_KEYS) {
      const v = body[k] === undefined ? getWeights()[k] : Number(body[k]);
      if (!(v >= 0 && v <= 5)) throw bad(`${k} must be a number from 0 to 5`);
      w[k] = v;
    }
    if (Object.keys(body).some((k) => !WEIGHT_KEYS.includes(k))) throw bad(`Weights are ${WEIGHT_KEYS.join(", ")}`);
    if (!Object.values(w).some((v) => v > 0)) throw bad("At least one weight must be above 0");
    run("INSERT OR REPLACE INTO settings (key, value, at) VALUES ('weights', ?, ?)", JSON.stringify(w), now());
    logEvent(null, "weights_changed", w);
    return { weights: w };
  });

  // Weekly curation review: "closed or changed?" reports grouped by restaurant.
  route("GET", "/api/admin/reports", async (req, body, ctx) => {
    requireAdmin(req);
    const days = Math.min(365, Math.max(1, Number(ctx.query.get("days")) || 7));
    const rows = all("SELECT restaurant_id, kind, note, at FROM place_reports WHERE at >= ? ORDER BY at DESC", now() - days * 86400000);
    const by = {};
    for (const r of rows) {
      const g = (by[r.restaurant_id] = by[r.restaurant_id] || { restaurantId: r.restaurant_id, name: (restaurants.find((x) => x.id === r.restaurant_id) || {}).name || null, total: 0, closed: 0, changed: 0, other: 0, notes: [], last: r.at });
      g.total++; g[r.kind]++;
      if (r.note) g.notes.push(r.note);
    }
    return { days, places: Object.values(by).sort((a, b) => b.total - a.total) };
  });

  route("GET", "/api/admin/metrics", async (req) => {
    requireAdmin(req);
    return computeMetrics();
  });

  // PRD section 9, metric by metric. Each one reports value, numerator, denominator, target and definition.
  function computeMetrics() {
    const t = now();
    const DAY = 86400000;
    const evs = all("SELECT plan_id, type, payload, at FROM events WHERE plan_id IS NOT NULL ORDER BY id").map((e) => ({ ...e, payload: JSON.parse(e.payload || "{}") }));
    const plans = all("SELECT id, organiser_phone, status, created, plan_at, winner_json FROM plans");
    const of = (type) => evs.filter((e) => e.type === type);
    const firstAt = (planId, type) => { const e = evs.find((x) => x.plan_id === planId && x.type === type); return e ? e.at : null; };
    const metric = (num, den, target, definition, extra = {}) => ({ value: den ? num / den : null, numerator: num, denominator: den, target, definition, ...extra });
    const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

    // Plan completion: plans that reach a chosen winner / plans shared.
    const shared = plans.filter((p) => firstAt(p.id, "plan_shared") !== null);
    const completed = shared.filter((p) => p.status === "decided");

    // Friend response rate: friends who submit / friends who open the link (matched by random browser id).
    const opened = new Set(of("link_opened").map((e) => e.payload.cid).filter(Boolean));
    const submitted = new Set(of("response_submitted").map((e) => e.payload.cid).filter(Boolean));
    const responded = [...opened].filter((c) => submitted.has(c)).length;
    const abandons = of("response_abandoned").filter((e) => !e.payload.cid || !submitted.has(e.payload.cid));
    const lastField = abandons.reduce((m, e) => ((m[e.payload.lastField] = (m[e.payload.lastField] || 0) + 1), m), {});

    // Time to decision: median minutes from the link being shared to the winner.
    const minutes = plans.map((p) => {
      const s = firstAt(p.id, "plan_shared"), w = firstAt(p.id, "winner_decided");
      return s !== null && w !== null && w >= s ? (w - s) / 60000 : null;
    }).filter((x) => x !== null);

    // Visit rate (H3): decided plans whose time has passed, where most members say they went.
    const pastDecided = plans.filter((p) => p.status === "decided" && p.plan_at < t);
    const visited = pastDecided.filter((p) => {
      const members = q("SELECT COUNT(*) n FROM responses WHERE plan_id = ?", p.id).n + 1; // + organiser
      const yes = q("SELECT COUNT(*) n FROM ratings WHERE plan_id = ? AND went = 'yes'", p.id).n;
      return yes > members / 2;
    });

    // Return rate (H4): organisers who start another plan within 30 days of their first decided plan.
    const byOrg = {};
    for (const p of [...plans].sort((a, b) => a.created - b.created)) (byOrg[p.organiser_phone] = byOrg[p.organiser_phone] || []).push(p);
    let eligible = 0, returned = 0;
    for (const list of Object.values(byOrg)) {
      const first = list.find((p) => p.status === "decided");
      if (!first) continue;
      const again = list.some((p) => p.created > first.created && p.created <= first.created + 30 * DAY);
      if (again) { returned++; eligible++; } else if (t - first.created >= 30 * DAY) eligible++; // window still open: not counted yet
    }

    // Pick satisfaction, veto/override rate, share at partners.
    const stars = q("SELECT COUNT(*) n, AVG(stars) avg FROM ratings WHERE stars IS NOT NULL");
    const shown = of("picks_generated").reduce((n, e) => n + (e.payload.picks || []).length, 0) + of("pick_vetoed").length; // each veto shows a replacement
    const vetoOverride = of("pick_vetoed").length + of("organiser_override").length;
    const partnerVisits = visited.filter((p) => { const w = p.winner_json ? JSON.parse(p.winner_json).pick : null; return w && w.partner; }).length;

    return {
      asOf: new Date(t).toISOString(),
      planCompletion: metric(completed.length, shared.length, ">= 0.70", "Plans that reach a chosen winner / plans shared (organiser tapped Share or Copy link)"),
      friendResponseRate: metric(responded, opened.size, ">= 0.60", "Friends who submit the form / friends who open the link (distinct browsers)", { abandoned: abandons.length, abandonedAtField: lastField }),
      timeToDecisionMinutes: { value: median(minutes), plans: minutes.length, target: "< 30", definition: "Median minutes from link shared to winner" },
      visitRate: metric(visited.length, pastDecided.length, ">= 0.50", "Decided plans whose time has passed where most members say they went / those plans (H3)"),
      returnRate: metric(returned, eligible, ">= 0.30", "Organisers who start another plan within 30 days of their first decided plan / organisers whose 30 days are up (H4). \"Unprompted\" cannot be measured."),
      pickSatisfaction: { value: stars.avg, ratings: stars.n, target: ">= 4", definition: "Average post-visit rating (1-5)" },
      vetoOverrideRate: metric(vetoOverride, shown, "watch", "Vetoed picks and organiser overrides / picks shown", {
        vetoReasons: of("pick_vetoed").reduce((m, e) => ((m[e.payload.reason || "none given"] = (m[e.payload.reason || "none given"] || 0) + 1), m), {}),
      }),
      shareAtPartners: metric(partnerVisits, visited.length, "watch", "Visits at partner places / all visits"),
      newOrganisersPerPlan: { value: null, target: "watch", definition: "Friends who later start their own plan", note: "Not measurable: friends have no account, so a friend who later signs up cannot be linked to the plan they answered." },
    };
  }

  // ---------- pages ----------
  const readPage = (f) => readFileSync(join(here, f), "utf8");
  const pages = {
    friend: async (ctx) => {
      const p = loadPlan(ctx.params.id);
      const title = `${p.data.occasion} on ${p.data.date}`;
      return readPage("public/friend.html")
        .replaceAll("__TITLE__", esc(title))
        .replaceAll("__DESC__", esc(`${p.organiser_name} is planning dinner. Answer in 30 seconds, no sign-in.`));
    },
  };

  const handler = async (req, res) => {
    const started = Date.now();
    const origin = `http://${req.headers.host}`;
    const ip = clientIp(req, trustProxy);
    let pathname = "?";
    const send = (status, body, type = "application/json") => {
      const html = type === "text/html";
      res.writeHead(status, {
        "content-type": type + "; charset=utf-8",
        "cache-control": "no-store",
        ...baseHeaders({ hsts }),
        ...(html ? { "content-security-policy": cspFor(body) } : { "content-security-policy": "default-src 'none'; frame-ancestors 'none'" }),
      });
      res.end(html ? body : JSON.stringify(body));
      if (accessLog) accessLog(accessLine(req.method, pathname, status, Date.now() - started));
    };
    try {
      const url = new URL(req.url, origin);
      pathname = url.pathname;
      // Liveness/readiness for the container and the proxy: touches the database, reveals nothing.
      if (req.method === "GET" && url.pathname === "/healthz") {
        q("SELECT 1 x");
        return send(200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/") return send(200, readPage("public/organiser.html"), "text/html");
      if (req.method === "GET" && url.pathname === "/privacy") return send(200, readPage("public/privacy.html"), "text/html");
      if (req.method === "GET" && url.pathname === "/prototype" && servePrototype) return send(200, readFileSync(join(here, "..", "prototype", "index.html"), "utf8"), "text/html");
      const pm = /^\/p\/([\w-]+)$/.exec(url.pathname);
      if (req.method === "GET" && pm) return send(200, await pages.friend({ params: { id: pm[1] } }), "text/html");
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        let body = {};
        if (req.method === "POST" || req.method === "PUT") {
          const chunks = [];
          let size = 0;
          for await (const c of req) {
            size += c.length;
            if (size > 100_000) throw new HttpError(413, "Body too large");
            chunks.push(c);
          }
          try {
            body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
          } catch {
            throw bad("Invalid JSON");
          }
        }
        return send(200, await r.fn(req, body, { params: m.groups || {}, query: url.searchParams, origin, ip }));
      }
      throw new HttpError(404, "Not found");
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      return send(500, { error: "Something went wrong" });
    }
  };

  // Tight timeouts: a slow or stalled client can't hold connections open (slowloris).
  const server = () => {
    const s = http.createServer(handler);
    s.requestTimeout = 15000;
    s.headersTimeout = 10000;
    s.keepAliveTimeout = 5000;
    return s;
  };
  return { handler, runReminders, hasReminders: !!sendReminder, server };
}
