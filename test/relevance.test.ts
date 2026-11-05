import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// @ts-ignore plain JS
import {
  batchHighlights,
  buildRelevanceRequest,
  chapterRefOf,
  createRelevance,
  emptyRelevanceCopy,
  parseVerdicts,
  rangeHash,
  rankErrorMessage,
  rankingCopy,
  rankStatusCopy,
  jevHintCopy,
  rankVerdicts,
  relatedCopy,
  sanitizeTopic,
  topicCopy,
  totalCopy,
  BATCH_SIZE,
} from "../public/relevance.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

function verseText(map: Record<string, string>) {
  return {
    get: async (ref: string) => ({ text: map[ref] ?? `text of ${ref}`, truncated: false, fetchRef: ref }),
    first() {},
    warm() {},
  };
}

describe("UI copy and list toolbar toggle", () => {
  test("the list bar offers Date · Genre · Relevant · Surprising · Topic above the list", () => {
    const bar = /<div id="group-by"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
    expect([...bar.matchAll(/data-mode="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "date",
      "genre",
      "relevant",
      "surprising",
      "topic",
    ]);
    // Relevant/Surprising hijack #ref; Topic swaps in #topic-ref inside #add.
    expect(html).not.toContain('id="relevance-ref"');
    expect(html).not.toContain('id="relevance-bar"');
    expect(html).not.toContain('id="list-foot"');
    expect(html).toContain('id="ref"');
    expect(html).toContain("<si-passage-input id=\"ref\"");
    expect(html).toContain('id="topic-ref"');
    expect(app).toContain('placeholder: "Rom 8:18–25"');
    expect(app).toContain("syncRefFieldMode");
    expect(app).toContain("rank-scope");
    expect(app).toContain("clearRankScopeFromRef");
    expect(css).toContain("#add.rank-scope");
    // Topic field lives inside #add beside #ref; #list-bar sits directly below #add and above #filters / #list.
    const addStart = html.indexOf('id="add"');
    const barStart = html.indexOf('id="list-bar"');
    const filtersStart = html.indexOf('id="filters"');
    const listStart = html.indexOf('id="list"');
    expect(addStart).toBeGreaterThan(html.indexOf("<header>"));
    expect(html.slice(addStart, barStart)).toContain('id="topic-ref"');
    expect(barStart).toBeGreaterThan(addStart);
    expect(filtersStart).toBeGreaterThan(barStart);
    expect(listStart).toBeGreaterThan(filtersStart);
    const listBar = html.slice(barStart, filtersStart);
    expect(listBar).toContain('id="group-by"');
    expect(listBar).toContain('id="list-total"');
    // Preview sits above the list, after filters.
    expect(html.indexOf('id="rank-preview"')).toBeLessThan(listStart);
    expect(html.indexOf('id="rank-preview"')).toBeGreaterThan(filtersStart);
    expect(css).toContain(".list-bar");
    expect(css).toContain(".rank-preview");
    expect(css).toContain("-webkit-line-clamp");
  });

  test("count and empty-state copy", () => {
    expect(totalCopy(6, 47)).toBe("6 of 47 relevant");
    expect(rankStatusCopy(3, 10, "relevant")).toBe("3 of 10 · closest");
    expect(rankStatusCopy(3, 10, "surprising")).toBe("3 of 10 · least obvious");
    expect(rankStatusCopy(10, 10, "topic")).toBe("10 · closest");
    expect(topicCopy("grace")).toBe("Sorted by closeness to “grace”");
    expect(topicCopy("")).toBe("Sorted by closeness");
    expect(jevHintCopy("relevant")).toBe("Type a passage to find related highlights");
    expect(jevHintCopy("surprising")).toBe("Type a passage to find related highlights");
    expect(jevHintCopy("topic")).toBe("Type a topic to sort your highlights");
    expect(sanitizeTopic("  grace  ")).toBe("grace");
    expect(emptyRelevanceCopy(17, "Hab 2:2")).toBe("None of your 17 highlights connect to Hab 2:2");
    expect(emptyRelevanceCopy(1, "Romans 8:28")).toBe("None of your 1 highlight connect to Romans 8:28");
    expect(chapterRefOf("HAB.2.2")).toBe("HAB.2");
    expect(chapterRefOf("ROM.8.18-25")).toBe("ROM.8");
    expect(chapterRefOf("PSA.23")).toBe("PSA.23");
    expect(html).toContain('id="relevance-none"');
    expect(html).toContain("Open on route.bible");
    expect(html).toContain("Try the whole chapter");
    expect(html).toContain("Sort by Date");
    expect(app).toContain("emptyRelevanceCopy");
    expect(app).toContain("showRelevanceNone");
    expect(app).toContain("showRankPreview");
    expect(app).toContain("relevance-none-route");
    expect(app).toContain("relevance-none-chapter");
    expect(app).toContain("relevance-none-date");
    expect(app).toContain("rankFailed");
    expect(app).toContain("rankErrorMessage");
    // Distinct from the error line and from the library-empty #empty copy.
    expect(app).toContain('textContent = "No highlights yet."');
    expect(css).toContain(".relevance-none");
  });

  test("rank-mode header and loading copy; stale generations are ignored; identical list markup", () => {
    expect(relatedCopy("Habakkuk 2:2")).toBe("Related to Habakkuk 2:2");
    expect(relatedCopy("")).toBe("Related");
    expect(rankingCopy()).toBe("Ranking…");
    expect(app).toContain("relatedCopy(relevance?.passage?.label)");
    expect(app).toContain("topicCopy(relevance?.topic)");
    expect(app).toContain("rankingCopy()");
    expect(app).toMatch(/if \(rankPending\) \{[\s\S]*?rankingCopy\(\)/);
    // Same group()/row() path as Date and Genre — no dedicated rankGroup or reason lines.
    expect(app).toContain('group({ id: "ranked"');
    expect(app).not.toContain("function rankGroup");
    expect(app).not.toContain("row-reason");
    expect(app).not.toContain("rankReasons");
    expect(css).not.toContain(".row-reason");
    expect(app).not.toContain("rank-mode");
    // Blank dark bar was summary.hidden + display:flex overriding [hidden]; now a labeled summary.
    expect(app).not.toContain("summary.hidden = true");
    expect(css).toContain("#list .group > summary[hidden] { display: none; }");
    // Generation token: bump on input/clear/run; apply results only when still current.
    expect(app).toContain("let rankGeneration = 0");
    expect(app).toContain("const gen = ++rankGeneration");
    expect(app).toContain("if (gen !== rankGeneration) return");
    expect(app).toContain("if (gen === rankGeneration)");
    // Auto-expand top result once per final paint (new query or mode switch); respect manual toggles.
    expect(app).toContain("beginRankPaint");
    expect(app).toContain("applyRankAutoExpand");
    expect(app).toContain("rankUserTouched");
    expect(app).toContain("applyRankAutoExpand(ranked[0].ref)");
    // Mode switch Relevant ↔ Surprising starts a new paint so the new top expands.
    expect(app).toMatch(/beginRankPaint\(\);\s*void reorderRelevance\(\)/);
    // Empty Jev scope: hint in the list area (not foot status), no stale Date groups.
    // Topic must not treat a leftover Relevant passage as scope (mode-specific hasScope).
    expect(app).toContain("jevWaiting");
    expect(app).toContain("jevHintCopy(groupBy)");
    expect(app).toContain('hint.className = "rank-hint"');
    expect(app).toContain('$("#list-total").textContent = ""');
    expect(app).toMatch(/RANK_MODES\.includes\(groupBy\)\s*\?\s*!!relevance\?\.passage/);
    expect(app).toContain('relevance?.setTopicInput("")');
    expect(css).toContain(".rank-hint");
    // Foot never shows topicCopy / “Sorted by closeness” while the list is empty.
    expect(app).not.toMatch(/list-total"\)\.textContent =\s*\n\s*groupBy === TOPIC_MODE \? topicCopy/);
    // Expanded reader forces Lexend inside the shadow (si-passage .root uses all:initial).
    expect(app).toContain('font-family: "Lexend"');
    expect(app).toContain("styleScripture(el); // re-apply after reconnect");
    // Typing a new ref clears the old list and shows loading before the debounced request.
    expect(app).toMatch(/addEventListener\("input"[\s\S]*?rankGeneration\+\+[\s\S]*?rankPending = true/);
    expect(app).toContain('rankPending = true;\n  render(); // loading before any network / verse fetch');
    // List bar keeps status right-aligned with wrap when needed.
    expect(css).toContain("white-space: nowrap");
    expect(css).toMatch(/\.list-bar\s*\{[^}]*justify-content:\s*space-between/);
    expect(css).toContain(".list-total:empty { display: none; }");
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

  test("valid ref → filter then sort; payload carries passage text; no reason questions", async () => {
    const calls: unknown[] = [];
    const session = createRelevance({
      lib: "lib1",
      jevUrl: "https://jev.test",
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        const ids = body.highlights.map((h: { id: string }) => h.id);
        if (body.ask === "filter") {
          return new Response(JSON.stringify({
            answers: Object.fromEntries(ids.map((id: string) => [`${id}_relevant`, { type: "noul", noul: 0.9 }])),
          }));
        }
        return new Response(JSON.stringify({
          answers: Object.fromEntries(ids.map((id: string) => [`${id}_obviousness`, { type: "score", score: 2 }])),
        }));
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
    expect(fetched).toBe(2); // filter + sort (2 survivors)
    expect(calls).toHaveLength(2);
    expect(calls.map((c: { ask: string }) => c.ask)).toEqual(["filter", "sort"]);
    const filterBody = calls[0] as ReturnType<typeof buildRelevanceRequest>;
    expect(filterBody.passage?.text).toContain("present sufferings");
    expect(filterBody.highlights.map((h) => h.text).join(" ")).toContain("For God so loved");
    expect(JSON.stringify(calls)).not.toContain("_reason");
    expect(ranked.length).toBe(2);
    expect(ranked[0]).not.toHaveProperty("reason");
  });

  test("sort is skipped when fewer than 2 survivors", async () => {
    const asks: string[] = [];
    const session = createRelevance({
      lib: "lib1",
      jevUrl: "https://jev.test",
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        asks.push(body.ask);
        return new Response(JSON.stringify({
          answers: {
            "JHN.3.16_relevant": { type: "noul", noul: 0.9 },
            "PSA.23.1_relevant": { type: "noul", noul: 0.1 },
          },
        }));
      }) as typeof fetch,
      verseText: verseText({
        "ROM.8.28": "all things",
        "JHN.3.16": "love",
        "PSA.23.1": "shepherd",
      }),
    });
    await session.setPassageInput("Rom 8:28");
    const { ranked, fetched } = await session.judge(
      [
        { id: "JHN.3.16", ref: "JHN.3.16", text: "love" },
        { id: "PSA.23.1", ref: "PSA.23.1", text: "shepherd" },
      ],
      "relevant",
    );
    expect(asks).toEqual(["filter"]);
    expect(fetched).toBe(1);
    expect(ranked.map((v) => v.id)).toEqual(["JHN.3.16"]);
  });

  test("topic mode: one closeness call, keeps every highlight, no passage", async () => {
    const calls: unknown[] = [];
    const session = createRelevance({
      lib: "lib1",
      jevUrl: "https://jev.test",
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        return new Response(JSON.stringify({
          answers: {
            "JHN.3.16_closeness": { type: "score", score: 4 },
            "PSA.23.1_closeness": { type: "score", score: 1 },
          },
        }));
      }) as typeof fetch,
      verseText: verseText({ "JHN.3.16": "love", "PSA.23.1": "shepherd" }),
    });
    const { ranked, fetched } = await session.judgeTopic(
      [
        { id: "JHN.3.16", ref: "JHN.3.16", text: "love" },
        { id: "PSA.23.1", ref: "PSA.23.1", text: "shepherd" },
      ],
      "  grace  ",
    );
    expect(fetched).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ask: "topic", topic: "grace" });
    expect((calls[0] as { passage?: unknown }).passage).toBeUndefined();
    expect(ranked.map((v) => v.id)).toEqual(["JHN.3.16", "PSA.23.1"]);
    expect(session.topic).toBe("grace");
    expect(session.passage).toBe(null);
  });

  test("long ranges are truncated to the first short verses in the verse helper", async () => {
    // Covered in bsb-text.test; here the payload still carries the full ref.
    const body = buildRelevanceRequest({
      lib: "x",
      ask: "filter",
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
        if (body.ask === "filter") {
          return new Response(JSON.stringify({
            answers: {
              A_relevant: { type: "noul", noul: 0.7 },
              B_relevant: { type: "noul", noul: 0.95 },
            },
          }));
        }
        return new Response(JSON.stringify({
          answers: {
            A_obviousness: { type: "score", score: 3, confidence: 1, legend: {}, probabilities: {} },
            B_obviousness: { type: "score", score: 0.2, confidence: 1, legend: {}, probabilities: {} },
          },
        }));
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
    expect(fetches).toBe(2); // filter + sort
    const second = session.reorder(items, "surprising");
    expect(second.fetched).toBe(0);
    expect(fetches).toBe(2);
    expect(second.ranked.map((v) => v.id)).toEqual(["B", "A"]); // B is less obvious
  });

  test("changes feed re-judges only changed ids", async () => {
    let bodies: Array<{ ask: string; highlights: Array<{ id: string }> }> = [];
    const session = createRelevance({
      lib: "lib1",
      jevUrl: "https://jev.test",
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (body.ask === "filter") {
          return new Response(JSON.stringify({
            answers: Object.fromEntries(
              body.highlights.map((h: { id: string }) => [`${h.id}_relevant`, { type: "noul", noul: 0.9 }]),
            ),
          }));
        }
        return new Response(JSON.stringify({
          answers: Object.fromEntries(
            body.highlights.map((h: { id: string }) => [`${h.id}_obviousness`, { type: "score", score: 2 }]),
          ),
        }));
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
    expect(bodies).toHaveLength(2);
    expect(bodies[0].ask).toBe("filter");
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
    expect(bodies.map((b) => b.ask)).toEqual(["filter", "sort"]);
    expect(bodies[0].highlights.map((h) => h.id)).toEqual(["ROM.5.3-4"]);
    expect(bodies[1].highlights.map((h) => h.id)).toEqual(["ROM.5.3-4"]);
  });
});

describe("batching and ranking helpers", () => {
  test("batches stay near 40 highlights", () => {
    const items = Array.from({ length: 90 }, (_, i) => ({ id: String(i), ref: `JHN.1.${i + 1}`, text: "x".repeat(20) }));
    const batches = batchHighlights(items);
    expect(batches[0].length).toBeLessThanOrEqual(BATCH_SIZE);
    expect(batches.reduce((n, b) => n + b.length, 0)).toBe(90);
  });

  test("parse and rank: relevant closest first, surprising least obvious first; no reasons", () => {
    const v = parseVerdicts({
      a_relevant: { type: "noul", noul: 0.9 },
      a_obviousness: { type: "score", score: 3 },
      b_relevant: { type: "noul", noul: 0.6 },
      b_obviousness: { type: "score", score: 0.1 },
      c_relevant: { type: "noul", noul: 0.1 },
      c_obviousness: { type: "score", score: 1 },
    });
    expect(rankVerdicts([...v.values()], "relevant").map((x) => x.id)).toEqual(["a", "b"]);
    expect(rankVerdicts([...v.values()], "surprising").map((x) => x.id)).toEqual(["b", "a"]);
    expect(v.get("a")).not.toHaveProperty("reason");
    expect(v.get("c")?.relevant).toBe(false);
  });

  test("topic closeness sorts highest first and keeps all", () => {
    const v = parseVerdicts({
      a_closeness: { type: "score", score: 2 },
      b_closeness: { type: "score", score: 5 },
      c_closeness: { type: "score", score: 1 },
    });
    expect(rankVerdicts([...v.values()], "topic").map((x) => x.id)).toEqual(["b", "a", "c"]);
  });

  test("rangeHash changes when the text changes", async () => {
    expect(await rangeHash("a")).not.toBe(await rangeHash("b"));
    expect(await rangeHash("same")).toBe(await rangeHash("same"));
  });
});
