import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");
const css = read("style.css"), app = read("app.js");

test("no copyright line; only the returned version's abbreviation shows, after the text", () => {
  expect(css).toContain(".verse-text::part(attribution) { display: none; }");
  expect(css).toMatch(/\.verse-text::part\(citation\) \{[^}]*font-size: 0;[^}]*text-align: right;/);
  expect(css).toMatch(/\.verse-text::part\(version\) \{[^}]*text-transform: uppercase;/);
  expect(app).toContain('el.setAttribute("reference", "citation");');
  expect(app).not.toContain("Public Domain");
});

test("the passage gets a rule in its row's color and themed verse numbers and words of Jesus", () => {
  expect(app).toContain('el.style.setProperty("--row-color", getComputedStyle(dot).backgroundColor)');
  expect(app).toContain("styleScripture(el);");
  expect(app).toMatch(/\.yv-vlbl, \.va \{ color: var\(--vault-verse/);
  expect(app).toMatch(/\.wj \{ color: var\(--vault-wj/);
  expect(css).toMatch(/\.verse-text \{[^}]*border-left: 2px solid color-mix\(in oklab, var\(--row-color/);
  expect(css).toMatch(/--vault-wj: color-mix\(in oklab, var\(--danger\)/);
  // Expand skeleton matches the same left rule so layout doesn't jump when text lands.
  expect(css).toContain(".verse-text-skel");
  expect(css).toMatch(/\.verse-text-skel \{[^}]*border-left: 2px solid color-mix\(in oklab, var\(--row-color/);
  expect(app).toContain("function verseTextSkeleton");
});

test("the expanded row's reference has no underline; the row keeps its focus ring", () => {
  expect(css).not.toMatch(/\.row-link\[aria-expanded="true"\][^{]*\{[^}]*text-decoration: underline/);
  expect(css).toContain(".row-link:focus-visible::after { outline: 2px solid var(--focus); outline-offset: -2px; }");
});
