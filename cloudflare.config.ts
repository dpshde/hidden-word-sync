import { bindings, defineConfig } from "cf/config";

// Before the first deploy: `cf d1 create hidden-word`, put its id below, and add `accountId`.
// Observability is off: the server should keep as little about its users as it can.
export default defineConfig({
	worker: {
		name: "hidden-word",
		compatibilityDate: "2026-09-01",
		entrypoint: "src/worker.ts",
		workersDev: true,
		observability: {
			enabled: false,
		},
		assets: {
			runWorkerFirst: false,
		},
		env: {
			DB: bindings.d1({
				name: "hidden-word",
				id: "00000000-0000-4000-8000-000000000000",
			}),
			ASSETS: bindings.assets(),
		},
	},
});
