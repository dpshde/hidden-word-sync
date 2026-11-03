import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MIGRATIONS, d1 } from "./d1";
import worker from "../src/worker";
import { clientErrors, errorFields, observe, routeOf, scrub } from "../src/observe";
import { deriveKeys, formatKey, newKey, parseKey } from "../public/sync.js";
import { reportFor } from "../public/report.js";

const ORIGIN = "https://hidden-word.example";

/** Everything written to the console while a test runs, one string per call. */
let lines: string[] = [];
let spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  lines = [];
  spies = (["log", "error", "warn", "info", "debug"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" "))),
  );
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

function setup() {
  const sqlite = new Database(":memory:");
  for (const m of MIGRATIONS) sqlite.exec(m);
  const env = { DB: d1(sqlite) };
  const fetch = (path: string, init?: RequestInit) => worker.fetch(new Request(new URL(path, ORIGIN), init), env);
  return { sqlite, env, fetch };
}

const logged = () => lines.map((l) => JSON.parse(l));

describe("scrub", () => {
  test("takes out sync keys, tokens, ids, quoted text, references, emails and queries", async () => {
    const key = await formatKey(newKey());
    const keys = await deriveKeys(await parseKey(key));
    const text = scrub(
      `bad key ${key} / ${key.toLowerCase().replace(/-/g, "")} / ${key.replace(/-/g, " ")} token ${keys.auth} lib ${keys.lib} ` +
        `"For God so loved the world" 'JHN.3.16' saving John 3:16 and Rom 5:3-5 and JHN.3.16-18 from a@b.co at https://x.test/save?ref=JHN.3.16#k=${key}`,
    );
    for (const secret of [key, key.toLowerCase().replace(/-/g, ""), keys.auth, keys.lib, "loved", "JHN", "3:16", "5:3", "a@b.co", "ref=", "#k"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("https://x.test/save");
  });

  test("keeps an error's shape readable", () => {
    expect(scrub("Cannot read properties of undefined (reading 'color')")).toBe("Cannot read properties of undefined (reading '…')");
    expect(scrub("addEventListener is not a function")).toBe("addEventListener is not a function");
    expect(scrub("x".repeat(1000)).length).toBe(300);
  });

  test("an error's fields: its class and a scrubbed message", async () => {
    const key = await formatKey(newKey());
    expect(errorFields(new TypeError(`no ${key}`))).toEqual({ error_class: "TypeError", error: "no [redacted]" });
    expect(errorFields("thrown string").error_class).toBe("string");
  });
});

describe("request logs", () => {
  test("routes are templates, without ids", () => {
    expect(routeOf("/v1/lib/0123456789abcdef0123456789abcdef")).toBe("/v1/lib/:lib");
    expect(routeOf("/v1/slot/0123456789abcdef0123456789abcdef")).toBe("/v1/slot/:slot");
    expect(routeOf("/mcp")).toBe("/mcp");
    expect(routeOf("/something/else")).toBe("other");
  });

  test("one line per request: route, status, time; never the key, token, id, or query", async () => {
    const s = setup();
    const key = await formatKey(newKey());
    const keys = await deriveKeys(await parseKey(key));
    await s.fetch(`/v1/lib/${keys.lib}?after=0`, { headers: { authorization: `Bearer ${keys.auth}` } });
    await s.fetch(`/v1/lib/${keys.lib}`, { headers: { authorization: "Bearer nope" } });
    await s.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_highlight", arguments: { reference: "John 3:16" } } }),
    });
    await s.fetch("/mcp", { method: "POST", headers: { "x-hidden-word-key": "not-a-key-0000" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) });
    await s.fetch("/save?ref=JHN.3.16&color=yellow");

    const all = lines.join("\n");
    for (const secret of [key, keys.auth, keys.lib, "not-a-key-0000", "JHN", "John", "3:16", "after=", "Bearer"]) expect(all).not.toContain(secret);
    const [read, wrong, tool, badKey, save] = logged();
    expect(read).toMatchObject({ event: "request", method: "GET", route: "/v1/lib/:lib", status: 200 });
    expect(typeof read.ms).toBe("number");
    expect(wrong).toMatchObject({ route: "/v1/lib/:lib", status: 401 });
    expect(tool).toMatchObject({ route: "/mcp", status: 200, mcp: "ok", mcp_methods: "tools/call", tools: "add_highlight" });
    expect(badKey).toMatchObject({ route: "/mcp", status: 401, mcp: "bad_key" });
    expect(save).toMatchObject({ route: "/save" });
  });

  test("a failure logs its class and a scrubbed message at error level, and answers 500", async () => {
    const key = await formatKey(newKey());
    const errors: string[] = [];
    const res = await observe(
      new Request(`${ORIGIN}/v1/lib/x`),
      async (note) => {
        note(errorFields(new RangeError(`broke on ${key}`)));
        return new Response(null, { status: 500 });
      },
      { log: () => {}, error: (line: string) => void errors.push(line) },
    );
    expect(res.status).toBe(500);
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain(key);
    expect(JSON.parse(errors[0])).toMatchObject({ status: 500, error_class: "RangeError", error: "broke on [redacted]" });
  });

  test("the Worker answers 500 when a route throws, and logs it", async () => {
    const env = { DB: { prepare() { throw new Error("D1 down"); }, batch() { throw new Error("D1 down"); } } as unknown as D1Database };
    const keys = await deriveKeys(await parseKey(await formatKey(newKey())));
    const res = await worker.fetch(new Request(`${ORIGIN}/v1/lib/${keys.lib}`, { headers: { authorization: `Bearer ${keys.auth}` } }), env);
    expect(res.status).toBe(500);
    expect(logged()[0]).toMatchObject({ status: 500, error_class: "Error", error: "D1 down" });
  });
});

describe("browser error reports", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/api/client-error`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

  test("a report is logged with only its shape", async () => {
    const key = await formatKey(newKey());
    const handler = clientErrors();
    const res = await handler(
      post({
        kind: "error", name: "TypeError", message: `Cannot read 'x' of ${key} while saving John 3:16`, source: "/app.js", line: 12, col: 4,
        stack: `/app.js:12:4 /sync.js:300:9 ${key} https://evil.test/x.js:1:1`, page: "/", verse: "For God so loved the world", extra: key,
      }),
    );
    expect(res.status).toBe(204);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(key);
    expect(lines[0]).not.toContain("loved");
    expect(lines[0]).not.toContain("3:16");
    expect(JSON.parse(lines[0])).toEqual({
      event: "client_error", kind: "error", name: "TypeError", message: "Cannot read '…' of [redacted] while saving [ref]",
      source: "/app.js", line: 12, col: 4, stack: "/app.js:12:4 /sync.js:300:9", page: "/",
    });
  });

  test("other sites, big bodies, bad JSON and GETs are turned away", async () => {
    const handler = clientErrors();
    expect((await handler(post({ message: "x" }, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await handler(post({ message: "x".repeat(5000) }))).status).toBe(413);
    expect((await handler(post("{not json"))).status).toBe(400);
    expect((await handler(post("[1,2]"))).status).toBe(400);
    expect((await handler(new Request(`${ORIGIN}/api/client-error`))).status).toBe(405);
    expect(lines).toHaveLength(0);
  });

  test("capped per minute", async () => {
    let t = 1_000_000;
    const handler = clientErrors({ perMinute: 3, now: () => t });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await handler(post({ message: `e${i}` }))).status);
    expect(codes).toEqual([204, 204, 204, 429, 429]);
    t += 60_000;
    expect((await handler(post({ message: "later" }))).status).toBe(204);
    expect(lines).toHaveLength(4);
  });

  test("the route is served by the Worker", async () => {
    const s = setup();
    const res = await s.fetch("/api/client-error", { method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify({ message: "boom", page: "/" }) });
    expect(res.status).toBe(204);
    expect(logged().map((l) => l.event)).toEqual(["client_error", "request"]);
  });

  test("the browser side sends only the error's shape, from this site", () => {
    const err = new TypeError("bad 'thing'");
    err.stack = `TypeError: bad\n    at render (${ORIGIN}/app.js:10:5)\n    at https://cdn.other.test/lib.js:1:2`;
    const report = reportFor({ kind: "error", error: err, filename: `${ORIGIN}/app.js?v=1`, lineno: 10, colno: 5 }, { origin: ORIGIN, pathname: "/" });
    expect(report).toEqual({ kind: "error", name: "TypeError", message: "bad '…'", source: "/app.js", line: 10, col: 5, stack: "/app.js:10:5 external:1:2", page: "/" });
  });
});
