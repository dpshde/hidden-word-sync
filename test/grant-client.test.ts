// The grant client: an app's view of a library through /connect, with an incremental changes feed.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS, d1 } from "./d1";
import { handle } from "../src/worker";
import { GrantClient, parseGrantFragment } from "../public/grant-client.js";
import { Library, formatKey, memoryStore, newKey, parseKey, readKeys, serverTransport } from "../public/sync.js";

async function setup(scopes = ["read", "highlights:write"]) {
  const sqlite = new Database(":memory:");
  for (const m of MIGRATIONS) sqlite.exec(m);
  const env = { DB: d1(sqlite) };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => handle(new Request(new URL(String(input), "http://local"), init), env)) as typeof globalThis.fetch;
  const keyText = await formatKey(newKey());
  // The owner's device: the reference client, syncing to the same server.
  const owner = await Library.open({ keyText, store: memoryStore() });
  await owner.use([serverTransport({ fetch })]);
  await owner.highlightRange("JHN.3.16", "yellow");
  await owner.sync();
  const { lib, enc, mac } = await readKeys(await parseKey(keyText));
  const res = await fetch(`http://local/v1/grant/${lib}`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner.keys.auth}`, "content-type": "application/json" },
    body: JSON.stringify({ scopes, client: "https://route.bible" }),
  });
  const g = await res.json();
  const fields: Record<string, string> = { vault: "http://local", lib, rt: g.token, ek: enc, exp: String(g.expires), name: "Personal", scope: g.scopes.join(" "), state: "s1" };
  if (g.scopes.includes("highlights:write")) fields.mk = mac;
  const grant = parseGrantFragment(`#${new URLSearchParams(fields)}`);
  const app = await GrantClient.open(grant as any, { fetch });
  return { sqlite, fetch, owner, app, lib };
}

describe("grant client: changes feed", () => {
  test("first read is a reset snapshot; then only what changed, deletions included", async () => {
    const { owner, app } = await setup();
    const first = await app.changes();
    expect(first.reset).toBe(true);
    expect(first.upserts.map((u) => [u.ref, u.color])).toEqual([["JHN.3.16", "yellow"]]);
    expect(first.deletions).toEqual([]);
    expect(typeof first.next).toBe("string");

    const none = await app.changes(first.next);
    expect({ upserts: none.upserts, deletions: none.deletions, reset: none.reset }).toEqual({ upserts: [], deletions: [], reset: false });

    await owner.highlightRange("ROM.5.3-5", "green");
    await owner.remove("highlight", "JHN.3.16");
    await owner.sync();
    const next = await app.changes(none.next);
    expect(next.reset).toBe(false);
    expect(next.upserts.map((u) => u.ref)).toEqual(["ROM.5.3", "ROM.5.4", "ROM.5.5"]);
    expect(next.deletions).toEqual(["JHN.3.16"]);
    expect(app.highlights({ group: "ranges" })).toEqual([{ ref: "ROM.5.3-5", verses: ["ROM.5.3", "ROM.5.4", "ROM.5.5"], color: "green", time: expect.any(Number) }]);
  });

  test("a fresh app with a saved cursor gets the same changes (no local state needed)", async () => {
    const s = await setup();
    const c0 = (await s.app.changes()).next;
    await s.owner.remove("highlight", "JHN.3.16");
    await s.owner.sync();
    const fresh = await GrantClient.open(s.app.grant, { fetch: s.fetch });
    const feed = await fresh.changes(c0);
    expect(feed.deletions).toEqual(["JHN.3.16"]);
    expect(feed.reset).toBe(false);
  });

  test("a server that lost data (new epoch) or an unknown cursor gives a reset", async () => {
    const { app, sqlite, lib, owner } = await setup();
    const c = (await app.changes()).next;
    expect((await app.changes("nonsense")).reset).toBe(true);
    sqlite.query("UPDATE libs SET epoch = 'ffffffffffffffffffffffff' WHERE lib = ?").run(lib);
    const after = await app.changes(c);
    expect(after.reset).toBe(true);
    expect(after.upserts.map((u) => u.ref)).toEqual(["JHN.3.16"]);
    void owner;
  });

  test("the merge rule is applied: an older version arriving later doesn't win", async () => {
    const { app, owner, sqlite, lib, fetch } = await setup();
    const c = (await app.changes()).next;
    const stale = sqlite.query("SELECT id, blob FROM items WHERE lib = ?").get(lib) as { id: string; blob: string };
    await app.highlightRange("JHN.3.16", "blue");
    // A device that missed the recolor sends its older copy again; the server keeps whatever arrives last.
    const res = await fetch(`http://local/v1/lib/${lib}`, { method: "POST", headers: { authorization: `Bearer ${owner.keys.auth}`, "content-type": "application/json" }, body: JSON.stringify({ items: [stale] }) });
    expect(res.status).toBe(200);
    const feed = await app.changes(c);
    expect(feed.upserts).toEqual([]);
    expect(app.find("JHN.3.16")!.highlights[0].color).toBe("blue");
  });
});

describe("grant client: writes and scopes", () => {
  test("a write grant saves a range in one POST, the owner's device sees it", async () => {
    const { app, owner } = await setup();
    await app.changes();
    const w = await app.highlightRange("PHP.4.6-7", "pink");
    expect(w.written).toEqual(["PHP.4.6", "PHP.4.7"]);
    expect((await app.highlightRange("PHP.4.6-7", "pink")).written).toEqual([]);
    await owner.sync();
    expect(owner.highlights({ group: "ranges" }).map((r: any) => r.ref)).toEqual(["JHN.3.16", "PHP.4.6-7"]);
    expect(await app.remove(["PHP.4.7", "PHP.4.8"])).toEqual(["PHP.4.7"]);
    await owner.sync();
    expect(owner.find("highlight", "PHP.4.7")).toBe(null);
  });

  test("a read grant reads, and can't write (refused before the network, and by the server)", async () => {
    const { app, fetch, lib } = await setup(["read"]);
    expect(app.canWrite).toBe(false);
    expect((await app.changes()).upserts).toHaveLength(1);
    await expect(app.highlightRange("ROM.5.3-5", "green")).rejects.toThrow(/highlights:write/);
    const res = await fetch(`http://local/v1/lib/${lib}`, { method: "POST", headers: { authorization: `Bearer ${app.grant.rt}`, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
  });

  test("a write-only grant can't read the feed", async () => {
    const { app } = await setup(["highlights:write"]);
    await expect(app.changes()).rejects.toThrow(/403/);
  });

  test("disconnect revokes the grant", async () => {
    const { app } = await setup();
    await app.disconnect();
    await expect(app.changes()).rejects.toThrow(/401/);
  });

  test("the fragment: errors and missing fields", () => {
    expect(parseGrantFragment("#error=access_denied")).toEqual({ error: "access_denied" });
    expect(parseGrantFragment("#vault=x")).toEqual({ error: "invalid_grant" });
  });
});
