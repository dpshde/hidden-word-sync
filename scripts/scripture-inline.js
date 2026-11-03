// The part of scripture-inline the web app uses: the passage field. scripts/vendor.js bundles this into
// public/vendor/scripture-inline.js. Not scriptureInline() or <si-passage>, which call YouVersion.
export { definePassageInput } from "@faith-tools/scripture-inline";
