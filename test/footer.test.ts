import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const footer = /<footer class="shell-meta">([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? "";

test("the footer holds the theme, the contract and the auth status, and nothing else", () => {
  const items = [...footer.matchAll(/<(button|a|span)\b[^>]*>/g)].map((m) => m[0]);
  expect(items).toHaveLength(3);
  expect(items[0]).toContain("theme-toggle");
  expect(items[1]).toContain('href="https://github.com/dpshde/hidden-word-sync/blob/main/SPEC.md"');
  expect(items[2]).toContain('id="auth-status"');
});

test("the contract link goes where For developers' spec link does", () => {
  expect(html).toContain('Read <a href="https://github.com/dpshde/hidden-word-sync/blob/main/SPEC.md"');
});

test("the theme button lives only in the footer; the ••• menu is unchanged", () => {
  expect(html.match(/theme-toggle/g)).toHaveLength(1);
  const menu = /<details id="menu">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
  expect([...menu.matchAll(/<(button|hr)\b[^>]*>([^<]*)/g)].map((m) => (m[1] === "hr" ? "—" : m[2]))).toEqual(["Sync", "Colors", "Backup", "—", "Log out"]);
});

test("the footer never says anything about sync, and auth status is only signed in or out", () => {
  const visible = footer.replace(/<[^>]*>/g, " ").toLowerCase(); // the repo name in the link's address is fine
  expect(visible).not.toContain("sync");
  expect(visible).not.toMatch(/online|offline|syncing/);
  const show = /function show\(id\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? "";
  const said = [...show.matchAll(/status\.textContent = ([^;]+);/g)].map((m) => m[1]);
  expect(said).toEqual(['SIGNED_IN.has(id) ? "Signed in" : "Signed out"']);
  expect(app.match(/#auth-status/g)).toHaveLength(1); // nothing else writes to it
  expect(app).toContain('const SIGNED_IN = new Set(["main", "colors", "backup", "sync"]);');
});
