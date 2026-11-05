import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
const footer = /<footer class="shell-meta">([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? "";

test("the footer holds the theme, the contract and the auth status, and #list-total sits beneath it", () => {
  const items = [...footer.matchAll(/<(button|a|span)\b[^>]*>/g)].map((m) => m[0]);
  expect(items).toHaveLength(3);
  expect(items[0]).toContain("theme-toggle");
  expect(items[1]).toContain('href="https://github.com/dpshde/selah-vault/blob/main/SPEC.md"');
  expect(items[2]).toContain('id="auth-status"');
  expect(html.indexOf('id="list-total"')).toBeGreaterThan(html.indexOf("</footer>"));
});

test("the contract link goes where For developers' spec link does", () => {
  expect(html).toContain('Read <a href="https://github.com/dpshde/selah-vault/blob/main/SPEC.md"');
});

test("the ••• menu is Sync · Colors · Backup, then theme/contract/status on phones, then Log out", () => {
  expect(html.match(/theme-toggle/g)).toHaveLength(2);
  expect(html).toContain('id="menu-auth-status"');
  expect(html).not.toContain('id="modes-menu"');
  expect(html).not.toContain('id="panel-slot"');
  const header = /<section id="main"[\s\S]*?<header>([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
  expect(header).toContain('id="lib-name"');
  expect(header).toContain('id="menu"');
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
  expect(app).not.toContain("function placeMenu()");
});

test("top-down flow on desktop and phone: #add then #list-bar above #filters and #list; no #chrome-dock", () => {
  expect(html).not.toContain('id="chrome-dock"');
  expect(html).not.toContain('id="dock-tray"');
  expect(html).not.toContain('id="list-foot"');
  expect(html).toContain('id="list-bar"');
  expect(css).not.toContain("#chrome-dock");
  expect(css).toMatch(/#main:not\(\[hidden\]\)\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column/);
  expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?min-height:\s*44px/);
  expect(css).toMatch(/body:has\(#main:not\(\[hidden\]\), #colors:not\(\[hidden\]\), #backup:not\(\[hidden\]\), #sync:not\(\[hidden\]\)\) > \.shell-meta \{[\s\S]*?display: none/);
});

test("phone ••• stays in <header> (reachable even when library is empty); sheet holds theme/contract/status", () => {
  const mobile = css.slice(css.indexOf("@media (max-width: 600px)"));
  expect(mobile).toContain("--dock-pad-x: .75rem");
  expect(mobile).toMatch(/#menu > summary \{[\s\S]*?min-height: 44px;/);
  expect(mobile).toMatch(/#menu > div button,[\s\S]*?\.menu-status \{[\s\S]*?min-height: 44px;/);
  expect(css).toContain("#menu > div { min-width: 12rem; padding: 0; }");
});

test("desktop uses segmented mode buttons in #list-bar; mobile (≤600px) uses a <select>", () => {
  for (const mode of ["date", "genre", "relevant", "surprising", "topic"]) {
    expect(html).toContain(`data-mode="${mode}"`);
    expect(html).toContain(`<option value="${mode}">`);
  }
  expect(html).toContain('id="group-by-select"');
  expect(html).toContain('aria-label="Sort highlights"');
  expect(html).not.toContain("mode-icon");
  expect(css).toContain(".list-bar .segmented");
  expect(css).toMatch(/\.list-bar \.segmented button\s*\{[^}]*flex:\s*1 0 auto/);
  expect(css).toContain(".mode-select");
  expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?\.list-bar \.segmented \{ display: none; \}/);
  expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?\.mode-select:not\(\[hidden\]\) \{[\s\S]*?display: block;/);
  expect(app).toContain("function selectMode(next)");
  expect(app).toContain('$("#group-by-select").value = groupBy');
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
