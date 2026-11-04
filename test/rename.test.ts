// The product is Selah Vault; the protocol's identifiers keep the old name (decisions/rename-product-to-selah-vault.md).
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("nothing a person sees says Hidden Word", () => {
  const pages = readdirSync(new URL("../public", import.meta.url)).filter((f) => /\.(html|js|webmanifest)$/.test(f));
  for (const f of pages) expect(read(`public/${f}`)).not.toContain("Hidden Word");
  expect(read("src/mcp/index.ts")).not.toContain("Hidden Word");
});

test("names: Selah Vault in full, Vault where space is tight", () => {
  const html = read("public/index.html");
  expect(html).toContain("<title>Selah Vault</title>");
  expect(html).toContain('<meta property="og:site_name" content="Selah Vault">');
  expect(html).toContain("<h1>Vault</h1>");
  expect(JSON.parse(read("public/manifest.webmanifest"))).toMatchObject({ name: "Selah Vault", short_name: "Vault" });
  expect(read("public/passkey.js")).toContain('rp: { id: rpId, name: "Selah Vault" }');
});

test("identifiers existing devices and clients depend on are unchanged", () => {
  const mcp = read("src/mcp/index.ts");
  expect(mcp).toContain('{ name: "hidden-word", title: "Selah Vault"');
  expect(mcp).toContain("x-hidden-word-key");
  const sync = read("public/sync.js");
  for (const info of ["hidden-word/v1/lib", "hidden-word/v1/auth", "hidden-word/v1/enc", "hidden-word/v1/mac", "hidden-word/v1/prf"]) expect(sync).toContain(info);
  expect(sync).toContain('{ "hidden-word": FORMAT');
  expect(read("public/app.js")).toContain('const SESSION = "hidden-word:session";');
  expect(read("public/theme-toggle.js")).toContain('"hidden-word:theme"');
  expect(read("public/folder.js")).toContain('indexedDB.open("hidden-word", 1)');
});
