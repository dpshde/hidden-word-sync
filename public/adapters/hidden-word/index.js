// Hidden Word's own folder format (spec section 4): each device keeps one readable file,
// `<device>.jsonl`, at the top of the folder, and reads everyone else's.

/**
 * A folder every device can reach (iCloud Drive, Dropbox, Syncthing, a USB stick), as a sync
 * adapter. `tree` is a folder tree (see `memoryTree` in sync.js).
 */
export function folderTransport(tree, name = "folder") {
  return {
    name,
    tree,
    async sync(lib) {
      const r = lib.remote(name);
      const mine = `${lib.device}.jsonl`;
      const files = (await tree.list("")).filter((f) => f.kind === "file");
      let changed = false;
      for (const file of files) {
        if (file.name === mine || !file.name.endsWith(".jsonl") || r.files[file.name] === file.stamp) continue;
        const lines = ((await tree.read(file.name)) ?? "").split(/\r?\n/).filter((l) => l.trim());
        const header = safeJson(lines[0]);
        // Only files written for this library: a folder may hold other libraries' files too.
        if (header?.["hidden-word"] && header.library === lib.lib) {
          for (const line of lines.slice(1)) {
            const record = safeJson(line);
            if (typeof record?.kind !== "string" || typeof record.ref !== "string") continue;
            if ((await lib.offer(record, line, name)) === "newer") changed = true;
          }
        }
        r.files[file.name] = file.stamp;
      }
      if (changed) lib.emit();
      if (lib.seq > r.sent || !files.some((f) => f.name === mine)) {
        const upTo = lib.seq;
        await tree.write(mine, lib.toFile({ deleted: true }));
        r.sent = upTo;
        lib.emit();
      }
    },
    async erase(lib) {
      for (const file of await tree.list("")) {
        if (file.kind !== "file") continue;
        const header = safeJson(((await tree.read(file.name)) ?? "").split("\n", 1)[0]);
        if (header?.library === lib.lib) await tree.remove(file.name);
      }
    },
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The folder format, for public/adapters/index.js. It takes any folder, so it is tried last. */
export default {
  id: "hidden-word",
  label: "Each device keeps a plain file there you can read.",
  detect: async () => true,
  adapter: (tree) => folderTransport(tree),
};
