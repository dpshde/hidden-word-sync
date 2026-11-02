// Canonical references: USFM book codes, KJV versification, the 66-book Protestant canon.
// `parseRef` turns what people type ("John 3:16", "jn 3.16", "1 Cor 13:4-7") into a canonical ref.

export const BOOKS = [
  ["GEN", "Genesis", 50], ["EXO", "Exodus", 40], ["LEV", "Leviticus", 27], ["NUM", "Numbers", 36],
  ["DEU", "Deuteronomy", 34], ["JOS", "Joshua", 24], ["JDG", "Judges", 21], ["RUT", "Ruth", 4],
  ["1SA", "1 Samuel", 31], ["2SA", "2 Samuel", 24], ["1KI", "1 Kings", 22], ["2KI", "2 Kings", 25],
  ["1CH", "1 Chronicles", 29], ["2CH", "2 Chronicles", 36], ["EZR", "Ezra", 10], ["NEH", "Nehemiah", 13],
  ["EST", "Esther", 10], ["JOB", "Job", 42], ["PSA", "Psalms", 150], ["PRO", "Proverbs", 31],
  ["ECC", "Ecclesiastes", 12], ["SNG", "Song of Solomon", 8], ["ISA", "Isaiah", 66], ["JER", "Jeremiah", 52],
  ["LAM", "Lamentations", 5], ["EZK", "Ezekiel", 48], ["DAN", "Daniel", 12], ["HOS", "Hosea", 14],
  ["JOL", "Joel", 3], ["AMO", "Amos", 9], ["OBA", "Obadiah", 1], ["JON", "Jonah", 4],
  ["MIC", "Micah", 7], ["NAM", "Nahum", 3], ["HAB", "Habakkuk", 3], ["ZEP", "Zephaniah", 3],
  ["HAG", "Haggai", 2], ["ZEC", "Zechariah", 14], ["MAL", "Malachi", 4], ["MAT", "Matthew", 28],
  ["MRK", "Mark", 16], ["LUK", "Luke", 24], ["JHN", "John", 21], ["ACT", "Acts", 28],
  ["ROM", "Romans", 16], ["1CO", "1 Corinthians", 16], ["2CO", "2 Corinthians", 13], ["GAL", "Galatians", 6],
  ["EPH", "Ephesians", 6], ["PHP", "Philippians", 4], ["COL", "Colossians", 4], ["1TH", "1 Thessalonians", 5],
  ["2TH", "2 Thessalonians", 3], ["1TI", "1 Timothy", 6], ["2TI", "2 Timothy", 4], ["TIT", "Titus", 3],
  ["PHM", "Philemon", 1], ["HEB", "Hebrews", 13], ["JAS", "James", 5], ["1PE", "1 Peter", 5],
  ["2PE", "2 Peter", 3], ["1JN", "1 John", 5], ["2JN", "2 John", 1], ["3JN", "3 John", 1],
  ["JUD", "Jude", 1], ["REV", "Revelation", 22],
];

const INDEX = new Map(BOOKS.map(([code], i) => [code, i]));
const squash = (s) => s.toLowerCase().replace(/[\s.]/g, "");
const NAMES = BOOKS.map(([code, name]) => [squash(name), code]);
// Common short forms that are not a unique prefix of a book's name.
const ALIASES = {
  jn: "JHN", mt: "MAT", mk: "MRK", lk: "LUK", ps: "PSA", pss: "PSA", phil: "PHP", philem: "PHM", phlm: "PHM",
  jas: "JAS", sos: "SNG",
  song: "SNG", songofsongs: "SNG", revelations: "REV", "1jn": "1JN", "2jn": "2JN", "3jn": "3JN",
};
const MAX_VERSE = 176;
const REF = /^([1-3A-Z][A-Z0-9]{2})\.(\d{1,3})(?:\.(\d{1,3})(?:-(\d{1,3}))?)?$/;

/** Splits a canonical ref, or returns null when it isn't one (unknown book, chapter out of range). */
export function splitRef(ref) {
  const m = REF.exec(String(ref));
  if (!m) return null;
  const book = INDEX.get(m[1]);
  if (book === undefined) return null;
  const chapter = Number(m[2]);
  const verse = m[3] === undefined ? null : Number(m[3]);
  const end = m[4] === undefined ? null : Number(m[4]);
  if (chapter < 1 || chapter > BOOKS[book][2]) return null;
  if (verse !== null && (verse < 1 || verse > MAX_VERSE)) return null;
  if (end !== null && (end <= verse || end > MAX_VERSE)) return null;
  return { code: m[1], book, chapter, verse, end };
}

export function bookCode(text) {
  let t = text.trim().toLowerCase().replace(/^(iii|ii|i)\s+/, (r) => `${r.trim().length} `);
  t = squash(t);
  if (!t) return null;
  if (INDEX.has(t.toUpperCase())) return t.toUpperCase();
  if (ALIASES[t]) return ALIASES[t];
  const exact = NAMES.find(([name]) => name === t);
  if (exact) return exact[1];
  const prefixed = NAMES.filter(([name]) => name.startsWith(t));
  return t.length >= 2 && prefixed.length === 1 ? prefixed[0][1] : null;
}

/** "John 3:16" → "JHN.3.16". Also takes canonical refs. Null when it can't tell. */
export function parseRef(input) {
  const text = String(input);
  const m = /^\s*(.+?)\s*(\d{1,3})(?:\s*[:.]\s*(\d{1,3})(?:\s*[-–—]\s*(\d{1,3}))?)?\s*$/.exec(text);
  const code = m && bookCode(m[1]);
  if (!code) return singleChapter(text);
  // Books of one chapter are cited by verse alone: "Jude 3" is Jude 1:3.
  if (m[3] === undefined && Number(m[2]) > 1 && BOOKS[INDEX.get(code)][2] === 1) return singleChapter(text);
  let ref = `${code}.${Number(m[2])}`;
  if (m[3] !== undefined) ref += `.${Number(m[3])}`;
  if (m[4] !== undefined && Number(m[4]) !== Number(m[3])) ref += `-${Number(m[4])}`;
  return splitRef(ref) ? ref : null;
}

function singleChapter(text) {
  const m = /^\s*(.+?)\s*(\d{1,3})(?:\s*[-–—]\s*(\d{1,3}))?\s*$/.exec(text);
  const code = m && bookCode(m[1]);
  if (!code || BOOKS[INDEX.get(code)][2] !== 1) return null;
  let ref = `${code}.1.${Number(m[2])}`;
  if (m[3] !== undefined && Number(m[3]) !== Number(m[2])) ref += `-${Number(m[3])}`;
  return splitRef(ref) ? ref : null;
}

/** "JHN.3.16-18" → "John 3:16–18". */
export function labelRef(ref) {
  const r = splitRef(ref);
  if (!r) return String(ref);
  const name = r.code === "PSA" ? "Psalm" : BOOKS[r.book][1];
  let out = `${name} ${r.chapter}`;
  if (r.verse !== null) out += `:${r.verse}`;
  if (r.end !== null) out += `–${r.end}`;
  return out;
}

export function compareRefs(a, b) {
  const x = splitRef(a);
  const y = splitRef(b);
  if (!x || !y) return String(a).localeCompare(String(b));
  return x.book - y.book || x.chapter - y.chapter || (x.verse ?? 0) - (y.verse ?? 0) || (x.end ?? 0) - (y.end ?? 0);
}

/** "JHN.3.16-18" → ["JHN.3.16", "JHN.3.17", "JHN.3.18"]. */
export function expandVerses(ref) {
  const r = splitRef(ref);
  if (!r || r.verse === null) return [];
  const out = [];
  for (let v = r.verse; v <= (r.end ?? r.verse); v++) out.push(`${r.code}.${r.chapter}.${v}`);
  return out;
}
