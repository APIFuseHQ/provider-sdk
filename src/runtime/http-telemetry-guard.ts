import type { HttpRetrySummary } from "../types.js";
import {
	HttpTelemetryCollector,
	type HttpTelemetryRequestSink,
	type HttpTelemetrySink,
} from "./http-telemetry.js";

const intrinsicPromiseThen = Promise.prototype.then;
const ignoreObserverResult = () => {};

/** Attach handlers only through the Promise intrinsic; never invoke a host thenable. */
function absorbObserverPromise(value: object): void {
	let constructorDescriptor: PropertyDescriptor | undefined;
	let shadowed = false;
	try {
		constructorDescriptor = Object.getOwnPropertyDescriptor(value, "constructor");
		// Even the intrinsic `then` consults Symbol.species. An undefined constructor
		// selects its intrinsic Promise without reading a subclass's species getter.
		Object.defineProperty(value, "constructor", {
			value: undefined,
			configurable: constructorDescriptor?.configurable ?? true,
		});
		shadowed = true;
	} catch {
		// Non-extensible ordinary promises can still accept intrinsic handlers.
	}
	try {
		void intrinsicPromiseThen.call(value, ignoreObserverResult, ignoreObserverResult);
	} catch {
		// A non-Promise thenable has no intrinsic rejection to absorb. Do not run it.
	} finally {
		if (shadowed) {
			try {
				if (constructorDescriptor) {
					Object.defineProperty(value, "constructor", constructorDescriptor);
				} else {
					Reflect.deleteProperty(value, "constructor");
				}
			} catch {
				// Host object traps are also observer failures.
			}
		}
	}
}

function isAsyncObserverReturn(value: unknown): boolean {
	if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
	try {
		if (!("then" in value) || typeof value.then !== "function") return false;
	} catch {
		// A rejected Promise can itself have a throwing `then` getter. Still absorb it.
	}
	absorbObserverPromise(value);
	return true;
}

/** Keep all public observers, including property access, outside transport failures. */
export function startHttpTelemetry(
	sink: HttpTelemetrySink | undefined,
	retryPreset: HttpRetrySummary["preset"],
): HttpTelemetryRequestSink & { observe(callback: () => void): void } {
	let failed = false;
	const fail = () => {
		if (failed) return;
		failed = true;
		try {
			isAsyncObserverReturn(sink?.markTelemetryFailed?.());
		} catch {
			// The failure reporter is itself an observer. Never recurse.
		}
	};
	const observe = <T>(callback: () => T): T | undefined => {
		try {
			const result = callback();
			if (isAsyncObserverReturn(result)) {
				// The observer API is synchronous. Absorb invalid asynchronous returns too.
				fail();
				return undefined;
			}
			return result;
		} catch {
			fail();
			return undefined;
		}
	};
	const result = observe(() =>
		(sink ?? new HttpTelemetryCollector()).startRequest({ retryPreset }),
	);
	const request = observe(() => {
		if (
			!result ||
			typeof result.recordAttempt !== "function" ||
			typeof result.finish !== "function" ||
			typeof result.toTenantRetryPayload !== "function"
		) {
			fail();
			return undefined;
		}
		return result;
	});
	return {
		observe,
		recordAttempt: (event) => {
			observe(() => request?.recordAttempt(event));
		},
		finish: (ms) => {
			observe(() => request?.finish(ms));
		},
		toTenantRetryPayload: () => {
			if (failed) return undefined;
			return observe(() => {
				const value = observe(() => request?.toTenantRetryPayload());
				if (value === undefined) return undefined;
				// Copy only validated primitive fields; never pass observer-owned objects on.
				const { attempts, retries, preset, transport, lastErrorCode, lastStatus } = value;
				if (
					!Number.isSafeInteger(attempts) ||
					attempts < 2 ||
					!Number.isSafeInteger(retries) ||
					(retries !== attempts - 1 &&
						!(attempts === Number.MAX_SAFE_INTEGER && retries === Number.MAX_SAFE_INTEGER)) ||
					transport !== "native" ||
					(preset !== undefined &&
						![
							"off",
							"transport_transient",
							"safe_read",
							"aggressive_read",
							"rate_limit_aware",
						].includes(preset)) ||
					(lastErrorCode !== undefined &&
						![
							"transport_network_error",
							"transport_timeout",
							"transport_cancelled",
							"upstream_http_error",
							"other",
						].includes(lastErrorCode)) ||
					(lastStatus !== undefined && (!Number.isSafeInteger(lastStatus) || lastStatus < 0))
				) {
					fail();
					return undefined;
				}
				return {
					attempts,
					retries,
					...(preset === undefined ? {} : { preset }),
					transport,
					...(lastErrorCode === undefined ? {} : { lastErrorCode }),
					...(lastStatus === undefined ? {} : { lastStatus }),
				};
			});
		},
	};
}
