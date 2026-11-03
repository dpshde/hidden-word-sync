// Hidden Word reference client (spec v0.2). Needs only WebCrypto and fetch, so it runs in browsers,
// Bun, Node 20+, Deno and Workers.
import { splitRef } from "./refs.js";

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export const COLORS = ["yellow", "green", "blue", "pink", "purple", "orange"];
export const KINDS = ["highlight", "note", "color"];
const COLOR_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAD = 256;
const BATCH = 100;
const FORMAT = 2;
const TIMEOUT_MS = 20_000;
/** How far ahead of this device's clock a stamp may be and still move it (bible-rs's MAX_DRIFT_MS). */
const MAX_DRIFT_MS = 24 * 3600 * 1000;
/** Kinds that carry bible-rs records Hidden Word doesn't show (spec 2.2). */
export const PLAN = "x-bible-rs-plan";
export const PLAN_READ = "x-bible-rs-plan-read";
export const BOOKMARK = "x-bible-rs-bookmark";

export class KeyError extends Error {
  constructor() {
    super("That sync key has a typo.");
  }
}

export class SyncError extends Error {
  constructor(status, body) {
    super(`server answered ${status}${body ? `: ${body}` : ""}`);
    this.status = status;
  }
}

// ---- bytes and primitives

export const now = () => Math.floor(Date.now() / 1000);
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text) {
  const s = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const sha256 = async (bytes) => new Uint8Array(await subtle.digest("SHA-256", bytes));

async function hkdf(ikm, info, length) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

const aesKey = (raw) => subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

/** base64url(nonce ‖ AES-256-GCM(plaintext)), with `aad` bound as associated data. */
async function seal(key, aad, plaintext, nonce = randomBytes(12)) {
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: te.encode(aad) }, key, plaintext));
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce);
  out.set(ct, 12);
  return b64url(out);
}

async function unseal(key, aad, blob) {
  const b = fromB64url(blob);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12), additionalData: te.encode(aad) }, key, b.subarray(12));
  return new Uint8Array(pt);
}

function base32(bytes) {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text) {
  const bytes = [];
  let value = 0;
  let bits = 0;
  for (const ch of text) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return { bytes: Uint8Array.from(bytes), rest: value };
}

// ---- the sync key

export const newKey = () => randomBytes(16);

/** 16 key bytes + 1 check byte (SHA-256(key)[0]) → 28 Crockford base32 chars in groups of 4. */
export async function formatKey(key) {
  const check = (await sha256(key))[0];
  return base32(Uint8Array.of(...key, check)).match(/.{4}/g).join("-");
}

/** Accepts any case, spaces or dashes, and O/I/L for 0/1. Throws KeyError on a typo. */
export async function parseKey(text) {
  const s = String(text).toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^[0-9A-HJKMNP-TV-Z]{28}$/.test(s)) throw new KeyError();
  const { bytes, rest } = unbase32(s);
  const key = bytes.slice(0, 16);
  if (rest !== 0 || bytes.length !== 17 || (await sha256(key))[0] !== bytes[16]) throw new KeyError();
  return key;
}

export async function deriveKeys(key) {
  const [lib, auth, enc, mac] = await Promise.all([
    hkdf(key, "hidden-word/v1/lib", 16),
    hkdf(key, "hidden-word/v1/auth", 32),
    hkdf(key, "hidden-word/v1/enc", 32),
    hkdf(key, "hidden-word/v1/mac", 32),
  ]);
  return {
    lib: hex(lib),
    auth: b64url(auth),
    enc: await aesKey(enc),
    mac: await subtle.importKey("raw", mac, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  };
}

export async function itemId(keys, kind, ref) {
  const mac = new Uint8Array(await subtle.sign("HMAC", keys.mac, te.encode(`${kind} ${ref}`)));
  return b64url(mac).slice(0, 22);
}

/** UTF-8 JSON padded with spaces to a multiple of 256 bytes, so sizes don't reveal note length. */
export function pad(json) {
  const bytes = te.encode(json);
  const out = new Uint8Array(Math.max(PAD, Math.ceil(bytes.length / PAD) * PAD)).fill(0x20);
  out.set(bytes);
  return out;
}

export async function encryptRecord(keys, record, nonce) {
  const id = await itemId(keys, record.kind, record.ref);
  return { id, blob: await seal(keys.enc, id, pad(JSON.stringify(record)), nonce) };
}

/** The record's JSON text as its writer encrypted it, without the padding. */
export async function decryptText(keys, id, blob) {
  return td.decode(await unseal(keys.enc, id, blob)).replace(/ +$/, "");
}

export async function decryptRecord(keys, id, blob) {
  return JSON.parse(await decryptText(keys, id, blob));
}

// ---- records

/** Null when the record is valid, else what's wrong. Unknown fields are always allowed. */
export function checkRecord(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "a record is a JSON object";
  if (typeof r.kind !== "string" || typeof r.ref !== "string") return "kind and ref are required";
  if (r.updated !== undefined && !Number.isSafeInteger(r.updated)) return "updated is a whole number of seconds";
  if (r.kind.startsWith("x-")) return null;
  if (!KINDS.includes(r.kind)) return `unknown kind ${r.kind}`;
  if (r.kind === "color") {
    if (!COLOR_ID.test(r.ref)) return `not a color id: ${r.ref}`;
    if (r.deleted === true) return null;
    if (r.hex !== undefined && !HEX.test(r.hex)) return "hex looks like #RRGGBB";
    if (r.hex === undefined && !COLORS.includes(r.ref)) return "a new color needs a hex";
    if (r.name !== undefined && typeof r.name !== "string") return "a color's name is text";
    return null;
  }
  const ref = splitRef(r.ref);
  if (!ref) return `not a canonical ref: ${r.ref}`;
  if (r.deleted === true) return null;
  if (r.kind === "highlight") {
    if (ref.verse === null || ref.end !== null) return "a highlight's ref is one verse";
    if (!Array.isArray(r.highlights) || !r.highlights.length) return "highlights must be a non-empty list";
    if (r.highlights.some((h) => !h || typeof h.color !== "string")) return "every highlight needs a color";
  }
  if (r.kind === "note" && typeof r.body !== "string") return "a note needs a body";
  return null;
}

/** UTF-8 byte order, as Rust and the spec compare strings. */
function compareBytes(a, b) {
  const x = te.encode(a);
  const y = te.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/**
 * A version's stamp (spec 3): when it changed, in Unix ms, and the device that changed it. A
 * version without `updated_ms`, or whose `updated_ms` doesn't agree with `updated` (an older app
 * edited it), counts as `updated` seconds from no device.
 */
export function stampOf(r) {
  const updated = Number.isSafeInteger(r?.updated) ? r.updated : 0;
  if (Number.isSafeInteger(r?.updated_ms) && Math.floor(r.updated_ms / 1000) === updated) {
    return { updated_ms: r.updated_ms, device: typeof r.device === "string" ? r.device : "" };
  }
  return { updated_ms: updated * 1000, device: "" };
}

/** Stamps in order: the later time, then the device id that sorts later (as bible-rs orders them). */
export const compareStamps = (a, b) => a.updated_ms - b.updated_ms || compareBytes(a.device, b.device);
const sameStamp = (a, b) => a.updated_ms === b.updated_ms && a.device === b.device;

/**
 * The merge rule: > 0 when version `a` beats `b`. The later stamp wins (time in ms, then device
 * id); on a tie, the JSON text that sorts later as UTF-8 bytes. Every device, server and file
 * compares the same way, so they all keep the same version whatever order changes arrive in.
 * Notes and bible-rs plans add to this (see `mergeNote` and `Library.offer`).
 */
export function compareVersions(a, b) {
  return compareStamps(stampOf(a), stampOf(b)) || compareBytes(a.text, b.text);
}

// ---- notes edited on two devices (spec 3.1, bible-rs's merge_note)

/** How many superseded versions a note remembers. */
const NOTE_HISTORY = 32;

/** A note's version: its stamp, whether it is live, what it was edited from and what else it supersedes. */
function noteVersion(r) {
  return {
    stamp: stampOf(r),
    live: !r.deleted,
    base: { updated_ms: Number.isSafeInteger(r.base_updated) ? r.base_updated : 0, device: r.base_device ?? "" },
    seen: (r.seen ?? []).map((t) => ({ updated_ms: t.updated_ms ?? 0, device: t.device ?? "" })),
  };
}

const hasSeen = (v, t) => sameStamp(t, v.stamp) || (t.updated_ms !== 0 && sameStamp(t, v.base)) || v.seen.some((s) => sameStamp(s, t));

function newestFirst(stamps) {
  const out = [...stamps].sort((a, b) => compareStamps(b, a));
  return out.filter((t, i) => i === 0 || !sameStamp(t, out[i - 1])).slice(0, NOTE_HISTORY);
}

const ancestors = (v) => newestFirst([v.base, ...v.seen].filter((t) => t.updated_ms !== 0));

function absorb(v, others) {
  const extra = [...others].filter((t) => t.updated_ms !== 0 && !sameStamp(t, v.stamp) && !sameStamp(t, v.base));
  return { ...v, seen: newestFirst([...v.seen, ...extra]) };
}

/** The version an edit of `prev` makes, stamped `stamp`. */
const edited = (prev, stamp, live) => absorb({ stamp, live, base: prev.stamp, seen: [] }, ancestors(prev));

/** `version`'s history as a note record's fields. */
function historyFields(v) {
  const f = { base_updated: undefined, base_device: undefined, seen: undefined };
  if (v.base.updated_ms) f.base_updated = v.base.updated_ms;
  if (v.base.device) f.base_device = v.base.device;
  if (v.seen.length) f.seen = v.seen;
  return f;
}

/**
 * bible-rs's merge_note, sync mode: of two versions of a note, the one that has seen the other wins;
 * when each was edited without seeing the other, the later stamp wins and the losing text is kept
 * as a conflict copy. Returns the pick ("local", "absorb": local with more history, "remote") with
 * its version, and which side's text became a copy (true: local's).
 */
export function mergeNote(l, r, sameBody) {
  if (!l) return { pick: "remote", version: r, copy: null };
  if (sameStamp(l.stamp, r.stamp)) {
    const v = absorb(l, ancestors(r));
    return { pick: JSON.stringify(v.seen) === JSON.stringify(l.seen) ? "local" : "absorb", version: v, copy: null };
  }
  if (hasSeen(l, r.stamp)) return { pick: "local", version: l, copy: null };
  if (hasSeen(r, l.stamp)) return { pick: "remote", version: absorb(r, ancestors(l)), copy: null };
  const remoteWins = compareStamps(r.stamp, l.stamp) > 0;
  const [winner, loser] = remoteWins ? [r, l] : [l, r];
  const version = absorb(winner, [...ancestors(loser), loser.stamp]);
  const copy = loser.live && !(winner.live && sameBody) ? remoteWins : null;
  return { pick: remoteWins ? "remote" : "absorb", version, copy };
}

const copyStamp = (k) => ({ updated_ms: k.updated_ms ?? 0, device: k.device ?? "" });
const sameCopies = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Merges note `remote` into `local` (either may be a tombstone), copies included, as bible-rs's
 * store does in sync mode. Returns the note to keep, or null to keep `local` as it is.
 */
export function mergeNoteRecords(local, remote, found = now()) {
  const l = local ? noteVersion(local) : null;
  const r = noteVersion(remote);
  const localBody = local && !local.deleted ? (local.body ?? "") : "";
  const remoteBody = remote.deleted ? "" : (remote.body ?? "");
  const m = mergeNote(l, r, localBody === remoteBody);
  const here = local?.conflicts ?? [];
  const theirs = remote.conflicts ?? [];
  const unseen = (by, copies) => copies.filter((k) => !hasSeen(by, copyStamp(k)));
  const followsOn = !l || hasSeen(r, l.stamp);
  let copies =
    m.pick === "local" ? (l ? [...here, ...unseen(l, theirs)] : [...here]) :
    m.pick === "remote" && followsOn ? [...theirs, ...unseen(r, here)] :
    [...here, ...theirs];
  const lost =
    m.copy === true && local && !local.deleted ? { body: localBody, ...l.stamp, found } :
    m.copy === false ? { body: remoteBody, ...r.stamp, found } : null;
  if (lost) copies.push(lost);
  copies = copies.map((k) => ({ body: k.body ?? "", updated_ms: k.updated_ms ?? 0, device: k.device ?? "", found: k.found ?? 0 }));
  copies.sort((a, b) => compareStamps(a, b));
  copies = copies.filter((k, i) => i === 0 || !sameStamp(k, copies[i - 1]));
  const held = copies.map(copyStamp);
  const copiesChanged = !sameCopies(copies, here.map((k) => ({ body: k.body ?? "", updated_ms: k.updated_ms ?? 0, device: k.device ?? "", found: k.found ?? 0 })));
  let { pick, version } = m;
  if (pick === "local") {
    if (!l || !(copiesChanged || held.some((t) => !hasSeen(l, t)))) return null;
    pick = "absorb";
  }
  version = absorb(version, held);
  const conflicts = copies.length ? copies : undefined;
  if (pick === "absorb") {
    return { ...local, ...historyFields(version), conflicts };
  }
  const lc = local && !local.deleted ? local.created : undefined;
  const rc = remote.created ?? 0;
  const created = lc > 0 && (rc === 0 || lc < rc) ? lc : rc > 0 ? rc : found;
  const out = { ...remote, ...historyFields(version), conflicts };
  if (version.live) out.created = created;
  return out;
}

/** The library's colors: the six built in (named, when the library names them), then its own. */
export function palette(colorRecords) {
  const byId = new Map(colorRecords.filter((r) => r.kind === "color" && !r.deleted).map((r) => [r.ref, r]));
  const builtIn = COLORS.map((id) => ({ id, name: byId.get(id)?.name ?? "", hex: null, builtIn: true }));
  const own = [...byId.values()]
    .filter((r) => !COLORS.includes(r.ref) && HEX.test(r.hex ?? ""))
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || a.ref.localeCompare(b.ref))
    .map((r) => ({ id: r.ref, name: r.name ?? "", hex: r.hex.toLowerCase(), builtIn: false }));
  return [...builtIn, ...own];
}

/** The color a highlight record shows as: its most recently colored part's, or yellow when unknown. */
export function topColor(record, known = COLORS) {
  let best = record.highlights?.[0];
  for (const h of record.highlights ?? []) if ((h.edited ?? h.created ?? 0) >= (best.edited ?? best.created ?? 0)) best = h;
  return known.includes(best?.color) ? best.color : "yellow";
}

// ---- files

/** JSON Lines. Later lines win; lines that aren't records (like a file's header) are skipped. */
export function parseJsonl(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (typeof r?.kind !== "string" || typeof r.ref !== "string") continue;
    out.set(`${r.kind} ${r.ref}`, r);
  }
  return [...out.values()];
}

const seconds = (s) => (s ? Math.floor(Date.parse(s) / 1000) || undefined : undefined);

/** A format 2 entry's stamp as record fields, or nothing for format 1. */
function stampFrom(e) {
  if (!Number.isSafeInteger(e.updated_ms) || e.updated_ms <= 0) return null;
  return { updated: Math.floor(e.updated_ms / 1000), updated_ms: e.updated_ms, device: typeof e.device === "string" ? e.device : "" };
}

/**
 * A bible-rs JSON export (format 1 or 2) → records. Its bookmarks have no Hidden Word kind and are
 * left out. Format 2's stamps become the records' stamps (spec 3), so a later export whose verse
 * lost a part still wins, and a note keeps its history and conflict copies. Tombstones are ignored,
 * as bible-rs's own import ignores them.
 */
export function fromBibleRs(doc) {
  if (doc?.app !== "bible-rs") throw new Error("not a bible-rs export");
  const ref = (e) => `${e.book}.${e.chapter}.${e.verse}`;
  const verses = new Map();
  for (const h of doc.highlights ?? []) {
    const part = { color: h.color, created: seconds(h.created) };
    if (h.start) part.start = h.start;
    if (h.end !== undefined && h.end !== null) part.end = h.end;
    if (h.quote) part.quote = h.quote;
    if (h.edited) part.edited = seconds(h.edited);
    const v = verses.get(ref(h)) ?? { parts: [], stamp: null };
    v.parts.push(part);
    const s = stampFrom(h);
    if (s && (!v.stamp || compareStamps(s, v.stamp) > 0)) v.stamp = s;
    verses.set(ref(h), v);
  }
  const out = [];
  for (const [r, { parts: highlights, stamp }] of verses) {
    const updated = Math.max(...highlights.map((h) => h.edited ?? h.created ?? 0));
    out.push({ kind: "highlight", ref: r, ...(stamp ?? { updated }), highlights });
  }
  for (const n of doc.notes ?? []) {
    const s = stampFrom(n);
    const note = { kind: "note", ref: ref(n), ...(s ?? { updated: seconds(n.updated) }), created: seconds(n.created), body: n.note };
    if (s && seconds(n.updated) !== s.updated) note["x-bible-rs-updated"] = seconds(n.updated);
    if (s && n.base_updated) note.base_updated = n.base_updated;
    if (s && n.base_device) note.base_device = n.base_device;
    if (s && n.seen?.length) note.seen = n.seen.map((t) => ({ updated_ms: t.updated_ms ?? 0, device: t.device ?? "" }));
    const copies = (n.conflicts ?? []).filter((c) => typeof c?.body === "string");
    if (copies.length) {
      note.conflicts = copies.map((c) => ({ body: c.body, updated_ms: c.updated_ms ?? 0, device: c.device ?? "", found: c.found ?? 0 }));
    }
    out.push(note);
  }
  return out;
}

// ---- a library on this device

export function memoryStore() {
  const m = new Map();
  return { load: (lib) => structuredClone(m.get(lib) ?? null), save: (lib, s) => m.set(lib, structuredClone(s)), clear: (lib) => m.delete(lib) };
}

// items: id → { t: the record's JSON text, n: local change number, s: the transport it came from }
const emptyState = () => ({ v: FORMAT, device: b64url(randomBytes(9)), n: 0, clock: 0, items: {}, remotes: {} });

export class Library {
  static async open({ keyText, name = "Personal", store = memoryStore(), transports = [] }) {
    const key = await parseKey(keyText);
    const keys = await deriveKeys(key);
    return new Library({ keyText: await formatKey(key), name, store, keys, transports });
  }

  constructor({ keyText, name, store, keys, transports }) {
    Object.assign(this, { keyText, name, store, keys, transports });
    const saved = store.load(keys.lib);
    this.state = saved?.v === FORMAT ? saved : emptyState();
    this.records = new Map(Object.entries(this.state.items).map(([id, it]) => [id, JSON.parse(it.t)]));
    this.blobs = new Map();
    this.status = { state: transports.length ? "idle" : "local", remotes: {} };
    this.listeners = new Set();
    this.running = null;
    this.again = false;
  }

  get lib() {
    return this.keys.lib;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.store.save(this.lib, this.state);
    for (const fn of this.listeners) fn(this);
  }

  /** Sets how this library syncs: any mix of servers and folders, or none. */
  use(transports) {
    this.transports = transports;
    this.status = { state: transports.length ? "idle" : "local", remotes: {} };
    this.emit();
    return this.sync();
  }

  /** Every live record, optionally of one kind. */
  all(kind) {
    return [...this.records.values()].filter((r) => !r.deleted && (!kind || r.kind === kind));
  }

  find(kind, ref) {
    return this.all(kind).find((r) => r.ref === ref) ?? null;
  }

  async put(record) {
    await this.putMany([record]);
    return record;
  }

  /**
   * Saves edits on this device at once and syncs in the background. Each gets a stamp (spec 3): now
   * in ms, but past every stamp this device has made or seen and past the version it replaces, so
   * an edit always beats what it was made from. A note also records the version it was edited from.
   */
  async putMany(records) {
    for (const record of records) {
      const err = checkRecord(record);
      if (err) throw new Error(err);
      const id = await itemId(this.keys, record.kind, record.ref);
      const prev = this.records.get(id);
      const ms = this.tick(prev ? stampOf(prev).updated_ms + 1 : 0);
      const stamp = { updated_ms: ms, device: this.state.device };
      let r = { ...record, updated: Math.floor(ms / 1000), ...stamp };
      if (r.kind === "note") {
        // bible-rs's own note time, read from its folder, is replaced by this edit's.
        delete r["x-bible-rs-updated"];
        const history = prev ? historyFields(edited(noteVersion(prev), stamp, !r.deleted)) : historyFields({ base: { updated_ms: 0, device: "" }, seen: [] });
        r = { ...r, ...history };
      }
      this.write(id, r, JSON.stringify(r), null);
    }
    this.emit();
    this.sync();
  }

  /** The next stamp's time (Unix ms): the wall clock, but never at or behind one given out or seen, or `atLeast`. */
  tick(atLeast = 0) {
    this.state.clock = Math.max(Date.now(), (this.state.clock ?? 0) + 1, atLeast);
    return this.state.clock;
  }

  /** Moves the clock past a stamp seen, unless it is over a day ahead (a device set to the wrong year). */
  observe(record) {
    const t = stampOf(record).updated_ms;
    if (t <= Date.now() + MAX_DRIFT_MS) this.state.clock = Math.max(this.state.clock ?? 0, t);
  }

  remove(kind, ref) {
    return this.put({ kind, ref, deleted: true });
  }

  /** Merges records from a file by the merge rule: each replaces this device's copy only if newer. */
  async merge(records) {
    let changed = 0;
    for (const record of records) {
      if (checkRecord(record)) continue;
      const r = Number.isSafeInteger(record.updated) ? record : { ...record, updated: now() };
      if ((await this.offer(r, JSON.stringify(r), null)) === "newer") changed++;
    }
    if (changed) {
      this.emit();
      this.sync();
    }
    return changed;
  }

  write(id, record, text, source) {
    this.state.items[id] = source ? { t: text, n: ++this.state.n, s: source } : { t: text, n: ++this.state.n };
    this.records.set(id, record);
  }

  /**
   * Keeps `record` if it beats this device's copy. "newer", "older" (this device's wins) or "same".
   * Notes merge by `mergeNoteRecords`, and bible-rs plans by `offerPlan`; a merge that changes this
   * device's copy without taking the incoming one counts as an edit here, which goes out everywhere.
   */
  async offer(record, text, source, id) {
    id ??= await itemId(this.keys, record.kind, record.ref);
    this.observe(record);
    const mine = this.state.items[id];
    const local = this.records.get(id);
    if (record.kind === "note" && local?.kind === "note") {
      const merged = mergeNoteRecords(local, record);
      if (!merged) return sameStamp(stampOf(local), stampOf(record)) ? "same" : "older";
      const mergedText = JSON.stringify(merged);
      const taken = sameStamp(stampOf(merged), stampOf(record));
      this.write(id, merged, taken && sameCopies(merged, record) ? text : mergedText, taken && sameCopies(merged, record) ? source : null);
      return taken ? "newer" : "older";
    }
    if (record.kind === PLAN && local?.kind === PLAN) return this.offerPlan(id, local, record, text, source);
    if (record.kind === PLAN_READ) {
      const plan = this.records.get(await itemId(this.keys, PLAN, record.plan));
      if (stampOf(record).updated_ms < (plan?.reset_ms ?? 0)) return "same";
    }
    const c = mine ? compareVersions({ ...record, text }, { ...local, text: mine.t }) : 1;
    if (c > 0) this.write(id, record, text, source);
    if (c > 0 && record.kind === PLAN) await this.planChanged(record, 0);
    return c > 0 ? "newer" : c < 0 ? "older" : "same";
  }

  /**
   * A bible-rs plan (spec 2.2): the later stamp wins, but a restart (`reset_ms`) seen anywhere
   * counts, and unticks what was ticked before it; a deleted plan unticks everything.
   */
  async offerPlan(id, local, record, text, source) {
    const reset = Math.max(local.reset_ms ?? 0, record.reset_ms ?? 0);
    if (compareStamps(stampOf(record), stampOf(local)) > 0) {
      const r = reset === (record.reset_ms ?? 0) ? record : { ...record, reset_ms: reset };
      this.write(id, r, r === record ? text : JSON.stringify(r), r === record ? source : null);
      await this.planChanged(r, local.reset_ms ?? 0);
      return "newer";
    }
    if (reset > (local.reset_ms ?? 0)) {
      const r = { ...local, reset_ms: reset };
      this.write(id, r, JSON.stringify(r), null);
      await this.planChanged(r, local.reset_ms ?? 0);
    }
    return sameStamp(stampOf(record), stampOf(local)) ? "same" : "older";
  }

  /** After plan `plan` changed: unticks its passages ticked before a later restart, or all of them when it was deleted. */
  async planChanged(plan, resetBefore) {
    const reset = plan.reset_ms ?? 0;
    if (!plan.deleted && reset <= resetBefore) return;
    const reads = this.all(PLAN_READ).filter((r) => r.plan === plan.ref).sort((a, b) => a.day - b.day || a.passage - b.passage);
    for (const read of reads) {
      let stamp;
      if (plan.deleted) stamp = stampOf(plan);
      else if (stampOf(read).updated_ms < reset) stamp = { updated_ms: reset, device: this.state.device };
      else continue;
      const r = { ...read, deleted: true, updated: Math.floor(stamp.updated_ms / 1000), ...stamp };
      this.write(await itemId(this.keys, PLAN_READ, read.ref), r, JSON.stringify(r), null);
    }
  }

  /** One encrypted item from a server. Items that don't decrypt, or sit under the wrong id, are "bad". */
  async receive(id, blob, source) {
    let text;
    let record;
    try {
      text = await decryptText(this.keys, id, blob);
      record = JSON.parse(text);
      if ((await itemId(this.keys, record.kind, record.ref)) !== id) return "bad";
    } catch {
      return "bad";
    }
    const result = await this.offer(record, text, source, id);
    // Cache the server's blob only when this device kept it as it came.
    if (result === "newer" && this.state.items[id].t === text) this.blobs.set(id, { n: this.state.items[id].n, blob });
    return result;
  }

  async blob(id) {
    const item = this.state.items[id];
    const cached = this.blobs.get(id);
    if (cached?.n === item.n) return cached.blob;
    const blob = await seal(this.keys.enc, id, pad(item.t));
    this.blobs.set(id, { n: item.n, blob });
    return blob;
  }

  remote(name) {
    return (this.state.remotes[name] ??= { cursor: 0, seq: 0, epoch: null, sent: 0, all: false, redo: [], files: {} });
  }

  /** Ids a transport hasn't got yet, oldest change first. */
  unsent(name) {
    const r = this.remote(name);
    const redo = new Set(r.redo);
    return Object.entries(this.state.items)
      .filter(([id, it]) => r.all || redo.has(id) || (it.n > r.sent && it.s !== name))
      .sort((a, b) => a[1].n - b[1].n)
      .map(([id]) => id);
  }

  /** How many changes haven't reached any transport yet (all of them when there are none). */
  waiting() {
    if (!this.transports.length) return 0;
    return Math.min(...this.transports.map((t) => this.unsent(t.name).length));
  }

  /** Every transport in turn. Concurrent calls share one run. Never throws: see `status`. */
  sync() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      // Without this, a run with nothing to await would finish before `running` is even set.
      await null;
      try {
        let passes = 0;
        do {
          this.again = false;
          const before = this.state.n;
          for (const t of this.transports) {
            this.status.remotes[t.name] = { state: "syncing" };
            this.setStatus();
            try {
              await t.sync(this);
              this.status.remotes[t.name] = { state: "synced" };
            } catch (error) {
              this.status.remotes[t.name] = { state: error instanceof SyncError ? "error" : "offline", error };
            }
          }
          // What one transport brought in goes out through the others on the next pass.
          if (this.state.n !== before && this.transports.length > 1 && ++passes < 3) this.again = true;
        } while (this.again);
      } finally {
        this.running = null;
        this.setStatus();
      }
    })();
    return this.running;
  }

  setStatus() {
    const states = this.transports.map((t) => this.status.remotes[t.name]?.state ?? "idle");
    const worst = ["error", "offline", "syncing", "idle", "synced"].find((s) => states.includes(s));
    this.status.state = this.transports.length ? worst : "local";
    this.emit();
  }

  /** The library as a readable JSON Lines file: a header line, then one record per line. */
  toFile({ deleted = false } = {}) {
    const header = { "hidden-word": FORMAT, library: this.lib, device: this.state.device, name: this.name };
    const lines = Object.entries(this.state.items)
      .filter(([id]) => deleted || !this.records.get(id).deleted)
      .map(([, it]) => it.t);
    return [JSON.stringify(header), ...lines].join("\n") + "\n";
  }

  /** Erases the library from every transport and this device. */
  async erase() {
    for (const t of this.transports) await t.erase?.(this);
    this.state = emptyState();
    this.records.clear();
    this.blobs.clear();
    this.store.clear(this.lib);
    for (const fn of this.listeners) fn(this);
  }

  /** Forgets this device's copy without touching anything else. */
  forget() {
    this.store.clear(this.lib);
    this.listeners.clear();
  }
}

// ---- syncing through a server (spec section 3)

/** A Hidden Word server. `url` "" means the site this page came from. */
export function serverTransport({ url = "", fetch: f } = {}) {
  const name = `server ${url}`;
  const call = async (lib, method, query = "", body) => {
    const headers = { authorization: `Bearer ${lib.keys.auth}` };
    if (body) headers["content-type"] = "application/json";
    const res = await (f ?? globalThis.fetch.bind(globalThis))(`${url}/v1/lib/${lib.lib}${query}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new SyncError(res.status, await res.text().catch(() => ""));
    return res.status === 204 ? null : res.json();
  };

  // The server lost data (it's a new library, or older than what we've seen): start over and
  // send it everything we have.
  const lost = (r, answer) =>
    (r.epoch !== null && answer.epoch !== r.epoch) || (answer.seq !== undefined && answer.seq < r.seq);
  const restart = (r, answer) => Object.assign(r, { cursor: 0, seq: 0, epoch: answer.epoch, sent: 0, all: true, redo: [] });

  async function push(lib, r) {
    const ids = lib.unsent(name);
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const ns = chunk.map((id) => lib.state.items[id].n);
      const items = await Promise.all(chunk.map(async (id) => ({ id, blob: await lib.blob(id) })));
      const answer = await call(lib, "POST", "", { items });
      if (lost(r, answer)) {
        restart(r, answer);
        return false;
      }
      r.epoch = answer.epoch;
      r.seq = Math.max(r.seq, answer.seq);
      const done = new Set(chunk);
      r.redo = r.redo.filter((id) => !done.has(id));
      if (!r.all) r.sent = Math.max(r.sent, ...ns);
      lib.emit();
    }
    if (r.all) Object.assign(r, { all: false, sent: Math.max(r.sent, ...ids.map((id) => lib.state.items[id]?.n ?? 0)) });
    return true;
  }

  async function pull(lib, r) {
    for (;;) {
      const page = await call(lib, "GET", `?after=${r.cursor}`);
      if (lost(r, page)) {
        restart(r, page);
        return false;
      }
      if (page.epoch !== null) r.epoch = page.epoch;
      r.seq = Math.max(r.seq, page.seq ?? 0);
      for (const { seq, id, blob } of page.items) {
        // This device has a newer copy than the server: send it again.
        if ((await lib.receive(id, blob, name)) === "older" && !r.redo.includes(id)) r.redo.push(id);
        r.cursor = seq;
        r.seq = Math.max(r.seq, seq);
      }
      if (page.items.length) lib.emit();
      if (!page.more) return true;
    }
  }

  return {
    name,
    async sync(lib) {
      const r = lib.remote(name);
      for (let round = 0; round < 4; round++) {
        if (!(await push(lib, r))) continue;
        if (!(await pull(lib, r))) continue;
        if (!r.redo.length && !lib.unsent(name).length) return;
      }
    },
    async erase(lib) {
      await call(lib, "DELETE");
    },
  };
}

// ---- syncing through a shared folder (spec section 4)

/**
 * A folder every device can reach (iCloud Drive, Dropbox, Syncthing, a USB stick). Each device
 * keeps one readable file there, `<device>.jsonl`, and reads everyone else's.
 * `dir` is { list() → [{name, stamp}], read(name) → text, write(name, text), remove(name) }.
 */
export function folderTransport(dir, name = "folder") {
  return {
    name,
    dir,
    async sync(lib) {
      const r = lib.remote(name);
      const mine = `${lib.state.device}.jsonl`;
      const files = await dir.list();
      let changed = false;
      for (const file of files) {
        if (file.name === mine || !file.name.endsWith(".jsonl") || r.files[file.name] === file.stamp) continue;
        const lines = (await dir.read(file.name)).split(/\r?\n/).filter((l) => l.trim());
        const header = safeJson(lines[0]);
        // Only files written for this library: a folder may hold other libraries' files too.
        if (header?.["hidden-word"] && header.library === lib.lib) {
          for (const line of lines.slice(1)) {
            const record = safeJson(line);
            if (typeof record?.kind !== "string" || typeof record.ref !== "string") continue;
            if ((await lib.offer(record, line, name)) === "newer") changed = true;
          }
        }
        r.files[file.name] = file.stamp;
      }
      if (changed) lib.emit();
      if (lib.state.n > r.sent || !files.some((f) => f.name === mine)) {
        const upTo = lib.state.n;
        await dir.write(mine, lib.toFile({ deleted: true }));
        r.sent = upTo;
        lib.emit();
      }
    },
    async erase(lib) {
      for (const file of await dir.list()) {
        const header = safeJson((await dir.read(file.name)).split("\n", 1)[0]);
        if (header?.library === lib.lib) await dir.remove(file.name);
      }
    },
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A folder in memory, for tests and demos. Pass the same Map to share it between devices. */
export function memoryDir(files = new Map()) {
  let clock = 0;
  return {
    files,
    list: async () => [...files].map(([name, f]) => ({ name, stamp: f.stamp })),
    read: async (name) => files.get(name)?.text ?? "",
    write: async (name, text) => void files.set(name, { text, stamp: `${Date.now()}-${++clock}-${Math.random()}` }),
    remove: async (name) => void files.delete(name),
  };
}

// ---- passkey key slots (WebAuthn PRF)

export const prfSalt = () => sha256(te.encode("hidden-word/v1/prf"));

export async function slotKeys(prf) {
  const [slot, auth, kek] = await Promise.all([
    hkdf(prf, "hidden-word/v1/slot", 16),
    hkdf(prf, "hidden-word/v1/slot-auth", 32),
    hkdf(prf, "hidden-word/v1/kek", 32),
  ]);
  return { slot: hex(slot), auth: b64url(auth), kek: await aesKey(kek) };
}

async function slotRequest({ server = "", prf, fetch: f = globalThis.fetch.bind(globalThis) }, method, body) {
  const s = await slotKeys(prf);
  const headers = { authorization: `Bearer ${s.auth}` };
  if (body) headers["content-type"] = "application/json";
  const res = await f(`${server}/v1/slot/${s.slot}`, { method, headers, body: body ? JSON.stringify(body(s)) : undefined });
  return { res, s };
}

/** Wraps `{key, name}` under a passkey's PRF output and stores it in the passkey's slot. */
export async function saveSlot({ keyText, name, ...opts }) {
  const s = await slotKeys(opts.prf);
  const wrapped = await seal(s.kek, s.slot, te.encode(JSON.stringify({ key: keyText, name })));
  const { res } = await slotRequest(opts, "PUT", () => ({ wrapped }));
  if (!res.ok) throw new SyncError(res.status, await res.text().catch(() => ""));
}

/** `{key, name}` from a passkey's slot, or null when the passkey has no slot. */
export async function openSlot(opts) {
  const { res, s } = await slotRequest(opts, "GET");
  if (res.status === 404) return null;
  if (!res.ok) throw new SyncError(res.status, await res.text().catch(() => ""));
  const { wrapped } = await res.json();
  return JSON.parse(td.decode(await unseal(s.kek, s.slot, wrapped)));
}
