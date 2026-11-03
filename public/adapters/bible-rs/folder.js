// A bible-rs Study Library (bible-rs PR #81, crates/core/src/folder.rs) as a Hidden Word sync
// adapter. The adapter is one more bible-rs device: it keeps that device's study in its own state
// (merge.js), turns Hidden Word edits into that device's edits, reads the other devices' files into
// it by bible-rs's rules, and gives Hidden Word what changed in its highlights and notes.
//
//   library.json                         {"app":"bible-rs study library","format":1,"id":…}
//   changes/<device>/<16 digits>.json    one batch: {format, device, seq, changes}
//   snapshots/<device>.json              everything that device has said, as of change seq

import { checkRecord, hex, randomBytes } from "../../sync.js";
import { GROUPS, changesSince, edit, emptyStudy, keyOf, merge } from "./merge.js";
import { fromRecord, sameContent, toRecord } from "./map.js";

export const APP = "bible-rs study library";
const FORMAT = 1;
const MARKER = "library.json";
/** A device's change files before it folds them into its snapshot. */
const COMPACT_AFTER = 64;

const changeName = (n) => `${String(n).padStart(16, "0")}.json`;
const changeNumber = (name) => (/^\d{16}\.json$/.test(name) ? Number(name.slice(0, 16)) : null);
/** The real name of a file iCloud hasn't downloaded yet (`.<name>.icloud`). */
const placeholder = (name) => (name.startsWith(".") && name.endsWith(".icloud") ? name.slice(1, -7) : null);
const validDevice = (d) => /^[A-Za-z0-9_-]{1,64}$/.test(d);
const count = (c) => Object.values(c).reduce((n, v) => n + v.length, 0);

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Whether the folder holds a Study Library. */
export async function isStudyLibrary(tree) {
  const m = parse(await tree.read(MARKER));
  return m?.app === APP && typeof m.id === "string";
}

/** Opens the library, making it when the folder has none. Its id. */
async function open(tree) {
  const text = await tree.read(MARKER);
  if (text === null) {
    // The marker hasn't downloaded yet: making a new one would give the library another identity.
    if ((await tree.list("")).some((e) => e.name === `.${MARKER}.icloud`)) throw new Error(`${MARKER} is still downloading`);
    const id = hex(randomBytes(8));
    await tree.write(MARKER, JSON.stringify({ app: APP, format: FORMAT, id }, null, 2));
    return id;
  }
  const m = parse(text);
  if (typeof m?.id !== "string") throw new Error(`${MARKER} isn't readable`);
  if (m.format > FORMAT) throw new Error("this study library was made by a newer version of bible-rs");
  return m.id;
}

async function listChanges(tree, path) {
  const files = { changes: new Set(), pending: new Set() };
  for (const { name } of await tree.list(path)) {
    const n = changeNumber(name);
    const p = placeholder(name);
    if (n !== null) files.changes.add(n);
    else if (p !== null && changeNumber(p) !== null) files.pending.add(changeNumber(p));
  }
  for (const n of files.changes) files.pending.delete(n);
  return files;
}

/** Every other device with files here. */
async function devices(tree, me) {
  const out = new Map();
  const files = (d) => out.get(d) ?? out.set(d, { changes: new Set(), pending: new Set() }).get(d);
  for (const e of await tree.list("changes")) {
    if (e.kind !== "directory" || e.name === me || !validDevice(e.name)) continue;
    Object.assign(files(e.name), await listChanges(tree, `changes/${e.name}`));
  }
  for (const e of await tree.list("snapshots")) {
    const inner = placeholder(e.name);
    const name = inner ?? e.name;
    const device = name.replace(/\.json$/, "");
    if (!name.endsWith(".json") || device === me || !validDevice(device)) continue;
    if (inner) files(device).snapshotPending = true;
    else files(device).snapshot = true;
  }
  return out;
}

function readBatch(text, device) {
  const b = parse(text);
  if (!b || typeof b !== "object") throw new Error("not a whole change file yet");
  if (b.format > FORMAT) throw new Error("written by a newer version of the app");
  if (b.device !== device) throw new Error(`written by another device (${b.device})`);
  return { seq: Number(b.seq) || 0, changes: b.changes ?? {} };
}

/** The adapter. Its state, per library id: the study (merge.js), and how far it has read and written. */
export function studyLibrary(tree, name = "bible-rs folder") {
  const stateFor = (lib, id) => {
    const r = lib.remote(name);
    return ((r.libraries ??= {})[id] ??= { study: emptyStudy(hex(randomBytes(8))), read: {}, written: 0, pushed: 0, sent: 0 });
  };

  /** Hidden Word's edits since the last sync, as this device's edits. */
  function takeEdits(lib, p) {
    const upTo = lib.seq;
    if (p.sent > upTo) p.sent = 0;
    for (const record of lib.changedSince(p.sent)) {
      const m = fromRecord(record);
      if (!m) continue;
      const [g, c] = m;
      const mine = p.study.entries[keyOf(g, c)]?.c;
      if (mine ? sameContent(g, c, mine) : c.deleted) continue;
      edit(p.study, g, c, (record.updated ?? 0) * 1000);
    }
    p.sent = upTo;
  }

  /** What reading changed in highlights and notes, as Hidden Word edits. */
  async function give(lib, p, keys) {
    const records = [];
    for (const key of keys) {
      const { g, c } = p.study.entries[key];
      const r = toRecord(g, c);
      if (!r) continue;
      const current = lib.find(r.kind, r.ref);
      if (r.deleted) {
        if (current) records.push(r);
        continue;
      }
      const m = current && fromRecord(current);
      if (m && sameContent(g, m[1], c)) continue;
      // Fields of the record bible-rs doesn't know (another app's) stay.
      const next = { ...(current ?? {}), ...r };
      if (!checkRecord(next)) records.push(next);
    }
    if (records.length) await lib.putMany(records);
  }

  return {
    name,
    tree,
    async sync(lib) {
      const id = await open(tree);
      const p = stateFor(lib, id);
      const me = p.study.device;
      takeEdits(lib, p);

      // This device's own snapshot: numbering continues past it.
      const ownText = await tree.read(`snapshots/${me}.json`);
      const ownSnapshot = ownText === null ? null : readBatch(ownText, me).seq;

      // The other devices' new files, each in order; a gap is a file still on its way.
      const changed = new Set();
      for (const [device, files] of await devices(tree, me)) {
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
            for (const k of merge(p.study, batch.changes)) changed.add(k);
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
          if (batch.seq <= read) break;
          for (const k of merge(p.study, batch.changes)) changed.add(k);
          p.read[device] = read = batch.seq;
        }
      }
      lib.emit();
      await give(lib, p, changed);

      // Then write what changed here.
      const others = new Set((await devices(tree, me)).keys());
      const since = p.pushed > p.study.seq ? 0 : p.pushed;
      const seq = p.study.seq;
      const changes = changesSince(p.study, since, others);
      const dir = `changes/${me}`;
      const mine = await listChanges(tree, dir);
      const hasSnapshot = (await tree.list("snapshots")).some((e) => e.name === `${me}.json` || e.name === `.${me}.json.icloud`);
      const removed = p.written > 0 && !mine.changes.size && !mine.pending.size && !hasSnapshot;
      if (!count(changes) && !removed) {
        p.pushed = seq;
        lib.emit();
        return;
      }
      let last = Math.max(0, ...mine.changes, ...mine.pending, p.written);
      if (hasSnapshot) {
        if (ownSnapshot === null) throw new Error(`snapshots/${me}.json isn't readable yet`);
        last = Math.max(last, ownSnapshot);
      }
      const n = last + 1;
      const snapshot = () => JSON.stringify({ format: FORMAT, device: me, seq: n, changes: changesSince(p.study, 0, others) });
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
      p.pushed = seq;
      lib.emit();
    },
    /** Takes this device's files out of the library; the other devices' stay. */
    async erase(lib) {
      for (const p of Object.values(lib.remote(name).libraries ?? {})) {
        await tree.remove(`changes/${p.study.device}`);
        await tree.remove(`snapshots/${p.study.device}.json`);
      }
    },
  };
}

export { GROUPS };
