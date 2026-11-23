// Real travel times via Google Distance Matrix, with a cache and the engine's straight-line fallback.
// Engine's travelFn is synchronous, so we run it twice: pass 1 records which (member, restaurant)
// pairs it actually needs (only places that survive the hard filters), then we fetch those, then pass 2.
import { generatePicks, fallbackTravelMinutes } from "../src/engine.js";

const r4 = (x) => Math.round(x * 1e4) / 1e4; // ~11 m: cache key granularity
const keyOf = (a, b, hour) => `${r4(a.lat)},${r4(a.lng)}>${r4(b.lat)},${r4(b.lng)}@${hour}`;

// Next occurrence of `hour` today/tomorrow in IST, as epoch seconds (for departure_time traffic model).
function departureEpoch(hour, now) {
  const ist = new Date(now + 5.5 * 3600000);
  const d = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hour) - 5.5 * 3600000;
  return Math.floor((d > now ? d : d + 86400000) / 1000);
}

async function fetchMatrix({ apiKey, fetchImpl, now }, origin, dests, hour) {
  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", `${origin.lat},${origin.lng}`);
  url.searchParams.set("destinations", dests.map((d) => `${d.lat},${d.lng}`).join("|"));
  url.searchParams.set("departure_time", String(departureEpoch(hour, now)));
  url.searchParams.set("traffic_model", "best_guess");
  url.searchParams.set("key", apiKey);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`maps http ${res.status}`);
  const body = await res.json();
  if (body.status !== "OK") throw new Error(`maps status ${body.status}`);
  return body.rows[0].elements.map((e) => (e.status === "OK" ? Math.round((e.duration_in_traffic || e.duration).value / 60) : null));
}

/**
 * Drop-in for generatePicks that uses real travel times when GOOGLE_MAPS_API_KEY is set.
 * Results are cached (licence terms: check before storing long-term; TTL is configurable).
 */
export async function generatePicksWithMaps(input, { db, apiKey, fetchImpl = globalThis.fetch, now = Date.now(), ttlMs = 7 * 86400000 } = {}) {
  if (!apiKey) return generatePicks(input);
  const hour = Number(input.plan.time.split(":")[0]);
  const wanted = new Map(); // key -> {a,b}
  generatePicks({
    ...input,
    travelFn: (a, b) => {
      wanted.set(keyOf(a, b, hour), { a, b });
      return fallbackTravelMinutes(a, b, hour);
    },
  });

  const cache = new Map();
  const get = db.prepare("SELECT minutes, at FROM travel_cache WHERE key = ?");
  const put = db.prepare("INSERT OR REPLACE INTO travel_cache (key, minutes, at) VALUES (?, ?, ?)");
  const missing = [];
  for (const [key, p] of wanted) {
    const row = get.get(key);
    if (row && now - row.at < ttlMs) cache.set(key, row.minutes);
    else missing.push([key, p]);
  }

  let failed = false;
  // One request per distinct origin, batching its destinations (API limit: 25 per request).
  const byOrigin = new Map();
  for (const [key, p] of missing) {
    const ok = `${r4(p.a.lat)},${r4(p.a.lng)}`;
    if (!byOrigin.has(ok)) byOrigin.set(ok, { origin: p.a, items: [] });
    byOrigin.get(ok).items.push([key, p.b]);
  }
  for (const { origin, items } of byOrigin.values()) {
    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      try {
        const mins = await fetchMatrix({ apiKey, fetchImpl, now }, origin, chunk.map((c) => c[1]), hour);
        chunk.forEach(([key], j) => {
          if (mins[j] != null) {
            cache.set(key, mins[j]);
            put.run(key, mins[j], now);
          }
        });
      } catch {
        failed = true;
      }
    }
  }

  let usedFallback = failed;
  const result = generatePicks({
    ...input,
    travelFn: (a, b) => {
      const v = cache.get(keyOf(a, b, hour));
      if (v != null) return v;
      usedFallback = true;
      return fallbackTravelMinutes(a, b, hour);
    },
  });
  // Honest labelling: if any lookup fell back, say so on the cards (PRD: Reliability).
  if (usedFallback && !result.travelFallback) {
    result.travelFallback = true;
    result.notes.push("Travel times are straight-line estimates");
    for (const p of [...result.picks, ...result.reserve]) p.travelEstimate = true;
  }
  return result;
}
