import { afterAll, describe, expect, it } from "bun:test";
import { z } from "zod";

import {
	PROVIDER_METRICS_CONTENT_TYPE,
	PROVIDER_METRICS_ROUTE,
} from "../server/provider-metrics.js";
import {
	type ProviderServerHandle,
	type ProviderServerOperationExecutor,
	serve,
} from "../server/serve.js";
import {
	buildSessionKey,
	HttpStatefulOwnerForwarder,
	InMemorySessionOwnerRegistry,
	RecordingStatefulProviderMetricEmitter,
	type StatefulProviderAdapter,
	StatefulProviderSessionManager,
	StatefulSessionInvalidatedError,
	StatefulSessionRouter,
	statefulForwardingContextFromProviderRequest,
	withStatefulLocalProviderContext,
} from "../stateful/index.js";
import { statefulProviderMetricRegistry } from "../stateful/stateful-provider-metric-registry.js";
import type { ProviderDefinition } from "../types.js";

// A pod started with serve(), the way a provider's serving runtime composes
// the SDK: its operation executor hands every operation to a real
// StatefulSessionRouter over a real StatefulProviderSessionManager. The
// session manager is built without a metricEmitter, as the stateful README's
// composition and the KakaoTalk serving runtime build it, so the operation
// durations and session invalidations it counts must come out of the pod's
// metrics listener. The only piece that is not the SDK's is the provider's
// session layer: an in-process upstream that can tell its open sessions to
// reconnect elsewhere, the way a LOCO server sends CHANGESVR, and an adapter
// that reports such a session as invalidated.
const PROVIDER_ID = "session-manager-default-metrics-assembly";
const OPERATION_ID = "read-profile";
const INVALIDATION_REASON = "server_moved";
const DURATION_METRIC = "apifuse_stateful_provider_session_operation_duration_ms";
const INVALIDATION_METRIC = "apifuse_stateful_provider_session_invalidations_total";

const provider: ProviderDefinition = {
	id: PROVIDER_ID,
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Session Manager Default Metrics Assembly",
		descriptionKey: "session-manager-default-metrics-assembly.description",
		category: "test",
	},
	operations: {
		[OPERATION_ID]: {
			riskClass: "read" as const,
			input: z.object({}),
			output: z.object({ connection: z.number() }),
			handler: async () => {
				throw new Error("served by the stateful runtime, not the plain handler");
			},
		},
	},
};

const sessionKey = buildSessionKey({
	providerId: PROVIDER_ID,
	serviceAccountId: "account-1",
	connectionId: "connection-1",
});

type UpstreamSession = { readonly connection: number; moved: boolean };

// The upstream: every connect opens a numbered session; moveAll() marks every
// open session as told to reconnect elsewhere.
function makeUpstream() {
	const open = new Set<UpstreamSession>();
	const closed: string[] = [];
	let connections = 0;
	return {
		connect(): UpstreamSession {
			connections += 1;
			const session = { connection: connections, moved: false };
			open.add(session);
			return session;
		},
		close(session: UpstreamSession, reason: string): void {
			open.delete(session);
			closed.push(reason);
		},
		moveAll(): void {
			for (const session of open) session.moved = true;
		},
		get connections() {
			return connections;
		},
		closed,
	};
}

type Upstream = ReturnType<typeof makeUpstream>;

// The provider's session layer: a session told to reconnect elsewhere is
// invalidated before the operation is sent, so the retry is safe.
function movingAdapter(upstream: Upstream): StatefulProviderAdapter<UpstreamSession> {
	return {
		providerId: PROVIDER_ID,
		policy: { concurrency: { mode: "serialize" }, reconnect: "recreate" },
		connect: async () => upstream.connect(),
		invoke: async (_ctx, session) => {
			if (session.moved) {
				throw new StatefulSessionInvalidatedError("Upstream asked the session to reconnect.", {
					reason: INVALIDATION_REASON,
					retryable: true,
				});
			}
			return { output: { connection: session.connection } };
		},
		close: async (_ctx, session, reason) => upstream.close(session, reason),
	};
}

const upstream = makeUpstream();
const registry = new InMemorySessionOwnerRegistry();
// No metricEmitter: the session manager's default is the pod's channel.
const manager = new StatefulProviderSessionManager({
	adapter: movingAdapter(upstream),
	poolPolicy: { maxSessions: 10, idleTimeoutMs: "unlimited", maxLifetimeMs: "unlimited" },
});
let router: StatefulSessionRouter | undefined;

const execute: ProviderServerOperationExecutor = async ({ ctx, request, operationId }) => {
	if (!router) throw new Error("the pod received an operation before its router was wired");
	const result = await router.route({
		requestId: request.requestId,
		sessionKey,
		providerId: PROVIDER_ID,
		operationId,
		connectionId: "connection-1",
		serviceAccountId: "account-1",
		input: request.input,
		runtimeContext: withStatefulLocalProviderContext(
			ctx,
			statefulForwardingContextFromProviderRequest(request),
		),
	});
	return result.output;
};

const handle: ProviderServerHandle = await serve(provider, {
	host: "127.0.0.1",
	port: 0,
	metricsPort: 0,
	logger: () => {},
	operationExecutor: execute,
	shutdown: { signals: false },
});
const endpoint = `http://127.0.0.1:${handle.port}`;
const metricsEndpoint = `http://127.0.0.1:${handle.metricsPort}`;
router = new StatefulSessionRouter({
	currentPod: { podId: "pod-a", endpoint },
	registry,
	forwarder: new HttpStatefulOwnerForwarder({
		currentPodId: "pod-a",
		secret: "session-manager-default-metrics-assembly-forwarding-secret",
	}),
	executor: manager,
	leaseDurationMs: 30_000,
});

afterAll(async () => {
	await handle.close({ timeoutMs: 5_000 });
	await router?.release();
	await manager.closeAll("test-complete");
});

// A gateway caller of the pod.
async function callPod(requestId: string): Promise<{ status: number; body: unknown }> {
	const response = await fetch(`${endpoint}/v1/${OPERATION_ID}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId, input: {} }),
	});
	return { status: response.status, body: await response.json() };
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

// The value of the one series of `name` whose label set is exactly `labels`.
function sampleValue(
	body: string,
	name: string,
	labels: Readonly<Record<string, string>>,
): number | undefined {
	const wanted = Object.entries(labels);
	for (const line of body.split("\n")) {
		if (!line.startsWith(`${name}{`)) continue;
		const match = /^[^{]+\{(.*)\} (\S+)$/.exec(line);
		if (!match) continue;
		const found = new Map<string, string>();
		for (const [, key, value] of match[1].matchAll(
			/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g,
		)) {
			found.set(key, value);
		}
		if (found.size === wanted.length && wanted.every(([key, value]) => found.get(key) === value)) {
			return Number(match[2]);
		}
	}
	return undefined;
}

describe("stateful session manager metrics exported by default on the pod's metrics listener", () => {
	it(
		"exports the operation durations and the invalidation the session manager counted",
		async () => {
			statefulProviderMetricRegistry.reset();
			// The first operation opens the session and succeeds on it.
			expect(await callPod("first-read")).toEqual({
				status: 200,
				body: { data: { connection: 1 } },
			});
			// The upstream tells the open session to reconnect elsewhere. The next
			// operation finds it invalidated; the session manager closes it,
			// reconnects and retries on the new session, so the caller still
			// receives the operation's output.
			upstream.moveAll();
			expect(await callPod("read-after-move")).toEqual({
				status: 200,
				body: { data: { connection: 2 } },
			});
			expect(upstream.connections).toBe(2);
			expect(upstream.closed).toEqual([INVALIDATION_REASON]);

			const scraped = await scrape();
			expect(scraped.status).toBe(200);
			expect(scraped.contentType).toBe(PROVIDER_METRICS_CONTENT_TYPE);
			const operation = { providerId: PROVIDER_ID, operationId: OPERATION_ID };
			// One duration per operation that returned an output, without any
			// emitter wired, under the exported labels only.
			expect(sampleValue(scraped.body, `${DURATION_METRIC}_count`, operation)).toBe(2);
			expect(
				sampleValue(scraped.body, `${DURATION_METRIC}_bucket`, { ...operation, le: "+Inf" }),
			).toBe(2);
			// One invalidation, labelled with the adapter's reason.
			expect(
				sampleValue(scraped.body, INVALIDATION_METRIC, {
					...operation,
					redactedErrorCode: INVALIDATION_REASON,
				}),
			).toBe(1);
			// No per-request, per-session or per-tenant value reaches a series.
			expect(scraped.body).not.toContain("first-read");
			expect(scraped.body).not.toContain("read-after-move");
			expect(scraped.body).not.toContain("connection-1");
			expect(scraped.body).not.toContain("account-1");
			expect(scraped.body).not.toContain("sessionKey");
			expect(scraped.body).not.toContain("pod-a");
		},
		{ timeout: 10_000 },
	);

	it("keeps a session manager given an explicit emitter out of the process registry", async () => {
		const explicitUpstream = makeUpstream();
		const recording = new RecordingStatefulProviderMetricEmitter();
		const explicitManager = new StatefulProviderSessionManager({
			adapter: movingAdapter(explicitUpstream),
			poolPolicy: { maxSessions: 10, idleTimeoutMs: "unlimited", maxLifetimeMs: "unlimited" },
			metricEmitter: recording,
		});
		const explicitKey = buildSessionKey({
			providerId: PROVIDER_ID,
			serviceAccountId: "account-2",
			connectionId: "connection-2",
		});
		const { record: owner } = await registry.acquire({
			sessionKey: explicitKey,
			ownerPodId: "pod-explicit",
			ownerEndpoint: "http://127.0.0.1:1",
			leaseDurationMs: 30_000,
		});
		const operation = (requestId: string) => ({
			requestId,
			sessionKey: explicitKey,
			providerId: PROVIDER_ID,
			operationId: OPERATION_ID,
			connectionId: "connection-2",
			serviceAccountId: "account-2",
			input: {},
		});
		const before = statefulProviderMetricRegistry.render();
		try {
			const signal = new AbortController().signal;
			expect(await explicitManager.invoke(owner, operation("explicit-first"), signal)).toEqual({
				output: { connection: 1 },
			});
			explicitUpstream.moveAll();
			expect(await explicitManager.invoke(owner, operation("explicit-after-move"), signal)).toEqual(
				{ output: { connection: 2 } },
			);
		} finally {
			await explicitManager.closeAll("test-complete");
		}
		expect(recording.metrics.map((metric) => metric.name)).toEqual([
			DURATION_METRIC,
			INVALIDATION_METRIC,
			DURATION_METRIC,
		]);
		expect(statefulProviderMetricRegistry.render()).toBe(before);
	});
});
