// Folder sync in the browser, through the File System Access API (desktop Chrome, Edge, Opera).
// The chosen folder's handle is kept in IndexedDB so it survives reloads; the browser may still ask
// for permission again, which needs a click.

const STORE = "folders";

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("hidden-word", 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const t = conn.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

export const foldersAvailable = () => typeof globalThis.showDirectoryPicker === "function";
export const pickFolder = () => globalThis.showDirectoryPicker({ id: "hidden-word", mode: "readwrite" });
export const saveFolder = (lib, handle) => tx("readwrite", (s) => s.put(handle, lib));
export const loadFolder = (lib) => tx("readonly", (s) => s.get(lib)).catch(() => undefined);
export const forgetFolder = (lib) => tx("readwrite", (s) => s.delete(lib));

/** Whether we may read and write the folder; with `ask`, prompts for it (needs a click). */
export async function mayUse(handle, ask = false) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  return ask && (await handle.requestPermission(opts)) === "granted";
}

/** The folder in the shape `folderTransport` takes. */
export function folderDir(handle) {
  return {
    async list() {
      const out = [];
      for await (const [name, entry] of handle.entries()) {
        if (entry.kind !== "file") continue;
        const file = await entry.getFile();
        out.push({ name, stamp: `${file.lastModified}:${file.size}` });
      }
      return out;
    },
    async read(name) {
      return (await (await handle.getFileHandle(name)).getFile()).text();
    },
    async write(name, text) {
      // createWritable writes to a temporary file and swaps it in on close.
      const w = await (await handle.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    },
    async remove(name) {
      await handle.removeEntry(name);
    },
  };
}
