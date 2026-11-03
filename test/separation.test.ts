// Hidden Word's core doesn't depend on any sync adapter but its own folder format: it builds and its
// tests pass with the bible-rs adapter (public/adapters/bible-rs, test/adapters/bible-rs) deleted.

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

function files(dir: string, keep: (p: string) => boolean): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? files(p, keep) : keep(p) ? [p] : [];
  });
}

describe("the core and its adapters", () => {
  test("no core file imports an adapter, names bible-rs, or reaches into public/adapters but for its plugin list", () => {
    const core = [
      ...files("public", (p) => !p.startsWith("public/adapters/") && /\.(js|html)$/.test(p) && !p.startsWith("public/vendor/")),
      ...files("src", (p) => p.endsWith(".ts")),
    ];
    expect(core.length).toBeGreaterThan(5);
    for (const f of core) {
      const text = readFileSync(join(ROOT, f), "utf8");
      expect([f, /bible-?rs|biblers/i.test(text)]).toEqual([f, false]);
      for (const [, spec] of text.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) {
        if (spec.includes("adapters/")) expect([f, spec]).toEqual([f, "./adapters/index.js"]);
      }
    }
  });

  test.skipIf(Boolean(process.env.HW_WITHOUT_ADAPTERS))("with the bible-rs adapter deleted, Hidden Word builds, typechecks and passes its tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-core-"));
    try {
      cpSync(ROOT, dir, {
        recursive: true,
        filter: (src) => {
          const p = relative(ROOT, src);
          return !/^(node_modules|\.git)(\/|$)/.test(p) && !/^(public|test)\/adapters\/bible-rs(\/|$)/.test(p);
        },
      });
      symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
      const env = { ...process.env, HW_WITHOUT_ADAPTERS: "1", HWCOMPAT: "" };
      const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" });
      const formats = run("bun", ["-e", 'const m = await import("./public/adapters/index.js"); console.log((await m.loadAdapters()).map((f) => f.id).join())']);
      expect(formats.trim()).toBe("hidden-word");
      run("bun", ["build", "public/app.js", "--outdir", join(dir, ".build")]);
      run("bun", ["run", "check"]);
      const tests = spawnSync("bun", ["test"], { cwd: dir, env, encoding: "utf8" });
      const summary = `${tests.stdout}${tests.stderr}`;
      expect(tests.status).toBe(0);
      expect(summary).toMatch(/ 0 fail/);
      expect(Number(/(\d+) pass/.exec(summary)?.[1])).toBeGreaterThan(60);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
