// Gives another app limited, expiring access to a library: /connect?return=URL&state=…&scope=read
// The app gets a grant token (public/grants.js) and the library's decryption key, in the return
// URL's fragment, which the browser never sends to a server. It never gets the sync key.
import { KeyError, Library, deriveKeys, openSlot, parseKey, readKeys } from "./sync.js";
import { getPasskeyPrf, passkeysAvailable, cancelled } from "./passkey.js";
import { GRANT_DAYS, SCOPES, allowedClient, parseScopes } from "./grants.js";

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const back = (() => {
  try {
    const url = new URL(params.get("return") ?? "");
    return allowedClient(url.href) ? url : null;
  } catch {
    return null;
  }
})();
const state = (params.get("state") ?? "").slice(0, 128);
const scopes = parseScopes(params.get("scope") ?? "read");
// The query (return address, state) has done its job; keep it out of history.
history.replaceState(null, "", location.pathname);
let chosen = null;

const show = (id) => {
  for (const section of document.querySelectorAll("main > section")) section.hidden = section.id !== id;
};

function finish(fields) {
  const url = new URL(back);
  url.hash = new URLSearchParams({ ...fields, state }).toString();
  location.replace(url.href);
}

function ask(keyText, name) {
  chosen = { keyText, name };
  $("#consent-lib").textContent = name;
  $("#consent-scopes").replaceChildren(...scopes.map((s) => Object.assign(document.createElement("li"), { textContent: SCOPES[s].label })));
  $("#consent-days").textContent = String(GRANT_DAYS);
  show("consent");
}

if (!back || !scopes || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) {
  show("bad");
} else {
  document.querySelectorAll(".app-name").forEach((el) => (el.textContent = back.host));
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

$("#allow").addEventListener("click", async () => {
  $("#allow").disabled = true;
  try {
    const key = await parseKey(chosen.keyText);
    const keys = await deriveKeys(key);
    const res = await fetch(`/v1/grant/${keys.lib}`, {
      method: "POST",
      headers: { authorization: `Bearer ${keys.auth}`, "content-type": "application/json" },
      body: JSON.stringify({ scopes, client: back.origin }),
    });
    if (!res.ok) throw new Error(res.status === 404 ? "This library hasn't synced to the server yet." : `Couldn't connect (${res.status}).`);
    const grant = await res.json();
    const { lib, enc } = await readKeys(key);
    finish({ vault: location.origin, lib, rt: grant.token, ek: enc, exp: String(grant.expires), name: chosen.name });
  } catch (error) {
    $("#consent-error").textContent = error.message;
    $("#allow").disabled = false;
  }
});
$("#deny").addEventListener("click", () => finish({ error: "denied" }));
