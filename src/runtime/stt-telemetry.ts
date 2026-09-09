import type { SttContext } from "../types.js";
import {
	add,
	capabilityErrorText,
	capabilityFacts,
	capabilityMetadata,
	capabilityText,
	inputBytes,
	integer,
	observeCapability,
	registerCapabilityInput,
} from "./capability-telemetry.js";
import {
	type ClosedEnum,
	closedEnum,
	type SpanIndex,
	type TelemetryContributor,
} from "./request-telemetry.js";
export type SttTelemetryBackend = "cloudflare-workers-ai" | "custom" | "unavailable";
export type SttTelemetryEngine = "workers-ai" | "custom";
export type SttTelemetryErrorCode =
	| "STT_UNAVAILABLE"
	| "UNSUPPORTED_STT_BACKEND"
	| "STT_UPSTREAM_FAILED"
	| "STT_AUDIO_TOO_LARGE"
	| "UNSUPPORTED_STT_OPTION"
	| "INVALID_STT_AUDIO"
	| "INVALID_STT_VERIFICATION_CODE_OPTIONS"
	| "NO_CODE_FOUND"
	| "AMBIGUOUS_CODE"
	| "transport_network_error"
	| "transport_timeout"
	| "other";
export type SttTelemetryModel = "whisper-large-v3-turbo";
const ERROR_CODES: ReadonlySet<string> = new Set([
	"STT_UNAVAILABLE",
	"UNSUPPORTED_STT_BACKEND",
	"STT_UPSTREAM_FAILED",
	"STT_AUDIO_TOO_LARGE",
	"UNSUPPORTED_STT_OPTION",
	"INVALID_STT_AUDIO",
	"INVALID_STT_VERIFICATION_CODE_OPTIONS",
	"NO_CODE_FOUND",
	"AMBIGUOUS_CODE",
	"transport_network_error",
	"transport_timeout",
	"other",
]);
const MODELS = new Map<string, SttTelemetryModel>([
	["@cf/openai/whisper-large-v3-turbo", "whisper-large-v3-turbo"],
]);
function errorCode(error: unknown): SttTelemetryErrorCode {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	return typeof code === "string" && ERROR_CODES.has(code)
		? (code as SttTelemetryErrorCode)
		: "other";
}
export type SttTelemetryEvent = {
	backend: SttTelemetryBackend;
	engine: SttTelemetryEngine;
	model?: string;
	ms: number;
	status?: number;
	audioBytes?: number;
	durationMs?: number;
	usage?: number;
	warnings?: number;
	errorCode?: SttTelemetryErrorCode;
	diagnostics?: string;
};
export interface SttTelemetrySink {
	record(event: SttTelemetryEvent): void;
	markTelemetryFailed?(): void;
}
export type SttTelemetryLogPayload = {
	telemetryFailed?: true;
	diagnostics?: string[];
	backend: SttTelemetryBackend;
	engine: SttTelemetryEngine;
	model?: string;
	ms: number;
	status?: number;
	audioBytes: number;
	durationMs: number;
	usage: number;
	warnings: number;
	lastErrorCode?: SttTelemetryErrorCode;

	samples?: Array<Omit<SttTelemetryEvent, "backend" | "engine" | "model" | "diagnostics">>;
	samplesDropped?: number;
};
export type SttTelemetryHeaderPayload = {
	backend: ClosedEnum<SttTelemetryBackend>;
	engine: ClosedEnum<SttTelemetryEngine>;
	model?: ClosedEnum<SttTelemetryModel>;
	ms: number;
	status?: number;
	audioBytes: number;
	durationMs: number;
	usage: number;
	warnings: number;
	lastErrorCode?: ClosedEnum<SttTelemetryErrorCode>;

	samples?: Array<{
		ms: number;
		status?: number;
		audioBytes?: number;
		durationMs?: number;
		usage?: number;
		warnings?: number;
		errorCode?: ClosedEnum<SttTelemetryErrorCode>;
	}>;
	samplesDropped?: number;
};
export class SttTelemetryCollector
	implements
		SttTelemetrySink,
		TelemetryContributor<SttTelemetryLogPayload, SttTelemetryHeaderPayload>
{
	readonly key = "stt" as const;
	readonly #redact?: (text: string) => string;
	#samples: NonNullable<SttTelemetryLogPayload["samples"]> = [];
	#summary: Omit<SttTelemetryLogPayload, "samples" | "samplesDropped"> | undefined;
	#diagnostics: string[] = [];
	#dropped = 0;
	#failed = false;
	constructor(options: { redact?: (text: string) => string } = {}) {
		this.#redact = options.redact;
	}
	markTelemetryFailed(): void {
		this.#failed = true;
		this.#summary ??= {
			backend: "custom",
			engine: "custom",
			ms: 0,
			audioBytes: 0,
			durationMs: 0,
			usage: 0,
			warnings: 0,
		};
	}
	record(event: SttTelemetryEvent): void {
		const sample = {
			ms: integer(event.ms),
			...(event.status === undefined ? {} : { status: integer(event.status) }),
			...(event.audioBytes === undefined ? {} : { audioBytes: integer(event.audioBytes) }),
			...(event.durationMs === undefined ? {} : { durationMs: integer(event.durationMs) }),
			...(event.usage === undefined ? {} : { usage: integer(event.usage) }),
			...(event.warnings === undefined ? {} : { warnings: integer(event.warnings) }),
			...(event.errorCode ? { errorCode: event.errorCode } : {}),

			...(event.diagnostics === undefined
				? {}
				: { diagnostics: capabilityText(event.diagnostics, this.#redact, true) }),
		};
		const prior = this.#summary;
		this.#summary = {
			backend: event.backend,
			engine: event.engine,
			...(event.model === undefined ? {} : { model: capabilityText(event.model, this.#redact) }),
			ms: add(prior?.ms ?? 0, sample.ms),
			...(sample.status === undefined ? {} : { status: sample.status }),
			audioBytes: add(prior?.audioBytes ?? 0, sample.audioBytes ?? 0),
			durationMs: add(prior?.durationMs ?? 0, sample.durationMs ?? 0),
			usage: add(prior?.usage ?? 0, sample.usage ?? 0),
			warnings: add(prior?.warnings ?? 0, sample.warnings ?? 0),
			...(event.errorCode ? { lastErrorCode: event.errorCode } : {}),
		};
		if (this.#samples.length < 24) {
			const { diagnostics, ...closedSample } = sample;
			this.#samples.push(closedSample);
			if (diagnostics !== undefined) this.#diagnostics.push(diagnostics);
		} else this.#dropped = add(this.#dropped, 1);
	}
	toLogPayload(_spans: SpanIndex): SttTelemetryLogPayload | undefined {
		if (!this.#summary) return undefined;
		return {
			...this.#summary,
			...(this.#diagnostics.length ? { diagnostics: [...this.#diagnostics] } : {}),
			...(this.#failed ? { telemetryFailed: true as const } : {}),
			samples: this.#samples.map((s) => ({ ...s })),
			...(this.#dropped ? { samplesDropped: this.#dropped } : {}),
		};
	}
	toHeaderPayload(log: SttTelemetryLogPayload): SttTelemetryHeaderPayload {
		return {
			backend: closedEnum(log.backend),
			engine: closedEnum(log.engine),
			...(log.model && MODELS.has(log.model) ? { model: closedEnum(MODELS.get(log.model)!) } : {}),
			ms: log.ms,
			...(log.status === undefined ? {} : { status: log.status }),
			audioBytes: log.audioBytes,
			durationMs: log.durationMs,
			usage: log.usage,
			warnings: log.warnings,
			...(log.lastErrorCode ? { lastErrorCode: closedEnum(log.lastErrorCode) } : {}),

			...(log.samples
				? {
						samples: log.samples.map((s) => ({
							ms: s.ms,
							...(s.status === undefined ? {} : { status: s.status }),
							...(s.audioBytes === undefined ? {} : { audioBytes: s.audioBytes }),
							...(s.durationMs === undefined ? {} : { durationMs: s.durationMs }),
							...(s.usage === undefined ? {} : { usage: s.usage }),
							...(s.warnings === undefined ? {} : { warnings: s.warnings }),
							...(s.errorCode ? { errorCode: closedEnum(s.errorCode) } : {}),
						})),
					}
				: {}),
			...(log.samplesDropped ? { samplesDropped: log.samplesDropped } : {}),
		};
	}
}
export function bindSttTelemetry(
	context: SttContext,
	sink: SttTelemetrySink,
	options: { backend?: SttTelemetryBackend; engine?: SttTelemetryEngine; model?: string } = {},
): SttContext {
	const metadata = capabilityMetadata(context);
	const backend =
		options.backend ?? (metadata?.backend as SttTelemetryBackend | undefined) ?? "custom";
	const engine = options.engine ?? (metadata?.engine as SttTelemetryEngine | undefined) ?? "custom";
	const model = options.model ?? metadata?.model;
	async function run<
		T extends {
			text: string;
			durationMs?: number;
			usage?: { audioBytes?: number; audioDurationMs?: number };
			warnings?: readonly unknown[];
		},
	>(input: { kind: string; data?: string; url?: string }, operation: () => Promise<T>): Promise<T> {
		const started = performance.now();
		const facts: { status?: number; finishReason?: string; diagnostics?: string } = {};
		observeCapability(sink, () => registerCapabilityInput(input));
		let result: T;
		try {
			result = await capabilityFacts.run(facts, operation);
		} catch (error) {
			observeCapability(sink, () => {
				const status =
					error &&
					typeof error === "object" &&
					"status" in error &&
					typeof error.status === "number"
						? error.status
						: undefined;
				return sink.record({
					backend,
					engine,
					model,
					ms: performance.now() - started,
					status: facts.status ?? status,
					audioBytes: inputBytes(input),
					errorCode: errorCode(error),

					diagnostics: `${capabilityErrorText(error)} ${facts.diagnostics ?? ""}`,
				});
			});
			throw error;
		}
		observeCapability(sink, () =>
			sink.record({
				backend,
				engine,
				model: model,
				ms: performance.now() - started,
				status: facts.status,
				audioBytes: result.usage?.audioBytes ?? inputBytes(input),
				durationMs: result.durationMs,
				usage: result.usage?.audioDurationMs,
				warnings: result.warnings?.length ?? 0,
			}),
		);
		return result;
	}
	return {
		...context,
		transcribe: (request) => run(request.audio, () => context.transcribe(request)),
		extractVerificationCode: (text, opts) => context.extractVerificationCode(text, opts),
	};
}
