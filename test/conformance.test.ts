// The conformance suite (conformance/) run against the reference Worker and the reference client.
import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { MIGRATIONS, d1 } from "./d1";
import { handle } from "../src/worker";
import { checkServer } from "../conformance/server.js";
import fixtures from "../conformance/fixtures.json";
import { Library, compareVersions, decryptRecord, deriveKeys, encryptRecord, memoryStore, parseKey, serverTransport, serverLostData } from "../public/sync.js";

function server() {
  const sqlite = new Database(":memory:");
  for (const m of MIGRATIONS) sqlite.exec(m);
  const env = { DB: d1(sqlite) };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => handle(new Request(new URL(String(input), "http://local"), init), env);
  return { sqlite, fetch };
}

describe("server conformance", () => {
  test("the reference Worker passes every check, and is left empty", async () => {
    const s = server();
    const { results, failed } = await checkServer({ base: "http://local", fetch: s.fetch });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(failed).toBe(0);
    expect(results.length).toBeGreaterThanOrEqual(11);
    expect(s.sqlite.query("SELECT COUNT(*) AS n FROM libs").get()).toEqual({ n: 0 });
    expect(s.sqlite.query("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
  });

  test("a server that breaks the contract fails the checks it breaks", async () => {
    const s = server();
    // Forgets Cache-Control, and never releases a claim on DELETE.
    const broken = async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
      const res = await s.fetch(input, init);
      const headers = new Headers(res.headers);
      headers.delete("cache-control");
      return new Response(res.body, { status: res.status, headers });
    };
    const { results } = await checkServer({ base: "http://local", fetch: broken });
    const failed = results.filter((r) => !r.ok).map((r) => r.name);
    expect(failed).toContain("GET of an unwritten library: no items, seq 0, epoch null");
    expect(failed).toContain("DELETE: 204, then the library is gone and its claim released");
  });
});

describe("client fixtures", () => {
  const version = (text: string) => ({ updated: JSON.parse(text).updated, text });
  for (const c of fixtures.merge) {
    test(`merge: ${c.name}`, () => {
      const d = compareVersions(version(c.a), version(c.b));
      expect(d > 0 ? "a" : d < 0 ? "b" : "same").toBe(c.winner);
      // The rule is symmetric.
      const e = compareVersions(version(c.b), version(c.a));
      expect(e > 0 ? "b" : e < 0 ? "a" : "same").toBe(c.winner);
    });
  }

  for (const c of fixtures.writes) {
    test(`writes: ${c.name}`, async () => {
      const lib = await Library.open({ keyText: fixtures.key });
      if (c.previous !== null) await lib.merge([{ kind: "note", ref: "JHN.3", updated: c.previous, body: "before" }]);
      const clock = spyOn(Date, "now").mockReturnValue(c.now * 1000);
      try {
        await lib.put({ kind: "note", ref: "JHN.3", body: "after" });
      } finally {
        clock.mockRestore();
      }
      expect(lib.find("note", "JHN.3")?.updated).toBe(c.updated);
    });
  }

  for (const c of fixtures.refill) {
    test(`refill: ${c.name}`, () => expect(serverLostData(c.seen, c.answer)).toBe(c.refill));
  }

  type Rec = Record<string, unknown>;
  const sorted = (records: Rec[]) => [...records].sort((x, y) => `${x.kind} ${x.ref}`.localeCompare(`${y.kind} ${y.ref}`));

  for (const scenario of fixtures.scenarios) {
    test(`scenario: ${scenario.name}`, async () => {
      const s = server();
      const keys = await deriveKeys(await parseKey(fixtures.key));
      const devices = new Map<string, Library>();
      const device = async (name: string) => {
        if (!devices.has(name)) devices.set(name, await Library.open({ keyText: fixtures.key, store: memoryStore(), transports: [serverTransport({ fetch: s.fetch })] }));
        return devices.get(name)!;
      };
      const serverRecords = async () => {
        const page = await (await s.fetch(`/v1/lib/${keys.lib}?after=0`, { headers: { authorization: `Bearer ${keys.auth}` } })).json();
        return Promise.all(page.items.map((it: { id: string; blob: string }) => decryptRecord(keys, it.id, it.blob)));
      };
      for (const step of scenario.steps as Array<Rec>) {
        if (step.import) await (await device(step.device as string)).merge(step.import as Rec[]);
        else if (step.sync) {
          const lib = await device(step.device as string);
          await lib.sync();
          expect(lib.status.state).toBe("synced");
        } else if (step.server === "erase") {
          await s.fetch(`/v1/lib/${keys.lib}`, { method: "DELETE", headers: { authorization: `Bearer ${keys.auth}` } });
        } else if (step.server === "write") {
          const items = await Promise.all((step.records as Rec[]).map((r) => encryptRecord(keys, r)));
          await s.fetch(`/v1/lib/${keys.lib}`, { method: "POST", headers: { authorization: `Bearer ${keys.auth}`, "content-type": "application/json" }, body: JSON.stringify({ items }) });
        } else if (step.expect) {
          const want = step.expect as { device?: string; records?: Rec[]; server?: Rec[] };
          if (want.server) expect(sorted(await serverRecords())).toEqual(sorted(want.server));
          else expect(sorted([...(await device(want.device!)).records.values()] as Rec[])).toEqual(sorted(want.records!));
        } else throw new Error(`unknown step ${JSON.stringify(step)}`);
      }
    });
  }
});
