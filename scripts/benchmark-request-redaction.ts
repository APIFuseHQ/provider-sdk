import { loadavg } from "node:os";
import { z } from "zod";

import {
	createDiagnosticRedactor,
	redactDiagnosticText,
} from "../src/runtime/diagnostic-redactor.js";
import { createTraceContext, getTraceRecorder } from "../src/runtime/trace.js";
import { createServerApp } from "../src/server/serve.js";
import type { ProviderDefinition } from "../src/types.js";

// Reproduce with: bun scripts/benchmark-request-redaction.ts
// No timing assertions: paired measurements alternate execution order after warmup.
const values = [
	"selftest-master-current-cedar8792",
	"selftest-master-previous-maple4861",
	"provider-wordkey1234",
	"provider-client-secret-pine2468",
	"health-probe-credential-birch8642",
	"connection-access-token-elm1753",
	"connection-refresh-token-oak3571",
	"connection-password-willow5791",
	"proxy-app-key-aspen9137",
	"proxy-username-hazel7319",
	"proxy-password-rowan2973",
	"d6de955a-3a2f-4bbc-8f07-d7a355c349de",
	"73af0460016ded89dfe3786b9e320aca",
	"solver-capsolver-credential-cedar2739",
	"solver-capmonster-credential-pine3972",
	"solver-hyper-credential-oak9723",
	"choice-master-secret-maple7293",
	"request-param-value-elm9327",
	"request-param-value-lime2379",
	"request-param-value-ash7932",
];
const spanCount = 1000;
const warmupTrials = 20;
const measuredTrials = 80;
const registry = createDiagnosticRedactor(values);
const redact = (text: string) => redactDiagnosticText(text, registry.redact);
const workloads = Array.from({ length: spanCount }, (_, index) => ({
	name: ["http.request", "browser.goto", "state.get", "resolver.solve"][index % 4],
	attributes: {
		url: `https://api.example.test/v1/${index % 4 === 0 ? values[index % values.length] : "catalog"}/items`,
		method: "GET",
		key: index % 4 === 2 ? `session:${values[index % values.length]}` : "catalog:products",
		selector: "main [data-product-id] .product-name",
		attempt: 1,
		cached: false,
	},
}));

function percentile(samples: readonly number[], proportion: number): number {
	const sorted = [...samples].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * proportion) - 1];
}

function distribution(samples: readonly number[]): { p50: number; p95: number } {
	return {
		p50: Number(percentile(samples, 0.5).toFixed(4)),
		p95: Number(percentile(samples, 0.95).toFixed(4)),
	};
}

async function measureSpans(redacted: boolean): Promise<number> {
	Bun.gc(true);
	const trace = createTraceContext({ maxSpans: spanCount, ...(redacted ? { redact } : {}) });
	const recorder = getTraceRecorder(trace);
	if (!recorder) throw new Error("Missing trace recorder");
	const start = performance.now();
	for (const workload of workloads) {
		await recorder.runSpan(workload.name, () => 200, {
			attributes: workload.attributes,
			onSuccess: (status) => ({ status, outcome: "completed" }),
		});
	}
	const durationMs = performance.now() - start;
	const spans = trace.getSpans();
	if (spans.length !== spanCount) throw new Error("Benchmark did not record 1000 spans");
	if (redacted && values.some((value) => JSON.stringify(spans).includes(value))) {
		throw new Error("Benchmark spans contained an unredacted value");
	}
	return durationMs;
}

const plainMs: number[] = [];
const redactedMs: number[] = [];
const addedMs: number[] = [];
for (let trial = 0; trial < warmupTrials + measuredTrials; trial++) {
	const plainFirst = trial % 2 === 0;
	const first = await measureSpans(!plainFirst);
	const second = await measureSpans(plainFirst);
	if (trial < warmupTrials) continue;
	const plain = plainFirst ? first : second;
	const redacted = plainFirst ? second : first;
	plainMs.push(plain);
	redactedMs.push(redacted);
	addedMs.push(redacted - plain);
}

// serve-http.test.ts "dispatches operation handlers" has no timing benchmark.
// This is its in-process echo/connection dispatch shape, measured separately here.
const provider: ProviderDefinition = {
	id: "redaction-cost-provider",
	version: "1.0.0",
	runtime: "standard",
	runtimeTarget: "vanilla",
	meta: {
		displayName: "Redaction cost provider",
		descriptionKey: "redaction.cost",
		category: "test",
	},
	credential: { keys: ["token"] },
	operations: {
		echo: {
			riskClass: "read",
			input: z.object({ value: z.string() }),
			output: z.object({ echoed: z.string(), secret: z.string().optional() }),
			handler: async (ctx, input) => ({
				echoed: z.object({ value: z.string() }).parse(input).value,
				secret: ctx.credential.get("token"),
			}),
		},
	},
};
const app = createServerApp(provider, { logger: () => {} });
const requestBody = JSON.stringify({
	requestId: "redaction-cost-request",
	input: { value: "hello" },
	connection: {
		id: "redaction-cost-connection",
		mode: "credentials",
		externalRef: "redaction-cost-external",
		secrets: {
			token: values[0],
			...Object.fromEntries(values.slice(1).map((value, index) => [`key${index}`, value])),
		},
		metadata: {},
	},
});
const requestMs: number[] = [];
for (let trial = 0; trial < 400; trial++) {
	const start = performance.now();
	const response = await app.request("/v1/echo", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: requestBody,
	});
	const result: unknown = await response.json();
	const durationMs = performance.now() - start;
	if (response.status !== 200 || !JSON.stringify(result).includes('"echoed":"hello"')) {
		throw new Error(`Request benchmark failed: ${response.status} ${JSON.stringify(result)}`);
	}
	if (trial >= 100) requestMs.push(durationMs);
}
console.log(
	JSON.stringify(
		{
			bun: Bun.version,
			loadAverage: loadavg(),
			secretCount: values.length,
			spanCount,
			warmupTrials,
			measuredTrials,
			method: "Alternating paired 1000-span trials; five string attributes; GC outside timing",
			plain1000SpansMs: distribution(plainMs),
			redacted1000SpansMs: distribution(redactedMs),
			added1000SpansMs: distribution(addedMs),
			addedPerSpanMicros: distribution(addedMs.map((value) => (value * 1000) / spanCount)),
			comparison:
				"serve-http dispatches operation handlers echo shape; no baseline benchmark exists",
			echoRequestMs: distribution(requestMs),
			addedOneSpanPercentOfEchoRequestP50: Number(
				((percentile(addedMs, 0.5) / spanCount / percentile(requestMs, 0.5)) * 100).toFixed(4),
			),
			added1000SpansPercentOfEchoRequestP50: Number(
				((percentile(addedMs, 0.5) / percentile(requestMs, 0.5)) * 100).toFixed(4),
			),
		},
		null,
		2,
	),
);
