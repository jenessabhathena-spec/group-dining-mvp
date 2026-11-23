// Start-point search (F5: "pin or area search").
//
// The Google key stays on the server: browsers call our /api/places/*, never Google. With no key (or if Google
// fails) search falls back to a built-in list of Bengaluru areas, so the form always works.
//
// Verified against Google's docs (Places API (New)): POST places:autocomplete with X-Goog-Api-Key, body
// {input, sessionToken, includedRegionCodes, locationRestriction.rectangle{low,high}}; response
// suggestions[].placePrediction{placeId, text.text, structuredFormat.mainText/secondaryText}; GET places/{id}
// with X-Goog-FieldMask. NOT spelled out in the docs, so assumed (see the tests that pin them):
//   - the session token on Place Details is the `sessionToken` query parameter
//   - Place Details returns location as {latitude, longitude}
// A session = Autocomplete calls then ONE Details call with the same token; reusing a token bills each call.

export const BENGALURU = { low: { latitude: 12.7, longitude: 77.3 }, high: { latitude: 13.3, longitude: 77.9 } };
export class PlacesError extends Error {}

const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

export const inBengaluru = (lat, lng) =>
  typeof lat === "number" && typeof lng === "number" &&
  lat >= BENGALURU.low.latitude && lat <= BENGALURU.high.latitude && lng >= BENGALURU.low.longitude && lng <= BENGALURU.high.longitude;

// ~110 m. Travel times do not need a doorstep, and a precise home location is more than we should keep.
export const roundCoord = (x) => Math.round(x * 1000) / 1000;

export function makePlaces({ apiKey, fetchImpl = globalThis.fetch, areas }) {
  const names = Object.keys(areas);

  const local = (q) => {
    const s = q.trim().toLowerCase();
    return names.filter((n) => n.toLowerCase().includes(s)).map((n) => ({ id: "area:" + n, label: n, secondary: "Bengaluru" }));
  };

  async function google(url, init) {
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch {
      throw new PlacesError("Places service unreachable");
    }
    if (!res.ok) throw new PlacesError(`Places service error (${res.status})`);
    try {
      return await res.json();
    } catch {
      // A 200 we cannot read is an upstream fault, not "no results": let the caller fall back.
      throw new PlacesError("Places service returned an unreadable response");
    }
  }

  return {
    hasGoogle: !!apiKey,

    async search(q, token) {
      if (!apiKey) return { source: "local", results: local(q) };
      try {
        const body = await google("https://places.googleapis.com/v1/places:autocomplete", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Goog-Api-Key": apiKey },
          body: JSON.stringify({
            input: q,
            ...(TOKEN_RE.test(token || "") ? { sessionToken: token } : {}),
            includedRegionCodes: ["in"],
            locationRestriction: { rectangle: BENGALURU },
          }),
        });
        const results = (body.suggestions || [])
          .map((s) => s.placePrediction)
          .filter((p) => p && PLACE_ID_RE.test(p.placeId || ""))
          .map((p) => ({
            id: p.placeId,
            label: (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) || (p.text && p.text.text) || "",
            secondary: (p.structuredFormat && p.structuredFormat.secondaryText && p.structuredFormat.secondaryText.text) || "",
          }))
          .filter((r) => r.label);
        return { source: "google", results };
      } catch {
        // Fail soft: the form keeps working on the built-in areas.
        return { source: "local", results: local(q), degraded: true };
      }
    },

    async details(id, token) {
      if (id.startsWith("area:")) {
        const a = areas[id.slice(5)];
        if (!a) throw new PlacesError("Unknown area");
        return { lat: roundCoord(a.lat), lng: roundCoord(a.lng), label: id.slice(5) };
      }
      if (!apiKey) throw new PlacesError("Address search is not configured");
      if (!PLACE_ID_RE.test(id)) throw new PlacesError("Bad place id");
      const url = new URL("https://places.googleapis.com/v1/places/" + encodeURIComponent(id));
      if (TOKEN_RE.test(token || "")) url.searchParams.set("sessionToken", token);
      const body = await google(url, { headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "location,displayName,formattedAddress" } });
      const loc = body.location;
      if (!loc || typeof loc.latitude !== "number" || typeof loc.longitude !== "number") throw new PlacesError("Place has no location");
      return { lat: roundCoord(loc.latitude), lng: roundCoord(loc.longitude), label: (body.displayName && body.displayName.text) || "Selected place" };
    },
  };
}
