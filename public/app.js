import {
  COLORS, Library, KeyError, newKey, formatKey, parseKey, now, palette, topColor, parseJsonl, saveSlot, openSlot,
  serverTransport,
} from "./sync.js";
import { labelRef, compareRefs } from "./refs.js";
import { editRun, highlightRecord, tombstone, groupRuns } from "./ranges.js";
import { readPassage } from "./passage.js";
import { MODES, RANK_MODES, LEGACY_TOPIC_MODE, JEV_MODES, groupList, startsOpen } from "./groups.js";
import { definePassageInput, defineScripturePassage } from "./vendor/scripture-inline.js";
import { createPasskeyPrf, getPasskeyPrf, passkeysAvailable, cancelled } from "./passkey.js";
import { setupThemeToggle } from "./theme-toggle.js";
import { registerSelahVaultTools } from "./webmcp.js";
import { armDelete } from "./confirm.js";
import { defineKeepingLoaded, createWarmer } from "./passage-warm.js";
import { createBsbText } from "./bsb-text.js";
import {
  createRelevance,
  emptyRelevanceCopy,
  chapterRefOf,
  totalCopy,
  relatedCopy,
  topicCopy,
  rankStatusCopy,
  jevHintCopy,
  jevCtaCopy,
  rankingCopy,
  rankErrorMessage,
  sanitizeTopic,
} from "./relevance.js";

const $ = (sel) => document.querySelector(sel);
const SESSION = "hidden-word:session";
const CREATED = "hidden-word:created";
const SAVE_LINK = "hidden-word:save-link";
// How this device sorts the list (date / genre / relevant / surprising): a display choice, not synced.
// The Relevant/Surprising passage and topic-search phrase are never stored — only the mode button is.
const GROUP_BY = "hidden-word:group-by";
// A library's name as this device last saw it, for the unlock form and before the library has synced.
// The name itself syncs as a `library` record (SPEC.md 1.5): library.name is the one to show.
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
const filtersKey = (lib) => `hidden-word:filters:${lib}`;

let library = null;
let colors = palette([]);
/** Multi-select color filter ids (empty Set = show all). */
let filter = new Set();
let flashTimer = 0;

function saveFilters() {
  if (!library) return;
  try {
    if (filter.size) localStorage.setItem(filtersKey(library.lib), JSON.stringify([...filter]));
    else localStorage.removeItem(filtersKey(library.lib));
  } catch {}
}

// The screens with a library open. The footer says only whether one is: never the key, never sync.
const SIGNED_IN = new Set(["main", "colors", "backup", "sync"]);

function show(id) {
  for (const section of document.querySelectorAll("main > section")) section.hidden = section.id !== id;
  const label = SIGNED_IN.has(id) ? "Signed in" : "Signed out";
  for (const status of document.querySelectorAll("#auth-status, #menu-auth-status")) {
    status.textContent = label;
    status.hidden = false;
  }
  const menu = $("#menu");
  if (menu?.open) menu.open = false;
  const filters = $("#filters");
  if (filters?.open) filters.open = false;
}

/** Shows a passing message, with an optional button such as `{ label: "Undo", run, ms }`. */
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
  flashTimer = setTimeout(() => el.replaceChildren(), action ? (action.ms ?? 15_000) : 6000);
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
  library.localName = localStorage.getItem(nameKey(library.lib)) || given;
  try {
    const saved = JSON.parse(localStorage.getItem(filtersKey(library.lib)) ?? "[]");
    filter = new Set(Array.isArray(saved) ? saved : []);
  } catch {
    filter = new Set();
  }
  highlightStamp = new Map();
  relevance = null;
  rankOrder = [];
  clearRelevanceInput();
  showName();
  library.onChange(render);
  library.onChange(showName);
  show("main");
  renderGroupBy(true);
  render();
  await saveFromLink();
  await connect();
  // Only now has every transport had its chance to bring a synced name (see showName).
  connected = library;
  showName();
}

/** Syncs the open library through this site's server, unless this browser turned that off. */
async function connect() {
  renderSync();
  await library.use(settings(library.lib).server ? [serverTransport()] : []);
}

/**
 * Folder sync is gone (decisions/one-way-to-interoperate.md). Browsers that used it kept only the
 * chosen folders' handles, in an IndexedDB database of their own ("hidden-word"); libraries live
 * in localStorage and on the server. Drop that database once, quietly: nothing in it is a record.
 */
function forgetFolderHandles() {
  try {
    globalThis.indexedDB?.deleteDatabase("hidden-word");
  } catch {
    // Private modes may refuse IndexedDB; there's nothing to clean up there.
  }
}

/**
 * Shows the library's name, synced from other devices, and remembers it here. A library with no
 * name yet takes this device's, once synced (Library.adoptName), so a typed name never renames one.
 */
let connected = null;
function showName() {
  if (!library) return;
  const name = library.name;
  if (document.activeElement !== $("#lib-name") && $("#lib-name").textContent !== name) $("#lib-name").textContent = name;
  if (localStorage.getItem(nameKey(library.lib)) !== name) localStorage.setItem(nameKey(library.lib), name);
  const session = JSON.parse(localStorage.getItem(SESSION) ?? "null");
  if (session?.key !== library.keyText || session.name !== name) localStorage.setItem(SESSION, JSON.stringify({ key: library.keyText, name }));
  if (connected === library && library.syncedName === null && ["synced", "local"].includes(library.status.state)) library.adoptName();
}

function lock() {
  library?.forget();
  library = null;
  localStorage.removeItem(SESSION);
  $("#menu").open = false;
  $("#passkey-offer").hidden = true;
  hideKey();
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

// The add form's color: one dot showing it, which opens the shared color popover to change it. The
// choice lives in the form's hidden "color" input, so submitting reads it like any field.
const addColor = $("#add").elements.namedItem("color");
const addDot = $("#add-dot");

function renderAddColor() {
  if (!colors.some((c) => c.id === addColor.value)) addColor.value = colors[0].id; // its color was deleted
  const c = colors.find((x) => x.id === addColor.value);
  paint(addDot.querySelector(".dot"), c.id);
  addDot.setAttribute("aria-label", `Highlight color: ${colorName(c)}`);
  addDot.title = `Highlight color: ${colorName(c)}`;
}

addDot.addEventListener("click", () =>
  openColorPicker(addDot, addColor.value, (id) => {
    addColor.value = id;
    renderAddColor();
  }),
);

/**
 * Highlights whole verses in one color. A verse already highlighted keeps when it was first. Returns
 * a function that puts back what the verses were before.
 */
async function highlight(verses, color) {
  const t = now();
  const before = verses.map((v) => library.find("highlight", v));
  await library.putMany(verses.map((v, i) => highlightRecord(before[i], v, color, t)));
  return () => library.putMany(verses.map((v, i) => before[i] ?? tombstone(v)));
}

// The reference field is scripture-inline's <si-passage-input>: book, chapter and verse suggestions
// as people type. Its value is a USFM id like ROM.5.3-5 once it reads a passage.
// Relevant/Surprising hijack the same field as the ranking scope (no second passage box).
definePassageInput();
const refField = $("#ref");
const REF_ADD = { placeholder: "John 3:16", aria: "Verse or passage" };
const REF_RANK = { placeholder: "Rom 8:18–25", aria: "Passage to rank highlights against" };
/** Debounce timer for ranking-from-#ref (Relevant/Surprising). */
let refRankTimer = 0;
/** What's in a passage field: its passage id when it read one, else the typed text, which readPassage reads
 * more loosely (the field won't take passages across chapters, like Genesis 1–2, but Selah Vault does). */
function refText(field = refField) {
  const typed = field.shadowRoot?.querySelector("input")?.value ?? "";
  return field.value && field.validity.valid ? field.value : typed;
}
/** Whether the field's suggestion list is showing (Enter and Escape act on it first). */
const suggesting = (field) => field.shadowRoot?.querySelector("[role=listbox]")?.hidden === false;

/** Sanitized text in the list-bar topic search, or "" when empty. */
function topicQuery() {
  return sanitizeTopic($("#topic-search")?.value ?? "");
}

/**
 * While topic search is open (or has a query), hide #add so only one text field is visible.
 * Collapse restores the add/rank row; Relevant/Surprising epigraph returns via showRankPreview.
 */
function syncAddHiddenForTopicSearch(searchOpen) {
  const form = $("#add");
  if (form) form.hidden = searchOpen;
  if (searchOpen) {
    const epigraph = $("#rank-epigraph");
    if (epigraph) {
      epigraph.hidden = true;
      epigraph.textContent = "";
    }
  } else if (!topicQuery() && RANK_MODES.includes(groupBy) && relevance?.passage) {
    showRankPreview(relevance.passage);
  }
}

/** Expand the list-bar topic search from its resting icon into the text field. */
function openTopicSearch({ focus = true } = {}) {
  const wrap = $("#topic-search-wrap");
  const toggle = $("#topic-search-toggle");
  const field = $("#topic-search");
  if (!wrap || !toggle || !field) return;
  wrap.classList.add("is-open");
  toggle.setAttribute("aria-expanded", "true");
  field.tabIndex = 0;
  syncAddHiddenForTopicSearch(true);
  if (focus) field.focus();
}

/**
 * Collapse topic search back to the icon. Stays expanded while the query is non-empty;
 * empty + blur/Escape (or an explicit clear) restores the icon and #add.
 */
function closeTopicSearch({ force = false } = {}) {
  if (!force && topicQuery()) return;
  const wrap = $("#topic-search-wrap");
  const toggle = $("#topic-search-toggle");
  const field = $("#topic-search");
  if (!wrap || !toggle || !field) return;
  wrap.classList.remove("is-open");
  toggle.setAttribute("aria-expanded", "false");
  field.tabIndex = -1;
  syncAddHiddenForTopicSearch(false);
}

/** Swap #add between add-highlight and passage-ranking (#ref) chrome. Topic search is orthogonal in #list-bar. */
function syncRefFieldMode() {
  const ranking = RANK_MODES.includes(groupBy);
  const meta = ranking ? REF_RANK : REF_ADD;
  refField.setAttribute("placeholder", meta.placeholder);
  refField.setAttribute("aria-label", meta.aria);
  // si-passage-input copies aria-label only on connect; keep the inner input in sync.
  refField.shadowRoot?.querySelector("input")?.setAttribute("aria-label", meta.aria);
  refField.hidden = false;
  const form = $("#add");
  form.classList.toggle("rank-scope", ranking);
  $("#add-dot").hidden = ranking;
  form.querySelector('button[type="submit"]').hidden = ranking;
}

// Enter: settle suggestions first; else rank (Relevant/Surprising) or add a highlight (Date/Genre).
refField.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  if (suggesting(refField)) return;
  if (RANK_MODES.includes(groupBy)) {
    e.preventDefault();
    clearTimeout(refRankTimer);
    void runRelevance();
    return;
  }
  $("#add").requestSubmit();
});

$("#add").addEventListener("submit", async (e) => {
  e.preventDefault();
  // Ranking modes never add from this form — #ref is the scope field (Highlight is hidden).
  if (RANK_MODES.includes(groupBy)) {
    void runRelevance();
    return;
  }
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

/** What the list was last built from (see render). */
let listSig = null;
/** Ordered highlight refs for the current Jev result (no reason/tagline attached). */
let rankOrder = [];
let rankPending = null;
/** True after a ranking call failed: keep Date order and the inline error; never "0 of N relevant". */
let rankFailed = false;
/** Bumps whenever a new ranking run starts (or the input changes); stale responses are ignored. */
let rankGeneration = 0;
/**
 * Bumps on each new final paint that may auto-expand (new query, or Relevant ↔ Surprising reorder).
 * Separate from rankGeneration so a cache-only mode switch still re-targets the top row.
 */
let rankPaint = 0;
/** Paint id we already auto-expanded for (once per paint). */
let rankExpandPaint = -1;
/** True after the person toggles a row open/closed during the current query — skip auto-expand. */
let rankUserTouched = false;

function render() {
  if (!library) return;
  colors = palette(library.all("color"));
  renderAddColor();
  syncRelevanceCache();

  const ids = colors.map((c) => c.id);
  const rows = library.all("highlight").sort((a, b) => compareRefs(a.ref, b.ref));
  const counts = new Map();
  for (const r of rows) counts.set(topColor(r, ids), (counts.get(topColor(r, ids)) ?? 0) + 1);
  let filterPruned = false;
  for (const id of filter) {
    if (!counts.has(id)) {
      filter.delete(id);
      filterPruned = true;
    }
  }
  if (counts.size <= 1 && filter.size) {
    filter.clear();
    filterPruned = true;
  }
  if (filterPruned) saveFilters();
  renderFilters(counts);

  const shown = filter.size ? rows.filter((r) => filter.has(topColor(r, ids))) : rows;
  // Topic search in #list-bar owns the list while it has a query; modes stay visible underneath.
  const searching = !!topicQuery();
  const jevActive = RANK_MODES.includes(groupBy) && !searching;
  // Scope is path-specific: a leftover Relevant passage must not count as topic search scope (and vice versa).
  const hasScope = searching ? !!relevance?.topic : jevActive ? !!relevance?.passage : false;
  // A failed call keeps Date order. Pending keeps Jev chrome (loading line) before the scope lands.
  const ranking = (searching || jevActive) && !rankFailed && (hasScope || rankPending);
  // Relevant/Surprising with nothing typed yet: empty list + hint (never a stale Date "Today" header).
  // Empty topic search shows no CTA panel — only the quiet field placeholder.
  const jevWaiting = jevActive && !rankFailed && !hasScope && !rankPending;
  const noneRelevant =
    ranking && !rankPending && !searching && !!relevance?.passage && RANK_MODES.includes(groupBy) && rankOrder.length === 0 && shown.length > 0;
  $("#empty").hidden = rows.length > 0;
  $("#empty").textContent = "No highlights yet.";
  showRelevanceNone(noneRelevant ? { count: shown.length, passage: relevance.passage } : null);
  showRankPreview(ranking && !rankPending && !searching && relevance?.passage && RANK_MODES.includes(groupBy) ? relevance.passage : null);
  renderGroupBy(rows.length > 0);
  // A row being edited stays as it is until the edit ends (a sync mid-edit would wipe the field);
  // finishing the edit renders again.
  // Rebuild the list only when what it shows changed. A sync that brings nothing new (every window
  // focus runs one) still emits for its status; rebuilding then would move the open passage and
  // replay its opening animation.
  const scopeKey = searching
    ? relevance?.topic || ""
    : RANK_MODES.includes(groupBy)
      ? relevance?.passage?.ref || ""
      : "";
  const sig = JSON.stringify([shown, colors, groupBy, [...filter], verseText.key, editing, ranking && scopeKey, rankOrder, rankFailed, noneRelevant, !!rankPending, jevWaiting, searching, verseText.open, rankPaint]);
  if (!editing && sig !== listSig) {
    if (jevWaiting) {
      // Actionable empty scope CTA in the list area; foot status stays empty.
      $("#list-total").textContent = "";
      const box = document.createElement("div");
      box.className = "offer rank-empty";
      box.setAttribute("role", "status");
      const hint = document.createElement("p");
      hint.className = "rank-hint";
      hint.textContent = jevHintCopy(groupBy);
      const row = document.createElement("div");
      row.className = "row";
      const cta = document.createElement("button");
      cta.type = "button";
      cta.className = "quiet rank-cta";
      cta.textContent = jevCtaCopy(groupBy);
      cta.addEventListener("click", () => {
        refField?.focus();
        refField?.suggest?.();
      });
      row.append(cta);
      box.append(hint, row);
      $("#list").replaceChildren(box);
      showRankPreview(null);
      $("#empty").hidden = true;
    } else if (ranking) {
      const runs = groupRuns(shown, (r) => topColor(r, ids));
      const byRef = new Map(runs.map((run) => [run.ref, run]));
      const ranked = rankOrder.map((id) => byRef.get(id)).filter(Boolean);
      if (rankPending) {
        $("#list-total").textContent = rankingCopy();
        $("#list").replaceChildren();
      } else if (ranked.length) {
        const heading = searching
          ? topicCopy(relevance?.topic)
          : relatedCopy(relevance?.passage?.label, groupBy);
        $("#list-total").textContent = rankStatusCopy(ranked.length, shown.length, searching ? "topic" : groupBy);
        // New final paint: expand the new top unless the person toggled a row this query.
        applyRankAutoExpand(ranked[0].ref);
        // Same group()/row() markup as Date and Genre — only the heading text differs.
        $("#list").replaceChildren(group({ id: "ranked", name: heading, runs: ranked }));
      } else {
        // Zero survivors (passage modes). Topic search keeps every highlight, so this is rare.
        // Never put topicCopy in the foot with an empty list.
        $("#list-total").textContent = searching ? "" : RANK_MODES.includes(groupBy) ? totalCopy(0, shown.length) : "";
        $("#list").replaceChildren();
      }
      $("#empty").hidden = true; // library has rows; zero relevant uses #relevance-none, not #empty
    } else {
      // Date/Genre, or a failed Jev/search call: Date/Genre grouping (failed stays in Date order).
      const mode = jevActive || searching ? "date" : groupBy;
      const groups = groupList(shown, mode, (r) => topColor(r, ids));
      const total = groups.reduce((n, g) => n + g.runs.length, 0);
      $("#list-total").textContent = `${total} ${total === 1 ? "highlight" : "highlights"}`;
      $("#list").replaceChildren(...groups.map(group));
      showRankPreview(null);
    }
  }
  listSig = editing ? null : sig;
  if (!$("#colors").hidden) renderColors();
}

/** Start a new auto-expand paint (new query results, or Relevant ↔ Surprising reorder). */
function beginRankPaint({ resetUser = false } = {}) {
  rankPaint++;
  rankExpandPaint = -1;
  if (resetUser) rankUserTouched = false;
}

/**
 * On a new final paint, open the top result once — collapsing whatever a previous paint auto-opened.
 * If the person opened/closed a row during this query, leave their choice alone.
 */
function applyRankAutoExpand(topRef) {
  if (!verseText.key || !topRef) return;
  if (rankExpandPaint === rankPaint) return;
  rankExpandPaint = rankPaint;
  if (rankUserTouched) return;
  verseText.open = topRef;
}

// ---- grouping / ranking: Date and Genre group; Relevant and Surprising rank against a passage.
// Topic search is orthogonal chrome in #list-bar (not a mode).

/** Load persisted mode; migrate legacy Topic mode → Date. */
function readGroupBy() {
  const stored = localStorage.getItem(GROUP_BY) ?? "";
  if (stored === LEGACY_TOPIC_MODE) {
    localStorage.setItem(GROUP_BY, "date");
    return "date";
  }
  return MODES.includes(stored) ? stored : "date";
}

let groupBy = readGroupBy();
const groupOpen = new Map();
let relevance = null;
const bsbText = createBsbText();
/** ref → updated, for change-only re-judging. */
let highlightStamp = new Map();

function renderGroupBy(any) {
  $("#group-by").hidden = !any;
  $("#group-by-select").hidden = !any;
  $("#group-by-select").value = groupBy;
  $("#list-bar").hidden = !any;
  syncRefFieldMode();
  for (const b of document.querySelectorAll("#group-by button")) b.setAttribute("aria-pressed", String(b.dataset.mode === groupBy));
}

function selectMode(next) {
  if (!MODES.includes(next)) return;
  const wasJev = JEV_MODES.includes(groupBy);
  const willJev = JEV_MODES.includes(next);
  const wasPassage = RANK_MODES.includes(groupBy);
  const willPassage = RANK_MODES.includes(next);
  const searching = !!topicQuery();
  groupBy = next;
  localStorage.setItem(GROUP_BY, groupBy);
  // Leaving Relevant/Surprising: clear ranking scope from #ref so Date/Genre don't inherit it as an add.
  // Topic search stays — it is orthogonal chrome, not a mode.
  if (wasPassage && !willPassage) clearRankScopeFromRef();
  if (wasJev && !willJev && !searching) clearRelevanceInput({ keepRef: wasPassage, keepSearch: true });
  // Entering Relevant/Surprising from Date/Genre: start with an empty rank field (don't rank a half-typed add).
  if (willPassage && !wasPassage) {
    refField.value = "";
    errorIn($("#add"), "");
  }
  renderGroupBy(!!$("#list-bar") && !$("#list-bar").hidden);
  // Search owns the list until cleared; only persist the mode for when the field empties.
  if (searching) {
    render();
    return;
  }
  if (willPassage && wasPassage && relevance?.passage && !rankFailed) {
    // Relevant ↔ Surprising: reorder cached verdicts, no network call.
    // New final paint so auto-expand follows the new top (unless the person toggled a row).
    beginRankPaint();
    void reorderRelevance();
  } else if (willPassage && refText(refField).trim()) {
    void runRelevance();
  } else {
    if (willPassage) relevance?.clearPassage();
    rankOrder = [];
    rankFailed = false;
    verseText.open = null;
    beginRankPaint({ resetUser: true });
    render();
  }
}

for (const b of document.querySelectorAll("#group-by button")) {
  b.addEventListener("click", () => selectMode(b.dataset.mode));
}
$("#group-by-select").addEventListener("change", (e) => selectMode(e.target.value));

/** Clear #ref ranking text and restore add-mode placeholder/aria (Highlight stays until renderGroupBy). */
function clearRankScopeFromRef() {
  clearTimeout(refRankTimer);
  refField.value = "";
  errorIn($("#add"), "");
}

function clearRelevanceInput({ keepRef = false, keepSearch = false } = {}) {
  if (!keepRef) clearRankScopeFromRef();
  if (!keepSearch) {
    const topicField = $("#topic-search");
    if (topicField) topicField.value = "";
  }
  errorIn($("#add"), "");
  rankGeneration++; // drop any in-flight response
  relevance?.clearPassage();
  rankOrder = [];
  rankPending = null;
  rankFailed = false;
  beginRankPaint({ resetUser: true });
  verseText.open = null;
  showRelevanceNone(null);
  showRankPreview(null);
  // Collapse after clearing passage so syncAddHiddenForTopicSearch doesn't revive the epigraph.
  if (!keepSearch) closeTopicSearch({ force: true });
}

/**
 * Threshold for the hybrid Relevant/Surprising passage preview:
 * - Short passages (≤ 2 verses and ≤ 200 chars, roughly ≤ 2 lines at the 32rem Vault measure):
 *   Option 1 — quiet left-ruled epigraph (#rank-epigraph) directly under #ref, no repeated title or box.
 * - Longer passages (> 2 verses or > 200 chars, e.g. multi-verse ranges or whole chapters):
 *   Option 3 — one-line collapsible strip (#rank-preview) that expands to show the BSB text with verse numbers.
 */
const SHORT_PREVIEW_MAX_VERSES = 2;
const SHORT_PREVIEW_MAX_CHARS = 200;
let previewRenderedRef = null;

function renderPreviewBody(body, passage) {
  body.replaceChildren();
  const block = document.createElement("div");
  block.className = "rank-preview-scripture";
  if (passage.html) {
    const doc = new DOMParser().parseFromString(passage.html, "text/html");
    for (const bad of doc.querySelectorAll("script, style, iframe, object")) bad.remove();
    const p = document.createElement("div");
    p.className = "rank-preview-verses";
    p.innerHTML = doc.body.innerHTML;
    block.append(p);
  } else if (verseText.key) {
    block.append(passageFor(passage.ref));
  } else {
    const p = document.createElement("p");
    p.className = "rank-preview-verses";
    p.textContent = passage.text;
    block.append(p);
  }
  const cite = document.createElement("div");
  cite.className = "rank-preview-cite";
  cite.textContent = "BSB";
  block.append(cite);
  body.append(block);
}

/** Hybrid preview of the input passage in Relevant/Surprising (Topic uses header copy only). */
function showRankPreview(passage) {
  // Topic search chrome hides #add; don't leave the epigraph floating without the scope field.
  if ($("#topic-search-wrap")?.classList.contains("is-open")) passage = null;
  const epigraph = $("#rank-epigraph");
  const panel = $("#rank-preview");
  if (!passage?.text) {
    if (epigraph) {
      epigraph.hidden = true;
      epigraph.textContent = "";
    }
    if (panel) {
      panel.hidden = true;
      panel.open = false;
    }
    previewRenderedRef = null;
    return;
  }
  const verseCount = passage.verses?.length ?? 1;
  const isShort = verseCount <= SHORT_PREVIEW_MAX_VERSES && passage.text.length <= SHORT_PREVIEW_MAX_CHARS;
  if (isShort) {
    if (panel) {
      panel.hidden = true;
      panel.open = false;
    }
    if (epigraph) {
      epigraph.textContent = passage.text;
      epigraph.hidden = false;
    }
    previewRenderedRef = passage.ref;
    return;
  }
  if (epigraph) {
    epigraph.hidden = true;
    epigraph.textContent = "";
  }
  if (panel) {
    panel.querySelector(".rank-preview-text").textContent = `“${passage.text}”`;
    const body = $("#rank-preview-body");
    if (previewRenderedRef !== passage.ref) {
      panel.open = false;
      const toggle = panel.querySelector(".rank-preview-toggle");
      if (toggle) toggle.textContent = "Read ▾";
      if (body) renderPreviewBody(body, passage);
      previewRenderedRef = passage.ref;
    }
    panel.hidden = false;
  }
}

$("#rank-preview")?.addEventListener("toggle", (e) => {
  const panel = e.currentTarget;
  const toggle = panel.querySelector(".rank-preview-toggle");
  if (toggle) toggle.textContent = panel.open ? "Hide ▴" : "Read ▾";
});

/** Calm panel when a valid passage returns no relevant highlights — not the error line, not #empty. */
function showRelevanceNone(info) {
  const panel = $("#relevance-none");
  if (!info) {
    panel.hidden = true;
    return;
  }
  const label = info.passage.label || labelRef(info.passage.ref);
  $("#relevance-none-copy").textContent = emptyRelevanceCopy(info.count, label);
  panel.dataset.ref = info.passage.ref;
  panel.dataset.label = label;
  const chapter = chapterRefOf(info.passage.ref);
  $("#relevance-none-chapter").hidden = !chapter || chapter === info.passage.ref;
  panel.hidden = false;
}

$("#relevance-none-route").addEventListener("click", () => {
  const ref = $("#relevance-none").dataset.ref;
  if (ref) window.open(`https://route.bible/${ref.toLowerCase()}`, "_blank", "noopener");
});

$("#relevance-none-chapter").addEventListener("click", () => {
  const ref = $("#relevance-none").dataset.ref;
  const chapter = chapterRefOf(ref);
  if (!chapter) return;
  refField.value = labelRef(chapter);
  void runRelevance();
});

$("#relevance-none-date").addEventListener("click", () => {
  selectMode("date");
});

function syncRelevanceCache() {
  if (!library || !relevance) return;
  const now = new Map();
  for (const r of library.all("highlight")) now.set(r.ref, r.updated);
  const upserts = [];
  const deletions = [];
  for (const [ref, updated] of now) if (highlightStamp.get(ref) !== updated) upserts.push({ ref });
  for (const ref of highlightStamp.keys()) if (!now.has(ref)) deletions.push(ref);
  if (upserts.length || deletions.length) relevance.applyChanges({ upserts, deletions });
  highlightStamp = now;
}

async function ensureRelevance() {
  if (!library) return null;
  if (!relevance || relevance.lib !== library.lib) {
    relevance = createRelevance({ lib: library.lib, verseText: bsbText });
    relevance.lib = library.lib;
  }
  return relevance;
}

/** Highlight runs currently shown (respecting the color filter), warmed for BSB text. */
function currentRuns() {
  const ids = colors.map((c) => c.id);
  const records = library.all("highlight").sort((a, b) => compareRefs(a.ref, b.ref));
  const shown = filter.size ? records.filter((r) => filter.has(topColor(r, ids))) : records;
  const runs = groupRuns(shown, (r) => topColor(r, ids));
  bsbText.warm(runs.map((r) => r.ref));
  return runs;
}

async function runRelevance() {
  const session = await ensureRelevance();
  // Topic search owns the list while it has a query; don't race passage ranking underneath.
  if (!session || !RANK_MODES.includes(groupBy) || topicQuery()) return;
  const form = $("#add");
  const raw = refText(refField);
  const gen = ++rankGeneration;
  // Drop prior results immediately so a slow second call can't flash an intermediate list.
  rankOrder = [];
  rankFailed = false;
  beginRankPaint({ resetUser: true });
  verseText.open = null;
  showRelevanceNone(null);
  showRankPreview(null);
  if (!String(raw).trim()) {
    errorIn(form, "");
    session.clearPassage();
    rankPending = null;
    if (gen === rankGeneration) render();
    return;
  }
  rankPending = true;
  render(); // loading before any network / verse fetch
  const found = await session.setPassageInput(raw);
  if (gen !== rankGeneration) return;
  if (found.error) {
    errorIn(form, found.error);
    session.clearPassage();
    rankOrder = [];
    rankPending = null;
    rankFailed = false;
    render();
    return;
  }
  errorIn(form, "");
  const runs = currentRuns();
  const items = runs.map((r) => ({ id: r.ref, ref: r.ref }));
  try {
    const { ranked } = await session.judge(items, groupBy);
    if (gen !== rankGeneration) return; // newer input or a later run owns the UI
    rankOrder = ranked.map((v) => v.id);
    rankFailed = false;
    beginRankPaint({ resetUser: true }); // final paint for this query
  } catch (e) {
    if (gen !== rankGeneration) return;
    errorIn(form, rankErrorMessage(e));
    rankOrder = [];
    rankFailed = true;
  } finally {
    if (gen === rankGeneration) {
      rankPending = null;
      render();
    }
  }
}

async function runTopic() {
  const session = await ensureRelevance();
  if (!session) return;
  const form = $("#add");
  const cleaned = topicQuery();
  const gen = ++rankGeneration;
  rankOrder = [];
  rankFailed = false;
  beginRankPaint({ resetUser: true });
  verseText.open = null;
  showRelevanceNone(null);
  showRankPreview(null);
  if (!cleaned) {
    errorIn(form, "");
    session.clearPassage();
    rankPending = null;
    if (gen !== rankGeneration) return;
    // Restore the selected mode's list (Relevant/Surprising re-rank from #ref when present).
    if (RANK_MODES.includes(groupBy) && refText(refField).trim()) void runRelevance();
    else render();
    return;
  }
  rankPending = true;
  session.setTopicInput(cleaned);
  render(); // loading before any network
  errorIn(form, "");
  const runs = currentRuns();
  const items = runs.map((r) => ({ id: r.ref, ref: r.ref }));
  try {
    const { ranked } = await session.judgeTopic(items, cleaned);
    if (gen !== rankGeneration) return;
    rankOrder = ranked.map((v) => v.id);
    rankFailed = false;
    beginRankPaint({ resetUser: true });
  } catch (e) {
    if (gen !== rankGeneration) return;
    errorIn(form, rankErrorMessage(e));
    rankOrder = [];
    rankFailed = true;
  } finally {
    if (gen === rankGeneration) {
      rankPending = null;
      render();
    }
  }
}

async function reorderRelevance() {
  const session = await ensureRelevance();
  if (!session?.passage || rankFailed) return render();
  const runs = currentRuns();
  const { ranked } = session.reorder(runs.map((r) => ({ id: r.ref, ref: r.ref })), groupBy);
  rankOrder = ranked.map((v) => v.id);
  render();
}

// Ranking input is #ref (hijacked in Relevant/Surprising). Autocomplete stays on that one field.
refField.addEventListener("input", () => {
  if (!RANK_MODES.includes(groupBy) || topicQuery()) return;
  clearTimeout(refRankTimer);
  const form = $("#add");
  const raw = refText(refField);
  if (!String(raw).trim()) errorIn(form, "");
  // Leave the old ranked list immediately when the passage changes; debounce the network call.
  rankGeneration++;
  rankOrder = [];
  rankFailed = false;
  beginRankPaint({ resetUser: true });
  verseText.open = null;
  showRelevanceNone(null);
  showRankPreview(null);
  if (String(raw).trim()) {
    rankPending = true;
  } else {
    relevance?.clearPassage();
    rankPending = null;
  }
  render();
  // Invalid refs show inline and make no call; wait for a pause so typing doesn't flash errors.
  refRankTimer = setTimeout(() => void runRelevance(), 400);
});

{
  const topicField = $("#topic-search");
  const topicToggle = $("#topic-search-toggle");
  let topicTimer = 0;
  topicToggle.addEventListener("click", () => openTopicSearch());
  topicField.addEventListener("input", () => {
    clearTimeout(topicTimer);
    const form = $("#add");
    const cleaned = sanitizeTopic(topicField.value);
    if (!cleaned) errorIn(form, "");
    // Stay expanded while typing a query; empty alone does not collapse (blur/Escape does).
    if (cleaned) openTopicSearch({ focus: false });
    // Search owns the list whenever the field has a query — independent of Date/Genre/Relevant/Surprising.
    rankGeneration++;
    rankOrder = [];
    rankFailed = false;
    beginRankPaint({ resetUser: true });
    verseText.open = null;
    showRelevanceNone(null);
    showRankPreview(null);
    if (cleaned) {
      rankPending = true;
      relevance?.setTopicInput(cleaned);
      render();
      topicTimer = setTimeout(() => void runTopic(), 400);
    } else {
      relevance?.clearPassage();
      rankPending = null;
      // Restore the selected mode immediately; debounce is unnecessary for clear.
      if (RANK_MODES.includes(groupBy) && refText(refField).trim()) void runRelevance();
      else render();
    }
  });
  topicField.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (topicQuery()) {
        topicField.value = "";
        topicField.dispatchEvent(new Event("input", { bubbles: true }));
        // Cleared but still expanded until a second Escape or blur.
        return;
      }
      closeTopicSearch({ force: true });
      topicToggle.focus();
      return;
    }
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    clearTimeout(topicTimer);
    void runTopic();
  });
  topicField.addEventListener("blur", () => {
    // Collapse only when empty; an active query keeps the field expanded.
    closeTopicSearch();
  });
}

/** One group: its name as the summary (the whole header toggles it), then its rows. */
function group({ id, name, runs }) {
  const key = `${groupBy}:${id}`;
  const details = document.createElement("details");
  details.className = "group";
  details.dataset.group = id;
  details.open = groupOpen.get(key) ?? startsOpen(groupBy, id);
  details.addEventListener("toggle", () => groupOpen.set(key, details.open));
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "group-name";
  title.textContent = name;
  summary.append(title);
  const list = document.createElement("ul");
  list.className = "rows";
  list.append(...runs.map(row));
  details.append(summary, list);
  return details;
}

function renderFilters(counts) {
  const details = $("#filters");
  const summary = $("#filter-summary");
  const badge = $("#filter-badge");
  const box = $("#filter-options");
  if (!details || !summary || !box) return;
  if (counts.size <= 1) {
    details.open = false;
    details.hidden = true;
    box.replaceChildren();
    return;
  }
  details.hidden = false;
  details.dataset.active = String(filter.size > 0);
  const label = filter.size > 0 ? `Filter by color (${filter.size} active)` : "Filter by color";
  summary.setAttribute("aria-label", label);
  summary.title = label;
  if (badge) {
    badge.hidden = filter.size === 0;
    badge.textContent = filter.size > 0 ? String(filter.size) : "";
  }

  const items = [];
  for (const c of colors) {
    if (!counts.has(c.id)) continue;
    const label = document.createElement("label");
    label.className = "filter-option";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = filter.has(c.id);
    check.addEventListener("change", () => {
      if (check.checked) filter.add(c.id);
      else filter.delete(c.id);
      saveFilters();
      render();
    });
    const dot = document.createElement("span");
    dot.className = "dot";
    paint(dot, c.id);
    const name = document.createElement("span");
    name.className = "filter-name";
    name.textContent = colorName(c);
    const count = document.createElement("span");
    count.className = "filter-count";
    count.textContent = String(counts.get(c.id));
    label.append(check, dot, name, count);
    items.push(label);
  }
  box.replaceChildren(...items);
}

const ICONS = {
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/></svg>',
  filter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
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
  dot.addEventListener("click", () =>
    openColorPicker(dot, topColor(records[0], ids), (id) => {
      const t = now();
      library.putMany(records.map((r) => ({ ...r, highlights: r.highlights.map((h) => ({ ...h, color: id, edited: t })) })));
    }),
  );

  // The whole row opens the passage's text under it (see .row-link in style.css: its ::after covers
  // the line, and the dot and icons sit above it as their own buttons). Without verse text it opens
  // the passage in route.bible instead, like the globe.
  const routeHref = `https://route.bible/${runRef.toLowerCase()}`; // the whole run, e.g. rom.5.3-5
  const link = document.createElement("button");
  link.type = "button";
  link.className = "row-link";
  if (verseText.key) {
    link.setAttribute("aria-label", `Show the text of ${labelRef(runRef)}`);
    wireTextToggle(link, li, runRef);
  } else {
    link.setAttribute("aria-label", `Open ${labelRef(runRef)} on route.bible`);
    link.addEventListener("click", () => window.open(routeHref, "_blank", "noopener"));
  }
  const ref = document.createElement("span");
  ref.className = "ref";
  ref.textContent = labelRef(runRef);
  const quote = document.createElement("span");
  quote.className = "quote";
  quote.textContent = records.flatMap((r) => r.highlights.map((h) => h.quote)).filter(Boolean).join(" … ");
  link.append(ref, quote);

  const line = document.createElement("div");
  line.className = "row";

  const edit = iconButton("button", "edit", `Edit ${labelRef(runRef)}`);
  edit.classList.add("edit");
  edit.addEventListener("click", () => editRow(li, line, { ref: runRef, records }));

  // Two taps to delete (see confirm.js): the first turns the trash into a red "Delete" confirm, and
  // a tap anywhere else, a scroll, Escape or 3 seconds puts it back. Deleting offers an Undo.
  const del = iconButton("button", "trash", `Delete ${labelRef(runRef)}`);
  del.classList.add("trash");
  armDelete(del, {
    label: labelRef(runRef),
    idleHTML: ICONS.trash,
    onConfirm: async () => {
      await library.putMany(records.map((r) => tombstone(r.ref)));
      flash(`Deleted ${labelRef(runRef)}.`, { label: "Undo", run: () => library.putMany(records), ms: 5000 });
    },
  });

  // Three icons as one compact group (see .actions in style.css). They sit above the row's link, so
  // tapping one never opens route.bible.
  const actions = document.createElement("span");
  actions.className = "actions";
  actions.append(edit);
  actions.append(globeLink(runRef, routeHref));
  actions.append(del);
  line.append(dot, link, actions);
  li.append(line);
  if (verseText.open === runRef) showText(li, runRef);
  return li;
}

// ---- editing a row's reference, in place

/** The row being edited, if any: while set, render leaves the list alone. */
let editing = null;

/**
 * Swaps a row's reference for a passage field in the same place, at the same size: the dot and icons
 * stay where they are (inert while editing). Enter, or leaving the field after changing it, saves;
 * Escape cancels. A reference that doesn't read keeps the field open and says why in the flash line.
 * Saving rewrites the run's verses (see editRun) in one putMany.
 */
function editRow(li, line, run) {
  const ids = colors.map((c) => c.id);
  const color = topColor(run.records[0], ids);
  const form = document.createElement("form");
  form.className = "ref-edit";
  form.noValidate = true;
  form.autocomplete = "off";
  const field = document.createElement("si-passage-input");
  field.setAttribute("aria-label", `Reference for ${labelRef(run.ref)}`);
  field.setAttribute("placeholder", "John 3:16");
  form.append(field);
  line.querySelector(".row-link").replaceWith(form);
  line.classList.add("editing");
  for (const el of line.querySelectorAll(":scope > .dot, :scope > .actions")) el.inert = true;
  editing = run.ref;
  listSig = null; // the edit changes the row by hand, so the next render rebuilds it
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
    if (found.error) return (form.dataset.invalid = "1"), flash(found.error);
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
  field.addEventListener("input", () => delete form.dataset.invalid);
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
const warmer = createWarmer(warmText);
// A passage's text themes itself inside its shadow root, so it's told the theme on screen, not left on auto.
const themeNow = setupThemeToggle(document.querySelectorAll(".theme-toggle"), {
  onChange: (theme) => {
    for (const el of verseText.passages.values()) el.setAttribute("theme", theme);
  },
});

// The verse-text key is public (it's served at /config.json). It's kept on this device too, so the
// book button shows on every load even when /config.json is slow, rate limited or offline; a failed
// fetch is retried once.
const YV_KEY = "hidden-word:yv-key";
function useVerseKey(yvpPublicAppKey) {
  if (!yvpPublicAppKey || verseText.key === yvpPublicAppKey) return;
  if (!verseText.key) {
    defineKeepingLoaded(() => defineScripturePassage({ yvpPublicAppKey }));
  }
  verseText.key = yvpPublicAppKey;
  render();
}

async function loadConfig(retry = true) {
  try { useVerseKey(localStorage.getItem(YV_KEY)); } catch {}
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`config ${res.status}`);
    const { yvpPublicAppKey } = await res.json();
    if (!yvpPublicAppKey) return;
    try { localStorage.setItem(YV_KEY, yvpPublicAppKey); } catch {}
    useVerseKey(yvpPublicAppKey);
  } catch {
    // Offline or no server: the kept key (if any) still shows verse text; try once more shortly.
    if (retry) setTimeout(() => loadConfig(false), 2000);
  }
}

/** The globe: opens the run in route.bible, in a new tab, whether or not verse text is available. */
function globeLink(runRef, href) {
  const a = iconButton("a", "globe", `Open ${labelRef(runRef)} on route.bible`);
  a.classList.add("globe");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

/** Makes `toggle` (the row) show and hide the run's text under it, warming it on the way. */
function wireTextToggle(toggle, li, runRef) {
  toggle.setAttribute("aria-expanded", String(verseText.open === runRef));
  // Every row's text loads in the background once the list is up (see passage-warm.js), so a tap
  // finds it ready; hover or focus moves this one to the front.
  warmer.add(runRef);
  const warm = () => (warmer.first(runRef), prefetchText(runRef));
  toggle.addEventListener("pointerenter", warm);
  toggle.addEventListener("focus", warm);
  toggle.addEventListener("click", () => {
    // Manual open/close during this query — don't let the next mode-switch paint override it.
    if (JEV_MODES.includes(groupBy) || topicQuery()) rankUserTouched = true;
    const wasOpen = verseText.open === runRef;
    for (const other of document.querySelectorAll("#list .verse-text")) other.remove();
    for (const other of document.querySelectorAll("#list .row-link[aria-expanded]")) other.setAttribute("aria-expanded", "false");
    verseText.open = wasOpen ? null : runRef;
    if (!wasOpen) (showText(li, runRef), toggle.setAttribute("aria-expanded", "true"));
  });
}

/** The run's <si-passage>, made once and kept, so a re-render doesn't refetch. */
function passageFor(runRef) {
  let el = verseText.passages.get(runRef);
  if (!el) {
    el = document.createElement("si-passage");
    el.className = "verse-text";
    el.id = `text-${runRef.replace(/\W/g, "-")}`;
    el.setAttribute("yvp-bible-version-id", "3034"); // Berean Standard Bible
    el.setAttribute("passage-id", runRef);
    // "citation" puts "<reference> <version>" after the text; style.css shows only the version (BSB).
    el.setAttribute("reference", "citation");
    el.setAttribute("theme", themeNow());
    el.setAttribute("headings", "hide");
    // Through this site's edge-cached pass-through (src/yv.ts) rather than straight to YouVersion.
    if (location.protocol === "https:") el.setAttribute("yvp-api-host", `${location.host}/yv`);
    styleScripture(el);
    verseText.passages.set(runRef, el);
  }
  return el;
}

/** Resolves once a run's text has loaded off screen (or failed, or 8s passed). */
function warmText(runRef) {
  const fresh = !verseText.passages.has(runRef);
  prefetchText(runRef);
  const el = verseText.passages.get(runRef);
  if (!el || el.loaded || !fresh) return Promise.resolve();
  return new Promise((done) => {
    el.addEventListener("scripture-load", done, { once: true });
    el.addEventListener("scripture-error", done, { once: true });
    setTimeout(done, 8000);
  });
}

/** Loads a run's text off screen: <si-passage> fetches when it's put in the page, and keeps what it got. */
function prefetchText(runRef) {
  if (!verseText.key || verseText.passages.has(runRef)) return;
  let holder = $("#text-prefetch");
  if (!holder) {
    holder = document.createElement("div");
    holder.id = "text-prefetch";
    holder.hidden = true;
    document.body.append(holder);
  }
  holder.append(passageFor(runRef));
}

/**
 * The passage's inside (verse numbers, words of Jesus, measure) lives in <si-passage>'s shadow root,
 * which outside CSS can't reach; one shared sheet is adopted there. Colors come from custom
 * properties set on .verse-text in style.css, so both themes follow the app.
 */
let scriptureSheet;
function styleScripture(el) {
  const root = el.shadowRoot;
  if (!root || !("adoptedStyleSheets" in root)) return;
  if (!scriptureSheet) {
    scriptureSheet = new CSSStyleSheet();
    scriptureSheet.replaceSync(SCRIPTURE_CSS);
  }
  if (!root.adoptedStyleSheets.includes(scriptureSheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, scriptureSheet];
}
const SCRIPTURE_CSS = `
/* Set type on the part itself: si-passage's inner .root uses all:initial, which drops host
   custom-property inheritance and falls back to Untitled Serif / tight leading. */
[part="text"] {
  max-width: var(--vault-measure, 36rem);
  font-family: "Lexend", "Helvetica Neue", sans-serif !important;
  font-size: var(--scripture-font-size, 1rem) !important;
  line-height: var(--scripture-line-height, 1.75) !important;
}
[part="text"] p { margin-block: 0 .55em; }
[part="text"] :is(p, .p) { text-indent: 0 !important; }
.yv-vlbl, .va { color: var(--vault-verse, currentColor) !important; font-size: .62em !important; font-weight: 600; letter-spacing: .02em;
  vertical-align: .55em; line-height: 0; margin-inline: .2em .25em; font-style: normal; }
.wj { color: var(--vault-wj, inherit) !important; }
`;

/** Puts the run's passage under its row, with a rule in the row's color. */
function showText(li, runRef) {
  const el = passageFor(runRef);
  el.className = "verse-text";
  styleScripture(el); // re-apply after reconnect; same path in Date/Genre/Jev
  const dot = li.querySelector(".dot");
  if (dot) el.style.setProperty("--row-color", getComputedStyle(dot).backgroundColor);
  li.querySelector(".row-link")?.setAttribute("aria-controls", el.id);
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
 * The shared color popover, anchored under the dot that opened it, with `current` pressed. Picking a
 * different color calls `pick(id)`: a row's dot recolors its run, the add form's dot only sets the form.
 * It closes on an outside press or Escape by itself, and focus goes back to the dot.
 */
function openColorPicker(anchor, current, pick) {
  const pop = $("#color-pop");
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
        if (c.id !== current) pick(c.id);
      });
      return b;
    }),
  );
  pop.ontoggle = (e) => {
    if (e.newState !== "closed") return;
    const focus = document.activeElement;
    if (anchor.isConnected && (!focus || focus === document.body || pop.contains(focus))) anchor.focus();
  };
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
      // Every row's field is the same width: the action sits inside its right edge, and the built-in
      // colors (which can't be deleted) keep that space empty.
      const field = document.createElement("span");
      field.className = "color-field";
      field.append(name);
      if (!c.builtIn) {
        const del = iconButton("button", "trash", `Delete ${colorName(c)}`);
        del.classList.add("trash", "field-action");
        del.addEventListener("click", () => deleteColor(c));
        field.append(del);
      }
      li.append(field);
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
  const on = settings(library.lib).server;
  $("#use-server").checked = on;
  $("#use-server").setAttribute("aria-checked", String(on));
}

$("#use-server").addEventListener("change", async (e) => {
  const on = e.target.checked;
  e.target.setAttribute("aria-checked", String(on));
  saveSettings(library.lib, { ...settings(library.lib), server: on });
  await connect();
});

for (const back of document.querySelectorAll(".back")) back.addEventListener("click", () => (hideKey(), show("main"), render()));

// ---- the library's name, edited in place

function rename(next) {
  library.rename(next);
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
// One ••• control permanently in <header>: reachable on both desktop and phone, even when the library is empty.

// Keep the focused field on screen when the soft keyboard opens on phone settings.
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (!el.matches("input, textarea, select, si-passage-input")) return;
  if (!matchMedia("(max-width: 600px)").matches) return;
  if (!el.closest(".settings-panel")) return;
  requestAnimationFrame(() => {
    setTimeout(() => el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" }), 250);
  });
});

document.addEventListener("pointerdown", (e) => {
  const menu = $("#menu");
  if (menu?.open && !menu.contains(e.target)) menu.open = false;
  const filters = $("#filters");
  if (filters?.open && !filters.contains(e.target)) filters.open = false;
});
document.addEventListener("keydown", (e) => {
  const menu = $("#menu");
  if (e.key === "Escape" && menu?.open) {
    menu.open = false;
    menu.querySelector("summary")?.focus();
  }
  const filters = $("#filters");
  if (e.key === "Escape" && filters?.open) {
    filters.open = false;
    filters.querySelector("summary")?.focus();
  }
});

function menuAction(sel, fn) {
  for (const el of document.querySelectorAll(sel)) {
    el.addEventListener("click", async () => {
      const menu = $("#menu");
      if (menu) menu.open = false;
      try {
        await fn();
      } catch (error) {
        if (!cancelled(error)) flash(error.message);
      }
    });
  }
}

menuAction("#open-sync", () => (renderSync(), hideKey(), ($("#access-note").textContent = ""), show("sync")));
menuAction("#open-colors", () => (renderColors(), show("colors")));
menuAction("#open-backup", () => (($("#backup-note").textContent = ""), show("backup")));

/** Runs a button on a settings screen, saying how it went in that screen's status line. */
function screenAction(id, note, fn) {
  $(id).addEventListener("click", async () => {
    try {
      const said = await fn();
      if (said) $(note).textContent = said;
    } catch (error) {
      if (!cancelled(error)) $(note).textContent = error.message;
    }
  });
}

/** Creates a passkey that unlocks the open library, and says so. */
async function addPasskey() {
  const prf = await createPasskeyPrf(library.name);
  await saveSlot({ prf, keyText: library.keyText, name: library.name });
  $("#passkey-offer").hidden = true;
  return "Passkey added. Use it to unlock this library in any browser.";
}

screenAction("#add-passkey", "#access-note", addPasskey);

// Offered once, right after creating a library. Declining or cancelling costs nothing: the Sync
// screen has "Add passkey" too.
$("#offer-passkey").addEventListener("click", async () => {
  try {
    flash(await addPasskey());
  } catch (error) {
    if (!cancelled(error)) flash(error.message);
  }
});
$("#skip-passkey").addEventListener("click", () => ($("#passkey-offer").hidden = true));

// The key shows on the Sync screen until hidden again or the screen is left.
const COPY_KEY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const COPIED_KEY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
let copyKeyTimer;
function resetCopyKeyButton() {
  clearTimeout(copyKeyTimer);
  const btn = $("#copy-key");
  if (!btn) return;
  btn.innerHTML = COPY_KEY_ICON;
  btn.setAttribute("aria-label", "Copy sync key");
  btn.title = "Copy sync key";
}
function hideKey() {
  resetCopyKeyButton();
  $("#key-reveal").hidden = true;
  $("#key-text").textContent = "";
  $("#show-key").textContent = "Show sync key";
  $("#show-key").setAttribute("aria-expanded", "false");
}
$("#show-key").addEventListener("click", () => {
  if (!$("#key-reveal").hidden) return hideKey();
  $("#key-text").textContent = library.keyText;
  $("#key-reveal").hidden = false;
  $("#show-key").textContent = "Hide sync key";
  $("#show-key").setAttribute("aria-expanded", "true");
});
$("#copy-key").addEventListener("click", async () => {
  if (!library) return;
  await navigator.clipboard.writeText(library.keyText);
  const btn = $("#copy-key");
  btn.innerHTML = COPIED_KEY_ICON;
  btn.setAttribute("aria-label", "Copied");
  btn.title = "Copied";
  clearTimeout(copyKeyTimer);
  copyKeyTimer = setTimeout(resetCopyKeyButton, 1500);
});

screenAction("#export", "#backup-note", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([library.toFile()], { type: "application/x-ndjson" }));
  a.download = `selah-vault-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return "Saved a copy of this library as a file.";
});

screenAction("#import", "#backup-note", () => $("#import-file").click());

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const records = parseJsonl(text);
    const changed = await library.merge(records);
    const older = records.length - changed;
    $("#backup-note").textContent = `Imported ${changed} ${changed === 1 ? "record" : "records"}${older ? ` (${older} unchanged: you had them, or newer)` : ""}.`;
  } catch (error) {
    $("#backup-note").textContent = `Couldn't import that file: ${error.message}`;
  }
});

menuAction("#lock", lock);

$("#erase").addEventListener("click", async () => {
  const ok = confirm("Erase this library from the server and this device? A device that still has it will put it back when it syncs.");
  if (!ok) return;
  await library.erase();
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
  forgetFolderHandles();
  // With passkeys, unlocking with one is the main way in and the key form is the fallback.
  if (passkeysAvailable()) {
    $("#passkey-unlock").hidden = false;
    $("#or-key").hidden = false;
    $("#start").classList.add("has-passkey");
    $("#lost-passkey").hidden = false;
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

// In-page tools for browser agents (public/webmcp.js). They act on the open library only, never see
// the sync key, and do nothing in browsers without WebMCP.
registerSelahVaultTools({ library: () => library, colors: () => colors, colorName, highlight, flash });

boot();
