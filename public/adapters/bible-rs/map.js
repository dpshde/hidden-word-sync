// Between bible-rs's records and Hidden Word's. Only highlights and one-verse notes have a Hidden
// Word kind; everything else bible-rs syncs stays in the adapter's own state.

import { COLORS, checkRecord } from "../../sync.js";
import { splitRef } from "../../refs.js";

const verseRef = (c) => `${c.book}.${c.chapter}.${c.verse}`;

/** A verse bible-rs can hold (u8 chapter and verse), or null. */
function verseOf(ref) {
  const r = splitRef(ref);
  if (!r || r.verse === null || r.end !== null || r.chapter > 255 || r.verse > 255) return null;
  return { book: r.code, chapter: r.chapter, verse: r.verse };
}

/**
 * What a Hidden Word record says, as bible-rs would hold it: `[group, change]` without a stamp, or
 * null when bible-rs has nothing like it (colors, chapter and range notes, other kinds). Colors
 * bible-rs lacks become yellow; a part gets the times bible-rs requires.
 */
export function fromRecord(r) {
  const verse = r.kind === "highlight" || r.kind === "note" ? verseOf(r.ref) : null;
  if (!verse) return null;
  if (r.kind === "highlight") {
    if (r.deleted || !r.highlights?.length) return ["highlights", { ...verse, deleted: true }];
    const parts = r.highlights.map((h) => {
      const created = Number.isSafeInteger(h.created) ? h.created : (r.updated ?? 0);
      const p = { color: COLORS.includes(h.color) ? h.color : "yellow", start: h.start ?? 0 };
      if (h.end !== undefined && h.end !== null) p.end = h.end;
      if (h.quote) p.quote = h.quote;
      return { ...p, created, edited: Number.isSafeInteger(h.edited) ? h.edited : created };
    });
    return ["highlights", { ...verse, parts }];
  }
  if (r.deleted) return ["notes", { ...verse, deleted: true }];
  return ["notes", { ...verse, body: r.body ?? "", created: r.created ?? 0, updated: r.updated ?? 0 }];
}

/** What bible-rs's highlight or note says, as Hidden Word's record fields (no `updated`), or null for other groups. */
export function toRecord(g, c) {
  if (g === "highlights") {
    if (c.deleted || !c.parts?.length) return { kind: "highlight", ref: verseRef(c), deleted: true };
    const highlights = c.parts.map((p) => {
      const h = { color: p.color, created: p.created, edited: p.edited };
      if (p.start) h.start = p.start;
      if (p.end !== undefined && p.end !== null) h.end = p.end;
      if (p.quote) h.quote = p.quote;
      return h;
    });
    return { kind: "highlight", ref: verseRef(c), highlights };
  }
  if (g === "notes") {
    if (c.deleted) return { kind: "note", ref: verseRef(c), deleted: true };
    return { kind: "note", ref: verseRef(c), body: c.body ?? "", created: c.created };
  }
  return null;
}

/** Whether a record and bible-rs's change say the same thing (stamps, history and times aside, but for highlight parts). */
export function sameContent(g, a, b) {
  if (Boolean(a.deleted) !== Boolean(b.deleted)) return false;
  if (a.deleted) return true;
  if (g === "notes") return (a.body ?? "") === (b.body ?? "");
  const parts = (c) => JSON.stringify((c.parts ?? []).map((p) => [p.color, p.start ?? 0, p.end ?? null, p.start || p.end != null ? (p.quote ?? null) : null, p.created, p.edited]).sort((x, y) => x[1] - y[1]));
  return parts(a) === parts(b);
}

const seconds = (s) => (s ? Math.floor(Date.parse(s) / 1000) || undefined : undefined);

/**
 * A bible-rs JSON export (format 1 or 2) → records, for Import. Bookmarks, history, plans and
 * tombstones are left out: an export brought in by hand never deletes. Format 2's stamps
 * (`updated_ms`) count for `updated`, so a later export whose verse lost a part still wins; a note's
 * conflict copies are kept in the record's extension field `x-bible-rs-conflicts`.
 */
export function fromExport(doc) {
  const ref = (e) => `${e.book}.${e.chapter}.${e.verse}`;
  const later = (a, b) => (a === undefined ? b : b === undefined ? a : Math.max(a, b));
  const fromMs = (ms) => (Number.isSafeInteger(ms) && ms > 0 ? Math.floor(ms / 1000) : undefined);
  const verses = new Map();
  for (const h of doc.highlights ?? []) {
    const part = { color: h.color, created: seconds(h.created) };
    if (h.start) part.start = h.start;
    if (h.end !== undefined && h.end !== null) part.end = h.end;
    if (h.quote) part.quote = h.quote;
    if (h.edited) part.edited = seconds(h.edited);
    const v = verses.get(ref(h)) ?? { parts: [], stamp: undefined };
    v.parts.push(part);
    v.stamp = later(v.stamp, fromMs(h.updated_ms));
    verses.set(ref(h), v);
  }
  const out = [];
  for (const [r, { parts: highlights, stamp }] of verses) {
    out.push({ kind: "highlight", ref: r, updated: later(stamp, Math.max(...highlights.map((h) => h.edited ?? h.created ?? 0))), highlights });
  }
  for (const n of doc.notes ?? []) {
    const note = { kind: "note", ref: ref(n), updated: later(seconds(n.updated), fromMs(n.updated_ms)), created: seconds(n.created), body: n.note };
    const copies = (n.conflicts ?? []).filter((c) => typeof c?.body === "string");
    if (copies.length) note["x-bible-rs-conflicts"] = copies.map((c) => ({ body: c.body, updated: fromMs(c.updated_ms), device: c.device || undefined }));
    out.push(note);
  }
  return out.filter((r) => !checkRecord(r));
}
