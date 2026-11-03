// The bible-rs adapter (public/adapters/bible-rs). The fixture folder `library/` and its dump were
// written by bible-rs's own code (hwcompat.rs here, run against bible-rs PR #81 at d393e4d). With
// HWCOMPAT set to that harness's binary, the last test runs the round trip against bible-rs live.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Library, checkRecord, formatKey, memoryTree, newKey } from "../../../public/sync.js";
import adapter from "../../../public/adapters/bible-rs/index.js";
import { changesSince } from "../../../public/adapters/bible-rs/merge.js";
import { fromRecord, sameContent } from "../../../public/adapters/bible-rs/map.js";

const FIXTURE = join(import.meta.dir, "library");
const DUMP = JSON.parse(readFileSync(join(import.meta.dir, "library.dump.json"), "utf8"));
const GROUPS = ["highlights", "notes", "bookmarks", "plans", "plan_reads"] as const;
type Changes = Record<string, Record<string, unknown>[]>;
type Tree = ReturnType<typeof memoryTree>;

/** A folder on disk, as bible-rs sees it. */
function nodeTree(root: string) {
  const at = (p: string) => join(root, p);
  return {
    async list(path = "") {
      try {
        return readdirSync(at(path), { withFileTypes: true }).map((e) =>
          e.isDirectory() ? { name: e.name, kind: "directory" } : { name: e.name, kind: "file", stamp: `${statSync(join(at(path), e.name)).mtimeMs}` });
      } catch {
        return [];
      }
    },
    async read(path: string) {
      try {
        return readFileSync(at(path), "utf8");
      } catch {
        return null;
      }
    },
    async write(path: string, text: string) {
      mkdirSync(dirname(at(path)), { recursive: true });
      const tmp = `${at(path)}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, at(path));
    },
    async remove(path: string) {
      rmSync(at(path), { recursive: true, force: true });
    },
  } as unknown as Tree;
}

/** A folder tree in memory holding a copy of a folder on disk. */
function memoryCopy(root: string) {
  const files = new Map();
  const walk = (dir: string) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const p = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else files.set(p, { text: readFileSync(join(root, p), "utf8"), stamp: "0" });
    }
  };
  walk("");
  return memoryTree(files);
}

async function device(tree: Tree) {
  const lib = await Library.open({ keyText: await formatKey(newKey()) });
  await lib.use([adapter.adapter(tree)]);
  return lib;
}

/** The adapter's own state for the one library in its folder. */
function study(lib: Library) {
  return Object.values(lib.remote("bible-rs folder").libraries as Record<string, { study: { device: string; entries: object } }>)[0].study;
}

/** Changes in one order, with what serde leaves out left out, to compare. */
function canon(c: Changes): Changes {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted) :
    v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)])) :
    v;
  const out: Changes = {};
  for (const g of GROUPS) out[g] = ((c[g] ?? []).map(sorted) as Record<string, unknown>[]).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return out;
}

/** Everything the adapter holds, as bible-rs's Changes; and a check that Hidden Word's highlights and notes say the same. */
function holds(lib: Library): Changes {
  const all = changesSince(study(lib) as never, 0) as Changes;
  for (const g of ["highlights", "notes"]) {
    for (const c of all[g] ?? []) {
      const ref = `${c.book}.${c.chapter}.${c.verse}`;
      const r = lib.find(g === "notes" ? "note" : "highlight", ref);
      expect([ref, r ? sameContent(g, fromRecord(r)![1], c) : Boolean(c.deleted)]).toEqual([ref, true]);
    }
  }
  return canon(all);
}

describe("a Study Library written by bible-rs", () => {
  test("Hidden Word takes in all of it: its highlights and notes show, and the rest is kept by the adapter", async () => {
    const lib = await device(memoryCopy(FIXTURE));
    expect(holds(lib)).toEqual(canon(DUMP));
    expect(lib.find("highlight", "GEN.1.2")).toBeNull();
    expect(lib.find("note", "JHN.3.17").body).toBe(DUMP.notes.find((n: { verse: number }) => n.verse === 17).body);
    // Core records stay plain Hidden Word records: no bible-rs fields, no bible-rs kinds.
    for (const r of lib.records.values()) {
      expect(checkRecord(r)).toBeNull();
      expect(Object.keys(r).filter((k) => !["kind", "ref", "updated", "deleted", "highlights", "body", "created"].includes(k))).toEqual([]);
    }
    expect(lib.all().every((r) => r.kind === "highlight" || r.kind === "note")).toBe(true);
  });

  test("Hidden Word writes only its own files, and another device reads them back whole", async () => {
    const tree = memoryCopy(FIXTURE);
    const before = new Map([...tree.files].map(([k, v]) => [k, v.text]));
    const hw = await device(tree);
    await hw.put({ ...hw.find("note", "JHN.3.17"), body: "edited in Hidden Word" });
    await hw.put({ kind: "highlight", ref: "PSA.23.1", highlights: [{ color: "orange", created: 1_793_000_000 }] });
    await hw.remove("highlight", "GEN.1.1");
    await hw.sync();
    for (const [k, text] of before) expect(tree.files.get(k)?.text).toBe(text);
    const me = study(hw).device;
    expect([...tree.files.keys()].filter((k) => !before.has(k)).every((k) => k.startsWith(`changes/${me}/`))).toBe(true);
    const other = await device(tree);
    expect(holds(other)).toEqual(holds(hw));
    // The edit followed on from the note that won, so its conflict copy still travels with it.
    const note = holds(other).notes.find((n) => n.verse === 17)!;
    expect([note.body, (note.conflicts as unknown[]).length]).toEqual(["edited in Hidden Word", 1]);
  });

  test("fields a newer bible-rs adds are kept and written back", async () => {
    const tree = memoryTree();
    const hw = await device(tree);
    // From a device that isn't in this folder (an imported backup, say), so Hidden Word passes it on.
    const mark = { book: "JHN", chapter: 1, verse: 1, updated_ms: 1_793_000_000_000, device: "zzzz", label: "x", created: 1, pinned: true };
    await tree.write("changes/dddd/0000000000000001.json", JSON.stringify({ format: 1, device: "dddd", seq: 1, changes: { bookmarks: [mark] } }));
    await hw.sync();
    const written = [...tree.files].filter(([k]) => k.startsWith(`changes/${study(hw).device}/`)).map(([, f]) => JSON.parse(f.text));
    expect(written.flatMap((b) => b.changes.bookmarks ?? [])).toEqual([mark]);
  });

  test("after 64 change files a device folds them into its snapshot, and a new device starts from it", async () => {
    const tree = memoryTree();
    const hw = await device(tree);
    for (let i = 0; i < 70; i++) {
      await hw.put({ kind: "highlight", ref: `GEN.1.${i + 1}`, highlights: [{ color: "blue", created: 1_793_000_000 + i }] });
      await hw.sync();
    }
    const files = [...tree.files.keys()];
    expect(files).toContain(`snapshots/${study(hw).device}.json`);
    expect(files.filter((k) => k.startsWith("changes/")).length).toBeLessThan(10);
    expect(holds(await device(tree))).toEqual(holds(hw));
  });

  test("a note edited on two devices that hadn't seen each other's edit keeps the losing text as a copy", async () => {
    const tree = memoryTree();
    const one = await device(tree);
    await one.put({ kind: "note", ref: "JHN.1.1", body: "first", created: 1_793_000_000 });
    await one.sync();
    const two = await device(tree);
    await two.put({ ...two.find("note", "JHN.1.1"), body: "from two" });
    await one.put({ ...one.find("note", "JHN.1.1"), body: "from one" });
    for (let i = 0; i < 2; i++) {
      await one.sync();
      await two.sync();
    }
    expect(holds(one)).toEqual(holds(two));
    const note = holds(one).notes[0];
    expect([note.body, (note.conflicts as { body: string }[])[0].body].sort()).toEqual(["from one", "from two"]);
    expect(one.find("note", "JHN.1.1").body).toBe(note.body);
  });

  test("ties go to the later device id, as in bible-rs", async () => {
    const tree = memoryTree();
    const hw = await device(tree);
    const change = (device: string, color: string) => ({ format: 1, device, seq: 1, changes: { highlights: [
      { book: "JHN", chapter: 1, verse: 1, updated_ms: 1_793_000_000_000, device, parts: [{ color, start: 0, created: 1, edited: 1 }] },
    ] } });
    await tree.write("changes/bbbb/0000000000000001.json", JSON.stringify(change("bbbb", "green")));
    await tree.write("changes/aaaa/0000000000000001.json", JSON.stringify(change("aaaa", "pink")));
    await hw.sync();
    expect(hw.find("highlight", "JHN.1.1").highlights[0].color).toBe("green");
  });

  test("a half-written file is waited for, not skipped", async () => {
    const tree = memoryTree();
    const hw = await device(tree);
    const batch = (seq: number, verse: number) => JSON.stringify({ format: 1, device: "dddd", seq, changes: { highlights: [
      { book: "JHN", chapter: 1, verse, updated_ms: 1_793_000_000_000 + seq, device: "dddd", parts: [{ color: "blue", start: 0, created: 1, edited: 1 }] },
    ] } });
    await tree.write("changes/dddd/0000000000000001.json", '{"format":1,"dev');
    await tree.write("changes/dddd/0000000000000002.json", batch(2, 2));
    await hw.sync();
    expect(hw.all("highlight")).toHaveLength(0);
    await tree.write("changes/dddd/0000000000000001.json", batch(1, 1));
    await hw.sync();
    expect(hw.all("highlight")).toHaveLength(2);
  });
});

describe("bible-rs exports", () => {
  test("convert, verse by verse", () => {
    const doc = {
      app: "bible-rs", format: 1, exported_at: "2026-10-16T12:00:00Z", translation: "KJV",
      highlights: [
        { reference: "John 3:16", book: "JHN", chapter: 3, verse: 16, color: "yellow", created: "2026-10-14T12:00:00Z" },
        { reference: "John 3:16", book: "JHN", chapter: 3, verse: 16, color: "blue", created: "2026-10-14T12:00:00Z",
          start: 4, end: 26, quote: "God so loved the world", edited: "2026-10-15T12:00:00Z" },
      ],
      notes: [{ reference: "John 3:17", book: "JHN", chapter: 3, verse: 17, note: "sent", created: "2026-10-14T12:00:00Z", updated: "2026-10-15T12:00:00Z" }],
      bookmarks: [{ reference: "Psalm 23:1", book: "PSA", chapter: 23, verse: 1, label: "", created: "2026-10-14T12:00:00Z" }],
    };
    expect(adapter.importFile(JSON.stringify(doc))).toEqual([
      { kind: "highlight", ref: "JHN.3.16", updated: 1792065600, highlights: [
        { color: "yellow", created: 1791979200 },
        { color: "blue", created: 1791979200, start: 4, end: 26, quote: "God so loved the world", edited: 1792065600 },
      ] },
      { kind: "note", ref: "JHN.3.17", updated: 1792065600, created: 1791979200, body: "sent" },
    ]);
    expect(adapter.importFile('{"kind":"note","ref":"JHN.3.16","body":"a library line"}')).toBeNull();
  });

  test("format 2: the stamp counts, so a later export that removed a part wins; conflict copies are kept", async () => {
    const part = (color: string) => ({ reference: "John 3:16", book: "JHN", chapter: 3, verse: 16, color, created: "2026-10-14T12:00:00Z" });
    const first = adapter.importFile(JSON.stringify({ app: "bible-rs", format: 2, highlights: [
      { ...part("yellow"), updated_ms: 1791979200000 }, { ...part("blue"), updated_ms: 1791979200000 },
    ] }))!;
    const second = adapter.importFile(JSON.stringify({ app: "bible-rs", format: 2, highlights: [{ ...part("yellow"), updated_ms: 1792065600000 }],
      notes: [{ book: "JHN", chapter: 3, verse: 17, note: "mine", created: "2026-10-14T12:00:00Z", updated: "2026-10-15T12:00:00Z",
        updated_ms: 1792584000999, device: "d1", conflicts: [{ body: "theirs", updated_ms: 1792584000500, device: "d2", found: 1 }] }],
      deleted: { highlights: [{ book: "JHN", chapter: 1, verse: 1, updated_ms: 1792497600000, device: "d1", deleted: true }] } }))!;
    const lib = await Library.open({ keyText: await formatKey(newKey()) });
    await lib.merge(first);
    await lib.merge(second);
    expect(lib.find("highlight", "JHN.3.16").highlights.map((h: { color: string }) => h.color)).toEqual(["yellow"]);
    expect(lib.find("note", "JHN.3.17")["x-bible-rs-conflicts"]).toEqual([{ body: "theirs", updated: 1792584000, device: "d2" }]);
    expect(lib.find("highlight", "JHN.1.1")).toBeNull();
  });
});

describe.skipIf(!process.env.HWCOMPAT)("round trip with bible-rs itself (HWCOMPAT)", () => {
  const bin = process.env.HWCOMPAT!;
  const run = (...args: string[]) => execFileSync(bin, args, { encoding: "utf8" });
  const dump = (db: string) => canon(JSON.parse(run("dump", db)));

  test("bible-rs → Hidden Word → bible-rs, with nothing lost, then a new bible-rs device from scratch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-bible-rs-"));
    const lib = join(dir, "lib");
    mkdirSync(lib);
    const [a, b, c] = ["a.db", "b.db", "c.db"].map((n) => join(dir, n));
    // bible-rs reads every file Hidden Word writes: nothing left waiting, no problems.
    const syncBr = (db: string) => expect(JSON.parse(run("sync", lib, db))).toMatchObject({ problems: [], waiting: 0 });
    run("seed", lib, a, b);
    cpSync(a, `${a}.seed`);
    const seeded = dump(`${a}.seed`);
    const hw = await device(nodeTree(lib));
    expect(holds(hw)).toEqual(seeded);

    // Edits on both sides: Hidden Word edits the conflicted note, clears a verse and adds one;
    // bible-rs clears a verse Hidden Word has and edits another note.
    await hw.put({ ...hw.find("note", "JHN.3.17"), body: "edited in Hidden Word" });
    await hw.remove("highlight", "GEN.1.1");
    await hw.put({ kind: "highlight", ref: "PSA.23.1", highlights: [{ color: "orange", created: 1_793_000_000 }] });
    run("edit", a, "unhighlight", "PHP", "4", "13");
    run("edit", b, "note", "ROM", "8", "28", "edited on b");
    for (let i = 0; i < 2; i++) {
      syncBr(a);
      syncBr(b);
      await hw.sync();
    }
    syncBr(a);
    syncBr(b);

    const want = dump(a);
    expect(dump(b)).toEqual(want);
    expect(holds(hw)).toEqual(want);
    expect(hw.find("highlight", "PHP.4.13")).toBeNull();
    expect(hw.find("note", "ROM.8.28").body).toBe("edited on b");
    const note = want.notes.find((n) => n.book === "JHN" && n.verse === 17)!;
    expect(note.body).toBe("edited in Hidden Word");
    // The note Hidden Word edited had a conflict copy (whichever of a and b lost the tie); it is still there.
    const bodies = (n: Record<string, unknown>) => (n.conflicts as { body: string }[]).map((k) => k.body);
    expect(bodies(note)).toEqual(bodies(seeded.notes.find((n) => n.book === "JHN" && n.verse === 17)!));
    expect(want.highlights.find((h) => h.book === "GEN" && h.verse === 1)!.deleted).toBe(true);
    // Hidden Word can't show these; they come back exactly as bible-rs wrote them.
    for (const g of ["bookmarks", "plans", "plan_reads"]) expect(want[g]).toEqual(seeded[g]);
    expect(want.bookmarks).toHaveLength(1);

    // Hidden Word passes 64 change files and folds them into its snapshot; a new bible-rs device reads it all.
    for (let i = 0; i < 66; i++) {
      await hw.put({ kind: "highlight", ref: `EXO.1.${i + 1}`, highlights: [{ color: "green", created: 1_793_000_000 + i }] });
      await hw.sync();
    }
    const me = study(hw).device;
    expect(readdirSync(join(lib, "snapshots"))).toContain(`${me}.json`);
    expect(readdirSync(join(lib, "changes", me)).every((f) => Number(f.slice(0, 16)) > 64)).toBe(true);
    syncBr(c);
    syncBr(a);
    await hw.sync();
    expect(dump(c)).toEqual(dump(a));
    expect(holds(hw)).toEqual(dump(c));
    rmSync(dir, { recursive: true, force: true });
  });
});
