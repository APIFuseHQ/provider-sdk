import type { BrowserClient } from "../types.js";
import type { BrowserTelemetrySink } from "./browser-telemetry.js";
import { observeTelemetryCallback } from "./http-telemetry-guard.js";

const methods = new Set(["newPage", "rawPage", "withIsolatedContext", "solveChallenge"]);
type State = { sink: BrowserTelemetrySink; adapter: BrowserClient };
const adapters = new WeakMap<object, State>();
let warned = false;

export function isSupportedBrowserBinding(value: unknown): value is BrowserClient {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
	return [...methods].some((method) => {
		try {
			return typeof Reflect.get(value, method) === "function";
		} catch {
			return false;
		}
	});
}

export function warnUnsupportedBrowserBinding(): void {
	if (warned) return;
	warned = true;
	try {
		console.warn("[apifuse] browser telemetry not attached; reason=unsupported_binding_shape");
	} catch {}
}

export function bindBrowserTelemetry(
	client: BrowserClient,
	sink: BrowserTelemetrySink,
): BrowserClient {
	const existing = adapters.get(client as object);
	if (existing) {
		existing.sink = sink;
		return existing.adapter;
	}
	const wrappers = new Map<
		PropertyKey,
		{ original: unknown; wrapped: (...args: unknown[]) => unknown }
	>();
	const adapter = new Proxy(Object.create(client) as BrowserClient, {
		get(_target, property) {
			const original = Reflect.get(client, property, client);
			if (typeof property !== "string" || !methods.has(property) || typeof original !== "function")
				return original;
			const cached = wrappers.get(property);
			if (cached && cached.original === original) return cached.wrapped;
			const wrapped = function (this: unknown, ...args: unknown[]) {
				const receiver = this === adapter ? client : this;
				observeTelemetryCallback(state.sink, () => {
					const declared = client.engine;
					const engine =
						declared === "playwright-stealth" ||
						declared === "nodriver" ||
						declared === "selenium-uc"
							? declared
							: "host";
					return state.sink.recordEngine(engine);
				});
				if (property === "newPage" || property === "rawPage" || property === "withIsolatedContext")
					observeTelemetryCallback(state.sink, () =>
						state.sink.recordPoolAcquire("not_configured"),
					);
				let result: unknown;
				try {
					result = Reflect.apply(original, receiver, args);
				} catch (error) {
					observeTelemetryCallback(state.sink, () => state.sink.recordError("other"));
					throw error;
				}
				try {
					if (result instanceof Promise)
						void Promise.prototype.then.call(result, undefined, () => {
							observeTelemetryCallback(state.sink, () => state.sink.recordError("other"));
						});
				} catch (error) {
					observeTelemetryCallback(state.sink, () => {
						throw error;
					});
				}
				return result;
			};
			wrappers.set(property, { original, wrapped });
			return wrapped;
		},
	});
	const state: State = { sink, adapter };
	adapters.set(client as object, state);
	adapters.set(adapter as object, state);
	return adapter;
}
