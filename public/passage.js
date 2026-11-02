// What people type or paste ("John 3:16", "jn 3.16", "Psalm 23", a bible.com or route.bible link), turned
// into the verses it covers. Parsing is grab-bcv's, bundled into vendor/grab-bcv.js by `bun run vendor`.

import { tryParsePassage, tryParseAnyPassage, getVerseCount } from "./vendor/grab-bcv.js";
import { BOOKS, labelRef } from "./refs.js";

/** Most verses one reference may highlight, so a slip like "Gen 1-Rev 22" can't cover the Bible. */
export const MAX_VERSES = 500;

const ORDER = BOOKS.map(([code]) => code);

/** → `{ verses: ["JHN.3.16", …], label: "John 3:16" }`, or `{ error }` with a sentence for people. */
export function readPassage(input) {
  const text = String(input ?? "").trim();
  if (!text) return { error: "Type a reference, like John 3:16." };
  const found = parse(text);
  if (found.error) return found;
  const verses = [];
  for (const passage of found.passages) {
    verses.push(...expand(passage));
    if (verses.length > MAX_VERSES) return { error: `That's more than ${MAX_VERSES} verses. Try a shorter passage.` };
  }
  return { verses: [...new Set(verses)], label: found.passages.map(label).join(", ") };
}

function parse(text) {
  // The single-passage parser reads "jn 3.16" and "I John 4:8" right where the any-passage parser
  // doesn't (grab-bcv 0.1.7), so it goes first. The other adds links, free text and verse lists.
  const single = tryParsePassage(text);
  if (single.ok) return { passages: [single.value] };
  const any = tryParseAnyPassage(text, { multiple: true });
  if (any.ok) return { passages: [].concat(any.value) };
  // grab-bcv reads "Jude 3" as chapter 3, but books of one chapter are cited by verse alone.
  const details = single.error.details;
  if (details?.kind === "chapter_cap" && details.maxChapter === 1) {
    const retry = tryParsePassage(text.replace(/(\d+)(\s*[-–—]\s*\d+)?\s*$/, "1:$1$2"));
    if (retry.ok) return { passages: [retry.value] };
  }
  return { error: message(single.error) };
}

function message(error) {
  if (error.details) return error.message;
  if (error.code === "REVERSED_RANGE") return "That range runs backwards.";
  return "Try a reference like John 3:16.";
}

function expand({ start, end }) {
  let book = ORDER.indexOf(start.book);
  let chapter = start.chapter;
  let verse = start.verse ?? 1;
  const lastBook = ORDER.indexOf(end.book);
  const lastVerse = end.verse ?? getVerseCount(end.book, end.chapter);
  const out = [];
  while (out.length <= MAX_VERSES && book < ORDER.length) {
    out.push(`${ORDER[book]}.${chapter}.${verse}`);
    if (book === lastBook && chapter === end.chapter && verse >= lastVerse) break;
    if (verse < getVerseCount(ORDER[book], chapter)) verse++;
    else if (chapter < BOOKS[book][2]) (chapter++, (verse = 1));
    else (book++, (chapter = 1), (verse = 1));
  }
  return out;
}

const refOf = (p) => (p.verse === undefined ? `${p.book}.${p.chapter}` : `${p.book}.${p.chapter}.${p.verse}`);

function label({ start, end }) {
  const first = labelRef(refOf(start));
  if (start.book !== end.book) return `${first}–${labelRef(refOf(end))}`;
  if (start.chapter === end.chapter) return start.verse === end.verse ? first : `${first}–${end.verse}`;
  return `${first}–${end.verse === undefined ? end.chapter : `${end.chapter}:${end.verse}`}`;
}
