// What the Worker writes to Cloudflare's logs: one line per request with its route, status, time
// and, for a failure, the error's class and a scrubbed message. Never a header, a body, a query
// string, a library or slot id, or a sync key: routes are logged as templates (/v1/lib/:lib), and
// anything free-form goes through scrub() first. Cloudflare's own invocation logs are off for the
// same reason (cloudflare.config.ts), so these lines are the whole record. docs/observability.md
// says where to read them.

import { reportFor as reportForJs, scrub as scrubJs } from "../public/report.js";

export const scrub = scrubJs as (text: unknown, max?: number) => string;
const reportFor = reportForJs as unknown as (event: Record<string, unknown>, where: { origin: string; pathname: string }) => Record<string, string | number>;

/** A fact about this request for its log line. Values are fixed words or numbers, never input. */
export type Note = (fields: Record<string, string | number | boolean>) => void;
export const noNote: Note = () => {};

type Log = Pick<Console, "log" | "error">;

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]);

/** The route a path belongs to, with ids left out. */
export function routeOf(pathname: string): string {
  if (["/mcp", "/save", "/config.json", "/api/client-error"].includes(pathname)) return pathname;
  const m = /^\/v1\/(lib|slot)\/[^/]*$/.exec(pathname);
  if (m) return `/v1/${m[1]}/:${m[1]}`;
  return pathname.startsWith("/v1/") ? "/v1/other" : "other";
}

/** An error as log fields: its class, and its message scrubbed. Never its stack's values. */
export function errorFields(error: unknown): { error_class: string; error: string } {
  const name = error instanceof Error ? error.name : typeof error;
  return { error_class: /^[A-Za-z]{1,40}$/.test(name) ? name : "Error", error: scrub(error instanceof Error ? error.message : "", 200) };
}

/** Runs one request and writes its log line, whatever happens. */
export async function observe(request: Request, run: (note: Note) => Promise<Response>, log: Log = console): Promise<Response> {
  const started = Date.now();
  const fields: Record<string, string | number | boolean> = {};
  const note: Note = (more) => Object.assign(fields, more);
  let status = 500;
  try {
    const response = await run(note);
    status = response.status;
    return response;
  } catch (error) {
    note(errorFields(error));
    throw error;
  } finally {
    const line = {
      event: "request",
      method: METHODS.has(request.method) ? request.method : "OTHER",
      route: routeOf(new URL(request.url).pathname),
      status,
      ms: Date.now() - started,
      ...fields,
    };
    (status >= 500 ? log.error : log.log)(JSON.stringify(line));
  }
}

// ---- browser error reports (public/report.js)

const PAGES = new Set(["/", "/index.html", "/unlock.html", "/save"]);
export const CLIENT_ERROR_LIMITS = { bodyBytes: 4_096, perMinute: 30 } as const;

/**
 * POST /api/client-error. Same-origin only, small, and capped per Worker instance, so a flood can't
 * run up the log bill. Every field is rebuilt and scrubbed here: the browser's copy isn't trusted.
 */
export function clientErrors({ perMinute = CLIENT_ERROR_LIMITS.perMinute, now = Date.now, log = console as Log } = {}) {
  let windowStart = 0;
  let count = 0;
  const empty = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });
  return async (request: Request, note: Note = noNote): Promise<Response> => {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return empty(403);
    if (Number(request.headers.get("content-length") ?? "0") > CLIENT_ERROR_LIMITS.bodyBytes) return empty(413);
    const text = await request.text();
    if (text.length > CLIENT_ERROR_LIMITS.bodyBytes) return empty(413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch {
      return empty(400);
    }
    const t = now();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      count = 0;
    }
    if (++count > perMinute) {
      note({ dropped: true });
      return empty(429);
    }
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const report = reportFor(
      {
        kind: body.kind,
        error: { name: str(body.name), message: str(body.message), stack: "" },
        filename: str(body.source),
        lineno: body.line,
        colno: body.col,
      },
      { origin: url.origin, pathname: PAGES.has(str(body.page)) ? str(body.page) : "other" },
    );
    // The stack arrives as "path:line:col" frames; keep only that shape.
    const stack = str(body.stack).split(" ").filter((f) => /^(\/[\w./-]{0,80}|external):\d{1,7}:\d{1,7}$/.test(f)).slice(0, 6).join(" ");
    log.error(JSON.stringify({ event: "client_error", ...report, stack }));
    return empty(204);
  };
}
