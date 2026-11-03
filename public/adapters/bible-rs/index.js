// The bible-rs adapter: sync with a bible-rs Study Library folder, and import bible-rs exports.
// Self-contained: Hidden Word's core doesn't know it's here (see ../index.js). Spec: README.md.

import { isStudyLibrary, studyLibrary } from "./folder.js";
import { fromExport } from "./map.js";

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export default {
  id: "bible-rs",
  label: "It's a bible-rs Study Library: Hidden Word syncs with it as one more bible-rs device.",
  detect: (tree) => isStudyLibrary(tree),
  adapter: (tree) => studyLibrary(tree),
  importFile(text) {
    const doc = json(text);
    return doc?.app === "bible-rs" ? fromExport(doc) : null;
  },
};
