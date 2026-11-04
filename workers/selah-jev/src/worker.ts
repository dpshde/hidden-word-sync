// selah-jev: a stateless proxy from the vault client to TypeSafe Jev (jev-latest).
// Accepts only the relevance request shape; never logs the API key; CORS only for the vault.
// Deployed on its own (see wrangler.toml); the hidden-word Worker is untouched.

export interface Env {
  TYPESAFE_API_KEY: string;
  /** Daily spend (usd) and per-library rate counters. */
  CAPS: KVNamespace;
}

const UPSTREAM = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
/** TypeSafe list price: $0.042 per million input tokens; output is free. */
export const USD_PER_MTOK = 0.042;
export const DAILY_CAP_USD = 0.25;
export const MAX_BODY_BYTES = 120_000;
export const MAX_HIGHLIGHTS = 40;
export const RATE_PER_MIN = 12;
export const VAULT_ORIGINS = new Set([
  "https://vault.selah.tools",
  "https://sync.selah.tools",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

/** Preview versions of the vault Worker, e.g. https://1a2b3c4d-hidden-word.dpshade.workers.dev. */
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+-hidden-word\.dpshade\.workers\.dev$/;

export const allowedOrigin = (origin: string | null): boolean =>
  !!origin && (VAULT_ORIGINS.has(origin) || PREVIEW_ORIGIN.test(origin));

// Labels are kept aligned with REASONS in public/relevance.js, which shows the chosen one under the row.
const TASK =
  "A person highlighted these Bible passages and wants to know which of them speak to `passage`. " +
  "A highlight speaks to it when it shares the passage's teaching, promise, warning, call or story, " +
  "including a real link across books or testaments (a promise and its fulfillment, the same theme in other words). " +
  "Sharing a word or image without sharing the meaning does not count.";

export const REASONS: Record<string, string> = {
  same_theme: "Same theme",
  same_promise: "Shared promise",
  fulfillment: "Promise and fulfillment",
  same_argument: "Same author's argument",
  same_call: "Same call to act",
  contrast: "Contrast that sharpens it",
  none: "No real link",
};

const OBVIOUSNESS = [
  "Hidden: a sound link few readers would see without having it pointed out, usually across books, genres or testaments with no shared words.",
  "Not obvious: the link is real but takes a careful, thoughtful reading to notice.",
  "Clear: a careful reader of both would usually notice the link, such as a well-known cross-reference.",
  "Plain: the link is on the surface, such as the same chapter, the same words, or a direct quotation.",
];

type Passage = { ref: string; text: string };
type Highlight = { id: string; ref: string; text: string };
export type RelevanceBody = { lib: string; passage: Passage; highlights: Highlight[] };

function cors(origin: string | null): HeadersInit {
  const allow = allowedOrigin(origin) ? origin : "https://vault.selah.tools";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "content-type": "application/json", "cache-control": "no-store" },
  });
}

const fail = (status: number, error: string, origin: string | null) => json({ error }, status, origin);

/** Reject anything that isn't the relevance shape the client sends. */
export function parseRelevanceBody(raw: unknown): { ok: true; body: RelevanceBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "body must be a JSON object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.lib !== "string" || !o.lib || o.lib.length > 128) return { ok: false, error: "lib is required" };
  const passage = o.passage as Record<string, unknown> | null;
  if (!passage || typeof passage.ref !== "string" || typeof passage.text !== "string") {
    return { ok: false, error: "passage.ref and passage.text are required" };
  }
  if (!Array.isArray(o.highlights)) return { ok: false, error: "highlights must be an array" };
  if (o.highlights.length === 0) return { ok: false, error: "highlights is empty" };
  if (o.highlights.length > MAX_HIGHLIGHTS) return { ok: false, error: `at most ${MAX_HIGHLIGHTS} highlights` };
  const highlights: Highlight[] = [];
  for (const h of o.highlights) {
    if (!h || typeof h !== "object") return { ok: false, error: "each highlight needs id, ref, text" };
    const row = h as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.ref !== "string" || typeof row.text !== "string") {
      return { ok: false, error: "each highlight needs id, ref, text" };
    }
    if (!row.id || row.id.length > 128) return { ok: false, error: "highlight id is too long" };
    highlights.push({ id: row.id, ref: row.ref, text: row.text });
  }
  for (const key of Object.keys(o)) {
    if (!["lib", "passage", "highlights"].includes(key)) return { ok: false, error: `unknown field ${key}` };
  }
  return { ok: true, body: { lib: o.lib, passage: { ref: passage.ref, text: passage.text }, highlights } };
}

/**
 * One request per batch: shared context in state, three self-contained questions per highlight that
 * name it by its path (`highlights.h0`). Question ids are for code only; answers come back under them.
 */
export function toSystemOne(body: RelevanceBody) {
  const highlights: Record<string, { reference: string; text: string }> = {};
  const questions: Record<string, unknown> = {};
  body.highlights.forEach((h, i) => {
    const key = `h${i}`, path = `\`highlights.${key}\``;
    highlights[key] = { reference: h.ref, text: h.text };
    questions[`${h.id}_relevant`] = {
      type: "noul",
      instructions: `Following \`task\`, does the highlighted text ${path} speak to \`passage\`? Judge by both texts, not by their references alone.`,
      criteria: {
        true: "The highlight shares the passage's teaching, promise, warning, call or story, even if it is in another book.",
        false: "The highlight is about something else, or shares only a word or image with the passage.",
      },
    };
    questions[`${h.id}_reason`] = {
      type: "choice",
      instructions: `Which best names how the highlighted text ${path} relates to \`passage\`?`,
      criteria: {
        same_theme: "It teaches the same theme or truth in other words.",
        same_promise: "It makes or rests on the same promise of God.",
        fulfillment: "One looks ahead to what the other shows fulfilled.",
        same_argument: "It is part of the same author's line of argument.",
        same_call: "It gives the same command, warning or call to respond.",
        contrast: "It shows the other side, so each makes the other clearer.",
        none: "There is no real link in meaning.",
      },
    };
    questions[`${h.id}_obviousness`] = {
      type: "score",
      instructions: `How obvious is the link between the highlighted text ${path} and \`passage\` to an ordinary Bible reader?`,
      criteria: [...OBVIOUSNESS],
    };
  });
  return { model: MODEL, state: { task: TASK, passage: { reference: body.passage.ref, text: body.passage.text }, highlights }, questions };
}

/** TypeSafe reports billable `usage.input_tokens`; output tokens are free. */
export function usdFromUsage(usage: { input_tokens?: number } | undefined): number {
  const tokens = usage?.input_tokens ?? 0;
  return (tokens / 1_000_000) * USD_PER_MTOK;
}

function dayKey(now = new Date()) {
  return `spend:${now.toISOString().slice(0, 10)}`;
}

function rateKey(lib: string, now = new Date()) {
  return `rate:${lib}:${now.toISOString().slice(0, 16)}`;
}

/** In-memory stand-in for KV when tests pass a Map-backed binding. */
export function memoryCaps(store = new Map<string, string>()) {
  return {
    store,
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string, _opts?: { expirationTtl?: number }) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

export async function handle(request: Request, env: Env, upstreamFetch: typeof fetch = fetch): Promise<Response> {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    if (origin && !allowedOrigin(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (request.method !== "POST") return fail(405, "POST only", origin);
  if (origin && !allowedOrigin(origin)) return fail(403, "origin not allowed", origin);

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return fail(413, "body too large", origin);
  const rawText = await request.text();
  if (new TextEncoder().encode(rawText).length > MAX_BODY_BYTES) return fail(413, "body too large", origin);

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return fail(400, "invalid JSON", origin);
  }
  const parsed = parseRelevanceBody(raw);
  if (!parsed.ok) return fail(400, parsed.error, origin);

  const spent = Number((await env.CAPS.get(dayKey())) ?? "0");
  if (spent >= DAILY_CAP_USD) return fail(429, "daily spend cap", origin);

  const rk = rateKey(parsed.body.lib);
  const hits = Number((await env.CAPS.get(rk)) ?? "0");
  if (hits >= RATE_PER_MIN) return fail(429, "library rate limit", origin);
  await env.CAPS.put(rk, String(hits + 1), { expirationTtl: 120 });

  const apiKey = String(env.TYPESAFE_API_KEY ?? "").trim();
  if (!apiKey) return fail(503, "jev unavailable", origin);

  let upstream: Response;
  try {
    upstream = await upstreamFetch(UPSTREAM, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(toSystemOne(parsed.body)),
    });
  } catch {
    return fail(502, "upstream error", origin);
  }
  const text = await upstream.text();
  let data: { answers?: unknown; usage?: { input_tokens?: number; output_tokens?: number }; model?: string };
  try {
    data = JSON.parse(text);
  } catch {
    return fail(502, "bad upstream", origin);
  }
  if (!upstream.ok) {
    // Never forward upstream bodies (they can mention auth). Map statuses the UI already knows.
    if (upstream.status === 429 || upstream.status === 529) return fail(429, "upstream rate limit", origin);
    if (upstream.status === 401 || upstream.status === 403) return fail(502, "ranking unavailable", origin);
    return fail(502, "upstream error", origin);
  }

  const usd = usdFromUsage(data.usage);
  await env.CAPS.put(dayKey(), String(spent + usd), { expirationTtl: 60 * 60 * 48 });

  return json({ model: data.model ?? MODEL, answers: data.answers ?? {}, usage: data.usage ?? {}, usd }, 200, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch {
      // Always answer with CORS so the vault never surfaces a raw "Failed to fetch" for Worker crashes.
      return fail(500, "jev unavailable", request.headers.get("origin"));
    }
  },
} satisfies ExportedHandler<Env>;
