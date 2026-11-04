// Range writes and grouped reads (ranges.js, Library.highlightRange / highlights, the MCP tools), and
// that a range reaches the server as one POST: all of it or none, under the grant scopes it needs.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIGRATIONS, d1 } from "./d1";
import { LIMITS, handle } from "../src/worker";
import { MAX_RANGE_VERSES, expandRange, rangeWrites } from "../public/ranges.js";
import { Library, batches, deriveKeys, encryptRecord, formatKey, memoryStore, newKey, parseKey, serverTransport } from "../public/sync.js";

const vectors = JSON.parse(readFileSync(new URL("./ranges-vectors.json", import.meta.url), "utf8"));

function server() {
  const sqlite = new Database(":memory:");
  for (const m of MIGRATIONS) sqlite.exec(m);
  const env = { DB: d1(sqlite) };
  const posts: number[] = [];
  let failPosts = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(new URL(String(input), "http://local"), init);
    if (req.method === "POST" && req.url.includes("/v1/lib/")) {
      const body = await req.clone().json().catch(() => null);
      if (failPosts > 0) {
        failPosts--;
        return new Response('{"error":"down"}', { status: 503 });
      }
      posts.push(body?.items?.length ?? 0);
    }
    return handle(req, env);
  };
  const count = (lib: string) => (sqlite.query("SELECT COUNT(*) AS n FROM items WHERE lib = ?").get(lib) as { n: number }).n;
  return { sqlite, env, fetch, posts, count, failNext: (n = 1) => (failPosts = n) };
}

async function openLibrary(s: ReturnType<typeof server>) {
  const lib = await Library.open({ keyText: await formatKey(newKey()), store: memoryStore() });
  await lib.use([serverTransport({ fetch: s.fetch as typeof fetch })]);
  return lib;
}

describe("vectors: range writes (test/ranges-vectors.json)", () => {
  for (const c of vectors.expand) {
    test(`expand ${c.ref}`, () => expect(expandRange(c.ref, c.max ? { max: c.max } : {})).toEqual(c.expect));
  }
  for (const c of vectors.rangeWrites) {
    test(`range write: ${c.name}`, () => {
      const live = new Map(c.existing.filter((r: any) => !r.deleted).map((r: any) => [r.ref, r]));
      const w = rangeWrites(c.ref, c.color, c.t, (v) => live.get(v) ?? null) as any;
      expect(w.error ? { error: w.error } : { ref: w.ref, verses: w.verses, records: w.records.map((r: object) => JSON.stringify(r)) }).toEqual(c.expect);
    });
  }
  test("the cap is one POST's worth of items", () => expect(MAX_RANGE_VERSES).toBe(LIMITS.itemsPerPost));
  test("verseCount refuses verses past the chapter's end", () => {
    expect(expandRange("JUD.1.24-26", { verseCount: () => 25 }).error).toBe("past the end of the chapter");
    expect(expandRange("JUD.1.24-25", { verseCount: () => 25 }).verses).toEqual(["JUD.1.24", "JUD.1.25"]);
  });
});

describe("grouped read: Library.highlights({ group: 'ranges' }) is the same rule as the vectors", () => {
  for (const [name, c] of Object.entries<any>(vectors.ranges)) {
    test(name, async () => {
      const lib = await Library.open({ keyText: await formatKey(newKey()), store: memoryStore() });
      await lib.merge(c.records);
      expect(lib.highlights({ group: "ranges" })).toEqual(c.canonical);
    });
  }
  test("the default read is unchanged: live records, one per verse, canonical order", async () => {
    const lib = await Library.open({ keyText: await formatKey(newKey()), store: memoryStore() });
    await lib.merge(vectors.ranges.outOfOrderInput.records);
    const plain = lib.highlights();
    expect(plain.map((r: any) => r.ref)).toEqual(["JHN.3.16", "JHN.3.17", "JHN.3.18"]);
    expect(plain[0]).toEqual(lib.find("highlight", "JHN.3.16"));
    expect(lib.highlights({ group: "verses" })).toEqual(plain);
    expect(() => lib.highlights({ group: "chapters" } as any)).toThrow();
  });
  test("a grouped read uses the library's own colors", async () => {
    const lib = await Library.open({ keyText: await formatKey(newKey()), store: memoryStore() });
    await lib.put({ kind: "color", ref: "c-abc", name: "Prayer", hex: "#3a7bd5" });
    await lib.highlightRange("ROM.8.26-27", "c-abc");
    expect(lib.highlights({ group: "ranges" }).map((r: any) => [r.ref, r.color, r.verses])).toEqual([["ROM.8.26-27", "c-abc", ["ROM.8.26", "ROM.8.27"]]]);
  });
});

describe("range write: Library.highlightRange", () => {
  test("writes one record per verse, and repeating it writes nothing", async () => {
    const s = server();
    const lib = await openLibrary(s);
    const first = await lib.highlightRange("ROM.5.3-5", "green");
    await lib.sync();
    expect(first).toEqual({ ref: "ROM.5.3-5", verses: ["ROM.5.3", "ROM.5.4", "ROM.5.5"], written: ["ROM.5.3", "ROM.5.4", "ROM.5.5"] });
    expect(s.count(lib.lib)).toBe(3);
    expect(s.posts).toEqual([3]);
    const before = lib.highlights().map((r: any) => r.updated);
    const again = await lib.highlightRange("ROM.5.3-5", "green");
    await lib.sync();
    expect(again.written).toEqual([]);
    expect(lib.highlights().map((r: any) => r.updated)).toEqual(before);
    expect(s.posts).toEqual([3]);
  });
  test("a verse in another color takes the new color and keeps when it was first highlighted", async () => {
    const lib = await Library.open({ keyText: await formatKey(newKey()), store: memoryStore() });
    await lib.highlightRange("ROM.5.4", "yellow");
    const created = lib.find("highlight", "ROM.5.4").highlights[0].created;
    const w = await lib.highlightRange("ROM.5.3-5", "blue");
    expect(w.written).toEqual(["ROM.5.3", "ROM.5.4", "ROM.5.5"]);
    expect(lib.find("highlight", "ROM.5.4").highlights).toHaveLength(1);
    expect(lib.find("highlight", "ROM.5.4").highlights[0].color).toBe("blue");
    expect(lib.find("highlight", "ROM.5.4").highlights[0].created).toBe(created);
  });
  test("a bad range throws and saves nothing", async () => {
    const lib = await Library.open({ keyText: await formatKey(newKey()), store: memoryStore() });
    for (const ref of ["ROM.5.5-3", "ROM.5.3-ROM.6.2", "PSA.119.1-176", "ROM.5", "nope"]) {
      await expect(lib.highlightRange(ref, "yellow")).rejects.toThrow();
    }
    await expect(lib.highlightRange("ROM.5.3-5", "")).rejects.toThrow();
    expect(lib.all()).toEqual([]);
  });
  test("putMany is all or nothing on the device too", async () => {
    const lib = await Library.open({ keyText: await formatKey(newKey()), store: memoryStore() });
    await expect(lib.putMany([{ kind: "highlight", ref: "ROM.5.3", highlights: [{ color: "yellow" }] }, { kind: "nope", ref: "x" }])).rejects.toThrow();
    expect(lib.all()).toEqual([]);
  });
});

describe("atomic: a range reaches the server in one POST", () => {
  test("batches keep a group whole when it fits, in order", () => {
    const ids = [...Array(98).keys()].map((i) => `s${i}`).concat(["a", "b", "c", "d", "e"], ["z"]);
    const group = (id: string) => ("abcde".includes(id) ? 99 : undefined);
    expect(batches(ids, group).map((b) => b.length)).toEqual([98, 6]);
    expect(batches(ids).map((b) => b.length)).toEqual([100, 4]);
    expect(batches([...Array(250).keys()].map(String), () => 1).map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches(ids, group).flat()).toEqual(ids);
  });
  test("with 98 unsent edits ahead of it, a 5-verse range still goes in one POST", async () => {
    const s = server();
    const lib = await openLibrary(s);
    s.failNext(1000);
    for (let v = 1; v <= 98; v++) await lib.put({ kind: "highlight", ref: `PSA.119.${v}`, highlights: [{ color: "yellow", created: 1 }] });
    await lib.highlightRange("ROM.5.1-5", "green");
    await lib.sync();
    expect(s.count(lib.lib)).toBe(0);
    s.failNext(0);
    await lib.sync();
    expect(s.posts).toEqual([98, 5]);
    expect(s.count(lib.lib)).toBe(103);
  });
  test("a failed POST leaves none of the range on the server, and the retry sends all of it", async () => {
    const s = server();
    const lib = await openLibrary(s);
    s.failNext(1000);
    await lib.highlightRange("JHN.3.16-18", "pink");
    await lib.sync();
    expect(s.count(lib.lib)).toBe(0);
    s.failNext(0);
    await lib.sync();
    expect(s.posts).toEqual([3]);
    expect(s.count(lib.lib)).toBe(3);
  });
  test("the server's D1 batch rolls back every verse when one can't fit", async () => {
    const s = server();
    const keys = await deriveKeys(await parseKey(await formatKey(newKey())));
    const owner = { authorization: `Bearer ${keys.auth}`, "content-type": "application/json" };
    const one = await encryptRecord(keys, { kind: "highlight", ref: "ROM.5.2", highlights: [{ color: "yellow" }], updated: 1 });
    expect((await s.fetch(`/v1/lib/${keys.lib}`, { method: "POST", headers: owner, body: JSON.stringify({ items: [one] }) })).status).toBe(200);
    const items = await Promise.all(["ROM.5.3", "ROM.5.4", "ROM.5.5"].map((ref) => encryptRecord(keys, { kind: "highlight", ref, highlights: [{ color: "yellow" }], updated: 1 })));
    // Room for two of the three new items, not all three.
    s.sqlite.query("UPDATE libs SET size = ? WHERE lib = ?").run(LIMITS.libraryChars - one.blob.length * 3 + 1, keys.lib);
    const res = await s.fetch(`/v1/lib/${keys.lib}`, { method: "POST", headers: owner, body: JSON.stringify({ items }) });
    expect(res.status).toBe(413);
    expect(s.count(keys.lib)).toBe(1);
  });
});

describe("scopes: a range write needs highlights:write; reads need read", () => {
  async function granted(scopes: string[]) {
    const s = server();
    const keys = await deriveKeys(await parseKey(await formatKey(newKey())));
    const owner = { authorization: `Bearer ${keys.auth}`, "content-type": "application/json" };
    const seed = await encryptRecord(keys, { kind: "highlight", ref: "JHN.1.1", highlights: [{ color: "yellow" }], updated: 1 });
    await s.fetch(`/v1/lib/${keys.lib}`, { method: "POST", headers: owner, body: JSON.stringify({ items: [seed] }) });
    const g = await (await s.fetch(`/v1/grant/${keys.lib}`, { method: "POST", headers: owner, body: JSON.stringify({ scopes, client: "https://route.bible" }) })).json();
    const w = rangeWrites("ROM.5.3-5", "green", 1000) as { records: object[] };
    const items = await Promise.all(w.records.map((r) => encryptRecord(keys, { ...r, updated: 1000 })));
    const headers = { authorization: `Bearer ${g.token}`, "content-type": "application/json" };
    const post = await s.fetch(`/v1/lib/${keys.lib}`, { method: "POST", headers, body: JSON.stringify({ items }) });
    const get = await s.fetch(`/v1/lib/${keys.lib}`, { headers });
    return { post: post.status, get: get.status, count: s.count(keys.lib) };
  }
  test("a read grant reads, and is refused the range write (403, nothing saved)", async () => {
    expect(await granted(["read"])).toEqual({ post: 403, get: 200, count: 1 });
  });
  test("a highlights:write grant saves the whole range in one POST", async () => {
    expect(await granted(["highlights:write", "read"])).toEqual({ post: 200, get: 200, count: 4 });
  });
  test("a write-only grant can't read", async () => {
    expect((await granted(["highlights:write"])).get).toBe(403);
  });
});
