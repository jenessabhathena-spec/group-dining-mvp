// Vote and veto (PRD F9). Pure, deterministic: the same inputs always give the same winner.

export function createSession(result, memberNames) {
  return {
    members: [...memberNames],
    shown: result.picks.slice(0, 3),
    reserve: [...result.reserve],
    votes: {}, // member -> pickId
    vetoes: {}, // member -> pickId
    removed: [],
    events: [],
  };
}

const clone = (s) => ({
  ...s,
  shown: [...s.shown],
  reserve: [...s.reserve],
  votes: { ...s.votes },
  vetoes: { ...s.vetoes },
  removed: [...s.removed],
  events: [...s.events],
});

function assertMember(s, member) {
  if (!s.members.includes(member)) throw new Error(`Unknown member: ${member}`);
}

export function vote(s, member, pickId) {
  assertMember(s, member);
  if (member in s.votes) throw new Error(`${member} has already voted`);
  if (!s.shown.some((p) => p.id === pickId)) throw new Error("Pick is not on the table");
  const n = clone(s);
  n.votes[member] = pickId;
  n.events.push({ type: "vote_cast", member, pickId });
  return n;
}

// One veto each. A veto swaps in the next-best pick once; voting does not restart.
export function veto(s, member, pickId) {
  assertMember(s, member);
  if (member in s.vetoes) throw new Error(`${member} has already used their veto`);
  const idx = s.shown.findIndex((p) => p.id === pickId);
  if (idx === -1) throw new Error("Pick is not on the table (already replaced?)");
  const n = clone(s);
  n.vetoes[member] = pickId;
  n.removed.push(pickId);
  const next = n.reserve.shift();
  if (next) n.shown[idx] = next;
  else n.shown.splice(idx, 1);
  // Votes for the removed pick are void; those voters vote again.
  for (const [m, id] of Object.entries(n.votes)) if (id === pickId) delete n.votes[m];
  n.events.push({ type: "pick_vetoed", member, pickId, replacedBy: next ? next.id : null });
  return n;
}

export function isComplete(s, { deadlinePassed = false } = {}) {
  return deadlinePassed || s.members.every((m) => m in s.votes);
}

const tally = (s) => {
  const counts = Object.fromEntries(s.shown.map((p) => [p.id, 0]));
  for (const id of Object.values(s.votes)) if (id in counts) counts[id]++;
  return counts;
};

// Most votes wins; a tie goes to the higher fairness score; then total score; then id.
export function decide(s) {
  const counts = tally(s);
  const ranked = [...s.shown].sort(
    (a, b) =>
      counts[b.id] - counts[a.id] ||
      b.factors.fairness - a.factors.fairness ||
      b.total - a.total ||
      (a.id < b.id ? -1 : 1)
  );
  return { winner: ranked[0] || null, counts, overridden: false };
}

// Organiser may override; allowed but logged (frequent overrides mean the engine is not trusted).
export function override(s, by, pickId) {
  const pool = [...s.shown, ...s.reserve];
  const pick = pool.find((p) => p.id === pickId);
  if (!pick) throw new Error("Unknown pick");
  const was = decide(s).winner;
  const n = clone(s);
  n.events.push({ type: "organiser_override", by, pickId, was: was ? was.id : null });
  return { session: n, winner: pick, overridden: true };
}
