// The passage field's keys, run against the vendored bundle the app ships (public/vendor/scripture-inline.js,
// built with patches/@faith-tools%2Fscripture-inline@0.3.1.patch).
import { expect, test } from "bun:test";

const classes: any[] = [];
Object.assign(globalThis, {
  HTMLElement: class {},
  customElements: { get: () => undefined, define: (_name: string, c: any) => classes.push(c) },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  document: { createElement: () => ({ setAttribute() {}, append() {}, style: {}, dataset: {} }) },
});
const { definePassageInput } = await import("../public/vendor/scripture-inline.js");
definePassageInput();
const Field = classes[0];

const suggestions = [
  { kind: "book", insertText: "John", label: "John" },
  { kind: "book", insertText: "1 John", label: "1 John" },
  { kind: "book", insertText: "2 John", label: "2 John" },
];

function field({ hovered = null as number | null, active = -1, open = true } = {}) {
  const accepted: string[] = [];
  const f = Object.create(Field.prototype);
  Object.assign(f, {
    suggestions,
    active,
    input: { value: "Joh" },
    list: {
      hidden: !open,
      querySelector: (sel: string) => (sel.includes(":hover") && hovered !== null ? { dataset: { index: String(hovered) } } : null),
    },
    accept: (s: { insertText: string }) => accepted.push(s.insertText),
  });
  return { f, accepted };
}

const tab = (shiftKey = false) => {
  const e = { key: "Tab", shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  return e;
};

test("Tab takes the option under the mouse, like a click", () => {
  const { f, accepted } = field({ hovered: 2, active: 0 });
  const e = tab();
  f.onKeydown(e);
  expect(accepted).toEqual(["2 John"]);
  expect(e.defaultPrevented).toBe(true);
});

test("with nothing under the mouse, Tab still completes the active (or first) book", () => {
  const first = field();
  first.f.onKeydown(tab());
  expect(first.accepted).toEqual(["John"]);
  const active = field({ active: 1 });
  active.f.onKeydown(tab());
  expect(active.accepted).toEqual(["1 John"]);
});

test("Shift+Tab, or a closed list, ignores the hovered option", () => {
  const shifted = field({ hovered: 2 });
  const e = tab(true);
  shifted.f.onKeydown(e);
  expect(shifted.accepted).toEqual([]);
  expect(e.defaultPrevented).toBe(false);
  const closed = field({ hovered: 2, open: false });
  closed.f.onKeydown(tab());
  expect(closed.accepted).toEqual(["John"]); // unchanged behavior: completes the first book
});

test("hovering marks the option active without scrolling, so Enter takes it too", () => {
  let scrolled = 0;
  const kids = [0, 1, 2].map((i) => ({ id: `l-${i}`, attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; }, scrollIntoView() { scrolled++; } }));
  const attrs: Record<string, string> = {};
  const f = Object.create(Field.prototype);
  Object.assign(f, { active: -1, list: { id: "l", children: kids }, input: { setAttribute: (k: string, v: string) => (attrs[k] = v), removeAttribute() {} } });
  f.highlight(2, false);
  expect(f.active).toBe(2);
  expect(kids[2].attrs["aria-selected"]).toBe("true");
  expect(attrs["aria-activedescendant"]).toBe("l-2");
  expect(scrolled).toBe(0);
  f.highlight(1);
  expect(scrolled).toBe(1); // arrow keys still scroll the option into view
});
