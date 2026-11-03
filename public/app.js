import {
  COLORS, Library, KeyError, newKey, formatKey, now, palette, topColor, parseJsonl, saveSlot, openSlot,
  serverTransport,
} from "./sync.js";
import { labelRef, compareRefs } from "./refs.js";
import { readPassage } from "./passage.js";
import { createPasskeyPrf, getPasskeyPrf, passkeysAvailable, cancelled } from "./passkey.js";
import { activateOPButton, encodeOPSaveRequest } from "./vendor/onepassword-save-button.js";
import { foldersAvailable, pickFolder, saveFolder, loadFolder, forgetFolder, mayUse, folderTree } from "./folder.js";
import { formatFor, importFile } from "./adapters/index.js";

const $ = (sel) => document.querySelector(sel);
const SESSION = "hidden-word:session";
const CREATED = "hidden-word:created";
const SAVE_LINK = "hidden-word:save-link";
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
let editing = null;
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

async function enter(keyText, name) {
  library = await Library.open({ keyText, name, store });
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
    if (folder.state === "on") {
      // The folder's format picks the adapter (public/adapters/).
      const tree = folderTree(folder.handle);
      const format = await formatFor(tree);
      if (format) {
        folder.label = format.label;
        transports.push(format.adapter(tree));
      } else {
        folder.state = "off";
        flash("No folder format here can sync that folder.");
      }
    }
    else flash("Folder sync is paused until you allow it again in Sync.");
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

$("#unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await enter(form.get("password"), form.get("username").trim() || "Personal");
  } catch (error) {
    errorIn(e.target, error instanceof KeyError ? "That sync key has a typo. Check it and try again." : String(error.message));
  }
});

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

$("#create").addEventListener("click", async () => {
  const form = $("#save-form");
  form.password.value = await formatKey(newKey());
  form.password.type = "password";
  $("#reveal").textContent = "Show";
  opClosing?.disconnect();
  opClosing = null;
  // Password managers such as 1Password only save what they saw entered; a value set by script
  // raises no events, so announce it as if it were typed.
  for (const input of [form.username, form.password]) {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  show("created");
  offerOnePassword();
});

$("#reveal").addEventListener("click", () => {
  const input = $("#save-form").password;
  input.type = input.type === "password" ? "text" : "password";
  $("#reveal").textContent = input.type === "password" ? "Show" : "Hide";
});

$("#copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#save-form").password.value);
  $("#copy").textContent = "Copied";
  setTimeout(() => ($("#copy").textContent = "Copy"), 1500);
});

// The form-submit save below relies on each password manager spotting a sign-up, which 1Password
// does unreliably. Its own Save button hands it the item directly. Only the 1Password extension
// enables the button, so a button still disabled after a moment means no extension: hide it.
let opReady = false;
let opWatch = null;
let opTimer = 0;

function opSaveRequest() {
  const form = $("#save-form");
  const name = form.username.value.trim() || "Personal";
  return encodeOPSaveRequest({
    title: `Hidden Word: ${name}`,
    fields: [
      { autocomplete: "username", value: name },
      { autocomplete: "new-password", value: form.password.value },
      // Undocumented in the save button's API; trying it so the item gets this site as its website.
      { autocomplete: "url", value: location.origin },
    ],
    notes: `Sync key for the Hidden Word library “${name}”. Unlock at ${location.origin}`,
  });
}

function offerOnePassword() {
  const slot = $("#onepassword");
  opWatch?.disconnect();
  const button = document.createElement("onepassword-save-button");
  button.setAttribute("data-onepassword-type", "login");
  button.setAttribute("padding", "none");
  if (matchMedia("(prefers-color-scheme: dark)").matches) button.setAttribute("data-theme", "dark");
  button.setAttribute("value", opSaveRequest());
  slot.replaceChildren(button);
  slot.hidden = false;
  const inner = button.shadowRoot?.querySelector("[data-onepassword-save-button]");
  if (!inner) return (slot.hidden = true);
  opWatch = new MutationObserver(() => {
    if (inner.disabled) return;
    opReady = true;
    slot.hidden = false;
  });
  opWatch.observe(inner, { attributes: true, attributeFilter: ["disabled"] });
  clearTimeout(opTimer);
  opTimer = setTimeout(() => (slot.hidden = !opReady && inner.disabled), 2000);
  button.addEventListener("click", (e) => {
    if (!inner.disabled && e.composedPath().includes(inner)) continueWhenOnePasswordCloses();
  });
  activateOPButton();
}

// 1Password shows its save dialog in a <com-1password-modal> element it adds to the page, and
// removes the element when the dialog closes. (Its notification element uses the same pattern, so
// watch both.) That closing is the cue to go on into the library without a Continue click; the
// short wait lets 1Password finish writing the item. The page can't tell a save from a dismissal.
let opClosing = null;

function continueWhenOnePasswordCloses() {
  if (opClosing) return;
  const DIALOGS = ["COM-1PASSWORD-MODAL", "COM-1PASSWORD-NOTIFICATION"];
  const open = () => DIALOGS.some((name) => document.querySelector(name));
  let opened = open();
  let settle = 0;
  opClosing = new MutationObserver((records) => {
    if ($("#created").hidden) return stop();
    for (const r of records) {
      if ([...r.addedNodes].some((n) => DIALOGS.includes(n.nodeName))) opened = true;
    }
    clearTimeout(settle);
    // 1Password sometimes moves the element between parents; only a removal that lasts counts.
    if (opened && !open()) settle = setTimeout(go, 150);
  });
  const stop = () => {
    opClosing?.disconnect();
    opClosing = null;
  };
  const go = () => {
    if (open()) return;
    stop();
    if (!$("#created").hidden) setTimeout(() => $("#save-form").requestSubmit(), 1000);
  };
  opClosing.observe(document.documentElement, { childList: true, subtree: true });
}

// The element copies its value to the inner button once, so a renamed library updates that button.
$("#new-username").addEventListener("input", () => {
  $("#onepassword onepassword-save-button")?.shadowRoot?.querySelector("[data-onepassword-save-button]")?.setAttribute("value", opSaveRequest());
});

// Password managers (1Password, Chrome, Safari) offer to save a sign-up when its form is really
// submitted, straight from the person's tap, and the page navigates. So Continue does only that:
// the form submits as a GET to "/" and the page reloads into the new library. iOS in particular
// offers nothing for a submission made later by script, which is why the passkey is offered on
// the next screen instead of before submitting. The formdata handler empties the submission, so
// the key never leaves the device.
$("#save-form").addEventListener("submit", (e) => {
  const form = e.target;
  const name = form.username.value.trim() || "Personal";
  localStorage.setItem(SESSION, JSON.stringify({ key: form.password.value, name }));
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
  await library.putMany(
    verses.map((v, i) => {
      const prev = before[i];
      const created = prev ? Math.min(...prev.highlights.map((h) => h.created ?? t)) : t;
      const part = created === t ? { color, created } : { color, created, edited: t };
      return { ...(prev ?? {}), kind: "highlight", ref: v, highlights: [part] };
    }),
  );
  return () => library.putMany(verses.map((v, i) => before[i] ?? { kind: "highlight", ref: v, deleted: true }));
}

$("#add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const found = readPassage($("#ref").value);
  if (found.error) return errorIn(form, found.error);
  errorIn(form, "");
  await highlight(found.verses, new FormData(form).get("color"));
  $("#ref").value = "";
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

function statusText() {
  const waiting = library.waiting();
  const { state } = library.status;
  if (state === "local") return "On this device only";
  if (state === "syncing") return "Syncing…";
  if (state === "offline") return `Offline${waiting ? ` · ${waiting} waiting` : ""}`;
  if (state === "error") return "Sync failed";
  return waiting ? `${waiting} waiting` : folder.state === "paused" ? "Synced · folder paused" : "Synced";
}

function render() {
  if (!library) return;
  colors = palette(library.all("color"));
  $("#status").textContent = statusText();
  $("#status").dataset.state = library.status.state;
  renderSwatches();

  const ids = colors.map((c) => c.id);
  const rows = library.all("highlight").sort((a, b) => compareRefs(a.ref, b.ref));
  const counts = new Map();
  for (const r of rows) counts.set(topColor(r, ids), (counts.get(topColor(r, ids)) ?? 0) + 1);
  if (filter && !counts.has(filter)) filter = null;
  renderFilters(counts);

  const shown = filter ? rows.filter((r) => topColor(r, ids) === filter) : rows;
  $("#empty").hidden = rows.length > 0;
  $("#list").replaceChildren(...shown.map(row));
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

function row(record) {
  const ids = colors.map((c) => c.id);
  const li = document.createElement("li");
  const head = document.createElement("button");
  head.type = "button";
  head.className = "row-head";
  head.setAttribute("aria-expanded", String(editing === record.ref));
  const dot = document.createElement("span");
  dot.className = "dot";
  paint(dot, topColor(record, ids));
  const ref = document.createElement("span");
  ref.className = "ref";
  ref.textContent = labelRef(record.ref);
  const quote = document.createElement("span");
  quote.className = "quote";
  quote.textContent = record.highlights.map((h) => h.quote).filter(Boolean).join(" … ");
  head.append(dot, ref, quote);
  head.addEventListener("click", () => {
    editing = editing === record.ref ? null : record.ref;
    render();
  });
  li.append(head);

  if (editing === record.ref) {
    const tools = document.createElement("div");
    tools.className = "tools";
    for (const c of colors) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dot";
      b.title = colorName(c);
      paint(b, c.id);
      b.setAttribute("aria-label", `Make ${colorName(c)}`);
      b.setAttribute("aria-pressed", String(topColor(record, ids) === c.id));
      b.addEventListener("click", () => {
        const t = now();
        library.put({ ...record, highlights: record.highlights.map((h) => ({ ...h, color: c.id, edited: t })) });
      });
      tools.append(b);
    }
    const open = document.createElement("a");
    open.href = `https://route.bible/${record.ref.toLowerCase()}`;
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = "Open";
    open.title = "Open in your Bible app (route.bible)";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger quiet";
    del.textContent = "Delete";
    del.addEventListener("click", () => {
      editing = null;
      library.remove("highlight", record.ref);
    });
    tools.append(open, del);
    li.append(tools);
  }
  return li;
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
    folder.state === "on" ? `Syncing with “${folder.handle.name}”. ${folder.label}` :
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

$("#status").addEventListener("click", () => (renderSync(), show("sync")));
for (const back of document.querySelectorAll(".back")) back.addEventListener("click", () => (show("main"), render()));

// ---- menu

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
    // Another app's file, through its adapter (public/adapters/), or a library file.
    const records = (await importFile(text)) ?? parseJsonl(text);
    const changed = await library.merge(records);
    const older = records.length - changed;
    flash(`Imported ${changed} ${changed === 1 ? "record" : "records"}${older ? ` (${older} unchanged: you had them, or newer)` : ""}.`);
  } catch (error) {
    flash(`Couldn't import that file: ${error.message}`);
  }
});

menuAction("#lock", lock);

menuAction("#erase", async () => {
  const ok = confirm("Erase this library from the server, the sync folder and this device? A device that still has it will put it back when it syncs.");
  if (!ok) return;
  await library.erase();
  await forgetFolder(library.lib);
  localStorage.removeItem(settingsKey(library.lib));
  lock();
});

// ---- boot

addEventListener("online", () => library?.sync());
addEventListener("focus", () => library?.sync());
setInterval(() => document.visibilityState === "visible" && library?.sync(), 30_000);

async function boot() {
  if (passkeysAvailable()) $("#passkey-unlock").hidden = false;
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
