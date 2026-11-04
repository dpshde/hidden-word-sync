import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");
const css = read("style.css"), app = read("app.js");

test("both pages carry route.bible's second, unmasked grain layer, shown only in dark", () => {
  for (const page of ["index.html", "unlock.html"])
    expect(read(page)).toMatch(/<body[^>]*>\s*(<!--[^>]*-->\s*)?<div class="monologue-grain" aria-hidden="true"><div class="monologue-grain__tile"><\/div><\/div>/);
  expect(css).toMatch(/\.monologue-grain \{ display: none;[^}]*z-index: 12;[^}]*mix-blend-mode: lighten; opacity: \.06; \}/);
  expect(css).toContain(':root[data-theme="dark"] .monologue-grain { display: block; }');
  expect(css).toContain(':root:not([data-theme="light"]) .monologue-grain { display: block; }');
});

test("custom and add rows are shaped like the built-in rows, with the action inside the field", () => {
  const add = /<form id="add-color"[\s\S]*?<\/form>/.exec(read("index.html"))?.[0] ?? "";
  expect(add).toMatch(/<span class="color-field">\s*<input name="name"[^>]*>\s*<button type="submit" class="icon field-action" aria-label="Add color"/);
  expect(app).toContain('iconButton("button", "trash", `Delete ${colorName(c)}`)');
  expect(app).toMatch(/className = "color-field"/);
  expect(css).toMatch(/input\[type="color"\] \{ width: 1\.25rem; height: 1\.25rem;/);
});
