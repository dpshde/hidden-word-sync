// Server conformance checks for SPEC.md section 5 (the /v1 routes). They run against any base URL
// with a fresh, random, throwaway sync key, and delete the library they made at the end.
// `bun run conformance <base-url>` runs them from the command line; test/conformance.test.ts runs
// them against the reference Worker. Nothing here prints a key or a token.
import { deriveKeys, encryptRecord, newKey } from "../public/sync.js";

const NO_STORE = /no-store/i;

/**
 * Runs every check. `fetch` defaults to the global one. Returns { results: [{name, ok, detail}] };
 * `log` gets each result as it finishes.
 */
export async function checkServer({ base, fetch: f = globalThis.fetch.bind(globalThis), log = () => {} }) {
  const results = [];
  const keys = await deriveKeys(newKey());
  const other = await deriveKeys(newKey());
  const libUrl = `${base.replace(/\/$/, "")}/v1/lib/${keys.lib}`;
  const auth = (k) => ({ authorization: `Bearer ${k.auth}` });
  const call = async (method, { query = "", token = keys, headers = {}, body } = {}) => {
    const h = { ...(token ? auth(token) : {}), ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await f(libUrl + query, { method, headers: h, body: typeof body === "string" || body === undefined ? body : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, headers: res.headers, text, json };
  };
  const item = async (ref, extra = {}) => encryptRecord(keys, { kind: "highlight", ref, updated: 1, highlights: [{ color: "yellow" }], ...extra });
  const items = (n, from = 1) => Promise.all(Array.from({ length: n }, (_, i) => item(`PSA.119.${from + i}`)));

  async function check(name, fn) {
    let result;
    try {
      const problem = await fn();
      result = { name, ok: !problem, detail: problem || "" };
    } catch (error) {
      result = { name, ok: false, detail: `threw: ${error?.message ?? error}` };
    }
    results.push(result);
    log(result);
    return result.ok;
  }
  const expect = (cond, detail) => (cond ? "" : detail);
  const all = (...problems) => problems.filter(Boolean).join("; ");
  const errorShape = (r, status) =>
    all(
      expect(Array.isArray(status) ? status.includes(r.status) : r.status === status, `status ${r.status}, wanted ${status}`),
      expect(r.json && typeof r.json.error === "string" && Object.keys(r.json).length >= 1, `body isn't {"error": "…"}: ${r.text.slice(0, 80)}`),
      expect(r.headers.get("access-control-allow-origin") === "*", "no Access-Control-Allow-Origin: *"),
    );
  const isInt = (n) => Number.isSafeInteger(n) && n >= 0;

  let epoch = null;
  let seq = 0;
  try {
    await check("OPTIONS preflight allows any origin, the methods and the headers", async () => {
      const res = await f(libUrl, {
        method: "OPTIONS",
        headers: { origin: "https://example.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
      });
      const methods = (res.headers.get("access-control-allow-methods") ?? "").toUpperCase();
      const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
      return all(
        expect(res.status >= 200 && res.status < 300, `status ${res.status}`),
        expect(res.headers.get("access-control-allow-origin") === "*", "no Access-Control-Allow-Origin: *"),
        expect(["GET", "POST", "DELETE"].every((m) => methods.includes(m)) || allowed === "*", `Allow-Methods: ${methods}`),
        expect(["authorization", "content-type"].every((h) => allowed.includes(h)) || allowed === "*", `Allow-Headers: ${allowed}`),
      );
    });

    await check("GET of an unwritten library: no items, seq 0, epoch null", async () => {
      const r = await call("GET");
      return all(
        expect(r.status === 200, `status ${r.status}`),
        expect(r.json && Array.isArray(r.json.items) && r.json.items.length === 0, "items isn't []"),
        expect(r.json?.more === false, "more isn't false"),
        expect(r.json?.seq === 0, `seq ${r.json?.seq}`),
        expect(r.json?.epoch === null, `epoch ${r.json?.epoch}`),
        expect(r.headers.get("access-control-allow-origin") === "*", "no Access-Control-Allow-Origin: *"),
        expect(NO_STORE.test(r.headers.get("cache-control") ?? ""), "no Cache-Control: no-store"),
      );
    });

    await check("no token: 401 with an error body", async () => errorShape(await call("GET", { token: null }), 401));

    await check("the first write claims the library and starts an epoch", async () => {
      const r = await call("POST", { body: { items: [await item("PSA.119.11")] } });
      epoch = r.json?.epoch;
      seq = r.json?.seq;
      return all(
        expect(r.status === 200, `status ${r.status}: ${r.text.slice(0, 80)}`),
        expect(isInt(r.json?.seq) && r.json.seq >= 1, `seq ${r.json?.seq}`),
        expect(typeof epoch === "string" && epoch.length > 0, `epoch ${epoch}`),
        expect(NO_STORE.test(r.headers.get("cache-control") ?? ""), "no Cache-Control: no-store"),
      );
    });

    await check("another token gets 401 on GET, POST and DELETE, and changes nothing", async () => {
      const g = await call("GET", { token: other });
      const p = await call("POST", { token: other, body: { items: [await item("PSA.119.12")] } });
      const d = await call("DELETE", { token: other });
      const after = await call("GET");
      return all(
        errorShape(g, 401) && `GET: ${errorShape(g, 401)}`,
        errorShape(p, 401) && `POST: ${errorShape(p, 401)}`,
        errorShape(d, 401) && `DELETE: ${errorShape(d, 401)}`,
        expect(after.json?.seq === seq && after.json?.items?.length === 1 && after.json?.epoch === epoch, "the library changed"),
      );
    });

    await check("POST of 100 items takes 100 new seqs", async () => {
      const r = await call("POST", { body: { items: await items(100, 101) } });
      const ok = expect(r.status === 200 && r.json?.seq === seq + 100 && r.json?.epoch === epoch, `status ${r.status}, seq ${r.json?.seq} (wanted ${seq + 100}), epoch kept: ${r.json?.epoch === epoch}`);
      if (r.status === 200) seq = r.json.seq;
      return ok;
    });

    await check("POST of 0 or 101 items, a bad id, or a blob out of range: 400 or 413", async () => {
      const good = await item("PSA.119.13");
      const cases = {
        "0 items": { items: [] },
        "101 items": { items: await items(101, 1) },
        "no items field": {},
        "bad id": { items: [{ ...good, id: "short" }] },
        "blob not base64url": { items: [{ ...good, blob: `${good.blob.slice(1)}!` }] },
        "blob too short": { items: [{ ...good, blob: good.blob.slice(0, 378) }] },
        "blob too long": { items: [{ ...good, blob: good.blob.padEnd(21_901, "A") }] },
      };
      const problems = [];
      for (const [label, body] of Object.entries(cases)) {
        const p = errorShape(await call("POST", { body }), [400, 413]);
        if (p) problems.push(`${label}: ${p}`);
      }
      const notJson = errorShape(await call("POST", { body: "{not json" }), 400);
      if (notJson) problems.push(`not JSON: ${notJson}`);
      const after = await call("GET", { query: `?after=${seq}` });
      if (after.json?.seq !== seq) problems.push("a refused POST changed seq");
      return problems.join("; ");
    });

    await check("a body over 2.4 MB: 413", async () => {
      const r = await call("POST", { body: JSON.stringify({ items: [], pad: "x".repeat(2_500_000) }) });
      return errorShape(r, 413);
    });

    await check("GET pages: limit, after, more, ascending seqs, seq and epoch", async () => {
      const first = await call("GET", { query: "?after=0&limit=40" });
      const page = first.json;
      if (first.status !== 200) return `status ${first.status}`;
      const problems = [
        expect(page.items.length === 40, `limit=40 gave ${page.items.length} items`),
        expect(page.more === true, "more isn't true with items left"),
        expect(page.seq === seq, `seq ${page.seq}, wanted ${seq}`),
        expect(page.epoch === epoch, "epoch changed"),
        expect(page.items.every((it, i) => isInt(it.seq) && typeof it.id === "string" && typeof it.blob === "string" && (i === 0 || it.seq > page.items[i - 1].seq)), "items aren't {seq,id,blob} in ascending seq"),
      ];
      let after = page.items.at(-1)?.seq ?? 0;
      let total = page.items.length;
      for (let guard = 0; guard < 10; guard++) {
        const next = (await call("GET", { query: `?after=${after}&limit=40` })).json;
        if (next.items.some((it) => it.seq <= after)) problems.push("a page repeated an earlier seq");
        total += next.items.length;
        after = next.items.at(-1)?.seq ?? after;
        if (!next.more) break;
      }
      problems.push(expect(total === 101, `paged ${total} items, wanted 101`));
      problems.push(expect(after === seq, `last item's seq ${after}, wanted ${seq}`));
      const tail = (await call("GET", { query: `?after=${seq}` })).json;
      problems.push(expect(tail.items.length === 0 && tail.more === false, "after=latest isn't empty"));
      const clamp = await call("GET", { query: "?after=0&limit=9999" });
      problems.push(expect(clamp.json?.items?.length === 101, "limit above 500 wasn't clamped to 500"));
      return all(...problems);
    });

    await check("writing an id again replaces its item with a new, higher seq", async () => {
      const again = await item("PSA.119.11", { updated: 2 });
      const r = await call("POST", { body: { items: [again] } });
      const page = (await call("GET", { query: "?after=0" })).json;
      const hits = page.items.filter((it) => it.id === again.id);
      const problems = [
        expect(r.json?.seq === seq + 1, `seq ${r.json?.seq}, wanted ${seq + 1}`),
        expect(hits.length === 1, `the id appears ${hits.length} times`),
        expect(hits[0]?.seq === seq + 1 && hits[0]?.blob === again.blob, "the item didn't take the new blob and seq"),
        expect(page.items.length === 101, `${page.items.length} items, wanted 101`),
      ];
      seq += 1;
      return all(...problems);
    });

    await check("DELETE: 204, then the library is gone and its claim released", async () => {
      const d = await f(libUrl, { method: "DELETE", headers: auth(keys) });
      const gone = await call("GET");
      // Another token can claim it now, and the next write starts a new epoch.
      const claim = await call("POST", { token: other, body: { items: [await item("PSA.119.14")] } });
      const problems = [
        expect(d.status === 204, `DELETE status ${d.status}`),
        expect(d.headers.get("access-control-allow-origin") === "*", "DELETE has no Access-Control-Allow-Origin: *"),
        expect(gone.json?.epoch === null && gone.json?.seq === 0 && gone.json?.items?.length === 0, "the library is still there"),
        expect(claim.status === 200, `a new token couldn't claim it: ${claim.status}`),
        expect(claim.json?.epoch && claim.json.epoch !== epoch, "the next write kept the old epoch"),
      ];
      const done = await f(libUrl, { method: "DELETE", headers: auth(other) });
      problems.push(expect(done.status === 204, `cleanup DELETE ${done.status}`));
      return all(...problems);
    });
  } finally {
    // Whatever failed, leave nothing behind.
    for (const k of [keys, other]) await f(libUrl, { method: "DELETE", headers: auth(k) }).catch(() => {});
  }
  return { results, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}
