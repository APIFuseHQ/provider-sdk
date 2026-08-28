import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { createServerApp } from "../server/serve.js";
import {
	APIFUSE__TRACE__ENABLED,
	APIFUSE__TRACE__EXPORTER,
	APIFUSE__TRACE__OTLP__ENDPOINT,
	resolveTraceConfigFromEnv,
} from "../runtime/trace-config.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

const provider = createProviderDefinitionDouble({
	operations: {
		echo: {
			input: z.object({ value: z.string() }),
			output: z.object({ value: z.string() }),
			handler: async (ctx, input) => {
				const parsed = z.object({ value: z.string() }).parse(input);
				return ctx.trace.span("provider.echo", async () => ({ value: parsed.value }));
			},
		},
	},
});

function withTraceEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
	const previous = new Map<string, string | undefined>();
	for (const name of [
		APIFUSE__TRACE__ENABLED,
		APIFUSE__TRACE__EXPORTER,
		APIFUSE__TRACE__OTLP__ENDPOINT,
	]) {
		previous.set(name, process.env[name]);
		const value = values[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	return run().finally(() => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
}

async function invokeEcho(): Promise<Response> {
	return createServerApp(provider, {
		allowMemoryStateFallback: true,
		logger: () => {},
	}).request("/v1/echo", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: "trace-output-test", input: { value: "hello" } }),
	});
}

describe("server trace output wiring", () => {
	it("keeps the default in-memory trace behavior silent", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
		try {
			await withTraceEnv({}, async () => {
				const response = await invokeEcho();
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ data: { value: "hello" } });
			});
		} finally {
			console.log = originalLog;
		}
		expect(output).toEqual([]);
	});

	it("emits JSON spans with names and durations for the console exporter", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
		try {
			await withTraceEnv(
				{ [APIFUSE__TRACE__ENABLED]: "true", [APIFUSE__TRACE__EXPORTER]: "console" },
				async () => {
					const response = await invokeEcho();
					expect(response.status).toBe(200);
				},
			);
		} finally {
			console.log = originalLog;
		}

		const spans = output.map((line) => JSON.parse(line) as { name: string; duration_ms: number });
		const span = spans.find((candidate) => candidate.name === "handler:echo");
		expect(span).toBeDefined();
		expect(span?.duration_ms).toBeGreaterThanOrEqual(0);
	});

	it("fails closed to the none exporter for an invalid exporter value", () => {
		expect(
		resolveTraceConfigFromEnv({
			[APIFUSE__TRACE__ENABLED]: "true",
			[APIFUSE__TRACE__EXPORTER]: "not-a-real-exporter",
		}),
	).toEqual({ enabled: true, exporter: "none" });
	});
});
