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
  expect(html.match(/theme-toggle/g)).toHaveLength(2);
  expect(html).toContain('id="menu-auth-status"');
  expect(html).toContain('id="modes-menu"');
  expect(html).not.toContain('id="panel-slot"');
  const menu = /<details id="menu">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
  expect(menu).toContain('id="open-sync"');
  expect(menu).toContain('id="open-colors"');
  expect(menu).toContain('id="open-backup"');
  expect(menu).toContain("menu-theme");
  expect(menu).toContain("menu-link");
  expect(menu).toContain('id="menu-auth-status"');
  expect(menu).toContain('id="lock"');
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
  expect(css).toMatch(/body:has\(#main:not\(\[hidden\]\), #colors:not\(\[hidden\]\), #backup:not\(\[hidden\]\), #sync:not\(\[hidden\]\)\) > \.shell-meta \{[\s\S]*?display: none/);
});

test("phone ••• sits on the modes row; sheet holds theme/contract/status", () => {
  const mobile = css.slice(css.indexOf("@media (max-width: 600px)"));
  expect(mobile).toContain("--dock-pad-x: .75rem");
  expect(mobile).toMatch(/#chrome-dock > #dock-tray \{ display: none; \}/);
  expect(mobile).toMatch(/\.modes-menu \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 44px;/);
  expect(mobile).toMatch(/#menu > div button,[\s\S]*?\.menu-status \{[\s\S]*?min-height: 44px;/);
  expect(css).toContain("#menu > div { min-width: 12rem; padding: 0; }");
});

test("phone mode segments use icons; inactive icon-only, active icon plus label", () => {
  for (const mode of ["date", "genre", "relevant", "surprising", "topic"]) {
    expect(html).toMatch(new RegExp(`data-mode="${mode}"[^>]*aria-label="[^"]+"[^>]*title="`));
    expect(html).toMatch(new RegExp(`data-mode="${mode}"[\\s\\S]*?<svg class="mode-icon"`));
    expect(html).toMatch(new RegExp(`data-mode="${mode}"[\\s\\S]*?<span class="mode-label">`));
  }
  const mobile = css.slice(css.indexOf("@media (max-width: 600px)"));
  expect(mobile).toContain("#group-by.segmented button .mode-icon");
  expect(mobile).toContain('#group-by.segmented button .mode-label { display: none; }');
  expect(mobile).toContain('#group-by.segmented button[aria-pressed="true"] .mode-label { display: block; }');
  // Desktop keeps text; icons stay hidden.
  expect(css).toContain(".mode-icon { display: none; }");
});

test("phone Colors/Sync/Backup are top-aligned pages with header close and pinned Done", () => {
  expect(html).toContain('class="settings-panel"');
  expect(html).toContain('class="panel-head"');
  expect(html).toContain('class="panel-foot"');
  expect(html).toContain('class="back panel-close"');
  const mobile = css.slice(css.indexOf("@media (max-width: 600px)"));
  expect(mobile).toMatch(/\.settings-panel:not\(\[hidden\]\) \{[\s\S]*?display: flex;/);
  expect(mobile).toMatch(/\.settings-panel \.panel-head \{[\s\S]*?min-height: 52px;/);
  expect(mobile).toMatch(/\.settings-panel \.panel-foot \.back \{[\s\S]*?min-height: 48px;/);
  expect(mobile).toMatch(/#color-list \.color-field input,[\s\S]*?min-height: 48px;/);
  expect(mobile).toMatch(/#color-list \.dot,[\s\S]*?width: 48px;[\s\S]*?height: 48px;/);
  expect(mobile).toMatch(/#color-list \.field-action,[\s\S]*?min-width: 44px;[\s\S]*?height: 44px;/);
  expect(app).toContain('el.closest(".settings-panel")');
});
