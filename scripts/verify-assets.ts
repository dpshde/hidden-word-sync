// Post-deploy check: every file in public/ must come back 200, with the right Content-Type and the
// exact bytes, and every module the home page imports (recursively) must be served as JavaScript.
// Workers Assets keeps the Content-Type a blob had when its hash was first uploaded, so a stale
// blob can be reused silently (2026-11-04 blank screen). Usage: bun scripts/verify-assets.ts <origin>
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const origin = (process.argv[2] ?? "").replace(/\/$/, "");
if (!origin) throw new Error("usage: bun scripts/verify-assets.ts https://origin");
const bust = `cb=${Date.now()}`;
const TYPES: Record<string, RegExp> = {
	".js": /javascript/, ".css": /^text\/css/, ".html": /^text\/html/, ".json": /json/,
	".webmanifest": /manifest\+json|json/, ".svg": /^image\/svg\+xml/, ".png": /^image\/png/,
	".ico": /^image\/(x-icon|vnd\.microsoft\.icon)/, ".webp": /^image\/webp/, ".woff2": /^font\/woff2/,
	".txt": /^text\/plain/, ".md": /^text\/markdown/,
};
const root = new URL("../public", import.meta.url).pathname;
const walk = (d: string): string[] =>
	readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const fails: string[] = [];
let passed = 0;

async function check(path: string, local: Buffer, ext: string) {
	const res = await fetch(`${origin}${path}?${bust}`);
	const type = res.headers.get("content-type") ?? "";
	const body = Buffer.from(await res.arrayBuffer());
	const want = TYPES[ext];
	if (res.status !== 200) fails.push(`${path}: HTTP ${res.status}`);
	else if (want && !want.test(type)) fails.push(`${path}: content-type ${type}`);
	else if (!body.equals(local)) fails.push(`${path}: bytes differ`);
	else passed++;
}

const files = walk(root).filter((f) => !f.endsWith("/_headers"));
for (const f of files) {
	const rel = "/" + relative(root, f);
	// .html pages redirect to their clean URL; check them there.
	const path = rel === "/index.html" ? "/" : rel.endsWith(".html") ? rel.slice(0, -5) : rel;
	await check(path, readFileSync(f), extname(f));
}

// Module graph from /: every import must be JavaScript.
const seen = new Set<string>();
async function crawl(url: string) {
	if (seen.has(url)) return;
	seen.add(url);
	const res = await fetch(`${url}?${bust}`);
	const text = await res.text();
	const type = res.headers.get("content-type") ?? "";
	if (url !== `${origin}/` && !/javascript/.test(type)) fails.push(`module ${url}: ${res.status} ${type}`);
	const re = url.endsWith("/")
		? /<script[^>]+type="module"[^>]+src="([^"]+)"/g
		: /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(?\s*["']([^"']+)["']/g;
	for (const m of text.matchAll(re)) {
		const spec = m[1] ?? m[2];
		if (spec && (spec.startsWith(".") || spec.startsWith("/"))) await crawl(new URL(spec, url).href.split("?")[0]);
	}
}
await crawl(`${origin}/`);

console.log(`${passed}/${files.length} files ok, ${seen.size - 1} modules crawled`);
if (fails.length) {
	console.error(fails.join("\n"));
	process.exit(1);
}
