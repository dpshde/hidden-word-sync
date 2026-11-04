// Selah Vault's MCP server: Streamable HTTP, stateless, JSON-RPC over POST at /mcp. It opens the
// caller's library with their sync key for one request, using the reference client (public/sync.js)
// so reads and writes follow SPEC.md exactly, and syncs through the same routes every device uses.
//
// The sync key reaches this Worker in memory for the request and nowhere else: it is never stored,
// logged, echoed, or put in an error. Every failure below answers with a fixed message.

import { Library, memoryStore, palette, serverTransport as server, topColor } from "../../public/sync.js";
import { BOOKS as books, compareRefs, groupRuns, highlightRecord, labelRef, splitRef } from "../../public/refs.js";
import { readPassage as read } from "../../public/passage.js";
import { type Note, noNote } from "../observe";

// The shared modules are plain JavaScript; these are the shapes they take and return.
const serverTransport = server as (options: { url?: string; fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }) => ReturnType<typeof server>;
const BOOKS = books as Array<[code: string, name: string, chapters: number]>;
const readPassage = read as (text: string) => { verses: string[]; label: string; error?: undefined } | { error: string; verses?: undefined; label?: undefined };

/** Stands in for `fetch` to the sync routes: the router's own handler, with no network in between. */
export type SyncFetch = (request: Request) => Promise<Response>;

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
// name stays "hidden-word": clients and their configs know the server by it (decisions/rename-product-to-selah-vault.md).
const SERVER_INFO = { name: "hidden-word", title: "Selah Vault", version: "0.2.0" };
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, x-hidden-word-key",
  "access-control-max-age": "86400",
};
const BAD_KEY = "Missing or invalid sync key. Send it as Authorization: Bearer <sync key>.";
const MAX_BODY = 64_000;

type Json = Record<string, unknown>;
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json };

const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
const rpcError = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** The sync key from `Authorization: Bearer …` or `X-Hidden-Word-Key`, unparsed. */
function keyFrom(request: Request): string | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  return (bearer ?? request.headers.get("x-hidden-word-key") ?? "").trim() || null;
}

const METHODS = new Set(["initialize", "ping", "tools/list", "tools/call"]);

/** `note` gets what the request log line may say: methods, tool names and outcomes, all fixed words. */
export async function mcp(request: Request, syncFetch: SyncFetch, note: Note = noNote): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  // Stateless: no server-to-client stream to open, and no session to end.
  if (request.method !== "POST") return reply(rpcError(null, -32000, "Method not allowed"), 405, { allow: "POST, OPTIONS" });

  const text = await request.text();
  if (text.length > MAX_BODY) return reply(rpcError(null, -32600, "Request too large"), 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(rpcError(null, -32700, "Parse error"), 400);
  }
  const messages = (Array.isArray(body) ? body : [body]) as Rpc[];
  if (!messages.length || messages.some((m) => !m || typeof m !== "object" || typeof m.method !== "string")) {
    return reply(rpcError(null, -32600, "Invalid request"), 400);
  }

  // Every request needs the key, the handshake included, so a client finds out at once.
  let library: Library;
  try {
    const keyText = keyFrom(request);
    if (!keyText) throw new Error();
    library = await Library.open({ keyText, store: memoryStore() });
  } catch {
    note({ mcp: "bad_key" });
    return reply(rpcError(messages[0]?.id, -32001, BAD_KEY), 401, { "www-authenticate": 'Bearer realm="hidden-word"' });
  }

  const session = new Session(library, syncFetch);
  const answers = [];
  for (const m of messages) {
    const answer = await session.answer(m);
    if (answer) answers.push(answer);
  }
  const method = (m: Rpc) => (METHODS.has(m.method as string) ? m.method as string : (m.method as string).startsWith("notifications/") ? "notification" : "other");
  note({ mcp: "ok", mcp_methods: messages.map(method).join(","), ...session.outcome });
  // Only notifications: nothing to say.
  if (!answers.length) return new Response(null, { status: 202, headers: CORS });
  return reply(Array.isArray(body) ? answers : answers[0]);
}

// ---- tools

const COLOR = { type: "string", description: "A color id (yellow, green, blue, pink, purple, orange, or a library's own id) or a name the library gave a color, like \"Prayer\"." };
const REFERENCE = { type: "string", description: "A Bible reference in any common form: \"John 3:16\", \"Rom 5:3-5\", \"Psalm 23\", \"JHN.3.16-18\", or a bible.com or route.bible link." };

export const TOOLS = [
  {
    name: "list_highlights",
    description: "List the library's highlights in canonical order. Back-to-back verses in one color come as one passage, like Romans 5:3–5.",
    inputSchema: { type: "object", properties: { color: COLOR }, additionalProperties: false },
  },
  {
    name: "find_highlights",
    description: "Find highlights inside a passage (\"Romans 5\", \"John 3:1-21\") or a whole book (book: \"Romans\").",
    inputSchema: {
      type: "object",
      properties: { reference: REFERENCE, book: { type: "string", description: "A book name or USFM code, like \"Romans\" or \"ROM\"." } },
      additionalProperties: false,
    },
  },
  {
    name: "add_highlight",
    description: "Highlight every verse a reference covers, in one color (yellow when none is given). Verses already highlighted take the new color.",
    inputSchema: { type: "object", properties: { reference: REFERENCE, color: COLOR }, required: ["reference"], additionalProperties: false },
  },
  {
    name: "set_highlight_color",
    description: "Recolor the highlighted verses inside a reference. Verses that aren't highlighted stay that way.",
    inputSchema: { type: "object", properties: { reference: REFERENCE, color: COLOR }, required: ["reference", "color"], additionalProperties: false },
  },
  {
    name: "delete_highlight",
    description: "Remove the highlights on every verse a reference covers. Other devices remove them when they next sync.",
    inputSchema: { type: "object", properties: { reference: REFERENCE }, required: ["reference"], additionalProperties: false },
  },
  {
    name: "list_colors",
    description: "List the library's colors (the six built in, then its own), with the name each was given and how many verses use it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_library_info",
    description: "The library's name (null until one has synced), and counts of what it holds: highlighted verses, passages, notes and colors.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_passage_link",
    description: "A route.bible link that opens a reference in the reader's preferred Bible app. Reads nothing from the library.",
    inputSchema: { type: "object", properties: { reference: REFERENCE }, required: ["reference"], additionalProperties: false },
  },
] as const;

/** A mistake in what the caller asked for: its message goes back as the tool's answer. */
class Refusal extends Error {}

type Rec = { kind: string; ref: string; highlights: Array<Json & { color: string }>; [k: string]: unknown };

const link = (ref: string) => `https://route.bible/${ref.toLowerCase()}`;

class Session {
  synced = false;
  /** For the log line: tools called and how they ended, as fixed words. */
  outcome: Record<string, string> = {};
  constructor(readonly library: Library, readonly syncFetch: SyncFetch) {}

  async answer(m: Rpc): Promise<Json | null> {
    const notification = m.id === undefined || m.id === null;
    try {
      const result = await this.dispatch(m.method as string, m.params ?? {});
      return notification ? null : { jsonrpc: "2.0", id: m.id, result };
    } catch (error) {
      if (notification) return null;
      if (error instanceof RpcFault) return rpcError(m.id, error.code, error.message);
      this.outcome.mcp_error_class = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
      return rpcError(m.id, -32603, "Internal error");
    }
  }

  async dispatch(method: string, params: Json): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = String(params.protocolVersion ?? "");
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: "Tools for one Selah Vault library of Bible highlights, opened with its sync key. References are USFM (JHN.3.16) underneath; give them in any common form.",
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        return this.call(String(params.name ?? ""), (params.arguments ?? {}) as Json);
      default:
        if (method.startsWith("notifications/")) return {};
        throw new RpcFault(-32601, "Method not found");
    }
  }

  async call(name: string, args: Json) {
    if (!TOOLS.some((t) => t.name === name)) throw new RpcFault(-32602, `Unknown tool: ${name}`);
    this.outcome.tools = this.outcome.tools ? `${this.outcome.tools},${name}` : name;
    try {
      const result = await this.run(name, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false };
    } catch (error) {
      this.outcome.tool_result = error instanceof Refusal ? "refused" : "failed";
      if (!(error instanceof Refusal)) this.outcome.mcp_error_class = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
      // Answers never repeat what the caller sent, which could be anything (a pasted key, even).
      const sent = Object.values(args).map(String).filter((v) => v.length >= 6);
      const message =
        error instanceof Refusal && !sent.some((v) => error.message.includes(v)) ? error.message
        : error instanceof Refusal ? "That request couldn't be read." : "The library couldn't be reached. Try again.";
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  /** Reads the library from the server, once per request. */
  async open() {
    if (this.synced) return;
    const transport = serverTransport({ fetch: (input: RequestInfo | URL, init?: RequestInit) => this.syncFetch(new Request(new URL(String(input), "https://hidden-word.internal"), init)) });
    await this.library.use([transport]);
    this.check();
    this.synced = true;
  }

  /** The last sync's outcome: a failure becomes the tool's fixed error, never the server's words. */
  check() {
    const state = this.library.status.remotes ? Object.values(this.library.status.remotes as Record<string, { state: string }>) : [];
    if (state.some((r) => r.state !== "synced")) throw new Error("sync failed");
  }

  async save(records: Json[]) {
    if (!records.length) return;
    await this.library.putMany(records);
    await this.library.sync();
    this.check();
  }

  get colors() {
    return palette(this.library.all("color"));
  }

  colorName(id: string) {
    const c = this.colors.find((x) => x.id === id);
    return c?.name || (c?.builtIn ? id[0].toUpperCase() + id.slice(1) : id);
  }

  /** A color by id or by name; a mistake says which colors there are. */
  color(wanted: unknown, fallback?: string): string {
    if (wanted === undefined || wanted === null || wanted === "") {
      if (fallback) return fallback;
      throw new Refusal("Give a color.");
    }
    const w = String(wanted).trim().toLowerCase();
    const found = this.colors.find((c) => c.id === w) ?? this.colors.find((c) => this.colorName(c.id).toLowerCase() === w);
    if (!found) throw new Refusal(`That isn't one of the library's colors: ${this.colors.map((c) => this.colorName(c.id)).join(", ")}.`);
    return found.id;
  }

  verses(reference: unknown): { verses: string[]; label: string } {
    const found = readPassage(String(reference ?? ""));
    if (found.error !== undefined) throw new Refusal(found.error);
    return found;
  }

  highlights(): Rec[] {
    return (this.library.all("highlight") as Rec[]).sort((a, b) => compareRefs(a.ref, b.ref));
  }

  /** Records as the app lists them: runs of back-to-back verses in one color. */
  runs(records: Rec[]) {
    const ids = this.colors.map((c) => c.id);
    return groupRuns(records, (r: Rec) => topColor(r, ids)).map(({ ref, records: rs }: { ref: string; records: Rec[] }) => {
      const color = topColor(rs[0], ids);
      return { reference: labelRef(ref), ref, color, colorName: this.colorName(color), verses: rs.map((r) => r.ref), link: link(ref) };
    });
  }

  async run(name: string, args: Json): Promise<Json> {
    if (name === "get_passage_link") {
      const { verses, label } = this.verses(args.reference);
      const refs = groupRuns(verses.map((ref) => ({ ref })), () => 0).map((g: { ref: string }) => g.ref);
      return { reference: label, links: refs.map((ref: string) => ({ reference: labelRef(ref), ref, link: link(ref) })) };
    }
    await this.open();
    const ids = this.colors.map((c) => c.id);
    switch (name) {
      case "list_highlights": {
        const color = args.color === undefined ? null : this.color(args.color);
        const records = this.highlights().filter((r) => !color || topColor(r, ids) === color);
        return { highlights: this.runs(records) };
      }
      case "find_highlights": {
        let inside: (ref: string) => boolean;
        let label: string;
        if (args.book !== undefined && args.reference === undefined) {
          const code = bookCode(String(args.book));
          if (!code) throw new Refusal("That isn't a book of the Bible.");
          inside = (ref) => splitRef(ref)?.code === code;
          label = BOOKS.find(([c]) => c === code)![1];
        } else {
          const found = this.verses(args.reference);
          const set = new Set(found.verses);
          inside = (ref) => set.has(ref);
          label = found.label;
        }
        return { reference: label, highlights: this.runs(this.highlights().filter((r) => inside(r.ref))) };
      }
      case "add_highlight": {
        const { verses, label } = this.verses(args.reference);
        const color = this.color(args.color, "yellow");
        const t = Math.floor(Date.now() / 1000);
        await this.save(verses.map((v) => highlightRecord(this.library.find("highlight", v), v, color, t)));
        return { added: label, color, colorName: this.colorName(color), verses };
      }
      case "set_highlight_color": {
        const { verses, label } = this.verses(args.reference);
        const color = this.color(args.color);
        const t = Math.floor(Date.now() / 1000);
        const records = verses.map((v) => this.library.find("highlight", v) as Rec | null).filter((r): r is Rec => !!r);
        if (!records.length) throw new Refusal(`Nothing in ${label} is highlighted.`);
        await this.save(records.map((r) => ({ ...r, highlights: r.highlights.map((h) => ({ ...h, color, edited: t })) })));
        return { recolored: label, color, colorName: this.colorName(color), verses: records.map((r) => r.ref) };
      }
      case "delete_highlight": {
        const { verses, label } = this.verses(args.reference);
        const records = verses.filter((v) => this.library.find("highlight", v));
        if (!records.length) throw new Refusal(`Nothing in ${label} is highlighted.`);
        await this.save(records.map((ref) => ({ kind: "highlight", ref, deleted: true })));
        return { deleted: label, verses: records };
      }
      case "list_colors": {
        const counts = new Map<string, number>();
        for (const r of this.highlights()) counts.set(topColor(r, ids), (counts.get(topColor(r, ids)) ?? 0) + 1);
        return {
          colors: this.colors.map((c) => ({ id: c.id, name: this.colorName(c.id), builtIn: c.builtIn, ...(c.hex ? { hex: c.hex } : {}), verses: counts.get(c.id) ?? 0 })),
        };
      }
      case "get_library_info": {
        const highlights = this.highlights();
        return {
          name: this.library.syncedName,
          highlightedVerses: highlights.length,
          passages: this.runs(highlights).length,
          notes: this.library.all("note").length,
          colors: this.colors.length,
          ownColors: this.colors.filter((c) => !c.builtIn).length,
        };
      }
    }
    throw new Refusal("Unknown tool.");
  }
}

class RpcFault extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/** "Romans", "rom", "ROM", "1 John", "Psalm" → a USFM code, or null. */
export function bookCode(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return null;
  const exact = BOOKS.find(([code, name]) => code.toLowerCase() === t || name.toLowerCase() === t || (code === "PSA" && t === "psalm"));
  if (exact) return exact[0];
  const found = readPassage(`${text} 1:1`);
  return found.error !== undefined ? null : splitRef(found.verses[0])?.code ?? null;
}
