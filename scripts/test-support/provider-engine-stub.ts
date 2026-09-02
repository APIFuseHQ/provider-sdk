import {
	PROVIDER_ENGINE_PROTOCOL_VERSION,
	type ProviderEngineProtocolRequest,
	type ProviderEngineRemoteError,
	type ProviderEngineResponse,
} from "../../src/engine.js";

export interface ProviderEngineStubStats {
	acceptedHandshakes: number;
	acceptedTraceSubscriptions: number;
	rejectedAuthentications: number;
}

export interface ProviderEngineStub {
	readonly url: string;
	readonly stats: ProviderEngineStubStats;
	stop(): Promise<void>;
}

/** Repository-only provider-engine.v1 double used to exercise packed consumers. */
export function startProviderEngineStub(apiKey: string): ProviderEngineStub {
	const stats: ProviderEngineStubStats = {
		acceptedHandshakes: 0,
		acceptedTraceSubscriptions: 0,
		rejectedAuthentications: 0,
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/health") {
				return Response.json({ status: "ok", version: PROVIDER_ENGINE_PROTOCOL_VERSION });
			}

			const envelope = await request.json().catch(() => undefined);
			const protocolRequest = isProtocolRequest(envelope) ? envelope : undefined;
			const bearer = request.headers.get("authorization");
			if (bearer !== `Bearer ${apiKey}` || protocolRequest?.authentication.credential !== apiKey) {
				stats.rejectedAuthentications += 1;
				return engineResponse(
					protocolRequest?.requestId ?? "pack-smoke-rejected",
					{
						ok: false,
						error: {
							code: "PROVIDER_ENGINE_AUTHENTICATION_FAILED",
							message: "Pack-smoke provider engine rejected the workspace API key",
							retryable: false,
						},
					},
					401,
				);
			}

			if (protocolRequest.version !== PROVIDER_ENGINE_PROTOCOL_VERSION) {
				return engineResponse(
					protocolRequest.requestId,
					{
						ok: false,
						error: {
							code: "PROVIDER_ENGINE_PROTOCOL_VERSION_MISMATCH",
							message: "Pack-smoke provider engine protocol mismatch",
							details: { receivedVersion: protocolRequest.version },
						},
					},
					409,
				);
			}

			if (url.pathname === "/v1/provider-engine/request") {
				if (
					protocolRequest.lane === "request" &&
					protocolRequest.capability === "attachment" &&
					protocolRequest.method === "attach"
				) {
					stats.acceptedHandshakes += 1;
					return engineResponse(protocolRequest.requestId, { ok: true, result: {} });
				}
				return engineResponse(protocolRequest.requestId, { ok: true, result: {} });
			}

			if (
				url.pathname === "/v1/provider-engine/stream" &&
				protocolRequest.lane === "stream" &&
				protocolRequest.capability === "trace" &&
				protocolRequest.method === "trace.subscribe"
			) {
				stats.acceptedTraceSubscriptions += 1;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.close();
						},
					}),
					{
						headers: {
							"content-type": "application/x-ndjson",
							"x-apifuse-engine-protocol": PROVIDER_ENGINE_PROTOCOL_VERSION,
						},
					},
				);
			}

			return Response.json({ error: "unsupported pack-smoke engine request" }, { status: 404 });
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		stats,
		async stop() {
			await server.stop(true);
		},
	};
}

function isProtocolRequest(value: unknown): value is ProviderEngineProtocolRequest {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ProviderEngineProtocolRequest>;
	return (
		typeof candidate.version === "string" &&
		typeof candidate.providerId === "string" &&
		typeof candidate.requestId === "string" &&
		typeof candidate.capability === "string" &&
		typeof candidate.method === "string" &&
		candidate.authentication?.scheme === "workspace-api-key" &&
		typeof candidate.authentication.credential === "string"
	);
}

function engineResponse(
	requestId: string,
	value:
		| { readonly ok: true; readonly result: unknown }
		| { readonly ok: false; readonly error: ProviderEngineRemoteError },
	status = 200,
): Response {
	return Response.json(
		{
			version: PROVIDER_ENGINE_PROTOCOL_VERSION,
			requestId,
			...value,
		} satisfies ProviderEngineResponse,
		{ status },
	);
}
