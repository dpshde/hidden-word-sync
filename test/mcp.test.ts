import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS, d1 } from "./d1";
import { handle } from "../src/worker";
import { TOOLS, bookCode } from "../src/mcp/index";
import { Library, formatKey, memoryStore, newKey, serverTransport } from "../public/sync.js";

function setup() {
  const sqlite = new Database(":memory:");
  for (const m of MIGRATIONS) sqlite.exec(m);
  const env = { DB: d1(sqlite) };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => handle(new Request(new URL(String(input), "http://local"), init), env);
  return { env, fetch };
}

type Setup = ReturnType<typeof setup>;
let n = 0;

/** One JSON-RPC message to /mcp; the raw text too, to check what it gives away. */
async function rpc(s: Setup, key: string | null, method: string, params: object = {}, headers: Record<string, string> = {}) {
  const auth: Record<string, string> = key === null ? {} : { authorization: `Bearer ${key}` };
  const res = await s.fetch("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

const call = async (s: Setup, key: string, name: string, args: object = {}) => {
  const r = await rpc(s, key, "tools/call", { name, arguments: args });
  return { ...r, result: r.body.result, data: r.body.result?.structuredContent };
};

describe("MCP", () => {
  test("handshake: initialize, the initialized notification, ping", async () => {
    const s = setup();
    const key = await formatKey(newKey());
    const init = await rpc(s, key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.status).toBe(200);
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    expect(init.body.result.capabilities.tools).toBeDefined();
    expect(init.body.result.serverInfo.name).toBe("hidden-word");
    const old = await rpc(s, key, "initialize", { protocolVersion: "1999-01-01" });
    expect(old.body.result.protocolVersion).toBe("2025-06-18");
    const note = await s.fetch("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);
    expect((await rpc(s, key, "ping")).body.result).toEqual({});
    expect((await rpc(s, key, "nope")).body.error.code).toBe(-32601);
  });

  test("GET is 405 and OPTIONS answers CORS with the key header allowed", async () => {
    const s = setup();
    expect((await s.fetch("/mcp")).status).toBe(405);
    const pre = await s.fetch("/mcp", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("x-hidden-word-key");
  });

  test("tools/list names every tool with a JSON schema", async () => {
    const s = setup();
    const { body } = await rpc(s, await formatKey(newKey()), "tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      "list_highlights", "find_highlights", "add_highlight", "set_highlight_color", "delete_highlight", "list_colors", "get_library_info", "get_passage_link",
    ]);
    for (const t of body.result.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(10);
    }
    expect(TOOLS.length).toBe(8);
  });

  test("add then list round-trips, and another device decrypts what the MCP wrote", async () => {
    const s = setup();
    const key = await formatKey(newKey());
    const added = await call(s, key, "add_highlight", { reference: "Romans 8:28", color: "blue" });
    expect(added.result.isError).toBe(false);
    expect(added.data).toEqual({ added: "Romans 8:28", color: "blue", colorName: "Blue", verses: ["ROM.8.28"] });
    await call(s, key, "add_highlight", { reference: "Rom 5:3-5" });
    const list = await call(s, key, "list_highlights");
    expect(list.data.highlights).toEqual([
      { reference: "Romans 5:3–5", ref: "ROM.5.3-5", color: "yellow", colorName: "Yellow", verses: ["ROM.5.3", "ROM.5.4", "ROM.5.5"], link: "https://route.bible/rom.5.3-5" },
      { reference: "Romans 8:28", ref: "ROM.8.28", color: "blue", colorName: "Blue", verses: ["ROM.8.28"], link: "https://route.bible/rom.8.28" },
    ]);
    expect((await call(s, key, "list_highlights", { color: "Blue" })).data.highlights.map((h: { ref: string }) => h.ref)).toEqual(["ROM.8.28"]);

    // The app, syncing through the same routes, sees and decrypts the MCP's items.
    const app = await Library.open({ keyText: key, store: memoryStore(), transports: [serverTransport({ fetch: s.fetch })] });
    await app.sync();
    const rom828 = app.find("highlight", "ROM.8.28");
    expect(rom828.highlights[0].color).toBe("blue");
    expect(Number.isSafeInteger(rom828.updated)).toBe(true);

    // And the MCP sees the app's edits.
    await app.putMany([{ kind: "highlight", ref: "JHN.3.16", highlights: [{ color: "green", created: 1 }] }]);
    await app.sync();
    expect((await call(s, key, "find_highlights", { book: "John" })).data.highlights.map((h: { ref: string }) => h.ref)).toEqual(["JHN.3.16"]);
  });

  test("recolor, find, delete, colors, info and links", async () => {
    const s = setup();
    const key = await formatKey(newKey());
    await call(s, key, "add_highlight", { reference: "Romans 5:3-5", color: "pink" });
    const recolor = await call(s, key, "set_highlight_color", { reference: "Romans 5:4-9", color: "green" });
    expect(recolor.data.verses).toEqual(["ROM.5.4", "ROM.5.5"]);
    const found = await call(s, key, "find_highlights", { reference: "Romans 5" });
    expect(found.data.highlights.map((h: { reference: string; color: string }) => [h.reference, h.color])).toEqual([["Romans 5:3", "pink"], ["Romans 5:4–5", "green"]]);
    const before = (await call(s, key, "list_highlights")).data.highlights;
    const del = await call(s, key, "delete_highlight", { reference: "Romans 5:3" });
    expect(del.data.verses).toEqual(["ROM.5.3"]);
    expect((await call(s, key, "list_highlights")).data.highlights.length).toBe(before.length - 1);
    // Updated goes up on every write, even when the clock doesn't.
    const app = await Library.open({ keyText: key, store: memoryStore(), transports: [serverTransport({ fetch: s.fetch })] });
    await app.sync();
    expect(app.records.size).toBe(3);
    expect([...app.records.values()].find((r) => r.ref === "ROM.5.3").deleted).toBe(true);

    const colors = (await call(s, key, "list_colors")).data.colors;
    expect(colors.find((c: { id: string }) => c.id === "green").verses).toBe(2);
    expect((await call(s, key, "get_library_info")).data).toEqual({ name: null, highlightedVerses: 2, passages: 1, notes: 0, colors: 6, ownColors: 0 });
    expect((await call(s, key, "get_passage_link", { reference: "John 3:16-18" })).data.links[0].link).toBe("https://route.bible/jhn.3.16-18");

    const nothing = await call(s, key, "delete_highlight", { reference: "Genesis 1:1" });
    expect(nothing.result.isError).toBe(true);
    const badColor = await call(s, key, "add_highlight", { reference: "John 1:1", color: "chartreuse" });
    expect(badColor.result.isError).toBe(true);
    expect(badColor.result.content[0].text).toContain("Yellow");
    const badRef = await call(s, key, "add_highlight", { reference: "Nothing 99" });
    expect(badRef.result.isError).toBe(true);
  });

  test("X-Hidden-Word-Key works like the bearer header", async () => {
    const s = setup();
    const key = await formatKey(newKey());
    await call(s, key, "add_highlight", { reference: "Psalm 23:1" });
    const r = await rpc(s, null, "tools/call", { name: "list_highlights", arguments: {} }, { "x-hidden-word-key": key.toLowerCase().replace(/-/g, " ") });
    expect(r.body.result.structuredContent.highlights[0].ref).toBe("PSA.23.1");
  });

  test("a missing, malformed or mistyped key is a 401 with a fixed message", async () => {
    const s = setup();
    const key = await formatKey(newKey());
    const typo = key.slice(0, -1) + (key.endsWith("0") ? "1" : "0");
    for (const k of [null, "", "not-a-key", typo, "Basic abc"]) {
      const r = await rpc(s, k, "tools/list");
      expect(r.status).toBe(401);
      expect(r.body.error.message).toBe("Missing or invalid sync key. Send it as Authorization: Bearer <sync key>.");
      if (k) expect(r.text).not.toContain(k);
    }
  });

  test("the key never appears in any answer or error", async () => {
    const s = setup();
    const key = await formatKey(newKey());
    const forms = [key, key.replace(/-/g, ""), key.toLowerCase()];
    const logs: unknown[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = (...a: unknown[]) => void logs.push(a);
    try {
      const texts = [
        (await rpc(s, key, "initialize", { protocolVersion: "2025-06-18" })).text,
        (await rpc(s, key, "tools/list")).text,
        (await rpc(s, key, "nope")).text,
        (await rpc(s, key, "tools/call", { name: "nope", arguments: {} })).text,
        ...(await Promise.all(
          TOOLS.map(async (t) => (await call(s, key, t.name, { reference: `${key} 3:16`, color: key, book: key })).text),
        )),
        (await call(s, key, "add_highlight", { reference: "John 3:16" })).text,
        (await call(s, key.slice(0, 27), "list_highlights")).text,
      ];
      // A server failure mid-call: the tool says so without the server's words or the key.
      const broken = { ...s, fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input), "http://local");
        if (url.pathname === "/mcp") return handle(new Request(url, init), { DB: { batch: () => Promise.reject(new Error(`db down ${key}`)), prepare: () => ({ bind: () => ({}) }) } as unknown as D1Database });
        return s.fetch(input, init);
      } };
      const down = await call(broken, key, "list_highlights");
      expect(down.result.isError).toBe(true);
      texts.push(down.text);
      for (const text of texts) for (const f of forms) expect(text).not.toContain(f);
      for (const entry of logs) for (const f of forms) expect(JSON.stringify(entry)).not.toContain(f);
    } finally {
      Object.assign(console, original);
    }
  });

  test("book names and codes", () => {
    expect(bookCode("Romans")).toBe("ROM");
    expect(bookCode("rom")).toBe("ROM");
    expect(bookCode("1 John")).toBe("1JN");
    expect(bookCode("Psalm")).toBe("PSA");
    expect(bookCode("Song of Songs")).toBe("SNG");
    expect(bookCode("Narnia")).toBe(null);
  });
});
