import { describe, expect, setSystemTime, test } from "bun:test";
import { MIGRATIONS, d1 } from "./d1";
import { Database } from "bun:sqlite";
import * as entry from "../src/worker";
import { LIMITS, handle, pageLimit } from "../src/worker";
import {
  Library, deriveKeys, encryptRecord, folderTransport, formatKey, memoryDir, memoryStore, newKey, openSlot, parseJsonl, parseKey,
  saveSlot, serverTransport, slotKeys,
} from "../public/sync.js";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function setup() {
  const sqlite = new Database(":memory:");
  for (const m of MIGRATIONS) sqlite.exec(m);
  const env = { DB: d1(sqlite) };
  const fetch: Fetch = async (input, init) => handle(new Request(new URL(String(input), "http://local"), init), env);
  return { sqlite, env, fetch };
}

async function keysFor() {
  const keyText = await formatKey(newKey());
  return { keyText, keys: await deriveKeys(await parseKey(keyText)) };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const post = (fetch: Fetch, lib: string, token: string, items: unknown[]) =>
  fetch(`/v1/lib/${lib}`, { method: "POST", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify({ items }) });
const hl = (ref: string, color: string, extra = {}) => ({ kind: "highlight", ref, highlights: [{ color, created: 1 }], ...extra });
const colors = (lib: Library) =>
  Object.fromEntries(lib.all("highlight").map((r) => [r.ref, r.highlights[0].color]).sort());

/** A device: its own storage, syncing through whatever it's given. */
async function device(keyText: string, transports: unknown[] = [], store = memoryStore()) {
  return Library.open({ keyText, store, transports: transports as never[] });
}

describe("save links", () => {
  test("/save serves the web app, which does the saving", async () => {
    const { env } = setup();
    const seen: string[] = [];
    const ASSETS = { fetch: async (r: Request) => (seen.push(new URL(r.url).pathname + new URL(r.url).search), new Response("app")) } as unknown as Fetcher;
    const res = await handle(new Request("http://local/save?ref=John+3:16&color=blue"), { ...env, ASSETS });
    expect(await res.text()).toBe("app");
    expect(seen).toEqual(["/"]);
    expect((await handle(new Request("http://local/save", { method: "POST" }), { ...env, ASSETS })).status).toBe(404);
  });

  test("/config.json serves the YouVersion app key when the secret is set, and null when not", async () => {
    const { env } = setup();
    const off = await handle(new Request("http://local/config.json"), env);
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ yvpPublicAppKey: null });
    const on = await handle(new Request("http://local/config.json"), { ...env, YVP_PUBLIC_APP_KEY: "k-123" });
    expect(await on.json()).toEqual({ yvpPublicAppKey: "k-123" });
    expect(on.headers.get("cache-control")).toBe("no-store");
  });
});

describe("canonical address", () => {
  const OLD = "https://hidden-word.dpshade.workers.dev";
  const CANONICAL_ORIGIN = "https://vault.selah.tools";
  const assets = () => ({ fetch: async () => new Response("page") }) as unknown as Fetcher;

  test("the Worker module exports only functions and objects, which workerd accepts as entrypoints", () => {
    for (const [name, value] of Object.entries(entry)) expect([name, typeof value]).toEqual([name, typeof value === "function" ? "function" : "object"]);
  });

  test("pages on the old workers.dev address redirect to vault.selah.tools, same path and query", async () => {
    const { env } = setup();
    for (const path of ["/", "/unlock?app=x&callback=https%3A%2F%2Fa.test", "/save?ref=JHN.3.16&color=blue", "/app.js"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await handle(new Request(OLD + path, { method }), { ...env, ASSETS: assets() });
        expect(res.status).toBe(308);
        expect(res.headers.get("location")).toBe(CANONICAL_ORIGIN + path);
      }
    }
  });

  test("API paths keep answering on the old address, and only GET and HEAD redirect", async () => {
    const { env } = setup();
    const lib = "0".repeat(32);
    expect((await handle(new Request(`${OLD}/v1/lib/${lib}`), env)).status).toBe(401);
    expect((await handle(new Request(`${OLD}/v1/lib/${lib}`, { method: "OPTIONS" }), env)).status).toBe(204);
    expect((await handle(new Request(`${OLD}/mcp`), env)).status).toBe(405);
    const rpc = {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    };
    expect((await handle(new Request(`${OLD}/mcp`, rpc), env)).status).toBe(401);
    expect((await handle(new Request(`${OLD}/config.json`), env)).status).toBe(200);
    expect((await handle(new Request(`${OLD}/api/client-error`, { method: "POST", body: "{}" }), env)).status).not.toBe(308);
    expect((await handle(new Request(`${OLD}/`, { method: "POST" }), env)).status).toBe(404);
  });

  test("vault.selah.tools and the sync.selah.tools alias serve pages directly", async () => {
    const { env } = setup();
    for (const host of ["https://vault.selah.tools", "https://sync.selah.tools"]) {
      const res = await handle(new Request(`${host}/unlock`), { ...env, ASSETS: assets() });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("page");
    }
  });
});

describe("server", () => {
  test("first write claims a library; other tokens are refused", async () => {
    const { fetch } = setup();
    const { keys } = await keysFor();
    const item = await encryptRecord(keys, hl("JHN.3.16", "yellow"));
    expect((await post(fetch, keys.lib, keys.auth, [item])).status).toBe(200);
    const other = "A".repeat(43);
    expect((await post(fetch, keys.lib, other, [item])).status).toBe(401);
    expect((await fetch(`/v1/lib/${keys.lib}`, { headers: auth(other) })).status).toBe(401);
    expect((await fetch(`/v1/lib/${keys.lib}`)).status).toBe(401);
  });

  test("keeps only the latest blob per id, each write with a new seq, under one epoch", async () => {
    const { fetch } = setup();
    const { keys } = await keysFor();
    const a = await encryptRecord(keys, hl("JHN.3.16", "yellow"));
    const b = await encryptRecord(keys, hl("JHN.3.17", "blue"));
    const a2 = await encryptRecord(keys, hl("JHN.3.16", "pink"));
    const first = await (await post(fetch, keys.lib, keys.auth, [a, b])).json();
    expect(first.seq).toBe(2);
    expect(first.epoch).toMatch(/^[0-9a-f]{24}$/);
    expect(await (await post(fetch, keys.lib, keys.auth, [a2])).json()).toEqual({ seq: 3, epoch: first.epoch });
    const all = await (await fetch(`/v1/lib/${keys.lib}?after=0`, { headers: auth(keys.auth) })).json();
    expect(all.items.map((i: { seq: number; id: string }) => [i.seq, i.id])).toEqual([[2, b.id], [3, a2.id]]);
    expect([all.seq, all.epoch]).toEqual([3, first.epoch]);
    const since = await (await fetch(`/v1/lib/${keys.lib}?after=2`, { headers: auth(keys.auth) })).json();
    expect(since).toEqual({ items: [{ seq: 3, id: a2.id, blob: a2.blob }], more: false, seq: 3, epoch: first.epoch });
  });

  test("pages through more than one page", async () => {
    const { fetch } = setup();
    const { keys } = await keysFor();
    const blob = (await encryptRecord(keys, hl("GEN.1.1", "yellow"))).blob;
    for (let start = 0; start < LIMITS.pageSize + 20; start += 100) {
      const items = Array.from({ length: 100 }, (_, i) => ({ id: `id${String(start + i).padStart(20, "0")}`, blob }));
      expect((await post(fetch, keys.lib, keys.auth, items)).status).toBe(200);
    }
    const first = await (await fetch(`/v1/lib/${keys.lib}`, { headers: auth(keys.auth) })).json();
    expect(first.items).toHaveLength(LIMITS.pageSize);
    expect(first.more).toBe(true);
    const rest = await (await fetch(`/v1/lib/${keys.lib}?after=${first.items.at(-1).seq}`, { headers: auth(keys.auth) })).json();
    expect(rest.items).toHaveLength(100);
    expect(rest.more).toBe(false);
  });

  test("limit caps a page, clamped to 1..500", async () => {
    const { fetch } = setup();
    const { keys } = await keysFor();
    const blob = (await encryptRecord(keys, hl("GEN.1.1", "yellow"))).blob;
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `id${String(i).padStart(20, "0")}`, blob }));
    expect((await post(fetch, keys.lib, keys.auth, items)).status).toBe(200);
    const page = async (q: string) => (await fetch(`/v1/lib/${keys.lib}?${q}`, { headers: auth(keys.auth) })).json();
    const two = await page("limit=2");
    expect(two.items.map((i: { seq: number }) => i.seq)).toEqual([1, 2]);
    expect(two.more).toBe(true);
    const next = await page("after=2&limit=2");
    expect(next.items.map((i: { seq: number }) => i.seq)).toEqual([3, 4]);
    expect((await page("after=4&limit=2")).more).toBe(false);
    expect((await page("limit=0")).items).toHaveLength(1);
    expect((await page("limit=-3")).items).toHaveLength(1);
    expect((await page("limit=abc")).items).toHaveLength(5);
    expect((await page("limit=9999")).more).toBe(false);
    expect([pageLimit("2.7"), pageLimit(""), pageLimit(null), pageLimit("9999")]).toEqual([2, 500, 500, 500]);
  });

  test("rejects malformed requests", async () => {
    const { fetch } = setup();
    const { keys } = await keysFor();
    const ok = await encryptRecord(keys, hl("GEN.1.1", "yellow"));
    expect((await post(fetch, keys.lib, keys.auth, [])).status).toBe(400);
    expect((await post(fetch, keys.lib, keys.auth, [{ id: "short", blob: ok.blob }])).status).toBe(400);
    expect((await post(fetch, keys.lib, keys.auth, [{ id: ok.id, blob: "tiny" }])).status).toBe(400);
    expect((await post(fetch, keys.lib, keys.auth, [{ id: ok.id, blob: "A".repeat(LIMITS.blobChars + 1) }])).status).toBe(400);
    expect((await post(fetch, keys.lib, keys.auth, Array(LIMITS.itemsPerPost + 1).fill(ok))).status).toBe(400);
    expect((await fetch(`/v1/lib/${keys.lib}?after=-1`, { headers: auth(keys.auth) })).status).toBe(400);
    expect((await fetch(`/v1/lib/nope`, { headers: auth(keys.auth) })).status).toBe(404);
    expect((await fetch(`/elsewhere`)).status).toBe(404);
  });

  test("answers CORS preflight for apps on other origins", async () => {
    const { fetch } = setup();
    const res = await fetch(`/v1/lib/${"0".repeat(32)}`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  test("erasing a library removes everything; the next write starts a new epoch", async () => {
    const { fetch } = setup();
    const { keys } = await keysFor();
    const item = await encryptRecord(keys, hl("GEN.1.1", "yellow"));
    const { epoch } = await (await post(fetch, keys.lib, keys.auth, [item])).json();
    expect((await fetch(`/v1/lib/${keys.lib}`, { method: "DELETE", headers: auth(keys.auth) })).status).toBe(204);
    expect(await (await fetch(`/v1/lib/${keys.lib}`, { headers: auth(keys.auth) })).json()).toEqual({ items: [], more: false, seq: 0, epoch: null });
    const again = await (await post(fetch, keys.lib, keys.auth, [item])).json();
    expect(again.epoch).not.toBe(epoch);
  });
});

describe("library size", () => {
  const size = (sqlite: Database, lib: string) =>
    sqlite.query("SELECT size, (SELECT COALESCE(SUM(LENGTH(blob)), 0) FROM items WHERE lib = ?1) AS actual FROM libs WHERE lib = ?1").get(lib) as
      { size: number; actual: number };

  test("is kept by every write: new items add, replaced ones swap their old size for the new", async () => {
    const { sqlite, fetch } = setup();
    const { keys } = await keysFor();
    const a = await encryptRecord(keys, hl("JHN.3.16", "yellow"));
    const b = await encryptRecord(keys, hl("JHN.3.17", "blue"));
    await post(fetch, keys.lib, keys.auth, [a, b]);
    expect(size(sqlite, keys.lib)).toEqual({ size: a.blob.length + b.blob.length, actual: a.blob.length + b.blob.length });
    const big = { id: a.id, blob: "A".repeat(LIMITS.blobChars) };
    await post(fetch, keys.lib, keys.auth, [big, big]);
    const after = size(sqlite, keys.lib);
    expect(after.size).toBe(after.actual);
    expect(after.size).toBe(LIMITS.blobChars + b.blob.length);
  });

  test("a write past the limit is refused whole, and replacing items still fits", async () => {
    const { sqlite, fetch } = setup();
    const { keys } = await keysFor();
    const batch = (start: number) =>
      Array.from({ length: 100 }, (_, i) => ({ id: `id${String(start + i).padStart(20, "0")}`, blob: "A".repeat(LIMITS.blobChars) }));
    for (const start of [0, 100, 200]) expect((await post(fetch, keys.lib, keys.auth, batch(start))).status).toBe(200);
    const before = sqlite.query("SELECT seq, size FROM libs").get();
    const res = await post(fetch, keys.lib, keys.auth, batch(300));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "library is full" });
    expect(sqlite.query("SELECT seq, size FROM libs").get()).toEqual(before);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 300 });
    expect((await post(fetch, keys.lib, keys.auth, batch(100))).status).toBe(200);
    expect(size(sqlite, keys.lib).size).toBe(300 * LIMITS.blobChars);
  });

  test("a refused token changes nothing: no claim, no items, no erasing", async () => {
    const { sqlite, fetch } = setup();
    const { keys } = await keysFor();
    const item = await encryptRecord(keys, hl("JHN.3.16", "yellow"));
    await post(fetch, keys.lib, keys.auth, [item]);
    const before = sqlite.query("SELECT * FROM libs").all();
    const other = "B".repeat(43);
    expect((await post(fetch, keys.lib, other, [{ id: "x".repeat(22), blob: item.blob }])).status).toBe(401);
    expect((await fetch(`/v1/lib/${keys.lib}`, { method: "DELETE", headers: auth(other) })).status).toBe(401);
    expect(sqlite.query("SELECT * FROM libs").all()).toEqual(before);
    expect(sqlite.query("SELECT id FROM items").all()).toEqual([{ id: item.id }]);
  });

  test("the migration fills in the size of libraries written before it", () => {
    const sqlite = new Database(":memory:");
    for (const m of MIGRATIONS.slice(0, 2)) sqlite.exec(m);
    sqlite.query("INSERT INTO libs (lib, auth_hash, seq, epoch) VALUES ('a', 'h', 2, 'e'), ('b', 'h', 0, 'e')").run();
    sqlite.query("INSERT INTO items (lib, id, seq, blob) VALUES ('a', '1', 1, 'xxx'), ('a', '2', 2, 'yyyyy')").run();
    sqlite.exec(MIGRATIONS[2]);
    expect(sqlite.query("SELECT lib, size FROM libs ORDER BY lib").all()).toEqual([{ lib: "a", size: 8 }, { lib: "b", size: 0 }]);
  });
});

describe("passkey slots", () => {
  test("save, open, and refuse another token", async () => {
    const { fetch } = setup();
    const prf = new Uint8Array(32).fill(7);
    expect(await openSlot({ prf, fetch })).toBeNull();
    await saveSlot({ prf, keyText: "KEY", name: "Personal", fetch });
    expect(await openSlot({ prf, fetch })).toEqual({ key: "KEY", name: "Personal" });
    await saveSlot({ prf, keyText: "KEY2", name: "Personal", fetch });
    expect(await openSlot({ prf, fetch })).toEqual({ key: "KEY2", name: "Personal" });
    const slotId = (await slotKeys(prf)).slot;
    const res = await fetch(`/v1/slot/${slotId}`, { method: "PUT", headers: { ...auth("B".repeat(43)), "content-type": "application/json" }, body: JSON.stringify({ wrapped: "A".repeat(60) }) });
    expect(res.status).toBe(401);
  });
});

describe("syncing through a server", () => {
  test("devices see each other's highlights, edits and deletions", async () => {
    const { fetch } = setup();
    const keyText = await formatKey(newKey());
    const phone = await device(keyText, [serverTransport({ fetch })]);
    const laptop = await device(keyText, [serverTransport({ fetch })]);

    await phone.put(hl("PSA.119.11", "yellow"));
    await phone.sync();
    await laptop.sync();
    expect(colors(laptop)).toEqual({ "PSA.119.11": "yellow" });

    await laptop.put(hl("PSA.119.11", "blue"));
    await laptop.sync();
    await phone.sync();
    expect(colors(phone)).toEqual({ "PSA.119.11": "blue" });

    await phone.remove("highlight", "PSA.119.11");
    await phone.sync();
    await laptop.sync();
    expect(laptop.all()).toEqual([]);
  });

  test("a change goes up in one request, and still pulls when another device wrote in between", async () => {
    const { fetch } = setup();
    const calls: string[] = [];
    const counted: Fetch = (input, init) => (calls.push(`${init?.method ?? "GET"} ${new URL(String(input), "http://local").search}`), fetch(input, init));
    const keyText = await formatKey(newKey());
    const phone = await device(keyText, [serverTransport({ fetch: counted })]);
    const laptop = await device(keyText, [serverTransport({ fetch })]);
    await phone.sync();
    calls.length = 0;

    // put() starts the sync itself.
    await phone.put(hl("ROM.5.3", "yellow"));
    await phone.running;
    expect(calls).toEqual(["POST "]);

    await laptop.sync();
    await laptop.put(hl("ROM.5.4", "blue"));
    await laptop.sync();
    calls.length = 0;
    await phone.put(hl("ROM.5.5", "yellow"));
    await phone.running;
    expect(calls).toEqual(["POST ", "GET ?after=1"]);
    expect(colors(phone)).toEqual({ "ROM.5.3": "yellow", "ROM.5.4": "blue", "ROM.5.5": "yellow" });
    expect(phone.status).toMatchObject({ state: "synced", failures: 0 });
  });

  test("failures in a row are counted, so one blip needn't be shown", async () => {
    const { fetch } = setup();
    let up = true;
    const flaky: Fetch = (input, init) => (up ? fetch(input, init) : Promise.resolve(new Response("{}", { status: 500 })));
    const phone = await device(await formatKey(newKey()), [serverTransport({ fetch: flaky })]);
    up = false;
    await phone.sync();
    expect(phone.status).toMatchObject({ state: "error", failures: 1 });
    await phone.sync();
    expect(phone.status).toMatchObject({ state: "error", failures: 2 });
    up = true;
    await phone.sync();
    expect(phone.status).toMatchObject({ state: "synced", failures: 0 });
  });

  test("offline edits wait across restarts, then go up", async () => {
    const { fetch } = setup();
    let online = false;
    const flaky: Fetch = (input, init) => (online ? fetch(input, init) : Promise.reject(new TypeError("Failed to fetch")));
    const keyText = await formatKey(newKey());
    const store = memoryStore();
    const phone = await device(keyText, [serverTransport({ fetch: flaky })], store);
    await phone.put({ kind: "note", ref: "JHN.3.16-18", body: "loved", created: 1 });
    await phone.sync();
    expect(phone.status.state).toBe("offline");
    expect(phone.waiting()).toBe(1);

    const reopened = await device(keyText, [serverTransport({ fetch: flaky })], store);
    expect(reopened.waiting()).toBe(1);
    online = true;
    await reopened.sync();
    expect(reopened.status.state).toBe("synced");
    expect(reopened.waiting()).toBe(0);

    const laptop = await device(keyText, [serverTransport({ fetch })]);
    await laptop.sync();
    expect(laptop.find("note", "JHN.3.16-18")?.body).toBe("loved");
  });

  test("a different key can't read the library", async () => {
    const { fetch } = setup();
    const mine = await device(await formatKey(newKey()), [serverTransport({ fetch })]);
    await mine.put(hl("GEN.1.1", "yellow"));
    await mine.sync();
    const theirs = await device(await formatKey(newKey()), [serverTransport({ fetch })]);
    await theirs.sync();
    expect(theirs.all()).toEqual([]);
  });

  test("a server that lost everything is refilled by the next device to sync", async () => {
    const first = setup();
    let server = first;
    const fetch: Fetch = (input, init) => server.fetch(input, init);
    const keyText = await formatKey(newKey());
    const phone = await device(keyText, [serverTransport({ fetch })]);
    await phone.putMany([hl("JHN.1.1", "yellow"), hl("JHN.1.2", "green")]);
    await phone.sync();

    server = setup(); // A new, empty database: a lost or replaced server.
    await phone.sync();
    const laptop = await device(keyText, [serverTransport({ fetch })]);
    await laptop.sync();
    expect(colors(laptop)).toEqual({ "JHN.1.1": "yellow", "JHN.1.2": "green" });
  });

  test("a server restored from an old backup is caught up again", async () => {
    const { sqlite, fetch } = setup();
    const keyText = await formatKey(newKey());
    const phone = await device(keyText, [serverTransport({ fetch })]);
    await phone.put(hl("JHN.1.1", "yellow"));
    await phone.sync();
    const backup = sqlite.serialize();
    await phone.putMany([hl("JHN.1.2", "green"), hl("JHN.1.1", "pink")]);
    await phone.sync();

    // Same epoch, older contents.
    const restored = Database.deserialize(backup);
    const env = { DB: d1(restored) };
    const fromBackup: Fetch = async (input, init) => handle(new Request(new URL(String(input), "http://local"), init), env);
    const phoneAgain = await device(keyText, [serverTransport({ fetch: fromBackup })], memoryStore());
    phoneAgain.state = phone.state;
    phoneAgain.records = phone.records;
    await phoneAgain.sync();

    const laptop = await device(keyText, [serverTransport({ fetch: fromBackup })]);
    await laptop.sync();
    expect(colors(laptop)).toEqual({ "JHN.1.1": "pink", "JHN.1.2": "green" });
  });

  test("an old version sent late doesn't win: a device with the newer one sends it again", async () => {
    const { fetch } = setup();
    const { keyText, keys } = await keysFor();
    const phone = await device(keyText, [serverTransport({ fetch })]);
    await phone.put(hl("ROM.8.28", "blue"));
    await phone.sync();
    // Another app (or a misbehaving server) puts back an older version.
    await post(fetch, keys.lib, keys.auth, [await encryptRecord(keys, hl("ROM.8.28", "yellow", { updated: 1 }))]);

    await phone.sync();
    const laptop = await device(keyText, [serverTransport({ fetch })]);
    await laptop.sync();
    expect(colors(laptop)).toEqual({ "ROM.8.28": "blue" });
  });
});

describe("the merge rule", () => {
  test("offline edits to the same verse on two devices end the same everywhere", async () => {
    const { fetch } = setup();
    const keyText = await formatKey(newKey());
    const phone = await device(keyText, [serverTransport({ fetch })]);
    const laptop = await device(keyText, [serverTransport({ fetch })]);
    await phone.put(hl("JHN.3.16", "yellow"));
    await phone.sync();
    await laptop.sync();

    // Both offline: both edit John 3:16, and each edits another verse.
    await phone.putMany([hl("JHN.3.16", "green"), hl("JHN.3.17", "green")]);
    const realNow = Date.now;
    Date.now = () => realNow() + 5_000;
    try {
      await laptop.putMany([hl("JHN.3.16", "pink"), hl("GEN.1.1", "pink")]);
    } finally {
      Date.now = realNow;
    }

    // They come back online in the "wrong" order: the older edit arrives last.
    await laptop.sync();
    await phone.sync();
    await laptop.sync();
    const expected = { "GEN.1.1": "pink", "JHN.3.16": "pink", "JHN.3.17": "green" };
    expect(colors(phone)).toEqual(expected);
    expect(colors(laptop)).toEqual(expected);
  });

  test("ties are broken the same way on every device", async () => {
    const { fetch } = setup();
    const keyText = await formatKey(newKey());
    const a = await device(keyText, [serverTransport({ fetch })]);
    const b = await device(keyText, [serverTransport({ fetch })]);
    const realNow = Date.now;
    Date.now = () => 1_800_000_000_000;
    try {
      await a.put(hl("PSA.23.1", "blue"));
      await b.put(hl("PSA.23.1", "green"));
    } finally {
      Date.now = realNow;
    }
    await a.sync();
    await b.sync();
    await a.sync();
    expect(colors(a)).toEqual(colors(b));
  });

  test("an edit on a device whose clock is behind still beats what it replaced", async () => {
    const keyText = await formatKey(newKey());
    const lib = await device(keyText);
    await lib.put(hl("GEN.1.1", "yellow"));
    const before = lib.find("highlight", "GEN.1.1").updated;
    const realNow = Date.now;
    Date.now = () => realNow() - 86_400_000;
    try {
      await lib.put(hl("GEN.1.1", "blue"));
    } finally {
      Date.now = realNow;
    }
    expect(lib.find("highlight", "GEN.1.1").updated).toBe(before + 1);
    expect(colors(lib)).toEqual({ "GEN.1.1": "blue" });
  });

  test("importing a file only replaces records it has newer versions of", async () => {
    const lib = await device(await formatKey(newKey()));
    await lib.put(hl("GEN.1.1", "blue"));
    const changed = await lib.merge([hl("GEN.1.1", "yellow", { updated: 5 }), hl("GEN.1.2", "green", { updated: 5 })]);
    expect(changed).toBe(1);
    expect(colors(lib)).toEqual({ "GEN.1.1": "blue", "GEN.1.2": "green" });
  });
});

describe("syncing through a folder", () => {
  test("devices sharing a folder see each other's changes, in files people can read", async () => {
    const shared = new Map();
    const keyText = await formatKey(newKey());
    const phone = await device(keyText, [folderTransport(memoryDir(shared))]);
    const laptop = await device(keyText, [folderTransport(memoryDir(shared))]);

    await phone.putMany([hl("PSA.119.11", "yellow"), { kind: "note", ref: "PSA.119", body: "hidden" }]);
    await phone.sync();
    await laptop.sync();
    expect(colors(laptop)).toEqual({ "PSA.119.11": "yellow" });
    expect(laptop.find("note", "PSA.119")?.body).toBe("hidden");

    await laptop.remove("highlight", "PSA.119.11");
    await laptop.sync();
    await phone.sync();
    expect(phone.all("highlight")).toEqual([]);

    const file = shared.get(`${phone.state.device}.jsonl`).text.trim().split("\n").map((l: string) => JSON.parse(l));
    expect(file[0]).toMatchObject({ "hidden-word": 2, library: phone.lib, name: "Personal" });
    expect(file.slice(1).find((r: { kind: string }) => r.kind === "note")).toMatchObject({ ref: "PSA.119", body: "hidden" });
  });

  test("files from another library in the same folder are left alone", async () => {
    const shared = new Map();
    const mine = await device(await formatKey(newKey()), [folderTransport(memoryDir(shared))]);
    const theirs = await device(await formatKey(newKey()), [folderTransport(memoryDir(shared))]);
    await theirs.put(hl("GEN.1.1", "pink"));
    await theirs.sync();
    await mine.sync();
    expect(mine.all()).toEqual([]);
    await mine.erase();
    expect(shared.size).toBe(1);
  });
});

describe("mixing servers, folders and no sync", () => {
  test("a server-only device and a folder-only device meet through one that uses both", async () => {
    const { fetch } = setup();
    const shared = new Map();
    const keyText = await formatKey(newKey());
    const web = await device(keyText, [serverTransport({ fetch })]);
    const offlineMac = await device(keyText, [folderTransport(memoryDir(shared))]);
    const phone = await device(keyText, [serverTransport({ fetch }), folderTransport(memoryDir(shared))]);

    await web.put(hl("JHN.1.1", "blue"));
    await offlineMac.put(hl("JHN.1.14", "green"));
    await web.sync();
    await offlineMac.sync();
    await phone.sync();
    await web.sync();
    await offlineMac.sync();

    const expected = { "JHN.1.1": "blue", "JHN.1.14": "green" };
    expect(colors(web)).toEqual(expected);
    expect(colors(offlineMac)).toEqual(expected);
    expect(colors(phone)).toEqual(expected);
  });

  test("a device with no sync at all trades by file, under the same rule", async () => {
    const keyText = await formatKey(newKey());
    const lonely = await device(keyText);
    await lonely.put(hl("REV.22.21", "purple"));
    expect(lonely.status.state).toBe("local");
    const other = await device(keyText);
    await other.put(hl("REV.22.20", "orange"));
    const { parseJsonl } = await import("../public/sync.js");
    await other.merge(parseJsonl(lonely.toFile()));
    expect(colors(other)).toEqual({ "REV.22.20": "orange", "REV.22.21": "purple" });
  });

  test("a library can start syncing later and catch everything up", async () => {
    const { fetch } = setup();
    const keyText = await formatKey(newKey());
    const lib = await device(keyText);
    await lib.putMany([hl("GEN.1.1", "yellow"), hl("GEN.1.2", "green")]);
    await lib.use([serverTransport({ fetch })]);
    const other = await device(keyText, [serverTransport({ fetch })]);
    await other.sync();
    expect(colors(other)).toEqual({ "GEN.1.1": "yellow", "GEN.1.2": "green" });
  });
});

describe("the library's name", () => {
  const named = (keyText: string, name: string, fetch: Fetch, store = memoryStore()) =>
    Library.open({ keyText, name, store, transports: [serverTransport({ fetch })] });

  test("a rename reaches another device, and shows there in place of the name typed to unlock", async () => {
    const { fetch } = setup();
    const { keyText } = await keysFor();
    const phone = await named(keyText, "Personal", fetch);
    const laptop = await named(keyText, "Typed at unlock", fetch);
    await phone.rename("Family devotions");
    await phone.sync();
    const seen: string[] = [];
    laptop.onChange((l) => seen.push(l.name));
    await laptop.sync();
    expect(laptop.name).toBe("Family devotions");
    expect(laptop.syncedName).toBe("Family devotions");
    expect(seen).toContain("Family devotions");
    // Another instance over the same device storage reads it without the network.
    const again = await Library.open({ keyText, name: "Whatever", store: laptop.store });
    expect(again.name).toBe("Family devotions");
  });

  test("of two renames made apart, the later one wins on both devices", async () => {
    const { fetch } = setup();
    const { keyText } = await keysFor();
    const phone = await named(keyText, "A", fetch);
    const laptop = await named(keyText, "A", fetch);
    try {
      setSystemTime(new Date(1_800_000_000_000));
      await phone.rename("Earlier");
      setSystemTime(new Date(1_800_000_060_000));
      await laptop.rename("Later");
    } finally {
      setSystemTime();
    }
    for (const d of [phone, laptop, phone]) await d.sync();
    expect([phone.name, laptop.name]).toEqual(["Later", "Later"]);
  });

  test("a name typed to unlock never replaces a synced one; a library with none adopts it", async () => {
    const { fetch } = setup();
    const { keyText } = await keysFor();
    const first = await named(keyText, "Prayer journal", fetch);
    await first.sync();
    expect(await first.adoptName()).toBe(true);
    await first.sync();

    // Not synced yet: nothing is adopted, since a name may be waiting on the server.
    const second = await named(keyText, "Personal", fetch);
    expect(await second.adoptName()).toBe(false);
    await second.sync();
    expect(await second.adoptName()).toBe(false);
    expect(second.name).toBe("Prayer journal");

    // Even one adopted on a device that had never seen the other's arrives as the loser.
    const isolated = await Library.open({ keyText, name: "Personal" });
    expect(await isolated.adoptName()).toBe(true);
    isolated.use([serverTransport({ fetch })]);
    // Two adopted names tie on `updated` 0, so the merge rule picks one, the same everywhere.
    for (const d of [isolated, first, isolated]) await d.sync();
    expect([isolated.name, first.name]).toEqual(["Prayer journal", "Prayer journal"]);
    // And any rename beats an adopted name.
    await isolated.rename("Renamed");
    await isolated.sync();
    await first.sync();
    expect(first.name).toBe("Renamed");
  });

  test("export carries the name in its header and as a record, and import brings it", async () => {
    const { keyText } = await keysFor();
    const a = await Library.open({ keyText, name: "Local" });
    expect(JSON.parse(a.toFile().split("\n")[0]).name).toBe("Local");
    await a.rename("Psalms");
    const file = a.toFile();
    expect(JSON.parse(file.split("\n")[0]).name).toBe("Psalms");
    expect(parseJsonl(file)).toContainEqual(expect.objectContaining({ kind: "library", ref: "name", name: "Psalms" }));
    const b = await Library.open({ keyText, name: "Other" });
    expect(await b.merge(parseJsonl(file))).toBe(1);
    expect(b.name).toBe("Psalms");
  });

  test("an erased library doesn't adopt a name and send it back", async () => {
    const { fetch } = setup();
    const { keyText } = await keysFor();
    const d = await named(keyText, "Gone", fetch);
    await d.sync();
    await d.erase();
    expect(await d.adoptName()).toBe(false);
  });
});
