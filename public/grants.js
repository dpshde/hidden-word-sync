// Grants: what another app may do with a library, shared by the server (src/worker.ts) and the
// consent page (public/connect.js). A grant token starts with "g1." so the server tells it from a
// library's own token without a lookup.

/** Apps that may ask for a grant: exact origins, plus any localhost port for development. */
export const CLIENT_ORIGINS = [
  "https://route.bible",
  // route.bible's Workers Builds preview for this feature's branch.
  "https://vault-highlights-route-bible.dpshade.workers.dev",
];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const GRANT_DAYS = 90;
export const GRANT_TOKEN = /^g1\.[A-Za-z0-9_-]{43}$/;

/**
 * Each scope and what it lets a grant token do on /v1/lib/:lib. Only "read" exists in v1.
 * A later "highlights:add" would be { methods: ["POST"], createOnly: true }: new records only,
 * never an update or a delete (the server checks the ids aren't in the library yet).
 */
export const SCOPES = {
  read: { methods: ["GET"], label: "See your highlights, notes, and colors" },
};

/** The origin of `raw` when it's an allowed app, else null. */
export function allowedClient(raw) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url.origin;
    return url.protocol === "https:" && CLIENT_ORIGINS.includes(url.origin) ? url.origin : null;
  } catch {
    return null;
  }
}

/** The scopes as a list, or null when any is unknown or the list is empty. */
export function parseScopes(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/\s+/).filter(Boolean);
  if (!list.length || list.some((s) => typeof s !== "string" || !Object.hasOwn(SCOPES, s))) return null;
  return [...new Set(list)].sort();
}

/** Whether a grant with these scopes may make this request. */
export function grantAllows(scopes, method) {
  return scopes.some((s) => SCOPES[s]?.methods.includes(method) && !SCOPES[s].createOnly);
}
