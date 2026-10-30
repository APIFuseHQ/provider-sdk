import { afterAll, describe, expect, it } from "bun:test";
import { z } from "zod";

import type { ProviderServerLogEvent } from "../server/index.js";
import type { StatefulProviderMetricEmitter } from "../stateful/index.js";
import type { ProviderDefinition } from "../types.js";

// A provider pod assembled from the built SDK artifact through the package's
// entry points, the way a provider image imports it: serve() from
// `@apifuse/provider-sdk/server` and the process metric registry from
// `@apifuse/provider-sdk/stateful`. The provider's own write ledger takes a
// metricEmitter, like the KakaoTalk provider's, and the provider passes the
// exported registry. Its operation runs inside the real serve() runtime, and
// the counts come out of the pod's real metrics listener, the one that also
// renders the routing counters.
const builtServerSpecifier: string = "../../dist/server/index.js";
const builtServer: Promise<typeof import("../server/index.js")> = import(builtServerSpecifier);
const { PROVIDER_METRICS_CONTENT_TYPE, PROVIDER_METRICS_ROUTE, serve } = await builtServer;

const builtStatefulSpecifier: string = "../../dist/stateful/index.js";
const builtStateful: Promise<typeof import("../stateful/index.js")> = import(
	builtStatefulSpecifier
);
const statefulEntry = await builtStateful;
const { buildSessionKey, statefulProviderMetricRegistry } = statefulEntry;

const PROVIDER_ID = "metric-registry-export-assembly";
const WRITE_OPERATION_ID = "send-message";

const sessionKey = buildSessionKey({
	providerId: PROVIDER_ID,
	serviceAccountId: "account-1",
	connectionId: "connection-1",
});

const WRITE_LEDGER_OUTCOMES = ["delivered", "not_found", "uncertain"] as const;
type WriteLedgerOutcome = (typeof WRITE_LEDGER_OUTCOMES)[number];

// The provider's write ledger metrics: it counts each write's ledger outcome
// through the emitter it is given, with the labels the provider has at hand,
// the raw session key among them.
function countWriteLedgerOutcome(input: {
	readonly metricEmitter?: StatefulProviderMetricEmitter;
	readonly operationId: string;
	readonly outcome: WriteLedgerOutcome;
	readonly errorCode?: string;
}): void {
	const labels = {
		providerId: PROVIDER_ID,
		sessionKey,
		operationId: input.operationId,
		ledgerState: input.outcome,
	};
	if (input.outcome === "delivered") {
		input.metricEmitter?.increment(
			"apifuse_stateful_provider_write_ledger_reconciled_total",
			labels,
		);
		return;
	}
	if (input.outcome === "not_found") {
		input.metricEmitter?.increment("apifuse_stateful_provider_write_ledger_failed_total", labels);
		return;
	}
	input.metricEmitter?.increment("apifuse_stateful_provider_write_ledger_ambiguous_total", {
		...labels,
		...(input.errorCode ? { redactedErrorCode: input.errorCode } : {}),
	});
}

const provider: ProviderDefinition = {
	allowedHosts: ["example.com"],
	reviewed: "community",
	id: PROVIDER_ID,
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Metric Registry Export Assembly",
		descriptionKey: "metric-registry-export-assembly.description",
		category: "test",
	},
	operations: {
		[WRITE_OPERATION_ID]: {
			riskClass: "write" as const,
			descriptionKey: "operations.WRITEOPERATIONID.description",
			input: z.object({
				outcome: z.enum(WRITE_LEDGER_OUTCOMES),
				errorCode: z.string().optional(),
			}),
			output: z.object({ ok: z.boolean() }),
			handler: async (_ctx, input: { outcome: WriteLedgerOutcome; errorCode?: string }) => {
				countWriteLedgerOutcome({
					metricEmitter: statefulProviderMetricRegistry,
					operationId: WRITE_OPERATION_ID,
					outcome: input.outcome,
					...(input.errorCode ? { errorCode: input.errorCode } : {}),
				});
				return { ok: true };
			},
		},
	},
};

const events: ProviderServerLogEvent[] = [];
const handle = await serve(provider, {
	host: "127.0.0.1",
	port: 0,
	metricsPort: 0,
	logger: (event) => events.push(event),
	shutdown: { signals: false },
});
const endpoint = `http://127.0.0.1:${handle.port}`;
const metricsEndpoint = `http://127.0.0.1:${handle.metricsPort}`;

afterAll(async () => {
	await handle.close({ timeoutMs: 5_000 });
});

async function write(
	requestId: string,
	input: { outcome: WriteLedgerOutcome; errorCode?: string },
): Promise<number> {
	const response = await fetch(`${endpoint}/v1/${WRITE_OPERATION_ID}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId, input }),
	});
	await response.text();
	return response.status;
}

type Scrape = {
	readonly status: number;
	readonly contentType: string | null;
	readonly body: string;
};

async function scrape(): Promise<Scrape> {
	const response = await fetch(`${metricsEndpoint}${PROVIDER_METRICS_ROUTE}`);
	return {
		status: response.status,
		contentType: response.headers.get("content-type"),
		body: await response.text(),
	};
}

describe("the process metric registry exported from the stateful entry point", () => {
	it("serves the write ledger outcomes a provider operation counted through it on the pod's metrics listener", async () => {
		expect(await write("write-not-found-1", { outcome: "not_found" })).toBe(200);
		expect(await write("write-not-found-2", { outcome: "not_found" })).toBe(200);
		expect(await write("write-delivered", { outcome: "delivered" })).toBe(200);
		expect(
			await write("write-uncertain", { outcome: "uncertain", errorCode: "upstream_timeout" }),
		).toBe(200);

		const scraped = await scrape();
		expect(scraped.status).toBe(200);
		expect(scraped.contentType).toBe(PROVIDER_METRICS_CONTENT_TYPE);
		// Each outcome under the exported labels only, in the allowlist's order.
		expect(scraped.body).toContain(
			`apifuse_stateful_provider_write_ledger_failed_total{providerId="${PROVIDER_ID}",operationId="${WRITE_OPERATION_ID}",ledgerState="not_found"} 2\n`,
		);
		expect(scraped.body).toContain(
			`apifuse_stateful_provider_write_ledger_reconciled_total{providerId="${PROVIDER_ID}",operationId="${WRITE_OPERATION_ID}",ledgerState="delivered"} 1\n`,
		);
		expect(scraped.body).toContain(
			`apifuse_stateful_provider_write_ledger_ambiguous_total{providerId="${PROVIDER_ID}",operationId="${WRITE_OPERATION_ID}",redactedErrorCode="upstream_timeout",ledgerState="uncertain"} 1\n`,
		);
		// The session key the provider passed, and the tenant identifiers in it,
		// never reach a series; neither do the request identifiers.
		expect(scraped.body).not.toContain(sessionKey);
		expect(scraped.body).not.toContain("connection-1");
		expect(scraped.body).not.toContain("account-1");
		expect(scraped.body).not.toContain("sessionKey");
		expect(scraped.body).not.toContain("write-not-found-1");
	});

	it("renders a provider's gauges and histogram observations and drops calls outside the contract without throwing", async () => {
		statefulProviderMetricRegistry.gauge(
			"apifuse_stateful_provider_active_sessions",
			{ providerId: PROVIDER_ID, sessionKey },
			3,
		);
		statefulProviderMetricRegistry.gauge(
			"apifuse_stateful_provider_active_sessions",
			{ providerId: PROVIDER_ID, sessionKey },
			2,
		);
		statefulProviderMetricRegistry.observe(
			"apifuse_stateful_provider_session_operation_queue_wait_ms",
			{ providerId: PROVIDER_ID, operationId: WRITE_OPERATION_ID },
			30,
		);
		// A counter call on a gauge's name and a value that is not finite are
		// dropped, as the router's default emitter drops them on the request path.
		expect(() => {
			statefulProviderMetricRegistry.increment(
				"apifuse_stateful_provider_session_operation_queue_depth",
				{ providerId: PROVIDER_ID },
			);
			statefulProviderMetricRegistry.observe(
				"apifuse_stateful_provider_session_operation_queue_wait_ms",
				{ providerId: PROVIDER_ID, operationId: WRITE_OPERATION_ID },
				Number.NaN,
			);
		}).not.toThrow();

		const { body } = await scrape();
		expect(body).toContain(
			`apifuse_stateful_provider_active_sessions{providerId="${PROVIDER_ID}"} 2\n`,
		);
		const labels = `providerId="${PROVIDER_ID}",operationId="${WRITE_OPERATION_ID}"`;
		const histogram = "apifuse_stateful_provider_session_operation_queue_wait_ms";
		expect(body).toContain(`${histogram}_bucket{${labels},le="25"} 0\n`);
		expect(body).toContain(`${histogram}_bucket{${labels},le="50"} 1\n`);
		expect(body).toContain(`${histogram}_bucket{${labels},le="+Inf"} 1\n`);
		expect(body).toContain(`${histogram}_sum{${labels}} 30\n`);
		expect(body).toContain(`${histogram}_count{${labels}} 1\n`);
		expect(body).not.toContain(
			`apifuse_stateful_provider_session_operation_queue_depth{providerId="${PROVIDER_ID}"}`,
		);
	});

	it("exposes only the emitter methods, so provider code cannot render or reset the pod's metrics", async () => {
		expect(Object.keys(statefulProviderMetricRegistry).sort()).toEqual([
			"gauge",
			"increment",
			"observe",
		]);
		expect(Object.isFrozen(statefulProviderMetricRegistry)).toBe(true);
		statefulProviderMetricRegistry.increment(
			"apifuse_stateful_provider_write_ledger_failed_total",
			{
				providerId: PROVIDER_ID,
				operationId: "kept-across-reset-attempt",
				ledgerState: "not_found",
			},
		);
		// @ts-expect-error test-invalid: the entry point types the registry as an emitter, without render().
		expect(() => statefulProviderMetricRegistry.render()).toThrow(TypeError);
		// @ts-expect-error test-invalid: the entry point types the registry as an emitter, without reset().
		expect(() => statefulProviderMetricRegistry.reset()).toThrow(TypeError);
		expect((await scrape()).body).toContain(
			`apifuse_stateful_provider_write_ledger_failed_total{providerId="${PROVIDER_ID}",operationId="kept-across-reset-attempt",ledgerState="not_found"} 1\n`,
		);
		// The class, its tables and the name the view has inside the SDK are not
		// exports of the entry point.
		for (const internal of [
			"StatefulProviderMetricRegistry",
			"statefulProviderMetricRegistryEmitter",
			"STATEFUL_PROVIDER_METRIC_KINDS",
			"STATEFUL_PROVIDER_METRIC_HELP",
			"STATEFUL_PROVIDER_METRIC_EXPORTED_LABELS",
			"STATEFUL_PROVIDER_METRIC_MS_BUCKETS",
		]) {
			expect(Object.hasOwn(statefulEntry, internal)).toBe(false);
		}
	});
});
