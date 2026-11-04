// Rank highlights against a passage with TypeSafe Jev (via the selah-jev Worker).
// Everything runs under a read grant on the device: the vault server never sees verses or verdicts.
//
// One batched call per ~40 highlights. The selah-jev Worker puts the task, the passage and each
// highlight's reference and text in `state` once, and asks per highlight: does it speak to the passage
// (noul), what kind of link (choice, shown as a short reason), and how obvious the link is (score).
// Relevant mode sorts closest first; Surprising sorts least-obvious-but-sound first. Switching
// those two reorders the cache with no network call. Verdicts are keyed by passage+id+rangeHash+BSB;
// a changes feed (grant-client shape) re-judges only the ids that moved.

import { readPassage } from "./passage.js";

export const JEV_URL = "https://jev.selah.tools";
export const BATCH_SIZE = 40;
/** Soft token budget per batch (~4–6k); highlights stop joining a batch past this estimate. */
export const BATCH_TOKENS = 5_000;
export const RELEVANT_MIN = 0.5;
export const BIBLE = "BSB";

/** Fixed one-line reasons Jev chooses among; the chosen phrase is shown under the row. */
export const REASONS = {
  same_theme: "Same theme",
  same_promise: "Shared promise",
  fulfillment: "Promise and fulfillment",
  same_argument: "Same author's argument",
  same_call: "Same call to act",
  contrast: "Contrast that sharpens it",
  none: "",
};


const estimateTokens = (s) => Math.ceil(String(s ?? "").length / 4);

/** Stable short hash of highlight text (rangeHash), so an edit invalidates its verdict. */
export async function rangeHash(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  const dig = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(dig)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function cacheKey(passageRef, highlightId, hash, bible = BIBLE) {
  return `${passageRef}\0${highlightId}\0${hash}\0${bible}`;
}

/** Split highlights into batches of ~BATCH_SIZE or ~BATCH_TOKENS. */
export function batchHighlights(highlights, { size = BATCH_SIZE, tokens = BATCH_TOKENS } = {}) {
  const batches = [];
  let cur = [], used = 0;
  for (const h of highlights) {
    const cost = estimateTokens(h.text) + 20;
    if (cur.length && (cur.length >= size || used + cost > tokens)) {
      batches.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(h);
    used += cost;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** Build the relevance request body the selah-jev Worker accepts. */
export function buildRelevanceRequest({ lib, passage, highlights }) {
  return {
    lib: String(lib ?? ""),
    passage: { ref: passage.ref, text: passage.text },
    highlights: highlights.map((h) => ({ id: String(h.id), ref: h.ref, text: h.text })),
  };
}

/**
 * Parse a mocked or live Worker response into per-id verdicts:
 * `{ id → { relevant, relevance, reason, obviousness } }`.
 */
export function parseVerdicts(answers = {}) {
  const byId = new Map();
  for (const [qid, ans] of Object.entries(answers)) {
    const m = /^(.*)_(relevant|reason|obviousness)$/.exec(qid);
    if (!m) continue;
    const [, id, kind] = m;
    const row = byId.get(id) ?? { id, relevant: false, relevance: 0, reason: "", obviousness: 1.5 };
    if (kind === "relevant" && ans?.type === "noul") {
      row.relevance = Number(ans.noul) || 0;
      row.relevant = row.relevance >= RELEVANT_MIN;
    } else if (kind === "reason" && ans?.type === "choice") {
      const key = ans.choice;
      row.reason = REASONS[key] ?? "";
    } else if (kind === "obviousness" && ans?.type === "score") {
      row.obviousness = Number(ans.score) || 0;
    }
    byId.set(id, row);
  }
  return byId;
}

/** Relevant: closest first. Surprising: least obvious among the relevant, sound first. */
export function rankVerdicts(verdicts, mode) {
  const list = [...verdicts].filter((v) => v.relevant);
  if (mode === "surprising") {
    return list.sort((a, b) => a.obviousness - b.obviousness || b.relevance - a.relevance || String(a.id).localeCompare(String(b.id)));
  }
  return list.sort((a, b) => b.relevance - a.relevance || a.obviousness - b.obviousness || String(a.id).localeCompare(String(b.id)));
}

export function totalCopy(shown, librarySize) {
  return `${shown} of ${librarySize} relevant`;
}

/** Fallback when the passage label isn't known yet. Prefer emptyRelevanceCopy with a count and label. */
export const EMPTY_RELEVANCE = "None of your highlights speak to this passage yet.";

/** Calm no-results line naming the library size and the passage, e.g. "None of your 17 highlights connect to Hab 2:2". */
export function emptyRelevanceCopy(count, label) {
  const n = Number(count) || 0;
  const what = n === 1 ? "highlight" : "highlights";
  const named = String(label ?? "").trim() || "this passage";
  return `None of your ${n} ${what} connect to ${named}`;
}

/** The whole-chapter reference for "try the chapter" (HAB.2.2 → HAB.2; ROM.8.18-25 → ROM.8). */
export function chapterRefOf(ref) {
  const m = /^([1-3A-Z][A-Z0-9]{2})\.(\d+)/.exec(String(ref ?? ""));
  return m ? `${m[1]}.${m[2]}` : null;
}

/** Turn network / Worker errors into a short line under the passage field (never raw "Failed to fetch"). */
export function rankErrorMessage(err) {
  const raw = String(err?.message ?? err ?? "");
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
    return "Couldn't reach Selah Vault ranking. Check your connection and try again.";
  }
  if (/daily spend cap/i.test(raw)) return "Today's ranking budget is used up. Try again tomorrow.";
  if (/library rate limit|upstream rate limit/i.test(raw)) {
    return "Too many ranking requests. Wait a moment and try again.";
  }
  if (/ranking unavailable|jev unavailable|upstream error|bad upstream/i.test(raw)) {
    return "Selah Vault couldn't rank these highlights right now. Try again in a moment.";
  }
  if (/verse text/i.test(raw)) return "Couldn't load the Bible text for that passage. Try again.";
  return raw || "Couldn't rank highlights.";
}

/**
 * Session for one library: caches verdicts, talks to selah-jev, and re-judges from a changes feed.
 *
 * `verseText.get(ref)` → `{ text }` (createBsbText). `fetch` posts to `jevUrl`.
 */
export function createRelevance({
  lib,
  jevUrl = JEV_URL,
  fetch = globalThis.fetch.bind(globalThis),
  verseText,
} = {}) {
  /** cacheKey → verdict */
  const cache = new Map();
  /** highlightId → rangeHash last judged under the current passage */
  const hashes = new Map();
  let passage = null; // { ref, label, text }
  let lastFetchCount = 0;

  function verdictFor(id) {
    if (!passage) return null;
    const hash = hashes.get(id);
    if (!hash) return null;
    return cache.get(cacheKey(passage.ref, id, hash)) ?? null;
  }

  async function postBatch(highlights) {
    const body = buildRelevanceRequest({ lib, passage, highlights });
    let res;
    try {
      res = await fetch(jevUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // Browsers surface DNS/CORS/offline as TypeError "Failed to fetch" — keep that wording for the UI mapper.
      throw new Error("Failed to fetch");
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `jev ${res.status}`);
    }
    const data = await res.json();
    return parseVerdicts(data.answers);
  }

  /**
   * Judge `items` (`{ id, ref }` plus optional `text`) against the current passage.
   * Cached ids are skipped. Returns ranked relevant verdicts for `mode`.
   */
  async function judge(items, mode = "relevant") {
    if (!passage) return { ranked: [], total: items.length, fetched: 0 };
    const need = [];
    for (const item of items) {
      const text = item.text ?? (await verseText.get(item.ref)).text;
      const hash = await rangeHash(text);
      hashes.set(item.id, hash);
      const key = cacheKey(passage.ref, item.id, hash);
      if (!cache.has(key)) need.push({ id: item.id, ref: item.ref, text });
    }
    lastFetchCount = 0;
    for (const batch of batchHighlights(need)) {
      lastFetchCount++;
      const got = await postBatch(batch);
      for (const [id, v] of got) {
        const hash = hashes.get(id);
        cache.set(cacheKey(passage.ref, id, hash), v);
      }
    }
    const verdicts = items.map((item) => verdictFor(item.id)).filter(Boolean);
    return { ranked: rankVerdicts(verdicts, mode), total: items.length, fetched: lastFetchCount };
  }

  return {
    lib,
    get passage() {
      return passage;
    },
    get lastFetchCount() {
      return lastFetchCount;
    },
    /**
     * Set the input passage from what the person typed. Returns `{ error }` from readPassage,
     * or `{ label, ref, verses }` after loading BSB text. Nothing is sent to Jev here.
     */
    async setPassageInput(raw) {
      const found = readPassage(raw);
      if (found.error) {
        passage = null;
        return found;
      }
      const ref = found.verses.length === 1
        ? found.verses[0]
        : (() => {
            // Prefer a compact range ref when the verses form one run in one chapter.
            const first = found.verses[0];
            const last = found.verses.at(-1);
            if (found.verses.length > 1 && first.replace(/\.\d+$/, "") === last.replace(/\.\d+$/, "")) {
              const a = first.split("."), b = last.split(".");
              return `${a[0]}.${a[1]}.${a[2]}-${b[2]}`;
            }
            return first;
          })();
      verseText.first?.(ref);
      const { text } = await verseText.get(ref);
      passage = { ref, label: found.label, text, verses: found.verses };
      return { label: found.label, ref, verses: found.verses };
    },
    clearPassage() {
      passage = null;
    },
    /** Reorder cached verdicts for `items` with no network call. */
    reorder(items, mode) {
      const verdicts = items.map((item) => verdictFor(item.id)).filter(Boolean);
      lastFetchCount = 0;
      return { ranked: rankVerdicts(verdicts, mode), total: items.length, fetched: 0 };
    },
    judge,
    /**
     * Apply a grant-client changes feed: drop deleted ids, and forget upserts so the next judge
     * re-asks only for those. Verse-level refs also invalidate any run id that covers them.
     * `reset` clears every cached verdict for this library session.
     */
    applyChanges({ upserts = [], deletions = [], reset = false } = {}) {
      if (reset) {
        cache.clear();
        hashes.clear();
        return;
      }
      const touched = new Set([
        ...deletions.map(String),
        ...upserts.map((u) => String(u.ref ?? u.id)),
      ]);
      const drop = (id) => {
        hashes.delete(id);
        for (const key of [...cache.keys()]) {
          const parts = key.split("\0");
          if (parts[1] === id) cache.delete(key);
        }
      };
      for (const id of [...hashes.keys()]) {
        if (touched.has(id)) {
          drop(id);
          continue;
        }
        // Run ids like ROM.5.3-5: invalidate when any of their verses changed.
        const m = /^([1-3A-Z][A-Z0-9]{2})\.(\d+)\.(\d+)-(\d+)$/.exec(id);
        if (!m) continue;
        for (let v = Number(m[3]); v <= Number(m[4]); v++) {
          if (touched.has(`${m[1]}.${m[2]}.${v}`)) {
            drop(id);
            break;
          }
        }
      }
      for (const ref of touched) drop(ref);
    },
    /** Test helper: seed a verdict without calling Jev. */
    put(passageRef, id, hash, verdict) {
      hashes.set(id, hash);
      cache.set(cacheKey(passageRef, id, hash), verdict);
    },
  };
}
