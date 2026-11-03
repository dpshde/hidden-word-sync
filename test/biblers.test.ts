// Hidden Word as a device in a bible-rs Study Library (spec 2.2). The fixture folder and its dump
// were written by bible-rs's own code (test/bible-rs/hwcompat.rs, run against bible-rs PR #81 at
// d393e4d). With HWCOMPAT set to that harness's binary, the last test runs the round trip live.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Library, formatKey, newKey } from "../public/sync.js";
import { bibleRsTransport, fromChange, memoryTree, toChange } from "../public/biblers.js";

const FIXTURE = join(import.meta.dir, "fixtures/bible-rs-library");
const DUMP = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/bible-rs-library.dump.json"), "utf8"));
const GROUPS = ["highlights", "notes", "bookmarks", "plans", "plan_reads"] as const;
type Changes = Record<string, Record<string, unknown>[]>;

/** A folder on disk, as bible-rs sees it. */
function nodeTree(root: string) {
  const at = (p: string) => join(root, p);
  return {
    async list(path: string) {
      try {
        return readdirSync(at(path), { withFileTypes: true }).map((e) => {
          if (e.isDirectory()) return { name: e.name, kind: "directory" };
          const s = statSync(join(at(path), e.name));
          return { name: e.name, kind: "file", stamp: `${s.size}-${s.mtimeMs}` };
        });
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
  };
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

async function device(tree: ReturnType<typeof memoryTree> | ReturnType<typeof nodeTree>) {
  const lib = await Library.open({ keyText: await formatKey(newKey()) });
  await lib.use([bibleRsTransport(tree)]);
  return lib;
}

/** Everything a library holds that bible-rs can, as bible-rs's Changes. */
function project(lib: Library): Changes {
  const out: Changes = Object.fromEntries(GROUPS.map((g) => [g, []]));
  for (const r of lib.records.values()) {
    const c = toChange(r);
    if (c) out[c[0]].push(c[1]);
  }
  return canon(out);
}

/** Changes in one order, with what serde leaves out left out, to compare. */
function canon(c: Changes): Changes {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted) :
    v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)])) :
    v;
  const out: Changes = {};
  for (const g of GROUPS) {
    out[g] = ((c[g] ?? []).map(sorted) as Record<string, unknown>[]).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  }
  return out;
}

describe("bible-rs records", () => {
  test("every change bible-rs wrote converts to a record and back unchanged", () => {
    for (const g of GROUPS) {
      for (const c of DUMP[g] ?? []) expect(canon({ [g]: [toChange(fromChange(g, c))![1]] })).toEqual(canon({ [g]: [c] }));
    }
  });

  test("fields a newer bible-rs adds are kept and written back", () => {
    const c = { book: "JHN", chapter: 1, verse: 1, updated_ms: 1_790_000_000_000, device: "d1", label: "", created: 1, pinned: true };
    expect(toChange(fromChange("bookmarks", c))![1]).toEqual(c);
  });

  test("colors bible-rs lacks go out as yellow, and parts get the times bible-rs requires", () => {
    const [, c] = toChange({ kind: "highlight", ref: "JHN.1.1", updated: 5, highlights: [{ color: "c-teal" }] })!;
    expect(c).toEqual({ book: "JHN", chapter: 1, verse: 1, updated_ms: 5000, device: "", parts: [{ color: "yellow", start: 0, created: 5, edited: 5 }] });
    expect(toChange({ kind: "note", ref: "JHN.3.16-18", updated: 5, body: "a range" })).toBeNull();
  });
});

describe("a Study Library written by bible-rs", () => {
  test("Hidden Word reads all of it: highlights, notes with conflict copies, tombstones, bookmarks, plans", async () => {
    const lib = await device(memoryCopy(FIXTURE));
    expect(project(lib)).toEqual(canon(DUMP));
    expect(lib.find("note", "JHN.3.17").conflicts[0].body).toBe("edited on a");
    expect(lib.find("highlight", "GEN.1.2")).toBeNull();
    expect(lib.all("x-bible-rs-bookmark")).toHaveLength(1);
  });

  test("Hidden Word writes only its own files, and another device reads them back whole", async () => {
    const tree = memoryCopy(FIXTURE);
    const before = new Map([...tree.files].map(([k, v]) => [k, v.text]));
    const hw = await device(tree);
    const note = hw.find("note", "JHN.3.17");
    await hw.put({ ...note, body: "edited in Hidden Word" });
    await hw.put({ kind: "highlight", ref: "PSA.23.1", highlights: [{ color: "orange", created: 1_793_000_000 }] });
    await hw.remove("highlight", "GEN.1.1");
    await hw.sync();
    for (const [k, text] of before) expect(tree.files.get(k)?.text).toBe(text);
    const mine = [...tree.files.keys()].filter((k) => !before.has(k));
    expect(mine.every((k) => k.startsWith(`changes/${hw.state.device}/`))).toBe(true);
    const other = await device(tree);
    expect(project(other)).toEqual(project(hw));
    // The edit followed on from the note that won, so its conflict copy travels with it.
    expect(other.find("note", "JHN.3.17").conflicts[0].body).toBe("edited on a");
  });

  test("after 64 change files a device folds them into its snapshot, and a new device starts from it", async () => {
    const tree = memoryTree();
    const hw = await device(tree);
    for (let i = 0; i < 70; i++) {
      await hw.put({ kind: "highlight", ref: `GEN.1.${i + 1}`, highlights: [{ color: "blue", created: 1_793_000_000 + i }] });
      await hw.sync();
    }
    const files = [...tree.files.keys()];
    expect(files).toContain(`snapshots/${hw.state.device}.json`);
    expect(files.filter((k) => k.startsWith("changes/")).length).toBeLessThan(10);
    const fresh = await device(tree);
    expect(project(fresh)).toEqual(project(hw));
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
    expect(project(one)).toEqual(project(two));
    const note = one.find("note", "JHN.1.1");
    expect([note.body, note.conflicts.map((k: { body: string }) => k.body)[0]].sort()).toEqual(["from one", "from two"]);
    // A later edit on either follows on from both, so it raises no new copy.
    await two.put({ ...two.find("note", "JHN.1.1"), body: "settled" });
    await two.sync();
    await one.sync();
    expect(one.find("note", "JHN.1.1").body).toBe("settled");
    expect(one.find("note", "JHN.1.1").conflicts).toHaveLength(1);
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
    const syncBr = (db: string) => {
      const r = JSON.parse(run("sync", lib, db));
      expect([r.problems, r.waiting]).toEqual([[], 0]);
    };
    run("seed", lib, a, b);
    cpSync(a, a + ".seed");
    const hw = await device(nodeTree(lib));
    expect(project(hw)).toEqual(dump(a));

    // Edits on both sides: Hidden Word edits the conflicted note, clears a verse, adds one; bible-rs
    // clears a verse Hidden Word has and edits another note.
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
    expect(project(hw)).toEqual(want);
    // What each side did reached the others, and bookmarks, plans and conflict copies came through.
    expect(hw.find("highlight", "PHP.4.13")).toBeNull();
    expect(hw.find("note", "ROM.8.28").body).toBe("edited on b");
    const note = want.notes.find((n) => n.book === "JHN" && n.verse === 17)!;
    expect(note.body).toBe("edited in Hidden Word");
    // The note Hidden Word edited had a conflict copy (whichever of a and b lost the tie); it is still there.
    const bodies = (n: Record<string, unknown>) => (n.conflicts as { body: string }[]).map((k) => k.body);
    expect(bodies(note)).toEqual(bodies(dump(a + ".seed").notes.find((n) => n.book === "JHN" && n.verse === 17)!));
    expect(bodies(note)).toHaveLength(1);
    expect(want.highlights.find((h) => h.book === "GEN" && h.verse === 1)!.deleted).toBe(true);
    // Hidden Word can't show these; they come back exactly as bible-rs wrote them.
    const seeded = dump(a + ".seed");
    for (const g of ["bookmarks", "plans", "plan_reads"]) expect(want[g]).toEqual(seeded[g]);
    expect(want.bookmarks).toHaveLength(1);

    // Hidden Word passes 64 change files and folds them into its snapshot; a new bible-rs device reads it all.
    for (let i = 0; i < 66; i++) {
      await hw.put({ kind: "highlight", ref: `EXO.1.${i + 1}`, highlights: [{ color: "green", created: 1_793_000_000 + i }] });
      await hw.sync();
    }
    expect(readdirSync(join(lib, "snapshots"))).toContain(`${hw.state.device}.json`);
    // Its files up to the snapshot are gone.
    expect(readdirSync(join(lib, "changes", hw.state.device)).every((f) => Number(f.slice(0, 16)) > 64)).toBe(true);
    syncBr(c);
    syncBr(a);
    await hw.sync();
    expect(dump(c)).toEqual(dump(a));
    expect(project(hw)).toEqual(dump(c));
    rmSync(dir, { recursive: true, force: true });
  });
});
