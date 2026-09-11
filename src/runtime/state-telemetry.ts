import type {
	ProviderRuntimeState,
	ProviderStateNamespace,
	StateNamespaceOptions,
} from "../types.js";
import { createTelemetryObserver } from "./http-telemetry-guard.js";
import {
	type ClosedEnum,
	closedEnum,
	type SpanIndex,
	type TelemetryContributor,
} from "./request-telemetry.js";
import { getStateViolation, isStateRedisNoop } from "./state.js";

export type StateTelemetryOperation =
	| "list"
	| "get"
	| "set"
	| "patch"
	| "delete"
	| "cas"
	| "increment";
export type StateTelemetryBackend = "redis" | "memory" | "unsupported";
export type StateTelemetryViolation = "quota" | "ttl" | "size" | "unsupported" | "error";

export type StateTelemetrySample = {
	key: string;
	op: StateTelemetryOperation;
	ms: number;
	backend: StateTelemetryBackend;
};
export type StateTelemetryLogPayload = {
	telemetryFailed?: true;
	ops: {
		list: number;
		get: number;
		set: number;
		patch: number;
		delete: number;
		cas: number;
		increment: number;
	};
	casConflicts: number;
	violations: { quota: number; ttl: number; size: number; unsupported: number; error: number };
	backend: ClosedEnum<StateTelemetryBackend>;
	/** State fails closed on Redis errors, so this remains 0 until a fallback exists. */
	redisFallbacks: number;
	redisMode: ClosedEnum<"not_configured" | "configured" | "degraded">;
	/** Successful state operations that touch Redis; each operation counts once, regardless of command count. */
	redisRoundTrips: number;
	ms: number;
	samples: StateTelemetrySample[];
	dropped: number;
};
export type StateTelemetryHeaderPayload = Omit<
	StateTelemetryLogPayload,
	"samples" | "telemetryFailed"
>;

export interface StateTelemetrySink {
	markTelemetryFailed?(): void;
	setRedisConfigured?(configured: boolean): void;
	record(event: {
		op: StateTelemetryOperation;
		key?: string;
		ms: number;
		backend: StateTelemetryBackend;
		ok: boolean;
		conflict?: boolean;
		violation?: StateTelemetryViolation;
		/** False for successful Redis-backed operations that execute no Redis commands. */
		redisTouched?: boolean;
	}): void;
}

const MAX_SAMPLES = 24;
const MAX_TEXT = 300;
const STATE_TELEMETRY_INSTRUMENTED = Symbol.for(
	"@apifuse/provider-sdk/state-telemetry-instrumented",
);
function integer(value: number): number {
	return Number.isFinite(value)
		? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
		: Number.MAX_SAFE_INTEGER;
}
function add(a: number, b: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, integer(a) + integer(b));
}
function keyText(value: string | undefined, redact?: (text: string) => string): string | undefined {
	if (value === undefined) return undefined;
	let result: string;
	try {
		result = redact?.(value) ?? value;
	} catch {
		result = "[REDACTION_FAILED]";
	}
	const length = Math.min(result.length, MAX_TEXT);
	const units = new Uint16Array(length);
	for (let index = 0; index < length; index += 1) units[index] = result.charCodeAt(index);
	return String.fromCharCode(...units);
}

export class StateTelemetryCollector
	implements
		TelemetryContributor<StateTelemetryLogPayload, StateTelemetryHeaderPayload>,
		StateTelemetrySink
{
	readonly key = "state" as const;
	readonly #redact?: (text: string) => string;
	#telemetryFailed = false;
	#ops = { list: 0, get: 0, set: 0, patch: 0, delete: 0, cas: 0, increment: 0 };
	#conflicts = 0;
	#violations = { quota: 0, ttl: 0, size: 0, unsupported: 0, error: 0 };
	#backend: StateTelemetryBackend = "unsupported";
	#redisFallbacks = 0;
	#configured: "not_configured" | "configured" | "degraded" = "not_configured";
	#redisRoundTrips = 0;
	#ms = 0;
	#samples: StateTelemetrySample[] = [];
	#dropped = 0;
	constructor(options: { redact?: (text: string) => string } = {}) {
		this.#redact = options.redact;
	}
	markTelemetryFailed(): void {
		this.#telemetryFailed = true;
	}
	setRedisConfigured(configured: boolean): void {
		if (configured && this.#configured === "not_configured") this.#configured = "configured";
	}
	record(event: {
		op: StateTelemetryOperation;
		key?: string;
		ms: number;
		backend: StateTelemetryBackend;
		ok: boolean;
		conflict?: boolean;
		violation?: StateTelemetryViolation;
		/** False for successful Redis-backed operations that execute no Redis commands. */
		redisTouched?: boolean;
	}): void {
		if (
			!["list", "get", "set", "patch", "delete", "cas", "increment"].includes(event.op) ||
			!["redis", "memory", "unsupported"].includes(event.backend) ||
			(event.violation !== undefined &&
				!["quota", "ttl", "size", "unsupported", "error"].includes(event.violation))
		) {
			this.#telemetryFailed = true;
			return;
		}
		this.#ops[event.op] = add(this.#ops[event.op], 1);
		this.#backend = event.backend;
		if (event.backend === "redis" && this.#configured === "not_configured")
			this.#configured = "configured";
		if (event.backend === "redis" && event.ok && event.redisTouched !== false)
			this.#redisRoundTrips = add(this.#redisRoundTrips, 1);
		if (event.backend === "redis" && !event.ok) this.#configured = "degraded";
		this.#ms = add(this.#ms, event.ms);
		if (event.conflict) this.#conflicts = add(this.#conflicts, 1);
		if (event.violation)
			this.#violations[event.violation] = add(this.#violations[event.violation], 1);
		if (this.#samples.length < MAX_SAMPLES)
			this.#samples.push({
				key: keyText(event.key, this.#redact) ?? "",
				op: event.op,
				ms: integer(event.ms),
				backend: event.backend,
			});
		else this.#dropped = add(this.#dropped, 1);
	}
	toLogPayload(_spans: SpanIndex): StateTelemetryLogPayload | undefined {
		if (Object.values(this.#ops).every((value) => value === 0) && !this.#telemetryFailed)
			return undefined;
		return {
			...(this.#telemetryFailed ? { telemetryFailed: true as const } : {}),
			ops: { ...this.#ops },
			casConflicts: this.#conflicts,
			violations: { ...this.#violations },
			backend: closedEnum(this.#backend),
			redisFallbacks: this.#redisFallbacks,
			redisMode: closedEnum(this.#configured),
			redisRoundTrips: this.#redisRoundTrips,
			ms: this.#ms,
			samples: this.#samples.map((sample) => ({ ...sample })),
			dropped: this.#dropped,
		};
	}
	toHeaderPayload(log: StateTelemetryLogPayload): StateTelemetryHeaderPayload {
		return {
			ops: log.ops,
			casConflicts: log.casConflicts,
			violations: log.violations,
			backend: log.backend,
			redisFallbacks: log.redisFallbacks,
			redisMode: log.redisMode,
			redisRoundTrips: log.redisRoundTrips,
			ms: log.ms,
			dropped: log.dropped,
		};
	}
}

function backendOf(state: ProviderRuntimeState): StateTelemetryBackend {
	try {
		const name = state.constructor?.name;
		return name?.includes("Redis") ? "redis" : name?.includes("Memory") ? "memory" : "unsupported";
	} catch {
		return "unsupported";
	}
}

function violationOf(error: unknown): StateTelemetryViolation {
	return getStateViolation(error) ?? "error";
}

function wrapNamespace(
	namespace: ProviderStateNamespace,
	sink: StateTelemetrySink,
	backend: StateTelemetryBackend,
): ProviderStateNamespace {
	// Compare-and-set records one event per attempt; a three-attempt loop therefore
	// reports cas: 3 and casConflicts: 2 when the first two attempts conflict.
	const observe = createTelemetryObserver(sink);
	return new Proxy(namespace, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function" || property === "constructor") return value;
			const op =
				property === "compareAndSet" ? "cas" : (String(property) as StateTelemetryOperation);
			if (!(op in { list: 1, get: 1, set: 1, patch: 1, delete: 1, cas: 1, increment: 1 }))
				return value;
			return async (...args: unknown[]) => {
				const started = Date.now();
				const key = typeof args[0] === "string" ? args[0] : undefined;
				try {
					const result = await Reflect.apply(value, target, args);
					observe(() =>
						sink.record({
							op,
							key,
							ms: Date.now() - started,
							backend,
							ok: true,
							redisTouched: !isStateRedisNoop(result),
							conflict:
								op === "cas" &&
								!!result &&
								typeof result === "object" &&
								"ok" in result &&
								result.ok === false,
						}),
					);
					return result;
				} catch (error) {
					observe(() =>
						sink.record({
							op,
							key,
							ms: Date.now() - started,
							backend,
							ok: false,
							violation: violationOf(error),
						}),
					);
					throw error;
				}
			};
		},
	}) as ProviderStateNamespace;
}

export function instrumentProviderRuntimeState(
	state: ProviderRuntimeState,
	sink: StateTelemetrySink,
	redact?: (text: string) => string,
): ProviderRuntimeState {
	if (
		(state as ProviderRuntimeState & { [STATE_TELEMETRY_INSTRUMENTED]?: boolean })[
			STATE_TELEMETRY_INSTRUMENTED
		]
	)
		return state;
	const backend = backendOf(state);
	const observe = createTelemetryObserver(sink);
	observe(() => sink.setRedisConfigured?.(backend === "redis"));
	return new Proxy(state, {
		get(target, property, receiver) {
			if (property === STATE_TELEMETRY_INSTRUMENTED) return true;
			const value = Reflect.get(target, property, receiver);
			if (property === "forConnection" && typeof value === "function")
				return (id: string | undefined) =>
					instrumentProviderRuntimeState(value.call(target, id), sink, redact);
			if (property === "namespace" && typeof value === "function")
				return (name: string, options: StateNamespaceOptions) =>
					wrapNamespace(value.call(target, name, options), sink, backend);
			return value;
		},
	}) as ProviderRuntimeState;
}
