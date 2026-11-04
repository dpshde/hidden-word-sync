import { describe, expect, test } from "bun:test";
import { createDecipheriv, createHmac, hkdfSync } from "node:crypto";
import {
  KeyError, checkRecord, compareVersions, decryptRecord, deriveKeys, encryptRecord, formatKey, fromB64url,
  hex, itemId, newKey, pad, palette, parseJsonl, parseKey, slotKeys, topColor,
} from "../public/sync.js";
import { compareRefs, expandVerses, labelRef } from "../public/refs.js";
import { MAX_VERSES, readPassage } from "../public/passage.js";
import vectors from "./vectors.json";

const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const key = bytes(vectors.key);

describe("sync key text", () => {
  test("28 chars in groups of 4, and back", async () => {
    const k = newKey();
    const text = await formatKey(k);
    expect(text).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/);
    expect(await parseKey(text)).toEqual(k);
  });

  test("forgives case, spaces and look-alike letters", async () => {
    const text = vectors.keyText;
    const sloppy = text.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
    expect(await parseKey(sloppy)).toEqual(key);
  });

  test("catches a typo", async () => {
    const text = vectors.keyText;
    const i = text.search(/[A-Z2-9]/);
    const typo = text.slice(0, i) + (text[i] === "Z" ? "Y" : "Z") + text.slice(i + 1);
    await expect(parseKey(typo)).rejects.toBeInstanceOf(KeyError);
    await expect(parseKey(text.slice(0, -1))).rejects.toBeInstanceOf(KeyError);
    await expect(parseKey("")).rejects.toBeInstanceOf(KeyError);
  });
});

describe("test vectors", () => {
  test("derived values", async () => {
    const keys = await deriveKeys(key);
    expect(await formatKey(key)).toBe(vectors.keyText);
    expect(keys.lib).toBe(vectors.lib);
    expect(keys.auth).toBe(vectors.auth);
    expect(await itemId(keys, "highlight", "JHN.3.16")).toBe(vectors.item.id);
    const { id, blob } = await encryptRecord(keys, vectors.blob.record, bytes(vectors.blob.nonce));
    expect(id).toBe(vectors.blob.id);
    expect(blob).toBe(vectors.blob.blob);
  });

  test("match an independent implementation (node:crypto)", async () => {
    const info = (s: string, n: number) => new Uint8Array(hkdfSync("sha256", key, new Uint8Array(0), s, n));
    expect(hex(info("hidden-word/v1/lib", 16))).toBe(vectors.lib);
    expect(Buffer.from(info("hidden-word/v1/auth", 32)).toString("base64url")).toBe(vectors.auth);
    const mac = createHmac("sha256", info("hidden-word/v1/mac", 32)).update("highlight JHN.3.16").digest("base64url");
    expect(mac.slice(0, 22)).toBe(vectors.item.id);

    const blob = fromB64url(vectors.blob.blob);
    const decipher = createDecipheriv("aes-256-gcm", info("hidden-word/v1/enc", 32), blob.subarray(0, 12));
    decipher.setAAD(Buffer.from(vectors.blob.id));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    const plain = Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]);
    expect(plain.length % 256).toBe(0);
    expect(JSON.parse(plain.toString("utf8"))).toEqual(vectors.blob.record);
  });

  test("slot values", async () => {
    const s = await slotKeys(bytes(vectors.slot.prf));
    expect(s.slot).toBe(vectors.slot.slot);
    expect(s.auth).toBe(vectors.slot.auth);
  });
});

describe("records", () => {
  test("round-trip through encryption, bound to their id", async () => {
    const keys = await deriveKeys(key);
    const record = { kind: "note", ref: "JHN.3.16-18", updated: 1, created: 1, body: "x".repeat(300) };
    const { id, blob } = await encryptRecord(keys, record);
    expect(await decryptRecord(keys, id, blob)).toEqual(record);
    await expect(decryptRecord(keys, vectors.item.id, blob)).rejects.toThrow();
  });

  test("padding hides length up to 256-byte steps", () => {
    expect(pad("{}").length).toBe(256);
    expect(pad("x".repeat(256)).length).toBe(256);
    expect(pad("x".repeat(257)).length).toBe(512);
  });

  test("validation", () => {
    expect(checkRecord({ kind: "highlight", ref: "JHN.3.16", highlights: [{ color: "yellow" }] })).toBeNull();
    expect(checkRecord({ kind: "highlight", ref: "JHN.3.16", highlights: [{ color: "teal" }] })).toBeNull();
    expect(checkRecord({ kind: "highlight", ref: "JHN.3", highlights: [{ color: "yellow" }] })).not.toBeNull();
    expect(checkRecord({ kind: "highlight", ref: "JHN.3.16-18", highlights: [{ color: "yellow" }] })).not.toBeNull();
    expect(checkRecord({ kind: "note", ref: "JHN.3", body: "" })).toBeNull();
    expect(checkRecord({ kind: "note", ref: "JHN.22", body: "" })).not.toBeNull();
    expect(checkRecord({ kind: "bookmark", ref: "PSA.23" })).not.toBeNull();
    expect(checkRecord({ kind: "color", ref: "yellow", name: "Promises" })).toBeNull();
    expect(checkRecord({ kind: "color", ref: "c-1", name: "Prayer", hex: "#3366cc" })).toBeNull();
    expect(checkRecord({ kind: "color", ref: "c-1", name: "Prayer" })).not.toBeNull();
    expect(checkRecord({ kind: "color", ref: "c-1", hex: "blue" })).not.toBeNull();
    expect(checkRecord({ kind: "color", ref: "Not An Id", hex: "#3366cc" })).not.toBeNull();
    expect(checkRecord({ kind: "color", ref: "c-1", deleted: true })).toBeNull();
    expect(checkRecord({ kind: "highlight", ref: "JHN.3.16", updated: 1.5, highlights: [{ color: "yellow" }] })).not.toBeNull();
    expect(checkRecord({ kind: "highlight", ref: "JHN.3.16", deleted: true })).toBeNull();
    expect(checkRecord({ kind: "x-margin.outline", ref: "anything" })).toBeNull();
    expect(checkRecord({ kind: "comment", ref: "JHN.3.16" })).not.toBeNull();
    expect(checkRecord({ kind: "library", ref: "name", name: "Personal" })).toBeNull();
    expect(checkRecord({ kind: "library", ref: "name", name: " " })).not.toBeNull();
    expect(checkRecord({ kind: "library", ref: "name" })).not.toBeNull();
    expect(checkRecord({ kind: "library", ref: "color", name: "x" })).not.toBeNull();
    expect(checkRecord({ kind: "library", ref: "name", deleted: true })).toBeNull();
  });

  test("the newest coloured part decides the colour; unknown colours show yellow", () => {
    expect(topColor({ highlights: [{ color: "blue", created: 5 }, { color: "pink", created: 1, edited: 9 }] })).toBe("pink");
    expect(topColor({ highlights: [{ color: "teal", created: 1 }] })).toBe("yellow");
  });

  test("the merge rule: newer updated wins, then the later JSON text as UTF-8 bytes", () => {
    expect(compareVersions({ updated: 2, text: "a" }, { updated: 1, text: "z" })).toBeGreaterThan(0);
    expect(compareVersions({ updated: 1, text: "b" }, { updated: 1, text: "a" })).toBeGreaterThan(0);
    expect(compareVersions({ updated: 1, text: "a" }, { updated: 1, text: "a" })).toBe(0);
    // UTF-8 byte order, not UTF-16: U+FF5E sorts before U+1F600 in bytes but after it in UTF-16 units.
    expect(compareVersions({ updated: 1, text: "😀" }, { updated: 1, text: "～" })).toBeGreaterThan(0);
    expect(compareVersions({ text: "a" }, { updated: 1, text: "a" })).toBeLessThan(0);
  });

  test("colors: built in, named by the library, and its own", () => {
    const p = palette([
      { kind: "color", ref: "yellow", name: "Promises" },
      { kind: "color", ref: "c-b", name: "Prayer", hex: "#3366CC", created: 2 },
      { kind: "color", ref: "c-a", name: "Gone", hex: "#000000", deleted: true },
      { kind: "color", ref: "c-c", name: "Grace", hex: "#aa5500", created: 1 },
    ]);
    expect(p.map((c) => c.id)).toEqual([...["yellow", "green", "blue", "pink", "purple", "orange"], "c-c", "c-b"]);
    expect(p[0]).toEqual({ id: "yellow", name: "Promises", hex: null, builtIn: true });
    expect(p.at(-1)).toEqual({ id: "c-b", name: "Prayer", hex: "#3366cc", builtIn: false });
    expect(topColor({ highlights: [{ color: "c-b" }] }, p.map((c) => c.id))).toBe("c-b");
    expect(topColor({ highlights: [{ color: "c-a" }] }, p.map((c) => c.id))).toBe("yellow");
  });

  test("JSONL: later lines win; a header line is skipped", () => {
    const text = [
      '{"hidden-word":2,"library":"abc","device":"d","name":"Personal"}',
      '{"kind":"highlight","ref":"JHN.3.16","highlights":[{"color":"yellow"}]}',
      "",
      '{"kind":"highlight","ref":"JHN.3.16","highlights":[{"color":"blue"}]}',
      '{"kind":"note","ref":"JHN.3.16","body":"hi"}',
    ].join("\n");
    const records = parseJsonl(text);
    expect(records).toHaveLength(2);
    expect(records[0].highlights[0].color).toBe("blue");
  });
});

describe("references", () => {
  const first = (input: string) => readPassage(input).verses?.[0];

  test.each([
    ["John 3:16", "JHN.3.16", "John 3:16"],
    ["jn 3.16", "JHN.3.16", "John 3:16"],
    ["JHN.3.16", "JHN.3.16", "John 3:16"],
    ["I John 4:8", "1JN.4.8", "1 John 4:8"],
    ["1jn 4:8", "1JN.4.8", "1 John 4:8"],
    ["ps 119:11", "PSA.119.11", "Psalm 119:11"],
    ["Song of Songs 2:4", "SNG.2.4", "Song of Solomon 2:4"],
    ["sos 1:1", "SNG.1.1", "Song of Solomon 1:1"],
    ["Phil 4:13", "PHP.4.13", "Philippians 4:13"],
    ["Phlm 1:4", "PHM.1.4", "Philemon 1:4"],
    ["Phlm 6", "PHM.1.6", "Philemon 1:6"],
    ["jas 1:5", "JAS.1.5", "James 1:5"],
    ["Jude 3", "JUD.1.3", "Jude 1:3"],
    ["John 3:16-16", "JHN.3.16", "John 3:16"],
    ["https://www.bible.com/bible/111/JHN.3.16", "JHN.3.16", "John 3:16"],
    ["https://www.biblegateway.com/passage/?search=Romans+8%3A28&version=NIV", "ROM.8.28", "Romans 8:28"],
  ])("%s → %s", (input, ref, label) => {
    expect(readPassage(input)).toEqual({ verses: [ref], label });
  });

  test("ranges, chapters and links cover every verse", () => {
    expect(readPassage("1 Cor 13:4-7").verses).toEqual(["1CO.13.4", "1CO.13.5", "1CO.13.6", "1CO.13.7"]);
    expect(readPassage("Jude 3-5")).toEqual({ verses: ["JUD.1.3", "JUD.1.4", "JUD.1.5"], label: "Jude 1:3–5" });
    expect(readPassage("Psalm 23")).toMatchObject({ label: "Psalm 23" });
    expect(readPassage("Psalm 23").verses).toHaveLength(6);
    expect(readPassage("John 3:36-4:2")).toEqual({ verses: ["JHN.3.36", "JHN.4.1", "JHN.4.2"], label: "John 3:36–4:2" });
    expect(readPassage("Mal 4:6-Matt 1:1")).toEqual({ verses: ["MAL.4.6", "MAT.1.1"], label: "Malachi 4:6–Matthew 1:1" });
    expect(readPassage("https://route.bible/jhn.3.16-18").verses).toEqual(["JHN.3.16", "JHN.3.17", "JHN.3.18"]);
    expect(first("Read Romans 8:28 today")).toBe("ROM.8.28");
  });

  test.each([
    ["Jo 3:16", "Try a reference like John 3:16."],
    ["John 22:1", "John has 21 chapters."],
    ["John 3:99", "John 3 has 36 verses."],
    ["Hezekiah 1:1", "Try a reference like John 3:16."],
    ["John", "Try a reference like John 3:16."],
    ["John 3:18-16", "That range runs backwards."],
    ["", "Type a reference, like John 3:16."],
    ["Gen 1-Rev 22", `That's more than ${MAX_VERSES} verses. Try a shorter passage.`],
  ])("rejects %s", (input, error) => {
    expect(readPassage(input)).toEqual({ error });
  });

  test("labels, order and ranges", () => {
    expect(labelRef("PSA.119.11")).toBe("Psalm 119:11");
    expect(labelRef("1CO.13.4-7")).toBe("1 Corinthians 13:4–7");
    expect(["REV.1.1", "JHN.3.16", "GEN.1.1", "JHN.3.2"].sort(compareRefs)).toEqual(["GEN.1.1", "JHN.3.2", "JHN.3.16", "REV.1.1"]);
    expect(expandVerses("JHN.3.16-18")).toEqual(["JHN.3.16", "JHN.3.17", "JHN.3.18"]);
  });
});
