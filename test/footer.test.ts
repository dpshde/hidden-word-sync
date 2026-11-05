import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
const footer = /<footer class="shell-meta">([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? "";

test("the footer holds the theme, the contract and the auth status, and nothing else", () => {
  const items = [...footer.matchAll(/<(button|a|span)\b[^>]*>/g)].map((m) => m[0]);
  expect(items).toHaveLength(3);
  expect(items[0]).toContain("theme-toggle");
  expect(items[1]).toContain('href="https://github.com/dpshde/selah-vault/blob/main/SPEC.md"');
  expect(items[2]).toContain('id="auth-status"');
});

test("the contract link goes where For developers' spec link does", () => {
  expect(html).toContain('Read <a href="https://github.com/dpshde/selah-vault/blob/main/SPEC.md"');
});

test("the ••• menu stays Sync · Colors · Backup · Log out; theme lives in footer and mobile dock", () => {
  // Desktop footer + mobile dock each carry a theme control (same setupThemeToggle wiring).
  expect(html.match(/theme-toggle/g)).toHaveLength(2);
  expect(html).toContain('id="dock-auth-status"');
  const menu = /<details id="menu">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
  expect([...menu.matchAll(/<(button|hr)\b[^>]*>([^<]*)/g)].map((m) => (m[1] === "hr" ? "—" : m[2]))).toEqual(["Sync", "Colors", "Backup", "—", "Log out"]);
});

test("the footer never says anything about sync, and auth status is only signed in or out", () => {
  const visible = footer.replace(/<[^>]*>/g, " ").toLowerCase(); // the repo name in the link's address is fine
  expect(visible).not.toContain("sync");
  expect(visible).not.toMatch(/online|offline|syncing/);
  const show = /function show\(id\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? "";
  expect(show).toContain('SIGNED_IN.has(id) ? "Signed in" : "Signed out"');
  expect(show).toContain("#auth-status, #dock-auth-status");
  expect(app).toContain('const SIGNED_IN = new Set(["main", "colors", "backup", "sync"]);');
});

test("small screens get a fixed thumb dock; desktop keeps shell-meta", () => {
  expect(html).toContain('id="chrome-dock"');
  expect(html).toContain('id="dock-tray"');
  expect(css).toContain("#chrome-dock { display: contents; }");
  expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?#chrome-dock\s*\{[^}]*position:\s*fixed/);
  expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?min-height:\s*44px/);
  expect(css).toMatch(/body:has\(#main:not\(\[hidden\]\)\) > \.shell-meta \{ display: none; \}/);
  // Dock theme control matches the footer icon (SVG), not a text glyph.
  expect(css).toContain(".dock-meta .theme-toggle svg { display: block; margin: 0 auto; }");
  // Mode labels stay unclipped at 375px (SURPRISING): tighter type, nowrap, no ellipsis.
  expect(css).toMatch(/#group-by\.segmented button \{[\s\S]*?font-size: \.625rem;[\s\S]*?letter-spacing: 0;[\s\S]*?white-space: nowrap/);
});
