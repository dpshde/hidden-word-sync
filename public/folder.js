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

/** The folder as paths, in the shape `bibleRsTransport` takes (a bible-rs Study Library has subfolders). */
export function folderTree(handle) {
  const parts = (path) => path.split("/").filter(Boolean);
  async function dir(names, create = false) {
    let d = handle;
    for (const name of names) d = await d.getDirectoryHandle(name, { create });
    return d;
  }
  const missing = (e) => e?.name === "NotFoundError" || e?.name === "TypeMismatchError";
  return {
    async list(path) {
      const out = [];
      try {
        for await (const [name, entry] of (await dir(parts(path))).entries()) {
          if (entry.kind === "directory") out.push({ name, kind: "directory" });
          else {
            const file = await entry.getFile();
            out.push({ name, kind: "file", stamp: `${file.size}-${file.lastModified}` });
          }
        }
      } catch (e) {
        if (!missing(e)) throw e;
      }
      return out;
    },
    async read(path) {
      const names = parts(path);
      try {
        const file = await (await (await dir(names.slice(0, -1))).getFileHandle(names.at(-1))).getFile();
        return await file.text();
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    async write(path, text) {
      const names = parts(path);
      // createWritable writes to a temporary file and swaps it in on close.
      const w = await (await (await dir(names.slice(0, -1), true)).getFileHandle(names.at(-1), { create: true })).createWritable();
      await w.write(text);
      await w.close();
    },
    async remove(path) {
      const names = parts(path);
      try {
        await (await dir(names.slice(0, -1))).removeEntry(names.at(-1), { recursive: true });
      } catch (e) {
        if (!missing(e)) throw e;
      }
    },
  };
}
