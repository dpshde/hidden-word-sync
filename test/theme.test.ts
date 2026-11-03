import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { THEME_KEY, flipped, shownTheme, storedTheme } from "../public/theme-toggle.js";

const storage = (value: string | null) => ({ getItem: (k: string) => (k === THEME_KEY ? value : null) });

test("no kept choice follows the system (System is the default)", () => {
  expect(storedTheme(storage(null))).toBeNull();
  expect(shownTheme(null, true)).toBe("dark");
  expect(shownTheme(null, false)).toBe("light");
});

test("a kept choice wins over the system, and junk counts as none", () => {
  expect(shownTheme(storedTheme(storage("light")), true)).toBe("light");
  expect(shownTheme(storedTheme(storage("dark")), false)).toBe("dark");
  expect(storedTheme(storage("purple"))).toBeNull();
  expect(storedTheme({ getItem: () => { throw new Error("blocked"); } })).toBeNull();
});

test("a tap switches to the other theme, both ways", () => {
  expect(flipped("light")).toBe("dark");
  expect(flipped("dark")).toBe("light");
});

// /theme.js runs before first paint, so a kept choice is on <html> before the stylesheet applies.
const runPrePaint = (value: string | null) => {
  const root = { dataset: {} as Record<string, string> };
  new Function("localStorage", "document", readFileSync(new URL("../public/theme.js", import.meta.url), "utf8"))(
    storage(value),
    { documentElement: root },
  );
  return root.dataset.theme;
};

test("the pre-paint script applies a kept choice, and leaves System alone", () => {
  expect(runPrePaint("dark")).toBe("dark");
  expect(runPrePaint("light")).toBe("light");
  expect(runPrePaint(null)).toBeUndefined();
  expect(runPrePaint("x")).toBeUndefined();
});

test("both pages load the pre-paint script before the stylesheet, as a plain (blocking) script", () => {
  for (const page of ["index.html", "unlock.html"]) {
    const html = readFileSync(new URL(`../public/${page}`, import.meta.url), "utf8");
    const script = html.indexOf('<script src="/theme.js"></script>');
    expect(script).toBeGreaterThan(-1);
    expect(script).toBeLessThan(html.indexOf('<link rel="stylesheet" href="/style.css">'));
  }
});
