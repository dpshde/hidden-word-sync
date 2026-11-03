// A bible-rs device's study, kept by the adapter in its own state: every record bible-rs syncs
// (highlights, notes, bookmarks, plans, ticked passages), exactly as bible-rs writes them, and
// merged by bible-rs's rules. Ports crates/core/src/sync.rs and StudyStore::merge (study.rs),
// sync mode, from bible-rs PR #80/#81.
//
// state: { device, clock, seq, entries: { key: { g: group, c: change, s: seq } } }

const te = new TextEncoder();
export const GROUPS = ["highlights", "notes", "bookmarks", "plans", "plan_reads"];
/** How far ahead of the clock a stamp may be and still move it (MAX_DRIFT_MS). */
const MAX_DRIFT_MS = 24 * 3600 * 1000;
/** How many superseded versions a note remembers (NOTE_HISTORY). */
const NOTE_HISTORY = 32;

function compareBytes(a, b) {
  const x = te.encode(a);
  const y = te.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** A stamp: when (Unix ms, from a hybrid logical clock) and on which device. */
export const stampOf = (c) => ({ updated_ms: Number.isSafeInteger(c?.updated_ms) ? c.updated_ms : 0, device: typeof c?.device === "string" ? c.device : "" });
/** Stamps in bible-rs's order: time, then device id. */
export const compareStamps = (a, b) => a.updated_ms - b.updated_ms || compareBytes(a.device, b.device);
const same = (a, b) => a.updated_ms === b.updated_ms && a.device === b.device;

/** The key a change is stored under. */
export function keyOf(g, c) {
  if (g === "plans") return `plans:${c.id}`;
  if (g === "plan_reads") return `plan_reads:${c.plan}/${c.day}/${c.passage}`;
  return `${g}:${c.book}.${c.chapter}.${c.verse}`;
}

export const emptyStudy = (device) => ({ device, clock: 0, seq: 0, entries: {} });

/** The next stamp's time for a change made at `wall` (ms): never at or behind one given out or seen. */
export function tick(st, wall) {
  st.clock = Math.max(wall, st.clock + 1);
  return st.clock;
}

function observe(st, changes) {
  const limit = Date.now() + MAX_DRIFT_MS;
  for (const g of GROUPS) for (const c of changes[g] ?? []) if (stampOf(c).updated_ms <= limit) st.clock = Math.max(st.clock, stampOf(c).updated_ms);
}

export function put(st, g, c) {
  st.entries[keyOf(g, c)] = { g, c, s: ++st.seq };
}

const get = (st, g, c) => st.entries[keyOf(g, c)]?.c;

// ---- notes (sync.rs: NoteVersion, merge_note)

function version(c) {
  return {
    stamp: stampOf(c),
    live: !c.deleted,
    base: { updated_ms: c.base_updated ?? 0, device: c.base_device ?? "" },
    seen: (c.seen ?? []).map(stampOf),
  };
}
const hasSeen = (v, t) => same(t, v.stamp) || (t.updated_ms !== 0 && same(t, v.base)) || v.seen.some((s) => same(s, t));
function newestFirst(stamps) {
  const out = [...stamps].sort((a, b) => compareStamps(b, a));
  return out.filter((t, i) => i === 0 || !same(t, out[i - 1])).slice(0, NOTE_HISTORY);
}
const ancestors = (v) => newestFirst([v.base, ...v.seen].filter((t) => t.updated_ms !== 0));
function absorb(v, others) {
  const extra = [...others].filter((t) => t.updated_ms !== 0 && !same(t, v.stamp) && !same(t, v.base));
  return { ...v, seen: newestFirst([...v.seen, ...extra]) };
}
/** The version an edit of `prev` makes. */
export const edited = (prev, stamp, live) => absorb({ stamp, live, base: prev.stamp, seen: [] }, ancestors(prev));

function history(v) {
  const f = {};
  if (v.base.updated_ms) f.base_updated = v.base.updated_ms;
  if (v.base.device) f.base_device = v.base.device;
  if (v.seen.length) f.seen = v.seen;
  return f;
}

function mergeNote(l, r, sameBody) {
  if (!l) return { pick: "remote", v: r, copy: null };
  if (same(l.stamp, r.stamp)) {
    const v = absorb(l, ancestors(r));
    return { pick: JSON.stringify(v.seen) === JSON.stringify(l.seen) ? "local" : "absorb", v, copy: null };
  }
  if (hasSeen(l, r.stamp)) return { pick: "local", v: l, copy: null };
  if (hasSeen(r, l.stamp)) return { pick: "remote", v: absorb(r, ancestors(l)), copy: null };
  const remoteWins = compareStamps(r.stamp, l.stamp) > 0;
  const [winner, loser] = remoteWins ? [r, l] : [l, r];
  const v = absorb(winner, [...ancestors(loser), loser.stamp]);
  return { pick: remoteWins ? "remote" : "absorb", v, copy: loser.live && !(winner.live && sameBody) ? remoteWins : null };
}

const copy = (k) => ({ body: k.body ?? "", updated_ms: k.updated_ms ?? 0, device: k.device ?? "", found: k.found ?? 0 });

/** A note as bible-rs writes it: `base` is the record's place, `v` its version, `note` its text or null. */
function noteChange(base, v, note, conflicts) {
  const { book, chapter, verse } = base;
  const c = { ...base, book, chapter, verse, ...v.stamp };
  for (const k of ["deleted", "base_updated", "base_device", "seen", "conflicts"]) delete c[k];
  Object.assign(c, note ? { body: note.body, created: note.created, updated: note.updated } : { deleted: true, body: "", created: 0, updated: 0 });
  Object.assign(c, history(v));
  if (conflicts.length) c.conflicts = conflicts;
  return c;
}

function mergeNoteChange(st, c, found) {
  const local = get(st, "notes", c);
  const l = local ? version(local) : null;
  const r = version(c);
  const localBody = local && !local.deleted ? local.body : null;
  const m = mergeNote(l, r, (localBody ?? "") === (c.body ?? ""));
  const here = (local?.conflicts ?? []).map(copy);
  const theirs = (c.conflicts ?? []).map(copy);
  const unseen = (by, copies) => copies.filter((k) => !hasSeen(by, stampOf(k)));
  const followsOn = !l || hasSeen(r, l.stamp);
  let copies =
    m.pick === "local" ? (l ? [...here, ...unseen(l, theirs)] : here) :
    m.pick === "remote" && followsOn ? [...theirs, ...unseen(r, here)] :
    [...here, ...theirs];
  const lost = m.copy === true && localBody !== null ? { body: localBody, ...l.stamp, found } : m.copy === false ? { body: c.body ?? "", ...r.stamp, found } : null;
  if (lost) copies.push(lost);
  copies = copies.sort(compareStamps).filter((k, i, all) => i === 0 || !same(k, all[i - 1]));
  const held = copies.map(stampOf);
  const changedCopies = JSON.stringify(copies) !== JSON.stringify(here);
  let { pick, v } = m;
  if (pick === "local") {
    if (!(changedCopies || held.some((t) => !hasSeen(l, t)))) return false;
    pick = "absorb";
  }
  v = absorb(v, held);
  if (pick === "absorb") {
    put(st, "notes", noteChange(local, v, localBody === null ? null : local, copies));
    return true;
  }
  const lc = localBody !== null ? local.created : 0;
  const rc = c.created ?? 0;
  const created = lc > 0 && (rc === 0 || lc < rc) ? lc : rc > 0 ? rc : found;
  const note = v.live ? { body: c.body ?? "", created, updated: c.updated > 0 ? c.updated : Math.floor(v.stamp.updated_ms / 1000) } : null;
  put(st, "notes", noteChange(c, v, note, copies));
  return true;
}

// ---- the rest (study.rs: merge_records)

/** A highlight change as bible-rs stores it: parts by start, one per start, a quote only on part of a verse. */
function normalHighlight(c) {
  const parts = (c.deleted ? [] : (c.parts ?? []))
    .map((p) => {
      const q = { ...p, start: p.start ?? 0 };
      if (q.quote === null || (q.start === 0 && (q.end === undefined || q.end === null))) delete q.quote;
      if (q.end === null) delete q.end;
      return q;
    })
    .sort((a, b) => a.start - b.start)
    .filter((p, i, all) => i === 0 || p.start !== all[i - 1].start);
  const out = { ...c };
  delete out.parts;
  delete out.deleted;
  return parts.length ? { ...out, parts } : { ...out, deleted: true };
}

const wins = (local, c) => !local || compareStamps(stampOf(c), stampOf(local)) > 0;

function unread(st, plan, stamp, only) {
  const reads = Object.values(st.entries).filter((e) => e.g === "plan_reads" && e.c.plan === plan && !e.c.deleted && only(e.c));
  reads.sort((a, b) => a.c.day - b.c.day || a.c.passage - b.c.passage);
  for (const e of reads) put(st, "plan_reads", { ...e.c, ...stamp, deleted: true });
}

/** Takes in another device's changes. Returns the keys that changed. */
export function merge(st, changes, found = Math.floor(Date.now() / 1000)) {
  observe(st, changes);
  const changed = new Set();
  const done = (g, c) => changed.add(keyOf(g, c));
  for (const c of changes.highlights ?? []) {
    if (!wins(get(st, "highlights", c), c)) continue;
    put(st, "highlights", normalHighlight(c));
    done("highlights", c);
  }
  for (const c of changes.notes ?? []) if (mergeNoteChange(st, c, found)) done("notes", c);
  for (const c of changes.bookmarks ?? []) {
    const local = get(st, "bookmarks", c);
    if (!wins(local, c)) continue;
    const l = local && !local.deleted ? local.created : 0;
    const created = l > 0 && (!c.created || l < c.created) ? l : (c.created ?? 0);
    put(st, "bookmarks", c.deleted ? { ...c, label: "", created: 0 } : { ...c, created });
    done("bookmarks", c);
  }
  for (const c of changes.plans ?? []) {
    const local = get(st, "plans", c);
    const localReset = local?.reset_ms ?? 0;
    const reset = Math.max(localReset, c.reset_ms ?? 0);
    const withReset = (p) => {
      const out = { ...p, reset_ms: reset };
      if (!reset) delete out.reset_ms;
      return out;
    };
    if (!wins(local, c)) {
      // A restart elsewhere still forgets the progress before it.
      if (reset > localReset) {
        put(st, "plans", withReset(local));
        unread(st, c.id, { updated_ms: reset, device: st.device }, (r) => stampOf(r).updated_ms < reset);
        done("plans", c);
      }
      continue;
    }
    const plan = c.deleted ? { ...c, started: 0 } : { ...c };
    if (c.deleted) delete plan.finished;
    if (c.deleted) unread(st, c.id, stampOf(c), () => true);
    put(st, "plans", withReset(plan));
    unread(st, c.id, { updated_ms: reset, device: st.device }, (r) => stampOf(r).updated_ms < reset);
    done("plans", c);
  }
  for (const c of changes.plan_reads ?? []) {
    if (stampOf(c).updated_ms < (get(st, "plans", { id: c.plan })?.reset_ms ?? 0)) continue;
    if (!wins(get(st, "plan_reads", c), c)) continue;
    put(st, "plan_reads", { ...c, at: c.at ?? 0 });
    done("plan_reads", c);
  }
  return changed;
}

/**
 * An edit made on this device (in Hidden Word) at `wall` ms: `c` is the verse and what it now says
 * (`parts`, or a note's `body` and `created`/`updated`; `deleted` when gone).
 */
export function edit(st, g, c, wall) {
  const stamp = { updated_ms: tick(st, wall), device: st.device };
  if (g === "highlights") return put(st, g, normalHighlight({ ...c, ...stamp }));
  const local = get(st, g, c);
  const v = local ? edited(version(local), stamp, !c.deleted) : { stamp, live: !c.deleted, base: { updated_ms: 0, device: "" }, seen: [] };
  const note = c.deleted ? null : { body: c.body, created: c.created || local?.created || Math.floor(wall / 1000), updated: c.updated };
  put(st, g, noteChange({ ...(local ?? {}), book: c.book, chapter: c.chapter, verse: c.verse }, v, note, (local?.conflicts ?? []).map(copy)));
}

/** What changed after `since`, but for records stamped by a device in `others`; a note with copies always goes. */
export function changesSince(st, since, others = new Set()) {
  const out = {};
  for (const e of Object.values(st.entries)) {
    if (e.s <= since) continue;
    if (others.has(stampOf(e.c).device) && !(e.g === "notes" && e.c.conflicts?.length)) continue;
    (out[e.g] ??= []).push(e.c);
  }
  // In the order they were made, as bible-rs writes them.
  for (const g of GROUPS) out[g]?.sort((a, b) => compareStamps(stampOf(a), stampOf(b)) || (keyOf(g, a) < keyOf(g, b) ? -1 : 1));
  return out;
}
