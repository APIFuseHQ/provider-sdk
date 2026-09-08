import { AsyncLocalStorage } from "node:async_hooks";
import type { HttpClient } from "../types.js";
import { type HttpTelemetrySink, httpTelemetryErrorCode } from "./http-telemetry.js";
import { startHttpTelemetry } from "./http-telemetry-guard.js";
import {
	proxyTransportRetryErrorCode,
	proxyTransportRetryErrorStatus,
} from "./proxy-retry-policy.js";

type HttpTelemetryScope = { sink: HttpTelemetrySink; nativeObserved: boolean };
const scopes = new AsyncLocalStorage<HttpTelemetryScope>();
const methods = new Set(["request", "get", "post", "put", "delete", "stream", "sse"]);
type AdapterState = { sink: HttpTelemetrySink; adapter: HttpClient };
const adapters = new WeakMap<object, AdapterState>();
let unsupportedShapeWarned = false;

/** Return whether a host binding has at least one callable declared HTTP method. */
export function isSupportedHttpBinding(value: unknown): value is HttpClient {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
	for (const method of methods) {
		try {
			if (typeof Reflect.get(value, method) === "function") return true;
		} catch {
			// A hostile property getter is not a usable binding.
		}
	}
	return false;
}

/** Emit the unsupported-shape warning once for the process. */
export function warnUnsupportedHttpBinding(): void {
	if (unsupportedShapeWarned) return;
	unsupportedShapeWarned = true;
	try {
		console.warn("[apifuse] http telemetry not attached; reason=unsupported_binding_shape");
	} catch {
		// Warning output is diagnostic only and must not affect request handling.
	}
}

/** Route SDK transports inside a host binding through the same attempt collector. */
export function scopedHttpTelemetry(
	existing: HttpTelemetrySink | undefined,
): HttpTelemetrySink | undefined {
	const scope = scopes.getStore();
	if (!scope) return existing;
	scope.nativeObserved = true;
	if (!existing || existing === scope.sink) return scope.sink;
	return {
		markTelemetryFailed: () => scope.sink.markTelemetryFailed?.(),
		startRequest(options) {
			const request = startHttpTelemetry(scope.sink, options.retryPreset);
			const observer = startHttpTelemetry(
				{
					startRequest: (options) => existing.startRequest(options),
					markTelemetryFailed() {
						scope.sink.markTelemetryFailed?.();
						existing.markTelemetryFailed?.();
					},
				},
				options.retryPreset,
			);
			return {
				recordAttempt(event) {
					request.recordAttempt(event);
					observer.recordAttempt(event);
				},
				finish(ms) {
					request.finish(ms);
					observer.finish(ms);
				},
				toTenantRetryPayload() {
					observer.toTenantRetryPayload();
					return request.toTenantRetryPayload();
				},
			};
		},
	};
}

/** Observe opaque host calls without changing their arguments, receiver or returned promise. */
export function bindHttpTelemetry(client: HttpClient, sink: HttpTelemetrySink): HttpClient {
	if ((typeof client === "object" && client !== null) || typeof client === "function") {
		const existing = adapters.get(client as object);
		if (existing) {
			existing.sink = sink;
			return existing.adapter;
		}
	}
	const wrappers = new Map<
		PropertyKey,
		{ original: unknown; wrapped: (...args: unknown[]) => unknown }
	>();
	// An inheriting target also supports hosts whose own methods are frozen.
	const adapter = new Proxy(Object.create(client) as HttpClient, {
		get(_target, property) {
			const original: unknown = Reflect.get(client, property, client);
			if (typeof property !== "string" || !methods.has(property) || typeof original !== "function")
				return original;
			const cached = wrappers.get(property);
			if (cached?.original === original) return cached.wrapped;
			const wrapped = function (this: unknown, ...args: unknown[]) {
				// Direct calls keep the host receiver; explicit and unbound receivers pass through.
				const receiver = this === adapter ? client : this;
				const scope: HttpTelemetryScope = { sink: state.sink, nativeObserved: false };
				const started = performance.now();
				const settled = (result: unknown, failed: boolean) => {
					if (scope.nativeObserved) return;
					const request = startHttpTelemetry(state.sink, undefined);
					request.observe(() => {
						const status = failed
							? proxyTransportRetryErrorStatus(result)
							: result &&
									typeof result === "object" &&
									"status" in result &&
									typeof result.status === "number"
								? result.status
								: undefined;
						request.recordAttempt({
							ms: performance.now() - started,
							proxyUsed: false,
							...(status === undefined ? {} : { status }),
							...(failed
								? { e: httpTelemetryErrorCode(proxyTransportRetryErrorCode(result)) }
								: {}),
						});
					});
					request.finish(performance.now() - started);
				};
				return scopes.run(scope, () => {
					let result: unknown;
					try {
						result = Reflect.apply(original, receiver, args);
					} catch (error) {
						settled(error, true);
						throw error;
					}
					try {
						if (result instanceof Promise) {
							void Promise.prototype.then.call(
								result,
								(value: unknown) => settled(value, false),
								(error: unknown) => settled(error, true),
							);
						} else settled(result, false);
					} catch (error) {
						// Promise subclasses may throw while a telemetry continuation is attached.
						startHttpTelemetry(state.sink, undefined).observe(() => {
							throw error;
						});
					}
					return result;
				});
			};
			wrappers.set(property, { original, wrapped });
			return wrapped;
		},
	});
	const state: AdapterState = { sink, adapter };
	adapters.set(adapter as object, state);
	return adapter;
}
