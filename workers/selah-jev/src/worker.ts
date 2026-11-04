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
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

// Keep aligned with public/relevance.js (INSTRUCTIONS / REASONS).
const INSTRUCTIONS = [
  "You are ranking a person's Bible highlights against one input passage.",
  "For each highlight id in `highlights`, judge only that highlight against `passage`.",
  "relevant: does the highlight speak to the passage's meaning, promise, warning, or call?",
  "reason: pick the one-line reason that best names how a relevant highlight speaks to the passage.",
  "obviousness: how plain the connection is (0 = surprising but sound, 3 = the most obvious link).",
].join(" ");

const REASONS: Record<string, string> = {
  same_theme: "Names the same theme as this passage",
  fulfillment: "Shows what this passage points toward",
  application: "Applies this passage's call",
  parallel: "Says the same thing in other words",
  background: "Gives the background this passage assumes",
  contrast: "Sets this passage in relief by contrast",
};

const OBVIOUSNESS = [
  "Surprising but sound: a real link most readers would miss",
  "Not obvious: takes a careful reading to see",
  "Clear: a careful reader would usually notice",
  "Obvious: the connection is plain on the surface",
];

type Passage = { ref: string; text: string };
type Highlight = { id: string; ref: string; text: string };
export type RelevanceBody = { lib: string; passage: Passage; highlights: Highlight[] };

function cors(origin: string | null): HeadersInit {
  const allow = origin && VAULT_ORIGINS.has(origin) ? origin : "https://vault.selah.tools";
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

/** Instructions once in state; one relevant + reason + obviousness question per highlight id. */
export function toSystemOne(body: RelevanceBody) {
  const questions: Record<string, unknown> = {};
  for (const h of body.highlights) {
    questions[`${h.id}_relevant`] = {
      type: "noul",
      instructions: `Is highlight \`${h.id}\` relevant to the passage?`,
    };
    questions[`${h.id}_reason`] = {
      type: "choice",
      instructions: `If highlight \`${h.id}\` is relevant, which one-line reason fits best?`,
      criteria: { ...REASONS },
    };
    questions[`${h.id}_obviousness`] = {
      type: "score",
      instructions: `How obvious is the link between highlight \`${h.id}\` and the passage?`,
      criteria: [...OBVIOUSNESS],
    };
  }
  return {
    model: MODEL,
    state: {
      instructions: INSTRUCTIONS,
      passage: body.passage,
      highlights: body.highlights.map((h) => `${h.id} · ${h.ref} · ${h.text}`),
    },
    questions,
  };
}

export function usdFromUsage(usage: { input_tokens?: number; usd?: number } | undefined): number {
  if (usage && typeof usage.usd === "number" && Number.isFinite(usage.usd)) return usage.usd;
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
    if (origin && !VAULT_ORIGINS.has(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (request.method !== "POST") return fail(405, "POST only", origin);
  if (origin && !VAULT_ORIGINS.has(origin)) return fail(403, "origin not allowed", origin);

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

  if (!env.TYPESAFE_API_KEY) return fail(503, "jev unavailable", origin);

  const upstream = await upstreamFetch(UPSTREAM, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(toSystemOne(parsed.body)),
  });
  const text = await upstream.text();
  let data: { answers?: unknown; usage?: { input_tokens?: number; usd?: number }; model?: string; usd?: number };
  try {
    data = JSON.parse(text);
  } catch {
    return fail(502, "bad upstream", origin);
  }
  if (!upstream.ok) return fail(upstream.status === 429 ? 429 : 502, "upstream error", origin);

  const usd = usdFromUsage(data.usage ?? { usd: data.usd });
  await env.CAPS.put(dayKey(), String(spent + usd), { expirationTtl: 60 * 60 * 48 });

  return json({ model: data.model ?? MODEL, answers: data.answers ?? {}, usage: data.usage ?? {}, usd }, 200, origin);
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
} satisfies ExportedHandler<Env>;
