// How highlight records become the ranges people see, and the records a highlight edit writes.
// The one definition: the vault's list, its WebMCP tools, the remote MCP server and route.bible
// (which vendors this file and checks it against test/ranges-vectors.json) all use it.
//
// Rules:
// - Storage is one record per verse. A range ("run") is back-to-back single verses, in one chapter
//   of one book, that share a color. A gap, a new chapter, or a different color starts a new run, so
//   John 3:16 yellow + 3:17 green are two rows (each row has one color, which its picker edits).
// - A record's color is its newest highlight part's color (topColor); unknown ids read as yellow.
// - A run's time is its newest verse's time (runTime); newest-first lists sort by it, ties keeping
//   canonical order.
// - Deleting is a tombstone per verse ({ kind, ref, deleted: true }). Tombstoned verses aren't live,
//   so a run loses them: deleting a run's middle verse splits it, an end verse shrinks it.
// - A write is stamped like Library.putMany: updated = max(now, the replaced version's updated + 1).
import { compareRefs, splitRef } from "./refs.js";

export const COLORS = ["yellow", "green", "blue", "pink", "purple", "orange"];

/** The color a highlight record shows as: its most recently colored part's, or yellow when unknown. */
export function topColor(record, known = COLORS) {
  let best = record.highlights?.[0];
  for (const h of record.highlights ?? []) if ((h.edited ?? h.created ?? 0) >= (best.edited ?? best.created ?? 0)) best = h;
  return known.includes(best?.color) ? best.color : "yellow";
}

/**
 * When a record was made, in Unix seconds: its newest part's `created`, else its `updated`, else null
 * (a record with no times, which goes in Older).
 */
export function recordTime(record) {
  const created = (record.highlights ?? []).map((h) => h.created).filter(Number.isSafeInteger);
  if (created.length) return Math.max(...created);
  return Number.isSafeInteger(record.updated) ? record.updated : null;
}

/** When a run was made: its newest verse's time, or null when none of its verses has one. */
export function runTime(run) {
  const times = run.records.map(recordTime).filter((t) => t !== null);
  return times.length ? Math.max(...times) : null;
}

/**
 * Groups sorted records into runs of back-to-back single verses in one chapter that share a key
 * (their color), so Romans 5:3, 5:4 and 5:5 read as Romans 5:3–5. Storage stays one record per
 * verse; this is only how the list shows them. Returns [{ ref, records }], ref being the run's label ref.
 */
export function groupRuns(records, keyOf) {
  const runs = [];
  for (const record of records) {
    const r = splitRef(record.ref);
    const last = runs.at(-1);
    const prev = last && splitRef(last.records.at(-1).ref);
    const joins =
      r && prev && r.verse !== null && r.end === null && prev.verse !== null && prev.end === null &&
      r.book === prev.book && r.chapter === prev.chapter && r.verse === prev.verse + 1 &&
      keyOf(record) === last.key;
    if (joins) last.records.push(record);
    else runs.push({ key: keyOf(record), records: [record] });
  }
  return runs.map(({ records: rs }) => {
    if (rs.length === 1) return { ref: rs[0].ref, records: rs };
    const first = splitRef(rs[0].ref);
    return { ref: `${first.code}.${first.chapter}.${first.verse}-${first.verse + rs.length - 1}`, records: rs };
  });
}

/**
 * A verse highlighted in one color, as the add form saves it. A verse already highlighted (`prev`)
 * keeps its other fields and when it was first highlighted; the color counts as an edit.
 */
export function highlightRecord(prev, ref, color, t) {
  const created = prev?.highlights?.length ? Math.min(...prev.highlights.map((h) => h.created ?? t)) : t;
  const part = created === t ? { color, created } : { color, created, edited: t };
  return { ...(prev ?? {}), kind: "highlight", ref, highlights: [part] };
}

/**
 * The records that turn a row's run into a new set of verses, for one putMany. Verses in both stay
 * untouched (left out); verses only in the run are tombstoned, like deleting them; verses only in
 * the new set are highlighted in the run's color. `find(ref)` gives any live record for a verse.
 */
export function editRun(records, verses, color, t, find = () => null) {
  const old = new Set(records.map((r) => r.ref));
  const next = new Set(verses);
  return [
    ...records.filter((r) => !next.has(r.ref)).map((r) => tombstone(r.ref)),
    ...[...next].filter((v) => !old.has(v)).map((v) => highlightRecord(find(v), v, color, t)),
  ];
}

/** A verse's deletion, as the vault writes it. */
export function tombstone(ref) {
  return { kind: "highlight", ref, deleted: true };
}

/** The version a device writes: `record` stamped one second past `prevUpdated` when its clock is behind. */
export function stamp(record, prevUpdated, t) {
  return { ...record, updated: Math.max(t, (prevUpdated ?? 0) + 1) };
}

/** Live single-verse highlight records only (no tombstones, no other kinds). */
export function liveHighlights(records) {
  return records.filter((r) => r && r.kind === "highlight" && r.deleted !== true && splitRef(r.ref)?.verse != null);
}

/**
 * Records (any kinds, tombstones included) → runs in canonical order:
 * [{ ref, verses, color, time, records }]. `known` is the library's color ids.
 */
export function listRanges(records, known = COLORS) {
  const live = liveHighlights(records).sort((a, b) => compareRefs(a.ref, b.ref));
  return groupRuns(live, (r) => topColor(r, known)).map((run) => ({
    ref: run.ref,
    verses: run.records.map((r) => r.ref),
    color: topColor(run.records[0], known),
    time: runTime(run),
    records: run.records,
  }));
}

/** Runs newest first by time; equal times keep their order (canonical). */
export function newestFirst(runs) {
  return runs
    .map((run, i) => ({ run, i, t: run.time ?? runTime(run) ?? -Infinity }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.run);
}
