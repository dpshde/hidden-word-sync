import { describe, expect, test } from "bun:test";
import {
  DAILY_CAP_USD,
  MAX_BODY_BYTES,
  MAX_HIGHLIGHTS,
  USD_PER_MTOK,
  handle,
  memoryCaps,
  parseRelevanceBody,
  toSystemOne,
  usdFromUsage,
  type Env,
} from "../workers/selah-jev/src/worker";

const origin = "https://vault.selah.tools";
const good = {
  lib: "abcdef0123456789abcdef0123456789",
  passage: { ref: "ROM.8.18-25", text: "I consider that our present sufferings" },
  highlights: [
    { id: "JHN.3.16", ref: "JHN.3.16", text: "For God so loved the world" },
    { id: "PSA.23.1", ref: "PSA.23.1", text: "The LORD is my shepherd" },
  ],
};

function env(extra: Partial<Env> = {}): Env {
  return {
    TYPESAFE_API_KEY: "test-key-not-real",
    CAPS: memoryCaps(),
    ...extra,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://jev.selah.tools/", {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("relevance request shape", () => {
  test("accepts the client shape and refuses unknown fields or oversize batches", () => {
    expect(parseRelevanceBody(good).ok).toBe(true);
    expect(parseRelevanceBody({ ...good, model: "jev-latest" }).ok).toBe(false);
    expect(parseRelevanceBody({ ...good, highlights: [] }).ok).toBe(false);
    const many = {
      ...good,
      highlights: Array.from({ length: MAX_HIGHLIGHTS + 1 }, (_, i) => ({
        id: String(i),
        ref: `JHN.1.${i + 1}`,
        text: "x",
      })),
    };
    expect(parseRelevanceBody(many).ok).toBe(false);
  });

  test("systemone payload holds instructions once and includes highlight text", () => {
    const req = toSystemOne(good);
    expect(req.model).toBe("jev-latest");
    expect(req.state.instructions).toContain("ranking a person's Bible highlights");
    expect(req.state.passage.text).toContain("present sufferings");
    expect(req.state.highlights[0]).toContain("JHN.3.16 · JHN.3.16 · For God so loved");
    expect(Object.keys(req.questions).filter((k) => k.endsWith("_relevant"))).toHaveLength(2);
    expect(req.questions["JHN.3.16_reason"]).toMatchObject({ type: "choice" });
    expect(req.questions["JHN.3.16_obviousness"]).toMatchObject({ type: "score" });
  });

  test("usd comes from the response or from input tokens at TypeSafe's rate", () => {
    expect(usdFromUsage({ usd: 0.01 })).toBe(0.01);
    expect(usdFromUsage({ input_tokens: 1_000_000 })).toBeCloseTo(USD_PER_MTOK);
  });
});

describe("selah-jev Worker", () => {
  test("CORS allows only the vault origin", async () => {
    const ok = await handle(new Request("https://jev.selah.tools/", { method: "OPTIONS", headers: { origin } }), env());
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(origin);

    const bad = await handle(
      new Request("https://jev.selah.tools/", { method: "OPTIONS", headers: { origin: "https://evil.example" } }),
      env(),
    );
    expect(bad.status).toBe(403);

    const blocked = await handle(post(good, { origin: "https://evil.example" }), env(), (async () => new Response("{}")) as typeof fetch);
    expect(blocked.status).toBe(403);
  });

  test("refuses an oversized body", async () => {
    const huge = "x".repeat(MAX_BODY_BYTES + 10);
    expect((await handle(post(huge), env())).status).toBe(413);
    expect((await handle(post(good, { "content-length": String(MAX_BODY_BYTES + 1) }), env())).status).toBe(413);
  });

  test("refuses when the daily spend cap is already met", async () => {
    const caps = memoryCaps();
    const day = `spend:${new Date().toISOString().slice(0, 10)}`;
    await caps.put(day, String(DAILY_CAP_USD));
    const res = await handle(post(good), { TYPESAFE_API_KEY: "k", CAPS: caps });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "daily spend cap" });
  });

  test("refuses when a library hits the per-minute rate limit", async () => {
    const caps = memoryCaps();
    const minute = `rate:${good.lib}:${new Date().toISOString().slice(0, 16)}`;
    await caps.put(minute, "12");
    const res = await handle(post(good), { TYPESAFE_API_KEY: "k", CAPS: caps });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "library rate limit" });
  });

  test("proxies a valid body to TypeSafe and never echoes the key", async () => {
    const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const upstream = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(
        JSON.stringify({
          model: "jev-1.14.0",
          answers: { "JHN.3.16_relevant": { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 1000, output_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const res = await handle(post(good), env(), upstream);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.answers["JHN.3.16_relevant"].noul).toBe(0.9);
    expect(data.usd).toBeCloseTo((1000 / 1_000_000) * USD_PER_MTOK);
    expect(seen[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen[0].auth).toBe("Bearer test-key-not-real");
    expect(JSON.stringify(data)).not.toContain("test-key-not-real");
    expect((seen[0].body as { state: { highlights: string[] } }).state.highlights[0]).toContain("For God so loved");
  });

  test("shape refusal does not call upstream", async () => {
    let called = 0;
    const upstream = (async () => {
      called++;
      return new Response("{}");
    }) as typeof fetch;
    const res = await handle(post({ ...good, extra: true }), env(), upstream);
    expect(res.status).toBe(400);
    expect(called).toBe(0);
  });
});
