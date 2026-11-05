// A classic consent screen: /connect?return=URL&state=…&scope=read[+highlights:write]
// The app gets a grant token (public/grants.js), the library's decryption key, and with a write
// scope its item-id key, all in the return URL's fragment, which the browser never sends to a
// server. It never gets the sync key. Cancel returns #error=access_denied&state=….
import { KeyError, Library, deriveKeys, openSlot, parseKey, readKeys } from "./sync.js";
import { getPasskeyPrf, passkeysAvailable, cancelled } from "./passkey.js";
import { allowedClient, clientInfo, consentLines, parseScopes } from "./grants.js";

const $ = (sel) => document.querySelector(sel);
const SESSION = "hidden-word:session";
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

const ICONS = {
  eye: '<path d="M247.31,124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57,61.26,162.88,48,128,48S61.43,61.26,36.34,86.35C17.51,105.18,9,124,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208s66.57-13.26,91.66-38.34c18.83-18.83,27.3-37.61,27.65-38.4A8,8,0,0,0,247.31,124.76ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.47,133.47,0,0,1,25,128,133.33,133.33,0,0,1,48.07,97.25C70.33,75.19,97.22,64,128,64s57.67,11.19,79.93,33.25A133.46,133.46,0,0,1,231.05,128C223.84,141.46,192.43,192,128,192Zm0-112a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Z"/>',
  bookmark: '<path d="M184,32H72A16,16,0,0,0,56,48V224a8,8,0,0,0,12.24,6.78L128,193.43l59.77,37.35A8,8,0,0,0,200,224V48A16,16,0,0,0,184,32Zm0,177.57-51.77-32.35a8,8,0,0,0-8.48,0L72,209.57V48H184Z"/>',
  lock: '<path d="M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z"/>',
  clock: '<path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z"/>',
  check: '<path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a11.32,11.32,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/>',
  x: '<path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/>',
};
const svg = (name, cls = "") => `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">${ICONS[name]}</svg>`;

function show(id) {
  for (const section of document.querySelectorAll("main > section")) section.hidden = section.id !== id;
}
function step(id) {
  $("#step-unlock").hidden = id !== "unlock";
  $("#step-consent").hidden = id !== "consent";
}

function finish(fields) {
  const url = new URL(back);
  url.hash = new URLSearchParams({ ...fields, state }).toString();
  location.replace(url.href);
}

function consent(keyText, name) {
  chosen = { keyText, name };
  $("#account-name").textContent = name;
  $("#account-initial").textContent = (name.trim()[0] || "P").toUpperCase();
  $("#perms").replaceChildren(
    ...consentLines(scopes).map((line) => {
      const li = document.createElement("li");
      li.dataset.ok = String(line.ok);
      li.innerHTML = `${svg(line.icon)}<span></span>${svg(line.ok ? "check" : "x", "oauth-mark")}`;
      li.querySelector("span").textContent = line.text;
      return li;
    }),
  );
  $("#consent-error").textContent = "";
  step("consent");
}

if (!back || !scopes || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) {
  show("bad");
} else {
  const app = clientInfo(back.origin);
  document.querySelectorAll(".app-name").forEach((el) => (el.textContent = app.name));
  $("#app-origin").textContent = back.origin;
  if (app.icon) {
    const img = Object.assign(document.createElement("img"), { src: app.icon, alt: "", width: 48, height: 48 });
    $("#app-logo").append(img);
  } else {
    $("#app-logo").innerHTML = `<span class="oauth-letter">${app.name[0]}</span>`;
  }
  document.title = `${app.name} · Allow access · Selah Vault`;
  show("card");
  const session = JSON.parse(localStorage.getItem(SESSION) ?? "null");
  if (session?.key) consent(session.key, session.name || "Personal");
  else step("unlock");
  if (!passkeysAvailable()) {
    $("#passkey-unlock").hidden = true;
    $("#key-details").open = true;
  }
}

$("#switch").addEventListener("click", () => {
  chosen = null;
  step("unlock");
});

$("#unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    const library = await Library.open({ keyText: form.get("password") });
    consent(library.keyText, form.get("username").trim() || "Personal");
  } catch (error) {
    $("#unlock-error").textContent = error instanceof KeyError ? "That sync key has a typo." : error.message;
  }
});

$("#passkey-unlock").addEventListener("click", async () => {
  try {
    const slot = await openSlot({ prf: await getPasskeyPrf() });
    if (slot) consent(slot.key, slot.name);
    else $("#unlock-error").textContent = "That passkey isn't linked to a library yet.";
  } catch (error) {
    if (!cancelled(error)) $("#unlock-error").textContent = error.message;
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
    const { lib, enc, mac } = await readKeys(key);
    const fields = { vault: location.origin, lib, rt: grant.token, ek: enc, exp: String(grant.expires), name: chosen.name, scope: grant.scopes.join(" ") };
    if (grant.scopes.includes("highlights:write")) fields.mk = mac;
    finish(fields);
  } catch (error) {
    $("#consent-error").textContent = error.message;
    $("#allow").disabled = false;
  }
});
$("#deny").addEventListener("click", () => finish({ error: "access_denied" }));
/* asset-rev 2 */
