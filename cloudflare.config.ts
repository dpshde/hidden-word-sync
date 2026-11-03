import { bindings, defineConfig } from "cf/config";

// To deploy to another account: `cf d1 create --name hidden-word`, and put its id and your account id below.
// Observability keeps as little about users as it can (docs/observability.md). Logs are the Worker's
// own redacted lines (src/observe.ts); Cloudflare's invocation logs are off, since they record the
// request itself. Traces record timings and fixed span attributes (no auth headers, no bodies), and
// query strings are stripped from every URL in both, so a /save?ref=… link leaves no reference.
export default defineConfig({
	accountId: "91ff2c2b757414041aeaa00896a8a43f",
	worker: {
		name: "hidden-word",
		compatibilityDate: "2026-09-01",
		entrypoint: "src/worker.ts",
		workersDev: true,
		observability: {
			enabled: true,
			redactQueryString: true,
			logs: { enabled: true, headSamplingRate: 1, invocationLogs: false },
			traces: { enabled: true, headSamplingRate: 1 },
			issues: { enabled: true },
		},
		assets: {
			runWorkerFirst: false,
		},
		env: {
			DB: bindings.d1({
				name: "hidden-word",
				id: "4e60d989-d13b-4884-ad5c-1366f4c73f00",
			}),
			ASSETS: bindings.assets(),
		},
	},
});
