import { bindings, defineConfig } from "cf/config";

// To deploy to another account: `cf d1 create --name hidden-word`, and put its id and your account id below.
// Observability is off: the server should keep as little about its users as it can.
export default defineConfig({
	accountId: "91ff2c2b757414041aeaa00896a8a43f",
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
				id: "4e60d989-d13b-4884-ad5c-1366f4c73f00",
			}),
			ASSETS: bindings.assets(),
		},
	},
});
