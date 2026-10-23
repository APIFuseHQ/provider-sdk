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
	error?: { code?: string; source?: string; retryable?: boolean };
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
	clientAborted: boolean;
	served?: { status: number; observability: Observability | null; body: ErrorBody };
	log?: FailureLog;
};
type Wire = Record<
	"http-sequential" | "stealth-sequential" | "http-provider-abort" | "http-upstream-503",
	Scenario
>;

// A real provider app behind a real local listener, called by a real HTTP
// client that closes its connection mid-operation. Run in a subprocess so the
// wreq-js module mock in stealth-client.test.ts cannot replace the stealth
// transport.
async function runWire(): Promise<Wire> {
	const subprocess = Bun.spawn({
		cmd: [
			process.execPath,
			new URL("./fixtures/serve-client-cancelled-wire.ts", import.meta.url).pathname,
		],
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`client-cancelled wire fixture failed: ${stderr}`);
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
		logStatus: scenario.log?.status,
		logCategory: scenario.log?.errorCategory,
		logRetryable: scenario.log?.retryable,
	};
}

// The same constant the streaming path terminalizes a cancelled stream with.
const clientCancelled = {
	status: CLIENT_CANCELLED_STATUS,
	category: "client_cancelled",
	retryable: false,
	source: "client",
	bodyRetryable: false,
	logStatus: CLIENT_CANCELLED_STATUS,
	logCategory: "client_cancelled",
	logRetryable: false,
};

describe("serve classification when the caller closes the connection mid-operation", () => {
	for (const scenario of ["http-sequential", "stealth-sequential"] as const) {
		it(`serves ${scenario}'s transport_cancelled with the streaming path's client-cancelled status`, () => {
			expect(CLIENT_CANCELLED_STATUS).toBe(400);
			const result = wire[scenario];
			// The cancellation really came from the inbound connection closing
			// while the second sequential upstream read was in flight.
			expect(result.clientAborted).toBe(true);
			expect(result.log?.code).toBe("transport_cancelled");
			expect(result.served?.body.error?.code).toBe("transport_cancelled");
			expect(result.log?.causeChain?.[0]?.errorClass).toBe("AbortError");
			// Never upstream_http/upstream_failure.
			expect(outcome(result)).toEqual(clientCancelled);
			expect(result.served?.observability?.upstreamStatus).toBeUndefined();
		});
	}

	it("keeps a provider-initiated transport_cancelled off client_cancelled while the caller stays connected", () => {
		const result = wire["http-provider-abort"];
		// Same code as a caller cancellation, but the provider's own
		// AbortSignal.timeout fired and the inbound connection never closed.
		expect(result.clientAborted).toBe(false);
		expect(result.log?.code).toBe("transport_cancelled");
		expect(result.served?.body.error?.code).toBe("transport_cancelled");
		expect(result.log?.causeChain?.[0]?.errorClass).toBe("TimeoutError");
		// The classification transport_cancelled had before client_cancelled
		// existed for it: upstream_http with no upstream status.
		expect(result.served?.observability).toEqual({
			category: "upstream_http",
			taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			retryable: false,
		});
		expect(outcome(result)).toEqual({
			status: 502,
			category: "upstream_http",
			retryable: false,
			source: "upstream_failure",
			bodyRetryable: false,
			logStatus: 502,
			logCategory: "upstream_http",
			logRetryable: false,
		});
	});

	it("leaves an upstream HTTP failure on the upstream_http branch", () => {
		const result = wire["http-upstream-503"];
		expect(result.clientAborted).toBe(false);
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
			logStatus: 502,
			logCategory: "upstream_http",
			logRetryable: true,
		});
	});
});
