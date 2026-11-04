import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");
const css = read("style.css"), app = read("app.js");

test("with a verse key the row always gets the book button, between the pencil and the trash", () => {
  expect(app).toMatch(/actions\.append\(edit\);\s*if \(verseText\.key\) actions\.append\(textButton\(li, runRef\)\);\s*actions\.append\(del\);/);
  // The key is kept on the device and the config fetch is retried, so a slow or failed /config.json
  // doesn't drop the book from every row.
  expect(app).toContain('const YV_KEY = "hidden-word:yv-key";');
  expect(app).toContain("useVerseKey(localStorage.getItem(YV_KEY))");
  expect(app).toContain("setTimeout(() => loadConfig(false), 2000)");
});

test("no narrow or touch rule hides the book, and a 320px row fits all three icons", () => {
  for (const m of css.matchAll(/@media[^{]*\{([\s\S]*?)\n\}/g)) expect(m[1]).not.toMatch(/\.text[^{]*\{[^}]*display:\s*none/);
  const narrow = /@media \(max-width: 22\.5rem\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  expect(narrow).toContain(".actions .icon { min-width: 2.5rem; height: 2.5rem;");
  // 320px screen: 20px gutters each side, a 1.5rem dot area; three 40px icons + 8px trash gap + 2px gaps.
  const rem = 16, row = 320 - 2 * 20, icons = 3 * 2.5 * rem + .5 * rem + 2 * .125 * rem;
  expect(row - icons).toBeGreaterThan(100); // room left for the dot and an ellipsized reference
  expect(css).toMatch(/\.row \.ref \{[^}]*min-width: 0; overflow: hidden; text-overflow: ellipsis;/);
});
