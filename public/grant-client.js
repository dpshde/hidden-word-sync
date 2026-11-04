// The client for an app connected through /connect (public/grants.js): what route.bible and any
// other app use to read and save a person's highlights with a grant, never the sync key.
//
// The server holds only encrypted items under HMAC'd ids, so it can't see a verse, a color or a
// deletion. Everything people mean by "highlights" happens here, where the plaintext is:
// - changes(since): an incremental feed. Upserts and deletions since an opaque cursor, plus the next
//   cursor. The merge rule (SPEC 3) and tombstones are applied here, so the app only applies a list.
// - highlights({ group }): the current highlights, one per verse or grouped into ranges (ranges.js).
// - highlightRange(ref, color) / remove(refs): one POST each, so the server takes all or none.
//
// Scopes: changes and highlights need "read" (GET); writes need "highlights:write" and the item-id
// key `mk`, which /connect only hands to apps granted it. The server enforces both by method.
import { compareRefs, splitRef } from "./refs.js";
import { listRanges, rangeView, rangeWrites, stamp, tombstone, topColor } from "./ranges.js";
import { SyncError, compareVersions, decryptText, encryptRecord, itemId, palette } from "./sync.js";

const MAX_WRITE = 100;
const TIMEOUT_MS = 20_000;
const HEX64 = /^[0-9a-f]{64}$/;

/** The fields /connect puts in the callback's fragment: vault, lib, rt, ek, exp, name, scope, state, and mk with write. */
export function parseGrantFragment(hash) {
  const p = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  if (p.get("error")) return { error: p.get("error") };
  const fields = Object.fromEntries(["vault", "lib", "rt", "ek", "exp", "name", "scope", "state", "mk"].map((k) => [k, p.get(k)]));
  if (!fields.vault || !fields.lib || !fields.rt || !fields.ek) return { error: "invalid_grant" };
  return fields;
}

/** A cursor is "<epoch>.<seq>": opaque to apps, so a server that lost data is told apart from one that didn't. */
const cursorOf = (epoch, seq) => `${epoch ?? "none"}.${seq}`;
function parseCursor(since) {
  const m = /^([0-9a-f]+|none)\.(\d+)$/.exec(String(since ?? ""));
  return m ? { epoch: m[1] === "none" ? null : m[1], seq: Number(m[2]) } : null;
}

export class GrantClient {
  /** `grant`: the fragment's fields (parseGrantFragment). `fetch` defaults to the global one. */
  static async open(grant, { fetch } = {}) {
    if (!HEX64.test(grant.ek ?? "")) throw new Error("ek must be 64 hex characters");
    if (grant.mk != null && !HEX64.test(grant.mk)) throw new Error("mk must be 64 hex characters");
    const raw = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
    const keys = {
      enc: await crypto.subtle.importKey("raw", raw(grant.ek), "AES-GCM", false, ["encrypt", "decrypt"]),
      mac: grant.mk ? await crypto.subtle.importKey("raw", raw(grant.mk), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]) : null,
    };
    return new GrantClient(grant, keys, fetch);
  }

  constructor(grant, keys, fetch) {
    this.grant = grant;
    this.keys = keys;
    this.fetch = fetch ?? globalThis.fetch.bind(globalThis);
    this.scopes = String(grant.scope ?? "").split(/\s+/).filter(Boolean);
    /** Item id → { record, text }: this app's copy, merged by the merge rule. */
    this.items = new Map();
    this.cursor = null;
  }

  get canWrite() {
    return this.scopes.includes("highlights:write") && !!this.keys.mac;
  }

  async call(method, query = "", body) {
    const headers = { authorization: `Bearer ${this.grant.rt}` };
    if (body) headers["content-type"] = "application/json";
    const res = await this.fetch(`${this.grant.vault.replace(/\/$/, "")}/v1/lib/${this.grant.lib}${query}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new SyncError(res.status, await res.text().catch(() => ""));
    return res.status === 204 ? null : res.json();
  }

  /**
   * Highlights changed since `since` (a cursor from an earlier call; omit for everything):
   * { upserts: [{ ref, color, record }], deletions: [ref], colors, next, reset }.
   * Apply upserts and deletions by ref, keep `next` for the next call. `reset` true means the
   * server lost data or the cursor is unknown: replace everything from this vault with `upserts`.
   */
  async changes(since) {
    let from = parseCursor(since);
    let reset = !from;
    let epoch = from?.epoch ?? null;
    let after = from?.seq ?? 0;
    const changed = new Map();
    for (;;) {
      const page = await this.call("GET", `?after=${after}`);
      const lost = from && ((from.epoch !== null && page.epoch !== from.epoch) || (page.seq ?? 0) < from.seq);
      if (lost) {
        // Start over from the beginning: everything is new, nothing carried over.
        this.items = new Map();
        changed.clear();
        from = null;
        reset = true;
        after = 0;
        continue;
      }
      epoch = page.epoch;
      for (const { seq, id, blob } of page.items) {
        after = seq;
        let text;
        let record;
        try {
          text = await decryptText(this.keys, id, blob);
          record = JSON.parse(text);
          if (this.keys.mac && (await itemId(this.keys, record.kind, record.ref)) !== id) continue;
        } catch {
          continue;
        }
        const mine = this.items.get(id);
        if (mine && compareVersions({ updated: record.updated, text }, { updated: mine.record.updated, text: mine.text }) <= 0) continue;
        this.items.set(id, { record, text });
        if (record.kind === "highlight" && splitRef(record.ref)?.verse != null && splitRef(record.ref)?.end === null) changed.set(record.ref, record);
      }
      after = Math.max(after, page.seq ?? 0);
      if (!page.more) break;
    }
    const known = this.colors().map((c) => c.id);
    const upserts = [];
    const deletions = [];
    for (const [ref, record] of [...changed].sort((a, b) => compareRefs(a[0], b[0]))) {
      if (record.deleted === true) {
        if (!reset) deletions.push(ref);
      } else upserts.push({ ref, color: topColor(record, known), record });
    }
    this.cursor = cursorOf(epoch, after);
    return { upserts, deletions, colors: this.colors(), next: this.cursor, reset };
  }

  /** The library's colors, from what this app has read. */
  colors() {
    return palette([...this.items.values()].map((x) => x.record).filter((r) => r.kind === "color"));
  }

  /** Current highlights from what this app has read (call changes first): one per verse, or { group: "ranges" }. */
  highlights({ group } = {}) {
    const records = [...this.items.values()].map((x) => x.record).filter((r) => r.kind === "highlight" && !r.deleted && splitRef(r.ref)?.verse != null);
    records.sort((a, b) => compareRefs(a.ref, b.ref));
    if (group === undefined || group === "verses") return records;
    if (group !== "ranges") throw new Error(`unknown group ${group}`);
    return rangeView(listRanges(records, this.colors().map((c) => c.id)));
  }

  find(ref) {
    return this.highlights().find((r) => r.ref === ref) ?? null;
  }

  /** Saves records in one POST (all or none), stamped by the writing rule. */
  async write(records) {
    if (!this.canWrite) throw new Error("this grant can't save highlights (it needs highlights:write)");
    if (records.length > MAX_WRITE) throw new Error(`at most ${MAX_WRITE} records in one write`);
    if (!records.length) return;
    const t = Math.floor(Date.now() / 1000);
    const out = await Promise.all(
      records.map(async (record) => {
        const id = await itemId(this.keys, record.kind, record.ref);
        const r = stamp(record, this.items.get(id)?.record.updated, t);
        return { r, text: JSON.stringify(r), ...(await encryptRecord(this.keys, r)) };
      }),
    );
    await this.call("POST", "", { items: out.map(({ id, blob }) => ({ id, blob })) });
    for (const { id, r, text } of out) this.items.set(id, { record: r, text });
  }

  /** Highlights a verse or same-chapter range ("ROM.5.3-5") in one POST. → { ref, verses, written }. */
  async highlightRange(ref, color = "yellow") {
    const w = rangeWrites(ref, color, Math.floor(Date.now() / 1000), (v) => this.find(v));
    if (w.error) throw new Error(w.error);
    await this.write(w.records);
    return { ref: w.ref, verses: w.verses, written: w.records.map((r) => r.ref) };
  }

  /** Removes the highlights on these verses (tombstones, one POST). → the refs that were highlighted. */
  async remove(refs) {
    const live = refs.filter((ref) => this.find(ref));
    await this.write(live.map((ref) => tombstone(ref)));
    return live;
  }

  /** Revokes this grant (the app disconnecting). */
  async disconnect() {
    const res = await this.fetch(`${this.grant.vault.replace(/\/$/, "")}/v1/grant/${this.grant.lib}`, { method: "DELETE", headers: { authorization: `Bearer ${this.grant.rt}` } });
    if (!res.ok && res.status !== 401) throw new SyncError(res.status, "");
  }
}
