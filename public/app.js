import {
  COLORS, Library, KeyError, newKey, formatKey, parseKey, now, palette, topColor, parseJsonl, fromBibleRs, saveSlot, openSlot,
  serverTransport, folderTransport,
} from "./sync.js";
import { labelRef, compareRefs, groupRuns, highlightRecord, editRun } from "./refs.js";
import { readPassage } from "./passage.js";
import { definePassageInput, defineScripturePassage } from "./vendor/scripture-inline.js";
import { createPasskeyPrf, getPasskeyPrf, passkeysAvailable, cancelled } from "./passkey.js";
import { foldersAvailable, pickFolder, saveFolder, loadFolder, forgetFolder, mayUse, folderDir } from "./folder.js";

const $ = (sel) => document.querySelector(sel);
const SESSION = "hidden-word:session";
const CREATED = "hidden-word:created";
const SAVE_LINK = "hidden-word:save-link";
// A library's name as this device last called it. The name isn't synced: it's this device's label.
const nameKey = (lib) => `hidden-word:name:${lib}`;
const store = {
  load: (lib) => JSON.parse(localStorage.getItem(`hidden-word:${lib}`) ?? "null"),
  save: (lib, state) => localStorage.setItem(`hidden-word:${lib}`, JSON.stringify(state)),
  clear: (lib) => localStorage.removeItem(`hidden-word:${lib}`),
};
// How this browser syncs each library. Not synced itself: each device chooses.
const settingsKey = (lib) => `hidden-word:settings:${lib}`;
const settings = (lib) => ({ server: true, ...JSON.parse(localStorage.getItem(settingsKey(lib)) ?? "{}") });
const saveSettings = (lib, s) => localStorage.setItem(settingsKey(lib), JSON.stringify(s));

let library = null;
let colors = palette([]);
let folder = { handle: null, state: "off" };
let filter = null;
let flashTimer = 0;

function show(id) {
  for (const section of document.querySelectorAll("main > section")) section.hidden = section.id !== id;
}

/** Shows a passing message, with an optional button such as `{ label: "Undo", run }`. */
function flash(text, action) {
  const el = $("#flash");
  el.replaceChildren(text);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", async () => {
      el.replaceChildren();
      await action.run();
    });
    el.append(" ", button);
  }
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.replaceChildren(), action ? 15_000 : 6000);
}

const errorIn = (form, text) => (form.querySelector(".error").textContent = text);
const capitalized = (s) => s[0].toUpperCase() + s.slice(1);
const colorName = (c) => c.name || (c.builtIn ? capitalized(c.id) : "Color");

function paint(el, id) {
  const c = colors.find((x) => x.id === id) ?? colors[0];
  el.dataset.color = c.builtIn ? c.id : "own";
  el.style.background = c.builtIn ? "" : c.hex;
}

// ---- unlocking, creating, locking

async function enter(keyText, given) {
  library = await Library.open({ keyText, name: given, store });
  const name = localStorage.getItem(nameKey(library.lib)) || given;
  library.name = name;
  localStorage.setItem(SESSION, JSON.stringify({ key: library.keyText, name }));
  $("#lib-name").textContent = name;
  library.onChange(render);
  show("main");
  render();
  await saveFromLink();
  await connect();
}

/** Sets up this browser's chosen transports for the open library and syncs. */
async function connect() {
  const transports = [];
  if (settings(library.lib).server) transports.push(serverTransport());
  folder = { handle: (await loadFolder(library.lib)) ?? null, state: "off" };
  if (folder.handle) {
    folder.state = (await mayUse(folder.handle)) ? "on" : "paused";
    if (folder.state === "on") transports.push(folderTransport(folderDir(folder.handle)));
    // Paused until allowed again; the Sync screen says so. The main view never talks about sync.
  }
  renderSync();
  await library.use(transports);
}

function lock() {
  library?.forget();
  library = null;
  localStorage.removeItem(SESSION);
  $("#menu").open = false;
  $("#passkey-offer").hidden = true;
  document.querySelectorAll("form").forEach((f) => f.reset());
  show("start");
}

let unlocking = false;

$("#unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (unlocking) return;
  const form = new FormData(e.target);
  unlocking = true;
  try {
    await enter(form.get("password"), form.get("username").trim() || "Personal");
  } catch (error) {
    errorIn(e.target, error instanceof KeyError ? "That sync key has a typo. Check it and try again." : String(error.message));
  } finally {
    unlocking = false;
  }
});

// Unlock as soon as the field holds a whole, valid key, so a password manager's fill (1Password,
// iCloud Keychain, Chrome) signs straight in without a click. The check byte means a key still
// being typed, or one with a typo, never submits; only a complete key does.
for (const type of ["input", "change"]) {
  $("#password").addEventListener(type, async () => {
    const value = $("#password").value;
    if (unlocking || value.replace(/[\s-]/g, "").length !== 28) return;
    try {
      await parseKey(value);
    } catch {
      return;
    }
    if ($("#password").value === value && !$("#start").hidden) $("#unlock-form").requestSubmit();
  });
}

$("#passkey-unlock").addEventListener("click", async () => {
  $("#start-error").textContent = "";
  try {
    const slot = await openSlot({ prf: await getPasskeyPrf() });
    if (!slot) {
      $("#start-error").textContent = "That passkey isn't linked to a library. Unlock with your sync key, then add the passkey.";
      return;
    }
    await enter(slot.key, slot.name);
  } catch (error) {
    if (!cancelled(error)) $("#start-error").textContent = error.message;
  }
});

// The new key is shown as text, and the person pastes it into the form's password field.
// Password managers (Safari, iOS, 1Password, Chrome) offer to save only a password the person
// entered; one the page filled in by itself got no offer in testing, even with input events.
// Pasting it also proves the key was copied before the screen goes away.
let newKeyText = "";
const sameKey = (text) => {
  const norm = (t) => t.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return norm(text) === norm(newKeyText);
};

$("#create").addEventListener("click", async () => {
  const form = $("#save-form");
  newKeyText = await formatKey(newKey());
  $("#new-key").textContent = newKeyText;
  form.elements["new-password"].value = "";
  errorIn(form, "");
  show("created");
});

$("#new-password").addEventListener("input", () => errorIn($("#save-form"), ""));

$("#copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(newKeyText);
  $("#copy").textContent = "Copied";
  setTimeout(() => ($("#copy").textContent = "Copy"), 1500);
});

// Password managers (1Password, Chrome, Safari) offer to save a sign-up when its form is really
// submitted, straight from the person's tap, and the page navigates. So Continue does only that:
// the form submits as a GET to "/" and the page reloads into the new library. iOS in particular
// offers nothing for a submission made later by script, which is why the passkey is offered on
// the next screen instead of before submitting. The formdata handler empties the submission, so
// the key never leaves the device.
$("#save-form").addEventListener("submit", (e) => {
  const form = e.target;
  if (!sameKey(form.elements["new-password"].value)) {
    e.preventDefault();
    return errorIn(form, "That isn't the key above. Copy it and paste it here.");
  }
  const name = form.elements["new-username"].value.trim() || "Personal";
  localStorage.setItem(SESSION, JSON.stringify({ key: newKeyText, name }));
  sessionStorage.setItem(CREATED, "1");
});
$("#save-form").addEventListener("formdata", (e) => {
  for (const name of [...e.formData.keys()]) e.formData.delete(name);
});

// ---- highlights

let swatchesFor = "";

function renderSwatches() {
  const key = JSON.stringify(colors);
  if (key === swatchesFor) return;
  swatchesFor = key;
  const picked = new FormData($("#add")).get("color") ?? "yellow";
  $("#add .swatches").replaceChildren(
    ...colors.map((c) => {
      const label = document.createElement("label");
      label.className = "dot";
      label.title = colorName(c);
      paint(label, c.id);
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "color";
      input.value = c.id;
      input.checked = c.id === picked;
      const text = document.createElement("span");
      text.className = "sr";
      text.textContent = colorName(c);
      label.append(input, text);
      return label;
    }),
  );
  if (!$("#add").querySelector("input:checked")) $("#add").querySelector("input").checked = true;
}

/**
 * Highlights whole verses in one color. A verse already highlighted keeps when it was first. Returns
 * a function that puts back what the verses were before.
 */
async function highlight(verses, color) {
  const t = now();
  const before = verses.map((v) => library.find("highlight", v));
  await library.putMany(verses.map((v, i) => highlightRecord(before[i], v, color, t)));
  return () => library.putMany(verses.map((v, i) => before[i] ?? { kind: "highlight", ref: v, deleted: true }));
}

// The reference field is scripture-inline's <si-passage-input>: book, chapter and verse suggestions
// as people type. Its value is a USFM id like ROM.5.3-5 once it reads a passage.
definePassageInput();
const refField = $("#ref");
/** What's in a passage field: its passage id when it read one, else the typed text, which readPassage reads
 * more loosely (the field won't take passages across chapters, like Genesis 1–2, but Hidden Word does). */
function refText(field = refField) {
  const typed = field.shadowRoot?.querySelector("input")?.value ?? "";
  return field.value && field.validity.valid ? field.value : typed;
}
/** Whether the field's suggestion list is showing (Enter and Escape act on it first). */
const suggesting = (field) => field.shadowRoot?.querySelector("[role=listbox]")?.hidden === false;
// Enter that settles a passage highlights it; Enter that only fills in a book name keeps typing.
// The field's own handler runs first (it's on the inner input), so its list shows what Enter did.
refField.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  if (!suggesting(refField)) $("#add").requestSubmit();
});

$("#add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const found = readPassage(refText());
  if (found.error) return errorIn(form, found.error);
  errorIn(form, "");
  await highlight(found.verses, new FormData(form).get("color"));
  refField.value = "";
});

// ---- saving from a link: /save?ref=John+3:16&color=blue

/** Keeps a /save link's request until a library is open, even across unlocking or creating one. */
function takeSaveLink() {
  if (location.pathname !== "/save") return null;
  const query = new URLSearchParams(location.search);
  const request = { ref: query.get("ref") ?? "", color: query.get("color") ?? "" };
  sessionStorage.setItem(SAVE_LINK, JSON.stringify(request));
  history.replaceState(null, "", "/");
  return request;
}

/** A color by id or by name ("blue", "Prayer"), else yellow. */
function colorFor(wanted) {
  const w = wanted.trim().toLowerCase();
  return colors.find((c) => c.id === w) ?? colors.find((c) => colorName(c).toLowerCase() === w) ?? colors[0];
}

async function saveFromLink() {
  const request = JSON.parse(sessionStorage.getItem(SAVE_LINK) ?? "null");
  if (!request) return;
  sessionStorage.removeItem(SAVE_LINK);
  $("#start-note").hidden = true;
  const found = readPassage(request.ref);
  if (found.error) return flash(`Nothing saved. ${found.error}`);
  const color = colorFor(request.color);
  const undo = await highlight(found.verses, color.id);
  flash(`Saved ${found.label} in ${colorName(color)}.`, { label: "Undo", run: undo });
}

function render() {
  if (!library) return;
  colors = palette(library.all("color"));
  renderSwatches();

  const ids = colors.map((c) => c.id);
  const rows = library.all("highlight").sort((a, b) => compareRefs(a.ref, b.ref));
  const counts = new Map();
  for (const r of rows) counts.set(topColor(r, ids), (counts.get(topColor(r, ids)) ?? 0) + 1);
  if (filter && !counts.has(filter)) filter = null;
  renderFilters(counts);

  const shown = filter ? rows.filter((r) => topColor(r, ids) === filter) : rows;
  $("#empty").hidden = rows.length > 0;
  // A row being edited stays as it is until the edit ends (a sync mid-edit would wipe the field);
  // finishing the edit renders again.
  if (!editing) $("#list").replaceChildren(...groupRuns(shown, (r) => topColor(r, ids)).map(row));
  if (!$("#colors").hidden) renderColors();
}

function renderFilters(counts) {
  const chips = [];
  if (counts.size > 1) {
    const all = document.createElement("button");
    all.type = "button";
    all.className = "chip";
    all.textContent = "All";
    all.setAttribute("aria-pressed", String(!filter));
    all.addEventListener("click", () => ((filter = null), render()));
    chips.push(all);
    for (const c of colors) {
      if (!counts.has(c.id)) continue;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.setAttribute("aria-pressed", String(filter === c.id));
      const dot = document.createElement("span");
      dot.className = "dot";
      paint(dot, c.id);
      chip.append(dot, `${colorName(c)} ${counts.get(c.id)}`);
      chip.addEventListener("click", () => ((filter = filter === c.id ? null : c.id), render()));
      chips.push(chip);
    }
  }
  $("#filters").replaceChildren(...chips);
}

const ICONS = {
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  text: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>',
};

function iconButton(tag, icon, label) {
  const el = document.createElement(tag);
  el.className = "icon";
  el.innerHTML = ICONS[icon];
  el.setAttribute("aria-label", label);
  el.title = label;
  if (tag === "button") el.type = "button";
  return el;
}

/** One list row: a single highlight, or a run of back-to-back verses in one color (see groupRuns). */
function row({ ref: runRef, records }) {
  const ids = colors.map((c) => c.id);
  const li = document.createElement("li");

  const dot = document.createElement("button");
  dot.type = "button";
  dot.className = "dot";
  paint(dot, topColor(records[0], ids));
  dot.setAttribute("aria-label", `Change color of ${labelRef(runRef)}`);
  dot.setAttribute("aria-haspopup", "true");
  dot.addEventListener("click", () => openColorPicker(dot, records));

  // The whole row opens the passage in route.bible: the link stretches over the line (see .row-link
  // in style.css), and the dot and icons sit above it as their own buttons.
  const link = document.createElement("a");
  link.className = "row-link";
  link.href = `https://route.bible/${runRef.toLowerCase()}`; // the whole run, e.g. rom.5.3-5
  link.target = "_blank";
  link.rel = "noopener";
  link.setAttribute("aria-label", `Open ${labelRef(runRef)} in route.bible`);
  const ref = document.createElement("span");
  ref.className = "ref";
  ref.textContent = labelRef(runRef);
  const quote = document.createElement("span");
  quote.className = "quote";
  quote.textContent = records.flatMap((r) => r.highlights.map((h) => h.quote)).filter(Boolean).join(" … ");
  link.append(ref, quote);

  // Two icons, as one compact group (see .actions in style.css): the verse text, and ••• for the rest.
  const more = iconButton("button", "more", `More for ${labelRef(runRef)}`);
  more.classList.add("more");
  more.setAttribute("aria-haspopup", "menu");
  const actions = document.createElement("span");
  actions.className = "actions";
  if (verseText.key) actions.append(textButton(li, runRef));
  actions.append(more);

  const line = document.createElement("div");
  line.className = "row";
  line.append(dot, link, actions);
  more.addEventListener("click", () => openRowMenu(more, li, line, { ref: runRef, records }));
  li.append(line);
  if (verseText.open === runRef) showText(li, runRef);
  return li;
}

// ---- editing a row's reference, in place

/** The row being edited, if any: while set, render leaves the list alone. */
let editing = null;

/**
 * Swaps a row for a passage field holding its reference. Enter, or leaving the field after changing it,
 * saves; Escape cancels. Saving rewrites the run's verses (see editRun) in one putMany.
 */
function editRow(li, line, run) {
  const ids = colors.map((c) => c.id);
  const color = topColor(run.records[0], ids);
  const form = document.createElement("form");
  form.className = "row edit";
  form.noValidate = true;
  form.autocomplete = "off";
  const dot = document.createElement("span");
  dot.className = "dot";
  paint(dot, color);
  const field = document.createElement("si-passage-input");
  field.setAttribute("aria-label", `Reference for ${labelRef(run.ref)}`);
  field.setAttribute("placeholder", "John 3:16");
  const error = document.createElement("p");
  error.className = "error";
  error.setAttribute("role", "alert");
  form.append(dot, field, error);
  line.replaceWith(form);
  editing = run.ref;
  field.value = labelRef(run.ref);
  const start = refText(field);
  field.focus();

  let done = false;
  const finish = () => {
    done = true;
    editing = null;
    render();
  };
  const save = async () => {
    if (done) return;
    const found = readPassage(refText(field));
    if (found.error) return errorIn(form, found.error);
    const changes = editRun(run.records, found.verses, color, now(), (v) => library.find("highlight", v));
    finish();
    if (changes.length) await library.putMany(changes);
  };
  form.addEventListener("submit", (e) => (e.preventDefault(), save()));
  field.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter" && !suggesting(field)) (e.preventDefault(), save());
    if (e.key === "Escape" && !suggesting(field)) (e.preventDefault(), finish());
  });
  field.addEventListener("input", () => errorIn(form, ""));
  // Leaving the field saves a change and quietly closes an unchanged one. An invalid change stays open.
  form.addEventListener("focusout", (e) => {
    if (done || form.contains(/** @type {Node} */ (e.relatedTarget))) return;
    setTimeout(() => {
      if (done || form.contains(document.activeElement)) return;
      if (refText(field) === start) finish();
      else save();
    });
  });
}

// ---- verse text: a row's passage from YouVersion (BSB), shown under the row when its book icon is tapped.
// One at a time, and only on request, so YouVersion hears only about passages someone opens. The app key
// comes from the server's /config.json (a Worker secret, kept out of the public repo); without one the
// icon doesn't show.

const verseText = { key: null, open: null, passages: new Map() };

async function loadConfig() {
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    const { yvpPublicAppKey } = res.ok ? await res.json() : {};
    if (!yvpPublicAppKey) return;
    defineScripturePassage({ yvpPublicAppKey });
    verseText.key = yvpPublicAppKey;
    render();
  } catch {
    // Offline or no server: no verse text.
  }
}

function textButton(li, runRef) {
  const b = iconButton("button", "text", `Show the text of ${labelRef(runRef)}`);
  b.classList.add("text");
  b.setAttribute("aria-expanded", String(verseText.open === runRef));
  b.addEventListener("click", () => {
    const wasOpen = verseText.open === runRef;
    for (const other of document.querySelectorAll("#list .verse-text")) other.remove();
    for (const other of document.querySelectorAll("#list button.text")) other.setAttribute("aria-expanded", "false");
    verseText.open = wasOpen ? null : runRef;
    if (!wasOpen) (showText(li, runRef), b.setAttribute("aria-expanded", "true"));
  });
  return b;
}

/** Puts the run's passage under its row. Elements are kept per run, so a re-render doesn't refetch. */
function showText(li, runRef) {
  let el = verseText.passages.get(runRef);
  if (!el) {
    el = document.createElement("si-passage");
    el.className = "verse-text";
    el.id = `text-${runRef.replace(/\W/g, "-")}`;
    el.setAttribute("yvp-bible-version-id", "3034"); // Berean Standard Bible
    el.setAttribute("passage-id", runRef);
    el.setAttribute("reference", "none");
    el.setAttribute("theme", "auto");
    el.setAttribute("headings", "hide");
    verseText.passages.set(runRef, el);
  }
  li.querySelector("button.text")?.setAttribute("aria-controls", el.id);
  li.append(el);
}

/** Shows a popover under its anchor (above it when there's no room below), kept on screen. */
function placePopover(pop, anchor, { alignEnd = false } = {}) {
  pop.showPopover();
  const a = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.max(8, Math.min(alignEnd ? a.right - w : a.left - 8, innerWidth - w - 8));
  const below = a.bottom + 6;
  pop.style.left = `${left}px`;
  pop.style.top = `${below + h > innerHeight - 8 ? a.top - h - 6 : below}px`;
}

/**
 * The shared ••• popover for a row: Edit reference, and Delete. Delete takes two taps: the first arms it
 * (it turns solid red and asks again), which resets after a moment. A popover closes on an outside press
 * and on Escape by itself.
 */
function openRowMenu(anchor, li, line, run) {
  const pop = $("#row-pop");
  const label = labelRef(run.ref);
  const item = (text, className = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    b.setAttribute("role", "menuitem");
    b.textContent = text;
    return b;
  };
  const edit = item("Edit reference");
  edit.addEventListener("click", () => {
    pop.hidePopover();
    editRow(li, line, run);
  });
  const del = item("Delete", "danger");
  del.setAttribute("aria-label", `Delete ${label}`);
  let reset;
  const disarm = () => {
    clearTimeout(reset);
    delete del.dataset.confirm;
    del.textContent = "Delete";
    del.setAttribute("aria-label", `Delete ${label}`);
  };
  del.addEventListener("click", () => {
    if (del.dataset.confirm) {
      disarm();
      pop.hidePopover();
      library.putMany(run.records.map((r) => ({ kind: "highlight", ref: r.ref, deleted: true })));
      return;
    }
    del.dataset.confirm = "1";
    del.textContent = "Tap again to delete";
    del.setAttribute("aria-label", `Confirm delete ${label}`);
    reset = setTimeout(disarm, 4000);
  });
  pop.replaceChildren(edit, del);
  pop.ontoggle = (e) => {
    anchor.setAttribute("aria-expanded", String(e.newState === "open"));
    if (e.newState === "closed") clearTimeout(reset);
  };
  placePopover(pop, anchor, { alignEnd: true });
  edit.focus();
}

/** The shared color popover, anchored under the dot that opened it. Picking a color recolors the whole run. */
function openColorPicker(anchor, records) {
  const pop = $("#color-pop");
  const ids = colors.map((c) => c.id);
  const current = topColor(records[0], ids);
  pop.replaceChildren(
    ...colors.map((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dot";
      b.title = colorName(c);
      paint(b, c.id);
      b.setAttribute("aria-label", `Make ${colorName(c)}`);
      b.setAttribute("aria-pressed", String(current === c.id));
      b.addEventListener("click", () => {
        pop.hidePopover();
        if (c.id === current) return;
        const t = now();
        library.putMany(records.map((r) => ({ ...r, highlights: r.highlights.map((h) => ({ ...h, color: c.id, edited: t })) })));
      });
      return b;
    }),
  );
  placePopover(pop, anchor);
  pop.querySelector('[aria-pressed="true"]')?.focus();
}

// ---- colors

function renderColors() {
  $("#color-list").replaceChildren(
    ...colors.map((c) => {
      const li = document.createElement("li");
      const record = library.find("color", c.id);
      if (c.builtIn) {
        const dot = document.createElement("span");
        dot.className = "dot";
        paint(dot, c.id);
        li.append(dot);
      } else {
        const pick = document.createElement("input");
        pick.type = "color";
        pick.value = c.hex;
        pick.setAttribute("aria-label", `${colorName(c)} color`);
        pick.addEventListener("change", () => library.put({ ...record, hex: pick.value }));
        li.append(pick);
      }
      const name = document.createElement("input");
      name.value = c.name;
      name.placeholder = c.builtIn ? capitalized(c.id) : "Name";
      name.setAttribute("aria-label", `Name for ${colorName(c)}`);
      name.addEventListener("change", () => {
        const base = record ?? { kind: "color", ref: c.id };
        library.put({ ...base, name: name.value.trim() });
      });
      li.append(name);
      if (!c.builtIn) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "danger quiet";
        del.textContent = "Delete";
        del.addEventListener("click", () => deleteColor(c));
        li.append(del);
      }
      return li;
    }),
  );
}

async function deleteColor(c) {
  const using = library.all("highlight").filter((r) => r.highlights.some((h) => h.color === c.id));
  if (using.length && !confirm(`${using.length} highlight${using.length === 1 ? "" : "s"} use ${colorName(c)}. They'll turn yellow.`)) return;
  const t = now();
  await library.putMany([
    ...using.map((r) => ({ ...r, highlights: r.highlights.map((h) => (h.color === c.id ? { ...h, color: "yellow", edited: t } : h)) })),
    { kind: "color", ref: c.id, deleted: true },
  ]);
}

$("#add-color").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const id = `c-${Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(36).padStart(2, "0")).join("")}`;
  await library.put({ kind: "color", ref: id, name: form.get("name").trim(), hex: form.get("hex").toLowerCase(), created: now() });
  e.target.name.value = "";
});

// ---- sync choices

function renderSync() {
  if (!library) return;
  $("#use-server").checked = settings(library.lib).server;
  const can = foldersAvailable();
  $("#no-folders").hidden = can;
  $("#choose-folder").disabled = !can;
  $("#folder-text").textContent =
    folder.state === "on" ? `Syncing with “${folder.handle.name}”. Each device keeps a plain file there you can read.` :
    folder.state === "paused" ? `“${folder.handle.name}” needs your permission again.` :
    "A folder in iCloud Drive, Dropbox or Syncthing. Each device keeps a plain file there you can read.";
  $("#choose-folder").textContent = folder.state === "paused" ? "Allow" : folder.state === "on" ? "Change" : "Choose folder";
  $("#stop-folder").hidden = folder.state === "off";
}

$("#use-server").addEventListener("change", async (e) => {
  saveSettings(library.lib, { ...settings(library.lib), server: e.target.checked });
  await connect();
});

$("#choose-folder").addEventListener("click", async () => {
  try {
    if (folder.state === "paused" && (await mayUse(folder.handle, true))) return connect();
    const handle = await pickFolder();
    await saveFolder(library.lib, handle);
    await connect();
  } catch (error) {
    if (!cancelled(error)) flash(error.message);
  }
});

$("#stop-folder").addEventListener("click", async () => {
  await forgetFolder(library.lib);
  await connect();
});

for (const back of document.querySelectorAll(".back")) back.addEventListener("click", () => (show("main"), render()));

// ---- the library's name, edited in place

function rename(next) {
  library.name = next;
  localStorage.setItem(nameKey(library.lib), next);
  localStorage.setItem(SESSION, JSON.stringify({ key: library.keyText, name: next }));
}

const libName = $("#lib-name");
libName.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) (e.preventDefault(), libName.blur());
  if (e.key === "Escape") (e.preventDefault(), (libName.textContent = library.name), libName.blur());
});
// Enter and tapping away save it; an empty name keeps the old one.
libName.addEventListener("blur", () => {
  if (!library) return;
  const next = libName.textContent.replace(/\s+/g, " ").trim().slice(0, 80);
  if (next && next !== library.name) rename(next);
  libName.textContent = library.name;
  getSelection()?.removeAllRanges();
});

// ---- menu
// Close the ••• menu on any press outside it, and on Escape (returning focus to its toggle).
document.addEventListener("pointerdown", (e) => {
  const menu = $("#menu");
  if (menu.open && !menu.contains(e.target)) menu.open = false;
});
document.addEventListener("keydown", (e) => {
  const menu = $("#menu");
  if (e.key === "Escape" && menu.open) {
    menu.open = false;
    menu.querySelector("summary").focus();
  }
});

function menuAction(id, fn) {
  $(id).addEventListener("click", async () => {
    $("#menu").open = false;
    try {
      await fn();
    } catch (error) {
      if (!cancelled(error)) flash(error.message);
    }
  });
}

menuAction("#open-sync", () => (renderSync(), show("sync")));
menuAction("#open-colors", () => (renderColors(), show("colors")));

/** Creates a passkey that unlocks the open library. */
async function addPasskey() {
  const prf = await createPasskeyPrf(library.name);
  await saveSlot({ prf, keyText: library.keyText, name: library.name });
  $("#passkey-offer").hidden = true;
  flash("Passkey added. Use it to unlock this library in any browser.");
}

menuAction("#add-passkey", addPasskey);

// Offered once, right after creating a library. Declining or cancelling costs nothing: the menu
// has "Add passkey" too.
$("#offer-passkey").addEventListener("click", async () => {
  try {
    await addPasskey();
  } catch (error) {
    if (!cancelled(error)) flash(error.message);
  }
});
$("#skip-passkey").addEventListener("click", () => ($("#passkey-offer").hidden = true));

menuAction("#show-key", () => flash(`Sync key: ${library.keyText}`));

menuAction("#export", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([library.toFile()], { type: "application/x-ndjson" }));
  a.download = `hidden-word-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

menuAction("#import", () => $("#import-file").click());

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    let doc = null;
    try {
      doc = JSON.parse(text);
    } catch {
      // Not one JSON document: JSON Lines.
    }
    const records = doc?.app === "bible-rs" ? fromBibleRs(doc) : parseJsonl(text);
    const changed = await library.merge(records);
    const older = records.length - changed;
    flash(`Imported ${changed} ${changed === 1 ? "record" : "records"}${older ? ` (${older} unchanged: you had them, or newer)` : ""}.`);
  } catch (error) {
    flash(`Couldn't import that file: ${error.message}`);
  }
});

menuAction("#lock", lock);

$("#erase").addEventListener("click", async () => {
  const ok = confirm("Erase this library from the server, the sync folder and this device? A device that still has it will put it back when it syncs.");
  if (!ok) return;
  await library.erase();
  await forgetFolder(library.lib);
  localStorage.removeItem(settingsKey(library.lib));
  localStorage.removeItem(nameKey(library.lib));
  $("#danger").open = false;
  lock();
});

// ---- boot

addEventListener("online", () => library?.sync());
addEventListener("focus", () => library?.sync());
setInterval(() => document.visibilityState === "visible" && library?.sync(), 30_000);

async function boot() {
  loadConfig();
  // With passkeys, unlocking with one is the main way in and the key form is the fallback.
  if (passkeysAvailable()) {
    $("#passkey-unlock").hidden = false;
    $("#or-key").hidden = false;
    $("#start").classList.add("has-passkey");
  }
  const request = takeSaveLink();
  if (request) {
    const found = readPassage(request.ref);
    $("#start-note").textContent = found.error ? "Unlock your library to save this verse." : `Unlock your library to save ${found.label}.`;
    $("#start-note").hidden = false;
  }
  // The new-library form submits to "/?"; tidy the address it leaves behind.
  if (location.href.endsWith("?")) history.replaceState(null, "", location.pathname);
  // A link like /#k=XXXX-…&name=Personal fills in the unlock form. The fragment never reaches the server.
  const link = new URLSearchParams(location.hash.slice(1));
  if (link.get("k")) {
    $("#unlock-form").password.value = link.get("k");
    if (link.get("name")) $("#unlock-form").username.value = link.get("name");
    history.replaceState(null, "", location.pathname);
  }
  const session = JSON.parse(localStorage.getItem(SESSION) ?? "null");
  if (session) {
    try {
      await enter(session.key, session.name);
      if (sessionStorage.getItem(CREATED)) {
        sessionStorage.removeItem(CREATED);
        // A verse saved from a link has already said so, with its Undo.
        if (!$("#flash").hasChildNodes()) flash("Library ready.");
        $("#passkey-offer").hidden = !passkeysAvailable();
      }
      return;
    } catch {
      localStorage.removeItem(SESSION);
    }
  }
  show("start");
}

boot();
