import { describe, expect, it } from "bun:test";

import { TransportError } from "../errors";
import {
	computeProxyAttemptIndex,
	createDefaultProxyTransportRetryOptions,
	DEFAULT_PROXY_TRANSPORT_RETRY_ERROR_CODES,
	DEFAULT_PROXY_TRANSPORT_RETRY_METHODS,
	MAX_PROXY_TRANSPORT_RETRY_ATTEMPTS,
	normalizeProxyTransportRetryOptions,
	shouldRetryProxyTransportAttempt,
	validateUnsafeProxyTransportRetryMethods,
} from "../runtime/proxy-retry-policy";
import { HttpRetryUnsafeMethodPolicy } from "../types";

describe("proxy transport retry policy", () => {
	it("keeps HTTP and stealth on the same default safe transport policy", () => {
		const http = createDefaultProxyTransportRetryOptions({ label: "HTTP" });
		const stealth = createDefaultProxyTransportRetryOptions({
			extraErrorCodes: ["proxy_connect_failed"],
			label: "Stealth",
		});

		expect(http.methods).toEqual(DEFAULT_PROXY_TRANSPORT_RETRY_METHODS);
		expect(stealth.methods).toEqual(DEFAULT_PROXY_TRANSPORT_RETRY_METHODS);
		expect(http.attempts).toBe(3);
		expect(stealth.attempts).toBe(http.attempts);
		for (const code of DEFAULT_PROXY_TRANSPORT_RETRY_ERROR_CODES) {
			expect(http.errorCodes).toContain(code);
			expect(stealth.errorCodes).toContain(code);
			expect(
				shouldRetryProxyTransportAttempt({
					error: new TransportError("retryable", { code, status: 0 }),
					explicitRetry: false,
					method: "GET",
					options: http,
					proxyUsed: true,
				}),
			).toBe(true);
			expect(
				shouldRetryProxyTransportAttempt({
					error: new TransportError("retryable", { code, status: 0 }),
					explicitRetry: false,
					method: "GET",
					options: stealth,
					proxyUsed: true,
				}),
			).toBe(true);
		}
	});

	it("does not apply default retry when no proxy was used", () => {
		const policy = createDefaultProxyTransportRetryOptions();

		expect(
			shouldRetryProxyTransportAttempt({
				error: new TransportError("network", {
					code: "transport_network_error",
					status: 0,
				}),
				explicitRetry: false,
				method: "GET",
				options: policy,
				proxyUsed: false,
			}),
		).toBe(false);
	});

	it("treats retry false as an explicit disable", () => {
		expect(normalizeProxyTransportRetryOptions(false)).toBeUndefined();
	});

	it("honors explicit unsafe POST retry only when acknowledged", () => {
		const rejected = normalizeProxyTransportRetryOptions({
			methods: ["POST"],
			attempts: 2,
		});
		expect(() => validateUnsafeProxyTransportRetryMethods(rejected!)).toThrow();

		const allowed = normalizeProxyTransportRetryOptions({
			methods: ["POST"],
			attempts: 2,
			unsafeMethodPolicy: HttpRetryUnsafeMethodPolicy.AllowExplicitUnsafe,
		});
		validateUnsafeProxyTransportRetryMethods(allowed!);
		expect(
			shouldRetryProxyTransportAttempt({
				error: new TransportError("network", {
					code: "transport_network_error",
					status: 0,
				}),
				explicitRetry: true,
				method: "POST",
				options: allowed,
				proxyUsed: true,
			}),
		).toBe(true);
	});

	it("caps attempts and centralizes proxy attempt offset math", () => {
		const policy = normalizeProxyTransportRetryOptions({ attempts: 99 });

		expect(policy?.attempts).toBe(MAX_PROXY_TRANSPORT_RETRY_ATTEMPTS);
		expect(
			computeProxyAttemptIndex({
				baseProxyAttempt: 2,
				proxyAttemptOffset: 3,
				retryAttemptOffset: 1,
			}),
		).toBe(6);
		expect(
			computeProxyAttemptIndex({
				baseProxyAttempt: Number.NaN,
				proxyAttemptOffset: Number.POSITIVE_INFINITY,
				retryAttemptOffset: -1,
			}),
		).toBe(0);
	});
});
