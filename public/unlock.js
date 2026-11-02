// Hands a library's sync key to another app: /unlock?app=Name&callback=scheme://path
// The key goes back in the callback's fragment, which the browser never sends to a server.
import { KeyError, Library, openSlot } from "./sync.js";
import { getPasskeyPrf, passkeysAvailable, cancelled } from "./passkey.js";

const $ = (sel) => document.querySelector(sel);
const BLOCKED = new Set(["javascript:", "data:", "blob:", "file:", "about:", "vbscript:"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function checkCallback(raw) {
  try {
    const url = new URL(raw);
    if (BLOCKED.has(url.protocol)) return null;
    if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

const params = new URLSearchParams(location.search);
const app = (params.get("app") ?? "").trim().slice(0, 60);
const callback = checkCallback(params.get("callback"));
let chosen = null;

function show(id) {
  for (const section of document.querySelectorAll("main > section")) section.hidden = section.id !== id;
}

function ask(key, name) {
  chosen = { key, name };
  $("#consent-lib").textContent = name;
  $("#consent-dest").textContent = /^https?:$/.test(callback.protocol) ? callback.host : `${callback.protocol}//${callback.host}`;
  show("consent");
}

function finish(fragment) {
  const url = new URL(callback);
  url.hash = new URLSearchParams(fragment).toString();
  location.assign(url.href);
}

if (!app || !callback) {
  show("bad");
} else {
  document.querySelectorAll(".app-name").forEach((el) => (el.textContent = app));
  const session = JSON.parse(localStorage.getItem("hidden-word:session") ?? "null");
  if (session) {
    $("#use-session").hidden = false;
    $("#use-session").textContent = `Use “${session.name}” (unlocked in this browser)`;
    $("#use-session").addEventListener("click", () => ask(session.key, session.name));
  }
  if (passkeysAvailable()) $("#passkey-unlock").hidden = false;
  show("pick");
}

$("#unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    const library = await Library.open({ keyText: form.get("password") });
    ask(library.keyText, form.get("username").trim() || "Personal");
  } catch (error) {
    e.target.querySelector(".error").textContent = error instanceof KeyError ? "That sync key has a typo." : error.message;
  }
});

$("#passkey-unlock").addEventListener("click", async () => {
  try {
    const slot = await openSlot({ prf: await getPasskeyPrf() });
    if (slot) ask(slot.key, slot.name);
    else $("#unlock-form .error").textContent = "That passkey isn't linked to a library yet.";
  } catch (error) {
    if (!cancelled(error)) $("#unlock-form .error").textContent = error.message;
  }
});

$("#allow").addEventListener("click", () => finish({ k: chosen.key, name: chosen.name }));
$("#deny").addEventListener("click", () => finish({ error: "denied" }));
