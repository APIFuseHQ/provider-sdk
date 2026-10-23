import { describe, expect, it } from "bun:test";
import { PROVIDER_OBSERVABILITY_TAXONOMY_VERSION } from "../observability.js";

type Observability = {
	category?: string;
	taxonomyVersion?: string;
	retryable?: boolean;
	upstreamStatus?: number;
};
type ErrorBody = {
	error?: { code?: string; message?: string; source?: string; retryable?: boolean };
};
type CauseFrame = { errorClass?: string; message?: string };
type FailureLog = {
	event?: string;
	status?: number;
	code?: string;
	errorCategory?: string;
	retryable?: boolean;
	causeChain?: CauseFrame[];
};
type Scenario = {
	upstreamReached: boolean;
	served?: { status: number; observability: Observability | null; body: ErrorBody };
	log?: FailureLog;
};
type Wire = Record<
	| "native-timeout-abort"
	| "native-timeout-abort-before-connect"
	| "native-provider-abort"
	| "native-provider-abort-before-connect"
	| "native-connect-timeout",
	Scenario
>;

// A real provider app behind a real local listener, called by a real HTTP
// client, whose operations open ctx.native connections through the real native
// client to a real local upstream that never answers. Run in a subprocess like
// the client-cancelled wire.
async function runWire(): Promise<Wire> {
	const subprocess = Bun.spawn({
		cmd: [
			process.execPath,
			new URL("./fixtures/serve-native-provider-abort-wire.ts", import.meta.url).pathname,
		],
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`native provider-abort wire fixture failed: ${stderr}`);
	return JSON.parse(stdout);
}

const wire = await runWire();

function outcome(scenario: Scenario) {
	return {
		status: scenario.served?.status,
		category: scenario.served?.observability?.category,
		retryable: scenario.served?.observability?.retryable,
		code: scenario.served?.body.error?.code,
		message: scenario.served?.body.error?.message,
		source: scenario.served?.body.error?.source,
		bodyRetryable: scenario.served?.body.error?.retryable,
		logStatus: scenario.log?.status,
		logCode: scenario.log?.code,
		logCategory: scenario.log?.errorCategory,
		logRetryable: scenario.log?.retryable,
	};
}

// What transport_timeout serves, with the native code kept in the body.
const providerTimeoutAbort = {
	status: 504,
	category: "timeout",
	retryable: true,
	code: "native_connection_aborted",
	message: "Request timed out",
	source: "upstream_failure",
	bodyRetryable: true,
	logStatus: 504,
	logCode: "native_connection_aborted",
	logCategory: "timeout",
	logRetryable: true,
};

// Any other provider abort: what ctx.http serves for a transport_cancelled the
// provider's own signal caused (upstream_http with no upstream status).
const providerAbort = {
	status: 502,
	category: "upstream_http",
	retryable: false,
	code: "native_connection_aborted",
	message: "Upstream request failed",
	source: "upstream_failure",
	bodyRetryable: false,
	logStatus: 502,
	logCode: "native_connection_aborted",
	logCategory: "upstream_http",
	logRetryable: false,
};

describe("serve classification of a provider's own ctx.native signal abort", () => {
	it("serves an AbortSignal.timeout abort during the TLS handshake as a 504 timeout", () => {
		const result = wire["native-timeout-abort"];
		// The connection really reached the upstream and was waiting on it.
		expect(result.upstreamReached).toBe(true);
		expect(outcome(result)).toEqual(providerTimeoutAbort);
		expect(result.served?.observability).toEqual({
			category: "timeout",
			taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			retryable: true,
		});
		// The signal's reason is the error's cause.
		expect(result.log?.causeChain?.[0]?.errorClass).toBe("TimeoutError");
	});

	it("serves an AbortSignal.timeout that fired before the connect as a 504 timeout", () => {
		const result = wire["native-timeout-abort-before-connect"];
		expect(result.upstreamReached).toBe(false);
		expect(outcome(result)).toEqual(providerTimeoutAbort);
		expect(result.log?.causeChain?.[0]?.errorClass).toBe("TimeoutError");
	});

	it("serves any other abort during the TLS handshake like ctx.http's provider-side transport_cancelled", () => {
		const result = wire["native-provider-abort"];
		expect(result.upstreamReached).toBe(true);
		expect(outcome(result)).toEqual(providerAbort);
		expect(result.served?.observability).toEqual({
			category: "upstream_http",
			taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			retryable: false,
		});
		expect(result.log?.causeChain?.[0]?.errorClass).toBe("AbortError");
	});

	it("serves an abort that happened before the connect the same way", () => {
		const result = wire["native-provider-abort-before-connect"];
		expect(result.upstreamReached).toBe(false);
		expect(outcome(result)).toEqual(providerAbort);
		expect(result.log?.causeChain?.[0]?.errorClass).toBe("AbortError");
	});

	it("serves the native connect timeout with the same status and message as the timeout abort", () => {
		const result = wire["native-connect-timeout"];
		expect(result.upstreamReached).toBe(true);
		expect(outcome(result)).toEqual({
			status: 504,
			category: "timeout",
			retryable: true,
			code: "native_connection_timeout",
			message: "Request timed out",
			source: "upstream_failure",
			bodyRetryable: true,
			logStatus: 504,
			logCode: "native_connection_timeout",
			logCategory: "timeout",
			logRetryable: true,
		});
		expect(result.log?.causeChain).toBeUndefined();
	});
});
