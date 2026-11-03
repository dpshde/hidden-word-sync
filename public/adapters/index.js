// Folder formats and file importers, as plugins. Each is a module whose default export is
//
//   { id, label, detect(tree) → Promise<boolean>, adapter(tree) → sync adapter,
//     importFile?(text) → records, or null when the file isn't this format's }
//
// (a sync adapter and a tree are described at `Library.use` and `memoryTree` in sync.js). The first
// format whose `detect` says yes syncs the folder. A module that's missing is skipped, so an adapter
// is removed by deleting its folder; Hidden Word's own format comes last because it takes any folder.

const MODULES = ["./bible-rs/index.js", "./hidden-word/index.js"];

let loaded = null;

/** The folder formats that are here. */
export function loadAdapters() {
  loaded ??= Promise.all(MODULES.map((m) => import(m).then((mod) => mod.default, () => null))).then((all) => all.filter(Boolean));
  return loaded;
}

/** The format to sync `tree` with. */
export async function formatFor(tree) {
  for (const f of await loadAdapters()) if (await f.detect(tree).catch(() => false)) return f;
  return null;
}

/** Records from an imported file, by the first format that knows it; null when none does. */
export async function importFile(text) {
  for (const f of await loadAdapters()) {
    const records = f.importFile?.(text);
    if (records) return records;
  }
  return null;
}
