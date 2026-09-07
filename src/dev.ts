import { serve } from "./server/serve.js";
import {
	createRemoteProviderEngineFromEnv,
	type ProviderEngine,
	type ProviderEngineTraceEvent,
} from "./engine.js";
import type { ProviderDefinition } from "./types.js";

export interface DevServerOptions {
	port?: number;
	sessionDbPath?: string;
	/** Override the authenticated remote attachment (primarily for SDK tests). */
	engine?: ProviderEngine;
}

export function createDevServer(
	provider: ProviderDefinition,
	options?: DevServerOptions,
): { start: () => Promise<void> } {
	const port = options?.port ?? 3900;

	return {
		start: async () => {
			const engine = options?.engine ?? createRemoteProviderEngineFromEnv(provider);
			await engine.ready?.();
			if (engine.openTraceStream) {
				const stream = await engine.openTraceStream();
				void renderEngineTraceStream(stream);
			}
			await serve(provider, { port, engine });
			console.log(
				`[apifuse dev] ${provider.id}@${provider.version} running at http://localhost:${port}`,
			);
			console.log(`[apifuse dev] Operations: ${Object.keys(provider.operations).join(", ")}`);
			console.log(`[apifuse dev] Health: http://localhost:${port}/health`);
		},
	};
}

export async function startDevServer(
	provider: ProviderDefinition,
	options?: DevServerOptions,
): Promise<void> {
	await createDevServer(provider, options).start();
}

function renderTraceEvent(event: ProviderEngineTraceEvent): void {
	const status = event.status === undefined ? "" : ` status=${event.status}`;
	const duration = event.durationMs === undefined ? "" : ` duration=${event.durationMs}ms`;
	const sizes =
		event.requestBytes === undefined && event.responseBytes === undefined
			? ""
			: ` bytes=${event.requestBytes ?? 0}/${event.responseBytes ?? 0}`;
	const error = event.errorCode ? ` error=${event.errorCode}` : "";
	console.log(
		`[apifuse dev] engine ${event.phase} ${event.capability}.${event.method} ${event.host}${event.path}${status}${duration}${sizes}${error}`,
	);
}

/** Render newline-delimited trace events without allowing a malformed line to stop the lane. */
export async function renderEngineTraceStream(stream: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffered += decoder.decode(value, { stream: true });
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				renderTraceEvent(JSON.parse(line) as ProviderEngineTraceEvent);
			} catch {
				console.warn("[apifuse dev] ignored a malformed provider-engine trace event");
			}
		}
	}
}
