import { AsyncLocalStorage } from "node:async_hooks";

import {
	resolvedStringVariants,
	urlCredentialComponents,
	otlpHeaderCredentialValues,
} from "./diagnostic-env-values.js";
import {
	type CompiledDiagnosticSensitiveValues,
	registerProcessDiagnosticValues,
	suppressProcessDiagnosticValues,
	withAppDiagnosticFallback,
} from "./diagnostic-redactor.js";

type EnvObserver = (name: string, value: string) => void;
export interface DiagnosticEnvScope {
	observe: EnvObserver;
	finished: boolean;
	staticValues?: CompiledDiagnosticSensitiveValues;
}
const observers = new AsyncLocalStorage<DiagnosticEnvScope>();

/** Resolve and register atomically, before any consumer can use a live env credential. */
export function readDiagnosticEnv(
	name: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	const value = env[name];
	if (value !== undefined) {
		const scope = observers.getStore();
		if (scope && !scope.finished) scope.observe(name, value);
		else {
			// ALS survives the response. Finished requests register into the app's
			// inherited fallback lifetime, never a dead request's private inventory.
			if (Buffer.byteLength(value) > 64 * 1024) suppressProcessDiagnosticValues();
			else
				registerProcessDiagnosticValues([
					...resolvedStringVariants(value),
					...urlCredentialComponents(value, {
						includePathAndQuery: name === "APIFUSE__CDP_POOL__URL",
					}),
					...(name === "OTEL_EXPORTER_OTLP_HEADERS" || name === "OTEL_EXPORTER_OTLP_TRACES_HEADERS"
						? otlpHeaderCredentialValues(value)
						: []),
				]);
		}
	}
	return value;
}

export function withDiagnosticEnv<T>(observer: EnvObserver | DiagnosticEnvScope, fn: () => T): T {
	const scope = typeof observer === "function" ? { observe: observer, finished: false } : observer;
	const run = () => observers.run(scope, fn);
	return scope.staticValues ? withAppDiagnosticFallback(scope.staticValues, run) : run();
}
