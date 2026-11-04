import { expect, test } from "bun:test";
// @ts-ignore plain JS
import { fetchRefFor, plainFromHtml, createBsbText, LONG_RANGE, SHORT_VERSES } from "../public/bsb-text.js";

test("ranges within the limit are fetched whole; longer ones take the first short verses", () => {
  expect(fetchRefFor("JHN.3.16")).toEqual({ fetchRef: "JHN.3.16", truncated: false });
  expect(fetchRefFor("ROM.8.18-25")).toEqual({ fetchRef: "ROM.8.18-25", truncated: false });
  const long = `PSA.119.1-${LONG_RANGE + 1}`;
  expect(fetchRefFor(long)).toEqual({
    fetchRef: `PSA.119.1-${SHORT_VERSES}`,
    truncated: true,
  });
});

test("YouVersion HTML becomes one plain line of words", () => {
  expect(plainFromHtml('<p><sup class="v">18</sup>I consider that our present sufferings</p>')).toBe(
    "I consider that our present sufferings",
  );
  expect(plainFromHtml("A &amp; B &nbsp; C")).toBe("A & B C");
});

test("text is cached by ref+BSB and fetched through /yv", async () => {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ id: "JHN.3.16", content: "<p>For God so loved</p>" }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  const bsb = createBsbText({
    fetch,
    host: "https://vault.selah.tools",
    warmerFactory: (start: (ref: string) => Promise<unknown>) => ({
      add: (ref: string) => void start(ref),
      first() {},
    }),
  });
  const a = await bsb.get("JHN.3.16");
  const b = await bsb.get("JHN.3.16");
  expect(a.text).toBe("For God so loved");
  expect(b.text).toBe("For God so loved");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("/yv/v1/bibles/3034/passages/JHN.3.16");
});
