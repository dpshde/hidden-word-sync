// Plain-text Berean Standard Bible (YouVersion 3034) through this site's /yv pass-through.
// scripture-inline's <si-passage> keeps HTML for the list; relevance needs the words alone.

import { expandVerses, splitRef } from "./refs.js";
import { createWarmer } from "./passage-warm.js";

export const BSB = "3034";
/** A range longer than this is shortened to its first SHORT_VERSES verses for the Jev payload. */
export const LONG_RANGE = 15;
export const SHORT_VERSES = 8;

/** The ref to fetch for `ref`: the whole range, or its first SHORT_VERSES when it runs long. */
export function fetchRefFor(ref) {
  const verses = expandVerses(ref);
  if (verses.length <= LONG_RANGE) return { fetchRef: ref, truncated: false };
  const first = splitRef(verses[0]);
  const last = splitRef(verses[SHORT_VERSES - 1]);
  return {
    fetchRef: `${first.code}.${first.chapter}.${first.verse}-${last.verse}`,
    truncated: true,
  };
}

/** HTML from YouVersion → one line of words (verse numbers and tags dropped). */
export function plainFromHtml(html) {
  return String(html ?? "")
    .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetches BSB plain text for a canonical ref through `/yv`. Cached by ref+BSB. Ranges go whole;
 * >LONG_RANGE verses use the first SHORT_VERSES (caller still sends the full ref with the text).
 * Background loads of many refs are paced with createWarmer.
 */
export function createBsbText({
  fetch = globalThis.fetch.bind(globalThis),
  host = typeof location !== "undefined" ? `${location.protocol}//${location.host}` : "",
  warmerFactory = createWarmer,
} = {}) {
  const cache = new Map(); // `${ref}|BSB` → { text, truncated, fetchRef }
  const pending = new Map();

  async function load(ref) {
    const key = `${ref}|BSB`;
    if (cache.has(key)) return cache.get(key);
    if (pending.has(key)) return pending.get(key);
    const { fetchRef, truncated } = fetchRefFor(ref);
    const work = (async () => {
      const url = `${host}/yv/v1/bibles/${BSB}/passages/${encodeURIComponent(fetchRef)}?format=html&include_headings=false`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`verse text ${res.status}`);
      const body = await res.json();
      const rawHtml = String(body.content ?? body.text ?? "");
      const text = plainFromHtml(rawHtml);
      const entry = { text, html: rawHtml, truncated, fetchRef };
      cache.set(key, entry);
      return entry;
    })();
    pending.set(key, work);
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  }

  const warmer = warmerFactory((ref) => load(ref));

  return {
    /** Resolves `{ text, truncated, fetchRef }` for `ref` (cached). */
    get(ref) {
      return load(ref);
    },
    /** Queue many highlight refs behind the warmer so YouVersion's rate limit stays quiet. */
    warm(refs) {
      for (const ref of refs) warmer.add(ref);
    },
    first(ref) {
      warmer.first(ref);
      warmer.add(ref);
    },
    peek(ref) {
      return cache.get(`${ref}|BSB`) ?? null;
    },
    clear() {
      cache.clear();
    },
  };
}
