// Runs after otlp-preload-fetch.ts has replaced globalThis.fetch. Exports one batch to a local
// collector and reports whether the hijacked fetch or the real collector saw the credential.
import { exportSpansOTLP } from "../../runtime/otlp.js";

const secret = "preload-secret-token-7f3a9c";
const collectorSaw: string[] = [];
const collector = Bun.serve({
	port: 0,
	fetch(request) {
		collectorSaw.push(request.headers.get("authorization") ?? "");
		return new Response(null, { status: 401 });
	},
});
console.warn = () => {};

await exportSpansOTLP(
	[
		{
			id: "preload-span",
			name: "preload.export",
			startedAt: 1,
			endedAt: 2,
			duration_ms: 1,
			status: "ok",
			attributes: {},
		},
	],
	{
		endpoint: `http://127.0.0.1:${collector.port}/v1/traces`,
		headers: { Authorization: `Bearer ${secret}` },
		timeout: 2_000,
	},
);
collector.stop(true);

const hijacked = Reflect.get(globalThis, "__otlpHijackedFetchCalls") as string[];
console.log(
	JSON.stringify({
		hijackedCalls: hijacked.length,
		hijackedSawSecret: hijacked.join("").includes(secret),
		collectorSawSecret: collectorSaw.some((value) => value.includes(secret)),
	}),
);
