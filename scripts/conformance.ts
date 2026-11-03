// bun run conformance <base-url>: checks a Hidden Word server against SPEC.md section 5. It makes
// one library with a fresh random key, and deletes it at the end.
import { checkServer } from "../conformance/server.js";

const base = process.argv[2];
if (!base || !/^https?:\/\//.test(base)) {
  console.error("Usage: bun run conformance <base-url>   e.g. http://localhost:8787");
  process.exit(2);
}
console.log(`Checking ${base} (one throwaway library, deleted at the end)`);
const { passed, failed } = await checkServer({
  base,
  log: (r: { ok: boolean; name: string; detail: string }) => console.log(`${r.ok ? "pass" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.detail}`}`),
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
