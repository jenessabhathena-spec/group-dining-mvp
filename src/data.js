// SAMPLE DATA ONLY. Restaurant names are fictional placeholders so nothing here is mistaken for real
// listings. Replace with the curated 50-100 place list from the curation tool (A1).

export const AREAS = {
  Koramangala: { lat: 12.9352, lng: 77.6245 },
  "HSR Layout": { lat: 12.9116, lng: 77.6474 },
  Indiranagar: { lat: 12.9784, lng: 77.6408 },
  Domlur: { lat: 12.9609, lng: 77.6387 },
  "BTM Layout": { lat: 12.9166, lng: 77.6101 },
  Jayanagar: { lat: 12.925, lng: 77.5938 },
  Marathahalli: { lat: 12.9569, lng: 77.7011 },
};

const loc = (area, dLat = 0, dLng = 0) => ({
  area,
  lat: AREAS[area].lat + dLat,
  lng: AREAS[area].lng + dLng,
});

const h = (open, close) => ({ open, close });
// Same hours every day except one closed day (weekly format, see isOpen in engine.js).
const closedOn = (day, open, close) => ({
  weekly: Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, d === day ? [] : [[open, close]]])),
});

export const RESTAURANTS = [
  { id: "r01", name: "Sample Tandoor House", ...loc("Koramangala", 0.002, 0.003), pricePerHead: 900, cuisines: ["north-indian", "mughlai"], dietOptions: ["veg", "non-veg"], vibes: ["lively", "chill"], maxGroup: 10, alcohol: "serves", noise: "medium", hours: h("12:00", "23:30"), partner: true, rating: 4.2 },
  { id: "r02", name: "Sample Dosa Lane", ...loc("Koramangala", -0.004, 0.001), pricePerHead: 350, cuisines: ["south-indian"], dietOptions: ["veg", "vegan", "jain"], vibes: ["quick", "chill"], maxGroup: 8, alcohol: "none", noise: "medium", hours: h("07:00", "22:30"), partner: false, rating: 4.4 },
  { id: "r03", name: "Sample Noodle Bar", ...loc("Indiranagar", 0.003, -0.002), pricePerHead: 1100, cuisines: ["pan-asian", "japanese"], dietOptions: ["veg", "non-veg"], vibes: ["lively", "fancy"], maxGroup: 8, alcohol: "serves", noise: "loud", hours: h("12:00", "23:00"), partner: false, rating: 4.5 },
  { id: "r04", name: "Sample Wood-fired Pizza", ...loc("Indiranagar", -0.002, 0.004), pricePerHead: 1000, cuisines: ["italian"], dietOptions: ["veg", "non-veg"], vibes: ["chill", "lively"], maxGroup: 12, alcohol: "serves", noise: "medium", hours: h("12:00", "23:30"), partner: true, rating: 4.1 },
  { id: "r05", name: "Sample Thali Kitchen", ...loc("HSR Layout", 0.003, 0.002), pricePerHead: 450, cuisines: ["gujarati", "north-indian"], dietOptions: ["veg", "jain"], vibes: ["quick", "chill"], maxGroup: 12, alcohol: "none", noise: "medium", hours: closedOn("mon", "11:30", "22:30"), partner: false, rating: 4.3 },
  { id: "r06", name: "Sample Brew & Bites", ...loc("HSR Layout", -0.003, -0.003), pricePerHead: 800, cuisines: ["continental", "cafe"], dietOptions: ["veg", "vegan", "non-veg"], vibes: ["chill"], maxGroup: 8, alcohol: "serves", noise: "quiet", hours: h("09:00", "23:00"), partner: false, rating: 4.0 },
  { id: "r07", name: "Sample Biryani Co.", ...loc("Koramangala", 0.005, -0.004), pricePerHead: 600, cuisines: ["hyderabadi", "mughlai"], dietOptions: ["veg", "non-veg"], vibes: ["quick", "lively"], maxGroup: 10, alcohol: "none", noise: "medium", hours: h("11:00", "23:59"), partner: false, rating: 4.2 },
  { id: "r08", name: "Sample Rooftop Grill", ...loc("Indiranagar", 0.006, 0.001), pricePerHead: 1600, cuisines: ["grill", "continental"], dietOptions: ["veg", "non-veg"], vibes: ["fancy", "lively"], maxGroup: 10, alcohol: "bar", noise: "loud", hours: h("17:00", "01:00"), partner: true, rating: 4.4 },
  { id: "r09", name: "Sample Coastal Kitchen", ...loc("HSR Layout", 0.001, 0.006), pricePerHead: 1050, cuisines: ["coastal", "seafood"], dietOptions: ["veg", "non-veg"], vibes: ["chill", "fancy"], maxGroup: 8, alcohol: "serves", noise: "medium", hours: h("12:00", "23:00"), partner: false, rating: 4.3 },
  { id: "r10", name: "Sample Vegan Table", ...loc("Koramangala", -0.001, -0.006), pricePerHead: 750, cuisines: ["vegan", "continental"], dietOptions: ["veg", "vegan", "jain"], vibes: ["chill", "quiet"], maxGroup: 6, alcohol: "none", noise: "quiet", hours: h("10:00", "22:00"), partner: false, rating: 4.1 },
  { id: "r11", name: "Sample Street Chaat Club", ...loc("Indiranagar", -0.005, -0.005), pricePerHead: 300, cuisines: ["street-food", "north-indian"], dietOptions: ["veg", "jain"], vibes: ["quick", "lively"], maxGroup: 10, alcohol: "none", noise: "loud", hours: h("16:00", "23:00"), partner: false, rating: 4.0 },
  { id: "r12", name: "Sample Dim Sum House", ...loc("HSR Layout", -0.005, 0.002), pricePerHead: 950, cuisines: ["chinese", "pan-asian"], dietOptions: ["veg", "non-veg"], vibes: ["lively", "chill"], maxGroup: 10, alcohol: "serves", noise: "medium", hours: h("12:00", "23:00"), partner: false, rating: 4.2 },
  { id: "r13", name: "Sample Late-night Diner", ...loc("Koramangala", 0.004, 0.006), pricePerHead: 650, cuisines: ["american", "cafe"], dietOptions: ["veg", "non-veg"], vibes: ["quick", "lively"], maxGroup: 8, alcohol: "none", noise: "medium", hours: h("18:00", "02:00"), partner: false, rating: 3.9 },
  { id: "r14", name: "Sample Fine Dine South", ...loc("Indiranagar", 0.001, 0.007), pricePerHead: 1800, cuisines: ["south-indian", "kerala"], dietOptions: ["veg", "non-veg"], vibes: ["fancy", "quiet"], maxGroup: 8, alcohol: "serves", noise: "quiet", hours: closedOn("mon", "12:00", "23:00"), partner: false, rating: 4.6 },
];
