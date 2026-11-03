// The parts of scripture-inline the web app uses: the passage field, and the passage text a row shows
// when asked. scripts/vendor.js bundles this into public/vendor/scripture-inline.js. Not scriptureInline(),
// which scans the page for references.
export { definePassageInput, defineScripturePassage } from "@faith-tools/scripture-inline";
