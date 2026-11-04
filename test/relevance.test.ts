import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// @ts-ignore plain JS
import {
  batchHighlights,
  buildRelevanceRequest,
  createRelevance,
  EMPTY_RELEVANCE,
  parseVerdicts,
  rangeHash,
  rankErrorMessage,
  rankVerdicts,
  totalCopy,
  BATCH_SIZE,
} from "../public/relevance.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function verseText(map: Record<string, string>) {
  return {
    get: async (ref: string) => ({ text: map[ref] ?? `text of ${ref}`, truncated: false, fetchRef: ref }),
    first() {},
    warm() {},
  };
}

function answersFor(ids: string[], opts: { relevant?: number; obvious?: number; reason?: string } = {}) {
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    out[`${id}_relevant`] = { type: "noul", noul: opts.relevant ?? 0.9 };
    out[`${id}_reason`] = { type: "choice", choice: opts.reason ?? "same_theme", confidence: 0.8, probabilities: {} };
    out[`${id}_obviousness`] = { type: "score", score: opts.obvious ?? 2, confidence: 0.7, legend: {}, probabilities: {} };
  }
  return out;
}

describe("UI copy and footer toggle", () => {
  test("the list footer offers Date · Genre · Relevant · Surprising", () => {
    const bar = /<div id="group-by"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
    expect([...bar.matchAll(/data-mode="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "date",
      "genre",
      "relevant",
      "surprising",
    ]);
    expect(html).toContain('id="relevance-ref"');
    expect(html).toContain("<si-passage-input id=\"relevance-ref\"");
    expect(html).toContain('placeholder="Rom 8:18–25"');
  });

  test("count and empty-state copy", () => {
    expect(totalCopy(6, 47)).toBe("6 of 47 relevant");
    expect(EMPTY_RELEVANCE).toBe("None of your highlights speak to this passage yet.");
    expect(app).toContain("totalCopy");
    expect(app).toContain("EMPTY_RELEVANCE");
    expect(app).toContain("rankFailed");
    expect(app).toContain("rankErrorMessage");
  });

  test("network and Worker errors become human lines, not Failed to fetch", () => {
    expect(rankErrorMessage(new Error("Failed to fetch"))).toMatch(/Couldn't reach Selah Vault ranking/);
    expect(rankErrorMessage(new Error("upstream error"))).toMatch(/couldn't rank these highlights/i);
    expect(rankErrorMessage(new Error("ranking unavailable"))).toMatch(/couldn't rank these highlights/i);
    expect(rankErrorMessage(new Error("daily spend cap"))).toMatch(/budget is used up/);
    expect(rankErrorMessage(new Error("Failed to fetch"))).not.toBe("Failed to fetch");
  });
});

describe("relevance session", () => {
  test("empty input does nothing and leaves no passage", async () => {
    const calls: unknown[] = [];
    const session = createRelevance({
      lib: "lib1",
      jevUrl: "https://jev.test",
      fetch: (async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response("{}");
      }) as typeof fetch,
      verseText: verseText({}),
    });
    await session.setPassageInput("   ");
    expect(session.passage).toBe(null);
    expect(calls).toEqual([]);
  });

  test("invalid ref shows its error and makes no call", async () => {
    const calls: unknown[] = [];
    const session = createRelevance({
      lib: "lib1",
      jevUrl: "https://jev.test",
      fetch: (async () => {
        calls.push(1);
        return new Response("{}");
      }) as typeof fetch,
      verseText: verseText({}),
    });
    const found = await session.setPassageInput("not a verse");
    expect(found.error).toBeTruthy();
    expect(session.passage).toBe(null);
    expect(calls).toEqual([]);
  });

  test("valid ref → exactly one batched call whose payload contains passage text", async () => {
    const calls: unknown[] = [];
    const session = createRelevance({
      lib: "lib1",
      jevUrl: "https://jev.test",
      fetch: (async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        const body = calls[0] as { highlights: Array<{ id: string }> };
        return new Response(JSON.stringify({ answers: answersFor(body.highlights.map((h) => h.id)) }));
      }) as typeof fetch,
      verseText: verseText({
        "ROM.8.18-25": "I consider that our present sufferings",
        "JHN.3.16": "For God so loved the world",
        "PSA.23.1": "The LORD is my shepherd",
      }),
    });
    const ok = await session.setPassageInput("Rom 8:18-25");
    expect(ok.error).toBeUndefined();
    expect(session.passage?.text).toContain("present sufferings");
    const { ranked, fetched } = await session.judge(
      [
        { id: "JHN.3.16", ref: "JHN.3.16" },
        { id: "PSA.23.1", ref: "PSA.23.1" },
      ],
      "relevant",
    );
    expect(fetched).toBe(1);
    expect(calls).toHaveLength(1);
    const body = calls[0] as ReturnType<typeof buildRelevanceRequest>;
    expect(body.passage.text).toContain("present sufferings");
    expect(body.highlights.map((h) => h.text).join(" ")).toContain("For God so loved");
    expect(ranked.length).toBe(2);
  });

  test("long ranges are truncated to the first short verses in the verse helper", async () => {
    // Covered in bsb-text.test; here the payload still carries the full ref.
    const body = buildRelevanceRequest({
      lib: "x",
      passage: { ref: "ROM.8.18-25", text: "passage" },
      highlights: [{ id: "PSA.119.1-176", ref: "PSA.119.1-176", text: "Blessed are those…" }],
    });
    expect(body.highlights[0].ref).toBe("PSA.119.1-176");
    expect(body.highlights[0].text.length).toBeGreaterThan(0);
  });

  test("mode switch reorders cached verdicts with no fetch", async () => {
    let fetches = 0;
    const session = createRelevance({
      lib: "lib1",
      jevUrl: "https://jev.test",
      fetch: (async (_url, init) => {
        fetches++;
        const body = JSON.parse(String(init?.body));
        const ans = answersFor(body.highlights.map((h: { id: string }) => h.id));
        // Make one more obvious than the other.
        ans["A_obviousness"] = { type: "score", score: 3, confidence: 1, legend: {}, probabilities: {} };
        ans["B_obviousness"] = { type: "score", score: 0.2, confidence: 1, legend: {}, probabilities: {} };
        ans["A_relevant"] = { type: "noul", noul: 0.7 };
        ans["B_relevant"] = { type: "noul", noul: 0.95 };
        return new Response(JSON.stringify({ answers: ans }));
      }) as typeof fetch,
      verseText: verseText({ A: "a", B: "b", "ROM.8.28": "all things" }),
    });
    await session.setPassageInput("Rom 8:28");
    const items = [
      { id: "A", ref: "A", text: "a" },
      { id: "B", ref: "B", text: "b" },
    ];
    const first = await session.judge(items, "relevant");
    expect(first.ranked.map((v) => v.id)).toEqual(["B", "A"]); // closest first
    expect(fetches).toBe(1);
    const second = session.reorder(items, "surprising");
    expect(second.fetched).toBe(0);
    expect(fetches).toBe(1);
    expect(second.ranked.map((v) => v.id)).toEqual(["B", "A"]); // B is less obvious
  });

  test("changes feed re-judges only changed ids", async () => {
    let bodies: Array<{ highlights: Array<{ id: string }> }> = [];
    const session = createRelevance({
      lib: "lib1",
      jevUrl: "https://jev.test",
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return new Response(JSON.stringify({ answers: answersFor(body.highlights.map((h: { id: string }) => h.id)) }));
      }) as typeof fetch,
      verseText: verseText({ "JHN.3.16": "love", "ROM.5.3": "suffering", "ROM.5.4": "endurance" }),
    });
    await session.setPassageInput("Rom 8:28");
    await session.judge(
      [
        { id: "JHN.3.16", ref: "JHN.3.16", text: "love" },
        { id: "ROM.5.3-4", ref: "ROM.5.3-4", text: "suffering endurance" },
      ],
      "relevant",
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0].highlights.map((h) => h.id).sort()).toEqual(["JHN.3.16", "ROM.5.3-4"]);

    // A verse inside the run changed: only that run is re-asked.
    session.applyChanges({ upserts: [{ ref: "ROM.5.4" }], deletions: [] });
    bodies = [];
    await session.judge(
      [
        { id: "JHN.3.16", ref: "JHN.3.16", text: "love" },
        { id: "ROM.5.3-4", ref: "ROM.5.3-4", text: "suffering endurance edited" },
      ],
      "relevant",
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0].highlights.map((h) => h.id)).toEqual(["ROM.5.3-4"]);
  });
});

describe("batching and ranking helpers", () => {
  test("batches stay near 40 highlights", () => {
    const items = Array.from({ length: 90 }, (_, i) => ({ id: String(i), ref: `JHN.1.${i + 1}`, text: "x".repeat(20) }));
    const batches = batchHighlights(items);
    expect(batches[0].length).toBeLessThanOrEqual(BATCH_SIZE);
    expect(batches.reduce((n, b) => n + b.length, 0)).toBe(90);
  });

  test("parse and rank: relevant closest first, surprising least obvious first", () => {
    const v = parseVerdicts({
      a_relevant: { type: "noul", noul: 0.9 },
      a_reason: { type: "choice", choice: "same_promise" },
      a_obviousness: { type: "score", score: 3 },
      b_relevant: { type: "noul", noul: 0.6 },
      b_reason: { type: "choice", choice: "contrast" },
      b_obviousness: { type: "score", score: 0.1 },
      c_relevant: { type: "noul", noul: 0.1 },
      c_reason: { type: "choice", choice: "same_theme" },
      c_obviousness: { type: "score", score: 1 },
    });
    expect(rankVerdicts([...v.values()], "relevant").map((x) => x.id)).toEqual(["a", "b"]);
    expect(rankVerdicts([...v.values()], "surprising").map((x) => x.id)).toEqual(["b", "a"]);
    expect(v.get("a")?.reason).toBe("Shared promise");
    expect(v.get("c")?.reason).toBe("Same theme");
  });

  test("rangeHash changes when the text changes", async () => {
    expect(await rangeHash("a")).not.toBe(await rangeHash("b"));
    expect(await rangeHash("same")).toBe(await rangeHash("same"));
  });
});
