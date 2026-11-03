// Syncing with bible-rs through its Study Library folder (spec 2.2). Hidden Word joins as one more
// bible-rs device: it writes only its own files, reads everyone else's, and merges them by
// bible-rs's rules. Matches crates/core/src/folder.rs and sync.rs in bible-rs (PR #80, #81).
//
//   library.json                         {"app":"bible-rs study library","format":1,"id":…}
//   changes/<device>/<16 digits>.json    one batch: {format, device, seq, changes}
//   snapshots/<device>.json              everything that device has said, as of change seq
//
// `tree` is a folder seen as paths ("changes/abc/0000000000000001.json"):
// { list(path) → [{name, kind: "file"|"directory", stamp}] ([] when missing), read(path) → text
//   or null, write(path, text) (atomic, making folders), remove(path) (a folder with what's in it) }.

import { BOOKMARK, COLORS, PLAN, PLAN_READ, checkRecord, hex, randomBytes, stampOf } from "./sync.js";
import { splitRef } from "./refs.js";

export const STUDY_LIBRARY = "bible-rs study library";
const FORMAT = 1;
const MARKER = "library.json";
/** A device's change files before it folds them into its snapshot. */
const COMPACT_AFTER = 64;
const GROUPS = ["highlights", "notes", "bookmarks", "plans", "plan_reads"];

// ---- records ↔ bible-rs changes

const KNOWN = {
  highlights: ["book", "chapter", "verse", "updated_ms", "device", "deleted", "parts"],
  notes: ["book", "chapter", "verse", "updated_ms", "device", "deleted", "body", "created", "updated", "base_updated", "base_device", "seen", "conflicts"],
  bookmarks: ["book", "chapter", "verse", "updated_ms", "device", "deleted", "label", "created"],
  plans: ["id", "updated_ms", "device", "deleted", "started", "finished", "reset_ms"],
  plan_reads: ["plan", "day", "passage", "updated_ms", "device", "deleted", "at"],
  part: ["color", "start", "end", "quote", "created", "edited"],
};

/** Fields a newer bible-rs wrote that this version doesn't know, kept to write back. */
function extras(c, known) {
  const out = {};
  for (const [k, v] of Object.entries(c)) if (!known.includes(k)) out[k] = v;
  return Object.keys(out).length ? { "x-bible-rs": out } : {};
}

const stampFields = (c) => {
  const ms = Number.isSafeInteger(c.updated_ms) ? c.updated_ms : 0;
  return { updated: Math.floor(ms / 1000), updated_ms: ms, device: typeof c.device === "string" ? c.device : "" };
};
const verseRef = (c) => `${c.book}.${c.chapter}.${c.verse}`;
const tombstone = (c) => (c.deleted ? { deleted: true } : {});

/** One bible-rs change (from group `group` of a batch) as a Hidden Word record. */
export function fromChange(group, c) {
  const x = extras(c, KNOWN[group]);
  if (group === "highlights") {
    const parts = c.deleted ? [] : (c.parts ?? []);
    if (!parts.length) return { kind: "highlight", ref: verseRef(c), ...stampFields(c), deleted: true, ...x };
    const highlights = parts.map((p) => {
      const h = { color: p.color, created: p.created, edited: p.edited };
      if (p.start) h.start = p.start;
      if (p.end !== undefined && p.end !== null) h.end = p.end;
      if (p.quote !== undefined && p.quote !== null) h.quote = p.quote;
      return { ...h, ...extras(p, KNOWN.part) };
    });
    return { kind: "highlight", ref: verseRef(c), ...stampFields(c), highlights, ...x };
  }
  if (group === "notes") {
    const s = stampFields(c);
    const r = { kind: "note", ref: verseRef(c), ...s, ...tombstone(c) };
    if (!c.deleted) {
      r.body = c.body ?? "";
      r.created = c.created ?? 0;
      if ((c.updated ?? 0) !== s.updated) r["x-bible-rs-updated"] = c.updated ?? 0;
    }
    if (c.base_updated) r.base_updated = c.base_updated;
    if (c.base_device) r.base_device = c.base_device;
    if (c.seen?.length) r.seen = c.seen.map((t) => ({ updated_ms: t.updated_ms ?? 0, device: t.device ?? "" }));
    if (c.conflicts?.length) {
      r.conflicts = c.conflicts.map((k) => ({ body: k.body ?? "", updated_ms: k.updated_ms ?? 0, device: k.device ?? "", found: k.found ?? 0 }));
    }
    return { ...r, ...x };
  }
  if (group === "bookmarks") {
    const r = { kind: BOOKMARK, ref: verseRef(c), ...stampFields(c), ...tombstone(c) };
    if (!c.deleted) Object.assign(r, { label: c.label ?? "", created: c.created ?? 0 });
    return { ...r, ...x };
  }
  if (group === "plans") {
    const r = { kind: PLAN, ref: c.id, ...stampFields(c), ...tombstone(c) };
    if (!c.deleted) r.started = c.started ?? 0;
    if (!c.deleted && c.finished !== undefined && c.finished !== null) r.finished = c.finished;
    if (c.reset_ms) r.reset_ms = c.reset_ms;
    return { ...r, ...x };
  }
  const r = { kind: PLAN_READ, ref: `${c.plan}/${c.day}/${c.passage}`, plan: c.plan, day: c.day, passage: c.passage, ...stampFields(c), ...tombstone(c) };
  return { ...r, at: c.at ?? 0, ...x };
}

/** A verse bible-rs can hold (u8 chapter and verse), or null. */
function verseOf(ref) {
  const r = splitRef(ref);
  if (!r || r.verse === null || r.end !== null || r.chapter > 255 || r.verse > 255) return null;
  return { book: r.code, chapter: r.chapter, verse: r.verse };
}

/** A record as a bible-rs change, `[group, change]`, or null when bible-rs has nothing like it. */
export function toChange(r) {
  const stamp = stampOf(r);
  const deleted = r.deleted === true;
  const del = deleted ? { deleted: true } : {};
  const x = r["x-bible-rs"] ?? {};
  if (r.kind === "highlight") {
    const verse = verseOf(r.ref);
    if (!verse) return null;
    const parts = deleted ? [] : (r.highlights ?? []).map((h) => {
      const created = Number.isSafeInteger(h.created) ? h.created : r.updated;
      const p = { ...(h["x-bible-rs"] ?? {}), color: COLORS.includes(h.color) ? h.color : "yellow", start: h.start ?? 0 };
      if (h.end !== undefined && h.end !== null) p.end = h.end;
      if (h.quote !== undefined && h.quote !== null) p.quote = h.quote;
      return { ...p, created, edited: Number.isSafeInteger(h.edited) ? h.edited : created };
    });
    const c = { ...x, ...verse, ...stamp, ...(parts.length ? {} : { deleted: true }) };
    if (parts.length) c.parts = parts;
    return ["highlights", c];
  }
  if (r.kind === "note") {
    const verse = verseOf(r.ref);
    if (!verse) return null;
    const c = { ...x, ...verse, ...stamp, ...del, body: deleted ? "" : (r.body ?? ""), created: deleted ? 0 : (r.created ?? 0) };
    c.updated = deleted ? 0 : (r["x-bible-rs-updated"] ?? r.updated);
    if (r.base_updated) c.base_updated = r.base_updated;
    if (r.base_device) c.base_device = r.base_device;
    if (r.seen?.length) c.seen = r.seen;
    if (r.conflicts?.length) c.conflicts = r.conflicts;
    return ["notes", c];
  }
  if (r.kind === BOOKMARK) {
    const verse = verseOf(r.ref);
    if (!verse) return null;
    return ["bookmarks", { ...x, ...verse, ...stamp, ...del, label: deleted ? "" : (r.label ?? ""), created: deleted ? 0 : (r.created ?? 0) }];
  }
  if (r.kind === PLAN) {
    const c = { ...x, id: r.ref, ...stamp, ...del, started: deleted ? 0 : (r.started ?? 0) };
    if (!deleted && r.finished !== undefined) c.finished = r.finished;
    if (r.reset_ms) c.reset_ms = r.reset_ms;
    return ["plans", c];
  }
  if (r.kind === PLAN_READ) {
    return ["plan_reads", { ...x, plan: r.plan, day: r.day, passage: r.passage, ...stamp, ...del, at: r.at ?? 0 }];
  }
  return null;
}

// ---- the folder

const changeName = (n) => `${String(n).padStart(16, "0")}.json`;
const changeNumber = (name) => (/^\d{16}\.json$/.test(name) ? Number(name.slice(0, 16)) : null);
/** The real name of a file iCloud hasn't downloaded yet (`.<name>.icloud`). */
const placeholder = (name) => (name.startsWith(".") && name.endsWith(".icloud") ? name.slice(1, -7) : null);
const validDevice = (d) => /^[A-Za-z0-9_-]{1,64}$/.test(d);

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The Study Library in `tree`: its id, or null when the folder isn't one. */
export async function studyLibrary(tree) {
  const m = parse(await tree.read(MARKER));
  return m?.app === STUDY_LIBRARY && typeof m.id === "string" ? m : null;
}

/** Opens the library in `tree`, making it when the folder has none. Its id. */
async function open(tree) {
  const text = await tree.read(MARKER);
  if (text === null) {
    // The marker hasn't downloaded yet: making a new one would give the library another identity.
    if ((await tree.list("")).some((e) => e.name === `.${MARKER}.icloud`)) throw new Error(`${MARKER} is still downloading`);
    const id = hex(randomBytes(8));
    await tree.write(MARKER, JSON.stringify({ app: STUDY_LIBRARY, format: FORMAT, id }, null, 2));
    return id;
  }
  const m = parse(text);
  if (typeof m?.id !== "string") throw new Error(`${MARKER} isn't readable`);
  if (m.format > FORMAT) throw new Error("this study library was made by a newer version of bible-rs; update Hidden Word to use it");
  return m.id;
}

async function listChanges(tree, path) {
  const files = { changes: new Set(), pending: new Set() };
  for (const { name } of await tree.list(path)) {
    const n = changeNumber(name);
    if (n !== null) files.changes.add(n);
    else {
      const p = placeholder(name);
      const m = p === null ? null : changeNumber(p);
      if (m !== null) files.pending.add(m);
    }
  }
  for (const n of files.changes) files.pending.delete(n);
  return files;
}

/** Every other device with files here: device → { changes, pending, snapshot, snapshotPending, version }. */
async function devices(tree, me) {
  const out = new Map();
  const files = (d) => out.get(d) ?? out.set(d, { changes: new Set(), pending: new Set() }).get(d);
  for (const e of await tree.list("changes")) {
    if (e.kind !== "directory" || e.name === me || !validDevice(e.name)) continue;
    Object.assign(files(e.name), await listChanges(tree, `changes/${e.name}`));
  }
  for (const e of await tree.list("snapshots")) {
    const inner = placeholder(e.name);
    const device = (inner ?? e.name).replace(/\.json$/, "");
    if (!(inner ?? e.name).endsWith(".json") || device === me || !validDevice(device)) continue;
    if (inner) files(device).snapshotPending = true;
    else Object.assign(files(device), { snapshot: true, version: e.stamp });
  }
  return out;
}

function readBatch(text, device) {
  const b = parse(text);
  if (!b || typeof b !== "object") throw new Error("not a whole change file yet");
  if (b.format > FORMAT) throw new Error("written by a newer version of the app");
  if (b.device !== device) throw new Error(`written by another device (${b.device})`);
  return { ...b, seq: Number(b.seq) || 0, changes: b.changes ?? {} };
}

/**
 * A bible-rs Study Library as a transport. Its place in each library (by the id in library.json)
 * is kept in the library's state, as bible-rs keeps it in sync_meta.
 */
export function bibleRsTransport(tree, name = "bible-rs folder") {
  async function merge(lib, changes) {
    let changed = false;
    for (const group of GROUPS) {
      for (const c of changes[group] ?? []) {
        const record = fromChange(group, c);
        if (checkRecord(record)) continue;
        if ((await lib.offer(record, JSON.stringify(record), name)) !== "same") changed = true;
      }
    }
    return changed;
  }

  /** What this device writes: what changed here since `since`, but for the records the other devices here wrote themselves. */
  function outgoing(lib, since, others) {
    const theirs = (s) => others.has(s.device);
    const out = Object.fromEntries(GROUPS.map((g) => [g, []]));
    for (const [id, it] of Object.entries(lib.state.items)) {
      if (it.n <= since) continue;
      const change = toChange(lib.records.get(id));
      if (!change) continue;
      const [group, c] = change;
      if (theirs(c) && !(group === "notes" && c.conflicts?.length)) continue;
      out[group].push(c);
    }
    // In the order they were made, as bible-rs writes them.
    const key = (c) => [c.book ?? c.id ?? c.plan ?? "", c.chapter ?? c.day ?? 0, c.verse ?? c.passage ?? 0];
    const order = (a, b) => a.updated_ms - b.updated_ms || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0) || String(key(a)) .localeCompare(String(key(b)));
    for (const g of GROUPS) {
      out[g].sort(order);
      if (!out[g].length) delete out[g];
    }
    return out;
  }
  const count = (c) => Object.values(c).reduce((n, v) => n + v.length, 0);

  return {
    name,
    tree,
    async sync(lib) {
      const id = await open(tree);
      const r = lib.remote(name);
      const p = ((r.libraries ??= {})[id] ??= { read: {}, snapshots: {}, written: 0, sent: 0 });
      const me = lib.state.device;
      let changed = false;

      // This device's own snapshot: numbering continues past it.
      let ownSnapshot = null;
      const ownText = await tree.read(`snapshots/${me}.json`);
      if (ownText !== null) ownSnapshot = readBatch(ownText, me).seq;

      // Read the other devices' new files, each in order; a gap is a file still on its way.
      let others = await devices(tree, me);
      for (const [device, files] of others) {
        let read = p.read[device] ?? 0;
        let snapshotTried = false;
        for (;;) {
          while (files.changes.has(read + 1)) {
            let batch;
            try {
              batch = readBatch(await tree.read(`changes/${device}/${changeName(read + 1)}`), device);
            } catch {
              break;
            }
            if (await merge(lib, batch.changes)) changed = true;
            p.read[device] = ++read;
          }
          const gap = !files.changes.has(read + 1) && !files.pending.has(read + 1);
          if (snapshotTried || !gap || !files.snapshot) break;
          snapshotTried = true;
          let batch;
          try {
            batch = readBatch(await tree.read(`snapshots/${device}.json`), device);
          } catch {
            break;
          }
          if (files.version) p.snapshots[device] = files.version;
          if (batch.seq <= read) break;
          if (await merge(lib, batch.changes)) changed = true;
          p.read[device] = read = batch.seq;
        }
      }
      if (changed) lib.emit();

      // Then write what changed here.
      others = await devices(tree, me);
      const since = p.sent > lib.state.n ? 0 : p.sent;
      const seq = lib.state.n;
      const changes = outgoing(lib, since, others);
      const dir = `changes/${me}`;
      const mine = await listChanges(tree, dir);
      const snapshots = await tree.list("snapshots");
      const hasSnapshot = snapshots.some((e) => e.name === `${me}.json` || e.name === `.${me}.json.icloud`);
      const removed = p.written > 0 && !mine.changes.size && !mine.pending.size && !hasSnapshot;
      if (!count(changes) && !removed) {
        if (p.sent !== seq) {
          p.sent = seq;
          lib.emit();
        }
        return;
      }
      let last = Math.max(0, ...mine.changes, ...mine.pending, p.written);
      if (hasSnapshot) {
        if (ownSnapshot === null) throw new Error(`snapshots/${me}.json isn't readable yet`);
        last = Math.max(last, ownSnapshot);
      }
      const n = last + 1;
      const snapshot = () => JSON.stringify({ format: FORMAT, device: me, seq: n, changes: outgoing(lib, 0, others) });
      if (n > 1 && !mine.changes.size && !hasSnapshot) {
        // This device's files were removed from the folder: write all of it again, as a snapshot.
        await tree.write(`snapshots/${me}.json`, snapshot());
      } else {
        await tree.write(`${dir}/${changeName(n)}`, JSON.stringify({ format: FORMAT, device: me, seq: n, changes }));
        mine.changes.add(n);
        if (mine.changes.size > COMPACT_AFTER) {
          // Everything this device's records say now, as of change n; then its files up to n go.
          await tree.write(`snapshots/${me}.json`, snapshot());
          for (const old of mine.changes) if (old <= n) await tree.remove(`${dir}/${changeName(old)}`);
        }
      }
      p.written = n;
      p.sent = seq;
      lib.emit();
    },
    /** Takes this device's files out of the library; the other devices' stay. */
    async erase(lib) {
      const me = lib.state.device;
      await tree.remove(`changes/${me}`);
      await tree.remove(`snapshots/${me}.json`);
    },
  };
}

/** A folder tree in memory, for tests. Pass the same Map to share it between devices. */
export function memoryTree(files = new Map()) {
  let clock = 0;
  const under = (path) => (path ? `${path}/` : "");
  return {
    files,
    async list(path) {
      const out = new Map();
      for (const [name, f] of files) {
        if (!name.startsWith(under(path))) continue;
        const [first, ...rest] = name.slice(under(path).length).split("/");
        out.set(first, rest.length ? { name: first, kind: "directory" } : { name: first, kind: "file", stamp: f.stamp });
      }
      return [...out.values()];
    },
    read: async (path) => files.get(path)?.text ?? null,
    write: async (path, text) => void files.set(path, { text, stamp: `${++clock}` }),
    async remove(path) {
      for (const name of [...files.keys()]) if (name === path || name.startsWith(`${path}/`)) files.delete(name);
    },
  };
}
