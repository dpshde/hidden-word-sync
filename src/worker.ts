// Hidden Word server (spec v0.2): a blind store of encrypted blobs. It never sees verses, notes,
// names or keys, only random-looking ids, ciphertext, and SHA-256 hashes of bearer tokens.

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  /** YouVersion Platform public app key, for verse text in the web app. A Worker secret, so it stays out of git. */
  YVP_PUBLIC_APP_KEY?: string;
}

type Item = { seq: number; id: string; blob: string };

const HEX32 = /^[0-9a-f]{32}$/;
const ITEM_ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

export const LIMITS = {
  itemsPerPost: 100,
  pageSize: 500,
  // 16 KiB of padded plaintext + nonce + tag, as base64url.
  blobChars: 21_900,
  // Smallest blob: 256 bytes of plaintext + nonce + tag.
  minBlobChars: 379,
  libraryChars: 8_000_000,
  wrappedChars: 2_000,
  bodyBytes: 2_400_000,
} as const;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });
}

const empty = (status = 204) => new Response(null, { status, headers: { ...CORS, "cache-control": "no-store" } });
const fail = (status: number, error: string) => json({ error }, status);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      console.error(JSON.stringify({ message: "request failed", error: String(error) }));
      return fail(500, "server error");
    }
  },
} satisfies ExportedHandler<Env>;

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // /save?ref=…&color=… is the web app's: it saves into the library unlocked in the browser.
  if (url.pathname === "/save" && env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
    return env.ASSETS.fetch(new Request(new URL("/", url), request));
  }
  // Web app settings that shouldn't live in a public repo. The key is public by design (it reaches the
  // browser either way); serving it from here keeps it out of git. No key: the app shows no verse text.
  if (url.pathname === "/config.json" && (request.method === "GET" || request.method === "HEAD")) {
    return json({ yvpPublicAppKey: env.YVP_PUBLIC_APP_KEY || null });
  }
  const parts = url.pathname.split("/");
  if (parts[1] !== "v1") return fail(404, "not found");
  if (request.method === "OPTIONS") return empty();
  if (parts.length !== 4 || !HEX32.test(parts[3])) return fail(404, "not found");
  const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token || !TOKEN.test(token)) return fail(401, "missing or malformed bearer token");
  const tokenHash = await sha256Hex(token);
  if (parts[2] === "lib") return library(request, env.DB, parts[3], tokenHash);
  if (parts[2] === "slot") return slot(request, env.DB, parts[3], tokenHash);
  return fail(404, "not found");
}

/** `?limit=` for a page of items: clamped to 1..pageSize; missing or not a number means pageSize. */
export function pageLimit(text: string | null): number {
  const n = text === null || text.trim() === "" ? NaN : Math.trunc(Number(text));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), LIMITS.pageSize) : LIMITS.pageSize;
}

// Each route is one D1 batch: one round trip to the database, run as one transaction.

async function library(request: Request, db: D1Database, lib: string, tokenHash: string): Promise<Response> {
  switch (request.method) {
    case "GET": {
      const query = new URL(request.url).searchParams;
      const after = Number(query.get("after") ?? "0");
      if (!Number.isSafeInteger(after) || after < 0) return fail(400, "after must be a non-negative integer");
      const limit = pageLimit(query.get("limit"));
      const [libs, items] = await db.batch([
        db.prepare("SELECT auth_hash, seq, epoch FROM libs WHERE lib = ?").bind(lib),
        // Only for the right token: a wrong one never reads a blob.
        db
          .prepare(
            `SELECT seq, id, blob FROM items WHERE lib = ?1 AND seq > ?2
             AND EXISTS (SELECT 1 FROM libs WHERE lib = ?1 AND auth_hash = ?3) ORDER BY seq LIMIT ?4`,
          )
          .bind(lib, after, tokenHash, limit + 1),
      ]);
      const row = libs.results[0] as { auth_hash: string; seq: number; epoch: string } | undefined;
      if (!row) return json({ items: [], more: false, seq: 0, epoch: null });
      if (row.auth_hash !== tokenHash) return fail(401, "wrong token for this library");
      const results = items.results as Item[];
      return json({ items: results.slice(0, limit), more: results.length > limit, seq: row.seq, epoch: row.epoch });
    }
    case "POST":
      return post(request, db, lib, tokenHash);
    case "DELETE": {
      const [libs] = await db.batch([
        db.prepare("SELECT auth_hash FROM libs WHERE lib = ?").bind(lib),
        db.prepare("DELETE FROM items WHERE lib = ?1 AND EXISTS (SELECT 1 FROM libs WHERE lib = ?1 AND auth_hash = ?2)").bind(lib, tokenHash),
        db.prepare("DELETE FROM libs WHERE lib = ? AND auth_hash = ?").bind(lib, tokenHash),
      ]);
      const row = libs.results[0] as { auth_hash: string } | undefined;
      return row && row.auth_hash !== tokenHash ? fail(401, "wrong token for this library") : empty();
    }
    default:
      return fail(405, "method not allowed");
  }
}

// What the library's size would be after this write: its size now, plus the new blobs, minus the
// blobs they replace. ?1 lib, ?3 characters added, ?4 the ids being written as a JSON list.
const SIZE_AFTER = `size + ?3 - (SELECT COALESCE(SUM(LENGTH(blob)), 0) FROM items WHERE lib = ?1 AND id IN (SELECT value FROM json_each(?4)))`;

async function post(request: Request, db: D1Database, lib: string, tokenHash: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const items = parseItems(body);
  if (typeof items === "string") return fail(400, items);
  const n = items.length;
  const adding = items.reduce((total, item) => total + item.blob.length, 0);
  const ids = JSON.stringify(items.map((item) => item.id));

  // One transaction. The first write claims the library for this token. Then reserve n sequence
  // numbers and write each item with its own, so readers never see a later seq before an earlier
  // one and `after` cursors skip nothing. A wrong token or a full library sets a NOT NULL column
  // to NULL, which fails the batch and rolls all of it back, claim included.
  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare("INSERT INTO libs (lib, auth_hash, seq, epoch, size) VALUES (?, ?, 0, ?, 0) ON CONFLICT(lib) DO NOTHING")
        .bind(lib, tokenHash, newEpoch()),
      db
        .prepare(
          `UPDATE libs SET seq = CASE WHEN auth_hash = ?2 THEN seq + ?5 END,
             size = CASE WHEN ${SIZE_AFTER} <= ?6 THEN ${SIZE_AFTER} END
           WHERE lib = ?1`,
        )
        .bind(lib, tokenHash, adding, ids, n, LIMITS.libraryChars),
      ...items.map((item, i) =>
        db
          .prepare(
            `INSERT INTO items (lib, id, seq, blob) VALUES (?1, ?2, (SELECT seq FROM libs WHERE lib = ?1) - ?3, ?4)
             ON CONFLICT(lib, id) DO UPDATE SET seq = excluded.seq, blob = excluded.blob`,
          )
          .bind(lib, item.id, n - 1 - i, item.blob),
      ),
      db.prepare("SELECT seq, epoch FROM libs WHERE lib = ?").bind(lib),
    ]);
  } catch (error) {
    // Only failures pay for a second round trip, to say which it was.
    const row = await db
      .prepare(`SELECT auth_hash = ?2 AS mine, ${SIZE_AFTER} AS after FROM libs WHERE lib = ?1`)
      .bind(lib, tokenHash, adding, ids)
      .first<{ mine: number; after: number }>();
    if (row && !row.mine) return fail(401, "wrong token for this library");
    if ((row?.after ?? adding) > LIMITS.libraryChars) return fail(413, "library is full");
    throw error;
  }
  const last = results[results.length - 1].results[0] as { seq: number; epoch: string };
  return json({ seq: last.seq, epoch: last.epoch });
}

async function slot(request: Request, db: D1Database, id: string, tokenHash: string): Promise<Response> {
  const row = await db
    .prepare("SELECT auth_hash, wrapped FROM slots WHERE slot = ?")
    .bind(id)
    .first<{ auth_hash: string; wrapped: string }>();
  if (row && row.auth_hash !== tokenHash) return fail(401, "wrong token for this slot");
  switch (request.method) {
    case "GET":
      return row ? json({ wrapped: row.wrapped }) : fail(404, "no such slot");
    case "PUT": {
      const body = await readJson(request);
      if (body instanceof Response) return body;
      const wrapped = (body as { wrapped?: unknown })?.wrapped;
      if (typeof wrapped !== "string" || !B64URL.test(wrapped) || wrapped.length > LIMITS.wrappedChars || wrapped.length < 38) {
        return fail(400, "wrapped must be base64url");
      }
      const [, saved] = await db.batch([
        db
          .prepare(
            `INSERT INTO slots (slot, auth_hash, wrapped) VALUES (?, ?, ?)
             ON CONFLICT(slot) DO UPDATE SET wrapped = excluded.wrapped WHERE slots.auth_hash = excluded.auth_hash`,
          )
          .bind(id, tokenHash, wrapped),
        db.prepare("SELECT auth_hash FROM slots WHERE slot = ?").bind(id),
      ]);
      return (saved.results[0] as { auth_hash: string } | undefined)?.auth_hash === tokenHash ? empty() : fail(401, "wrong token for this slot");
    }
    case "DELETE":
      if (row) await db.prepare("DELETE FROM slots WHERE slot = ?").bind(id).run();
      return empty();
    default:
      return fail(405, "method not allowed");
  }
}

async function readJson(request: Request): Promise<unknown | Response> {
  if (Number(request.headers.get("content-length") ?? "0") > LIMITS.bodyBytes) return fail(413, "body too large");
  const text = await request.text();
  if (text.length > LIMITS.bodyBytes) return fail(413, "body too large");
  try {
    return JSON.parse(text);
  } catch {
    return fail(400, "body must be JSON");
  }
}

export function parseItems(body: unknown): Array<{ id: string; blob: string }> | string {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length === 0) return "items must be a non-empty list";
  if (items.length > LIMITS.itemsPerPost) return `at most ${LIMITS.itemsPerPost} items per request`;
  // The same id twice in one request: the later one wins, as if sent separately.
  const byId = new Map<string, string>();
  for (const item of items) {
    const { id, blob } = (item ?? {}) as { id?: unknown; blob?: unknown };
    if (typeof id !== "string" || !ITEM_ID.test(id)) return "every item needs a 22-character base64url id";
    if (typeof blob !== "string" || !B64URL.test(blob)) return "every item needs a base64url blob";
    if (blob.length < LIMITS.minBlobChars || blob.length > LIMITS.blobChars) return "blob size out of range";
    byId.delete(id);
    byId.set(id, blob);
  }
  return [...byId].map(([id, blob]) => ({ id, blob }));
}

function newEpoch(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
