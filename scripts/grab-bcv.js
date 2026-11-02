// Entry for `bun run vendor`: the parts of grab-bcv the web app uses, bundled into public/vendor/grab-bcv.js.
// The package root also bundles paragraph data (about 280 KB) the app doesn't need, so import sub-paths.
export { tryParsePassage, tryParseAnyPassage } from "grab-bcv/parse";
export { getVerseCount } from "grab-bcv/books";
