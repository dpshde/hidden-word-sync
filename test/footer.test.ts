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

test("the ••• menu is Sync · Colors · Backup, then theme/contract/status on phones, then Log out", () => {
  // Desktop footer chip + menu theme row (phones) share setupThemeToggle.
  expect(html.match(/theme-toggle/g)).toHaveLength(2);
  expect(html).toContain('id="menu-auth-status"');
  expect(html).toContain('id="modes-menu"');
  expect(html).toContain('id="panel-slot"');
  const menu = /<details id="menu">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
  expect(menu).toContain('id="open-sync"');
  expect(menu).toContain('id="open-colors"');
  expect(menu).toContain('id="open-backup"');
  expect(menu).toContain("menu-theme");
  expect(menu).toContain("menu-link");
  expect(menu).toContain('id="menu-auth-status"');
  expect(menu).toContain('id="lock"');
  // Desktop keeps the short popover; phone-only rows are hidden above 600px.
  expect(css).toMatch(/@media \(min-width: 601px\)[\s\S]*?#menu \.menu-theme/);
});

test("the footer never says anything about sync, and auth status is only signed in or out", () => {
  const visible = footer.replace(/<[^>]*>/g, " ").toLowerCase();
  expect(visible).not.toContain("sync");
  expect(visible).not.toMatch(/online|offline|syncing/);
  const show = /function show\(id\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? "";
  expect(show).toContain('SIGNED_IN.has(id) ? "Signed in" : "Signed out"');
  expect(show).toContain("#auth-status, #menu-auth-status");
  expect(app).toContain('const SIGNED_IN = new Set(["main", "colors", "backup", "sync"]);');
  expect(app).toContain("function placeMenu()");
});

test("small screens get a fixed thumb dock; desktop keeps shell-meta", () => {
  expect(html).toContain('id="chrome-dock"');
  expect(html).toContain('id="dock-tray"');
  expect(css).toContain("#chrome-dock { display: contents; }");
  expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?#chrome-dock\s*\{[^}]*position:\s*fixed/);
  expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?min-height:\s*44px/);
  // Phone library/settings hide the desktop footer chips (they live in the ••• sheet).
  expect(css).toMatch(/body:has\(#main:not\(\[hidden\]\), #colors:not\(\[hidden\]\), #backup:not\(\[hidden\]\), #sync:not\(\[hidden\]\)\) > \.shell-meta \{[\s\S]*?display: none/);
});

test("phone ••• sits on the modes row; sheet holds theme/contract/status", () => {
  const mobile = css.slice(css.indexOf("@media (max-width: 600px)"));
  expect(mobile).toContain("--dock-pad-x: .75rem");
  // No bottom tray on phones — dock-tray is the desktop menu host only.
  expect(mobile).toMatch(/#chrome-dock > #dock-tray \{ display: none; \}/);
  // Modes + 44px ••• share one full-width row.
  expect(mobile).toMatch(/\.modes-menu \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 44px;/);
  expect(mobile).toMatch(/#group-by\.segmented button \{[\s\S]*?font-size: \.5625rem;[\s\S]*?letter-spacing: 0;[\s\S]*?white-space: nowrap/);
  // Sheet rows are full-width ≥44px including theme/contract/status.
  expect(mobile).toMatch(/#menu > div button,[\s\S]*?\.menu-status \{[\s\S]*?min-height: 44px;/);
  expect(mobile).toMatch(/\.panel-slot:not\(\[hidden\]\) \{[\s\S]*?position: fixed;/);
  // Desktop popover still shrink-wraps.
  expect(css).toContain("#menu > div { min-width: 12rem; padding: 0; }");
  expect(css.indexOf("#menu > div { min-width: 12rem")).toBeLessThan(css.indexOf("@media (max-width: 600px)"));
});
