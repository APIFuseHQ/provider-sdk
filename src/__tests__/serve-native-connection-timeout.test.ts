import { describe, expect, it } from "bun:test";
import { PROVIDER_OBSERVABILITY_TAXONOMY_VERSION } from "../observability.js";

type Observability = {
	origin?: string;
	category?: string;
	taxonomyVersion?: string;
	retryable?: boolean;
	upstreamStatus?: number;
};
type ErrorBody = {
	error?: { code?: string; message?: string; source?: string; retryable?: boolean };
};
type FailureLog = {
	event?: string;
	status?: number;
	code?: string;
	message?: string;
	errorCategory?: string;
	errorOrigin?: string;
	retryable?: boolean;
};
type Scenario = {
	elapsedMs: number;
	served?: { status: number; observability: Observability | null; body: ErrorBody };
	log?: FailureLog;
};
type Wire = { connectTimeoutMs: number } & Record<
	"native-connect-timeout" | "http-timeout" | "native-idle-timeout" | "http-upstream-503",
	Scenario
>;

// A real provider app behind a real local listener, called by a real HTTP
// client, with ctx.native and ctx.http reaching real local peers that never
// answer in time. Run in a subprocess so a fetch or module mock left by another
// test file cannot replace the real transports.
async function runWire(): Promise<Wire> {
	const subprocess = Bun.spawn({
		cmd: [
			process.execPath,
			new URL("./fixtures/serve-native-connection-timeout-wire.ts", import.meta.url).pathname,
		],
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`native connection timeout wire fixture failed: ${stderr}`);
	return JSON.parse(stdout);
}

const wire = await runWire();

// Everything the caller and the operator see, minus the code that names the
// transport.
function outcome(scenario: Scenario) {
	return {
		status: scenario.served?.status,
		observability: scenario.served?.observability,
		message: scenario.served?.body.error?.message,
		source: scenario.served?.body.error?.source,
		bodyRetryable: scenario.served?.body.error?.retryable,
		logStatus: scenario.log?.status,
		logCategory: scenario.log?.errorCategory,
		logOrigin: scenario.log?.errorOrigin,
		logRetryable: scenario.log?.retryable,
	};
}

const timedOut = {
	status: 504,
	observability: {
		origin: "provider",
		category: "timeout",
		taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
		retryable: true,
	},
	message: "Request timed out",
	source: "upstream_failure",
	bodyRetryable: true,
	logStatus: 504,
	logCategory: "timeout",
	logOrigin: "provider",
	logRetryable: true,
};

describe("serving an operation whose upstream ran out of time", () => {
	it("serves ctx.native's expired connect deadline (timeoutMs) as 504 Request timed out", () => {
		const result = wire["native-connect-timeout"];
		// The rejection really came from the native client's own timeoutMs
		// during the TLS handshake with a silent peer.
		expect(result.log?.code).toBe("native_connection_timeout");
		expect(result.log?.message).toBe("Native connection timed out");
		expect(result.served?.body.error?.code).toBe("native_connection_timeout");
		expect(result.elapsedMs).toBeGreaterThanOrEqual(wire.connectTimeoutMs);
		expect(outcome(result)).toEqual(timedOut);
	});

	it("serves native_connection_timeout exactly like ctx.http's transport_timeout", () => {
		const http = wire["http-timeout"];
		expect(http.log?.code).toBe("transport_timeout");
		expect(http.served?.body.error?.code).toBe("transport_timeout");
		expect(outcome(http)).toEqual(timedOut);
		expect(outcome(wire["native-connect-timeout"])).toEqual(outcome(http));
	});

	it("leaves native_connection_idle_timeout on its 502 Upstream request failed", () => {
		const result = wire["native-idle-timeout"];
		expect(result.log?.code).toBe("native_connection_idle_timeout");
		expect(result.served?.body.error?.code).toBe("native_connection_idle_timeout");
		expect(outcome(result)).toEqual({
			...timedOut,
			status: 502,
			logStatus: 502,
			message: "Upstream request failed",
		});
	});

	it("leaves an upstream HTTP failure on the upstream_http branch", () => {
		const result = wire["http-upstream-503"];
		expect(result.log?.code).toBe("upstream_http_error");
		expect(outcome(result)).toEqual({
			status: 502,
			observability: {
				origin: "provider",
				category: "upstream_http",
				taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
				retryable: true,
				upstreamStatus: 503,
			},
			message: "Upstream request failed with status 503",
			source: "upstream_failure",
			bodyRetryable: true,
			logStatus: 502,
			logCategory: "upstream_http",
			logOrigin: "provider",
			logRetryable: true,
		});
	});
});
