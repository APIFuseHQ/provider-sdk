import { describe, expect, it } from "bun:test";
import { PROVIDER_OBSERVABILITY_TAXONOMY_VERSION } from "../observability.js";
import { CLIENT_CANCELLED_STATUS } from "../server/client-cancelled.js";

type Observability = {
	category?: string;
	taxonomyVersion?: string;
	retryable?: boolean;
	upstreamStatus?: number;
};
type ErrorBody = {
	error?: {
		code?: string;
		message?: string;
		requestId?: string;
		source?: string;
		retryable?: boolean;
	};
};
type CauseFrame = { errorClass?: string; code?: string; message?: string };
type FailureLog = {
	event?: string;
	status?: number;
	code?: string;
	errorClass?: string;
	errorCategory?: string;
	retryable?: boolean;
	causeChain?: CauseFrame[];
};
type SourceSaw = { errorClass: string; code?: string; status?: number };
type Scenario = {
	clientAborted: boolean;
	source?: SourceSaw;
	served?: {
		status: number;
		observability: Observability | null;
		body: ErrorBody;
		inboundAborted: boolean;
	};
	log?: FailureLog;
	upstreamHits?: number;
	streamedBytesBeforeAbort?: number;
};
type Wire = Record<
	| "timeout-signal"
	| "timeout-option"
	| "native-connect-timeout"
	| "bare-abort"
	| "reason-abort"
	| "timeout-signal-during-backoff"
	| "timeout-signal-during-body"
	| "stateful-timeout-signal"
	| "stateful-deadline"
	| "caller-leaves"
	| "timeout-signal-then-caller-leaves"
	| "upstream-503",
	Scenario
>;

// A real provider app behind a real local listener, called over real HTTP on
// its operation route and by the SDK's real stateful forwarder, its operations
// cancelling real upstream reads with their own signal. Run in a subprocess so
// module mocks in other test files cannot replace the transports.
async function runWire(): Promise<Wire> {
	const subprocess = Bun.spawn({
		cmd: [
			process.execPath,
			new URL("./fixtures/serve-provider-timeout-cancellation-wire.ts", import.meta.url).pathname,
		],
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	if (exitCode !== 0)
		throw new Error(`provider timeout cancellation wire fixture failed: ${stderr}`);
	return JSON.parse(stdout);
}

const wire = await runWire();

function outcome(scenario: Scenario) {
	return {
		status: scenario.served?.status,
		category: scenario.served?.observability?.category,
		retryable: scenario.served?.observability?.retryable,
		source: scenario.served?.body.error?.source,
		bodyRetryable: scenario.served?.body.error?.retryable,
		message: scenario.served?.body.error?.message,
		logStatus: scenario.log?.status,
		logCategory: scenario.log?.errorCategory,
		logRetryable: scenario.log?.retryable,
	};
}

// What the `timeout` request option's transport_timeout is served as.
const TIMEOUT_OUTCOME = {
	status: 504,
	category: "timeout",
	retryable: true,
	source: "upstream_failure",
	bodyRetryable: true,
	message: "Request timed out",
	logStatus: 504,
	logCategory: "timeout",
	logRetryable: true,
};

// What any other transport_cancelled keeps being served as.
const DEFAULT_CANCELLED_OUTCOME = {
	status: 502,
	category: "upstream_http",
	retryable: false,
	source: "upstream_failure",
	bodyRetryable: false,
	message: "Upstream request failed",
	logStatus: 502,
	logCategory: "upstream_http",
	logRetryable: false,
};

// Nobody on the caller side cancelled: the caller (or the source pod) stayed
// connected and the served request's own signal never aborted.
function expectCallerStayed(scenario: Scenario) {
	expect(scenario.clientAborted).toBe(false);
	expect(scenario.served?.inboundAborted).toBe(false);
}

function expectProviderTimeoutCancellation(scenario: Scenario, requestId: string) {
	expectCallerStayed(scenario);
	// Still the transport's cancellation, caused by the provider's own
	// AbortSignal.timeout reason.
	expect(scenario.log?.code).toBe("transport_cancelled");
	expect(scenario.log?.errorClass).toBe("TransportError");
	expect(scenario.log?.causeChain?.[0]?.errorClass).toBe("TimeoutError");
	expect(outcome(scenario)).toEqual(TIMEOUT_OUTCOME);
	expect(scenario.served?.observability).toEqual({
		category: "timeout",
		taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
		retryable: true,
	});
	expect(scenario.served?.body).toEqual({
		error: {
			code: "transport_cancelled",
			message: "Request timed out",
			requestId,
			retryable: true,
			source: "upstream_failure",
		},
	});
}

describe("serve classification of a provider's own per-request signal abort", () => {
	it("serves the timeout option's transport_timeout as timeout 504 (the reference)", () => {
		const result = wire["timeout-option"];
		expectCallerStayed(result);
		expect(result.log?.code).toBe("transport_timeout");
		expect(result.served?.body.error?.code).toBe("transport_timeout");
		expect(outcome(result)).toEqual(TIMEOUT_OUTCOME);
	});

	it("classifies an AbortSignal.timeout abort like the timeout option, keeping its code", () => {
		expectProviderTimeoutCancellation(wire["timeout-signal"], "timeout-signal");
		expect(outcome(wire["timeout-signal"])).toEqual(outcome(wire["timeout-option"]));
	});

	it("serves the abort, the timeout option and ctx.native's connect deadline with one status, message and category", () => {
		const native = wire["native-connect-timeout"];
		expectCallerStayed(native);
		expect(native.log?.code).toBe("native_connection_timeout");
		expect(native.served?.body.error?.code).toBe("native_connection_timeout");
		// Status, message, category, source and retryability, in the response
		// and the log, are the same for all three.
		expect(outcome(native)).toEqual(TIMEOUT_OUTCOME);
		expect(outcome(wire["timeout-signal"])).toEqual(outcome(native));
		expect(outcome(wire["timeout-option"])).toEqual(outcome(native));
	});

	it("classifies the same abort during the retry policy's backoff sleep the same way", () => {
		const result = wire["timeout-signal-during-backoff"];
		// The first attempt got its 503 and the second never started: the limit
		// fired while the retry policy was sleeping.
		expect(result.upstreamHits).toBe(1);
		expectProviderTimeoutCancellation(result, "timeout-signal-during-backoff");
	});

	it("classifies the same abort while a streamed response body is consumed the same way", () => {
		const result = wire["timeout-signal-during-body"];
		// Headers and the first chunk had arrived before the limit fired.
		expect(result.streamedBytesBeforeAbort).toBe("first chunk".length);
		expectProviderTimeoutCancellation(result, "timeout-signal-during-body");
	});

	for (const [scenario, causeClass] of [
		["bare-abort", "AbortError"],
		["reason-abort", "Error"],
	] as const) {
		it(`keeps ${scenario}'s transport_cancelled (reason ${causeClass}) on upstream_http 502`, () => {
			const result = wire[scenario];
			expectCallerStayed(result);
			expect(result.log?.code).toBe("transport_cancelled");
			expect(result.served?.body.error?.code).toBe("transport_cancelled");
			expect(result.log?.causeChain?.[0]?.errorClass).toBe(causeClass);
			expect(outcome(result)).toEqual(DEFAULT_CANCELLED_OUTCOME);
			expect(result.served?.observability).toEqual({
				category: "upstream_http",
				taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
				retryable: false,
			});
		});
	}
	it("keeps an arbitrary abort reason visible as the cause", () => {
		expect(wire["reason-abort"].log?.causeChain?.[0]?.message).toBe("provider gave up");
	});

	it("serves the abort the same way on the stateful owner route, and the source pod receives 504", () => {
		const result = wire["stateful-timeout-signal"];
		expectProviderTimeoutCancellation(result, "stateful-timeout-signal");
		expect(result.source).toEqual({
			errorClass: "StatefulOwnerForwardingError",
			code: "transport_cancelled",
			status: 504,
		});
	});

	it("keeps a stateful forwarding deadline expiry on the deadline", () => {
		const result = wire["stateful-deadline"];
		expectCallerStayed(result);
		expect(outcome(result)).toEqual({
			status: 504,
			category: "timeout",
			retryable: false,
			source: "apifuse",
			bodyRetryable: false,
			message: "Stateful forwarding deadline expired.",
			logStatus: 504,
			logCategory: "timeout",
			logRetryable: false,
		});
		expect(result.served?.body.error?.code).toBe("STATEFUL_FORWARDING_DEADLINE_EXPIRED");
		expect(result.log?.errorClass).toBe("StatefulRoutingDeadlineError");
		// The deadline's own TimeoutError cancelled the read, yet it never
		// reaches the provider-timeout branch.
		expect(result.log?.causeChain?.slice(0, 2)).toEqual([
			expect.objectContaining({ errorClass: "TransportError", code: "transport_cancelled" }),
			expect.objectContaining({ errorClass: "TimeoutError" }),
		]);
		expect(result.source).toEqual({
			errorClass: "StatefulOwnerForwardingError",
			code: "STATEFUL_FORWARDING_DEADLINE_EXPIRED",
			status: 504,
		});
	});

	it("keeps a caller that left while the provider's limit was pending on client_cancelled", () => {
		const result = wire["caller-leaves"];
		expect(result.clientAborted).toBe(true);
		expect(result.served?.inboundAborted).toBe(true);
		expect(result.log?.code).toBe("transport_cancelled");
		expect(result.log?.causeChain?.[0]?.errorClass).toBe("AbortError");
		expect(outcome(result)).toEqual({
			status: CLIENT_CANCELLED_STATUS,
			category: "client_cancelled",
			retryable: false,
			source: "client",
			bodyRetryable: false,
			message: "Upstream request failed",
			logStatus: CLIENT_CANCELLED_STATUS,
			logCategory: "client_cancelled",
			logRetryable: false,
		});
	});

	it("lets a caller that left before serve answered win over a provider limit that fired first", () => {
		const result = wire["timeout-signal-then-caller-leaves"];
		// The provider's own AbortSignal.timeout cancelled the read, but the
		// served request's signal had aborted by the time it was classified.
		expect(result.clientAborted).toBe(true);
		expect(result.served?.inboundAborted).toBe(true);
		expect(result.log?.causeChain?.[0]?.errorClass).toBe("TimeoutError");
		expect(outcome(result)).toEqual(outcome(wire["caller-leaves"]));
	});

	it("leaves an upstream HTTP failure on the upstream_http branch", () => {
		const result = wire["upstream-503"];
		expectCallerStayed(result);
		expect(result.log?.code).toBe("upstream_http_error");
		expect(result.served?.observability).toEqual({
			category: "upstream_http",
			taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			retryable: true,
			upstreamStatus: 503,
		});
		expect(outcome(result)).toEqual({
			status: 502,
			category: "upstream_http",
			retryable: true,
			source: "upstream_failure",
			bodyRetryable: true,
			message: "Upstream request failed with status 503",
			logStatus: 502,
			logCategory: "upstream_http",
			logRetryable: true,
		});
	});
});
