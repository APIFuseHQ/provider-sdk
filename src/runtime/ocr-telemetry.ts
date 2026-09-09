import type { OcrContext } from "../types.js";
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
export type OcrTelemetryBackend =
	| "cloudflare-workers-ai"
	| "openai-compatible"
	| "custom"
	| "unavailable";
export type OcrTelemetryEngine = "workers-ai" | "openai-compatible" | "custom";
export type OcrTelemetryErrorCode =
	| "OCR_UNAVAILABLE"
	| "UNSUPPORTED_OCR_BACKEND"
	| "OCR_UPSTREAM_FAILED"
	| "OCR_INCOMPLETE_RESPONSE"
	| "transport_network_error"
	| "transport_timeout"
	| "other";
export type OcrTelemetryModel =
	| "gemma-4-26b-a4b-it"
	| "glm-ocr"
	| "moondream3.1-9B-A2B"
	| "kimi-k2.7-code";
export type OcrTelemetryFinishReason =
	| "stop"
	| "length"
	| "content_filter"
	| "tool_calls"
	| "function_call"
	| "error"
	| "unknown";
const ERROR_CODES: ReadonlySet<string> = new Set([
	"OCR_UNAVAILABLE",
	"UNSUPPORTED_OCR_BACKEND",
	"OCR_UPSTREAM_FAILED",
	"OCR_INCOMPLETE_RESPONSE",
	"transport_network_error",
	"transport_timeout",
	"other",
]);
const MODELS = new Map<string, OcrTelemetryModel>([
	["@cf/google/gemma-4-26b-a4b-it", "gemma-4-26b-a4b-it"],
	["zai-org/GLM-OCR", "glm-ocr"],
	["@cf/moondream/moondream3.1-9B-A2B", "moondream3.1-9B-A2B"],
	["@cf/moonshotai/kimi-k2.7-code", "kimi-k2.7-code"],
]);
function errorCode(error: unknown): OcrTelemetryErrorCode {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	return typeof code === "string" && ERROR_CODES.has(code)
		? (code as OcrTelemetryErrorCode)
		: "other";
}
function finishReason(value: string | undefined, failed: boolean): OcrTelemetryFinishReason {
	switch (value) {
		case "stop":
		case "length":
		case "content_filter":
		case "tool_calls":
		case "function_call":
			return value;
		default:
			return value === undefined ? (failed ? "error" : "stop") : "unknown";
	}
}
export type OcrTelemetryEvent = {
	backend: OcrTelemetryBackend;
	engine: OcrTelemetryEngine;
	model?: string;
	ms: number;
	status?: number;
	bytesIn?: number;
	bytesOut?: number;
	candidates?: number;
	warnings?: number;
	errorCode?: OcrTelemetryErrorCode;
	diagnostics?: string;
	finishReason?: OcrTelemetryFinishReason;
};
export interface OcrTelemetrySink {
	record(event: OcrTelemetryEvent): void;
	markTelemetryFailed?(): void;
}
export type OcrTelemetryLogPayload = {
	telemetryFailed?: true;
	diagnostics?: string[];
	backend: OcrTelemetryBackend;
	engine: OcrTelemetryEngine;
	model?: string;
	ms: number;
	status?: number;
	bytesIn: number;
	bytesOut: number;
	candidates: number;
	warnings: number;
	lastErrorCode?: OcrTelemetryErrorCode;
	finishReason?: OcrTelemetryFinishReason;
	samples?: Array<Omit<OcrTelemetryEvent, "backend" | "engine" | "model" | "diagnostics">>;
	samplesDropped?: number;
};
export type OcrTelemetryHeaderPayload = {
	backend: ClosedEnum<OcrTelemetryBackend>;
	engine: ClosedEnum<OcrTelemetryEngine>;
	model?: ClosedEnum<OcrTelemetryModel>;
	ms: number;
	status?: number;
	bytesIn: number;
	bytesOut: number;
	candidates: number;
	warnings: number;
	lastErrorCode?: ClosedEnum<OcrTelemetryErrorCode>;
	finishReason?: ClosedEnum<OcrTelemetryFinishReason>;
	samples?: Array<{
		ms: number;
		status?: number;
		bytesIn?: number;
		bytesOut?: number;
		candidates?: number;
		warnings?: number;
		errorCode?: ClosedEnum<OcrTelemetryErrorCode>;
		finishReason?: ClosedEnum<OcrTelemetryFinishReason>;
	}>;
	samplesDropped?: number;
};
export class OcrTelemetryCollector
	implements
		OcrTelemetrySink,
		TelemetryContributor<OcrTelemetryLogPayload, OcrTelemetryHeaderPayload>
{
	readonly key = "ocr" as const;
	readonly #redact?: (text: string) => string;
	#samples: NonNullable<OcrTelemetryLogPayload["samples"]> = [];
	#summary: Omit<OcrTelemetryLogPayload, "samples" | "samplesDropped"> | undefined;
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
			bytesIn: 0,
			bytesOut: 0,
			candidates: 0,
			warnings: 0,
		};
	}
	record(event: OcrTelemetryEvent): void {
		const sample = {
			ms: integer(event.ms),
			...(event.status === undefined ? {} : { status: integer(event.status) }),
			...(event.bytesIn === undefined ? {} : { bytesIn: integer(event.bytesIn) }),
			...(event.bytesOut === undefined ? {} : { bytesOut: integer(event.bytesOut) }),
			...(event.candidates === undefined ? {} : { candidates: integer(event.candidates) }),
			...(event.warnings === undefined ? {} : { warnings: integer(event.warnings) }),
			...(event.errorCode ? { errorCode: event.errorCode } : {}),
			...(event.finishReason ? { finishReason: event.finishReason } : {}),
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
			bytesIn: add(prior?.bytesIn ?? 0, sample.bytesIn ?? 0),
			bytesOut: add(prior?.bytesOut ?? 0, sample.bytesOut ?? 0),
			candidates: add(prior?.candidates ?? 0, sample.candidates ?? 0),
			warnings: add(prior?.warnings ?? 0, sample.warnings ?? 0),
			...(event.errorCode ? { lastErrorCode: event.errorCode } : {}),
			...(event.finishReason ? { finishReason: event.finishReason } : {}),
		};
		if (this.#samples.length < 24) {
			const { diagnostics, ...closedSample } = sample;
			this.#samples.push(closedSample);
			if (diagnostics !== undefined) this.#diagnostics.push(diagnostics);
		} else this.#dropped = add(this.#dropped, 1);
	}
	toLogPayload(_spans: SpanIndex): OcrTelemetryLogPayload | undefined {
		if (!this.#summary) return undefined;
		return {
			...this.#summary,
			...(this.#diagnostics.length ? { diagnostics: [...this.#diagnostics] } : {}),
			...(this.#failed ? { telemetryFailed: true as const } : {}),
			samples: this.#samples.map((s) => ({ ...s })),
			...(this.#dropped ? { samplesDropped: this.#dropped } : {}),
		};
	}
	toHeaderPayload(log: OcrTelemetryLogPayload): OcrTelemetryHeaderPayload {
		return {
			backend: closedEnum(log.backend),
			engine: closedEnum(log.engine),
			...(log.model && MODELS.has(log.model) ? { model: closedEnum(MODELS.get(log.model)!) } : {}),
			ms: log.ms,
			...(log.status === undefined ? {} : { status: log.status }),
			bytesIn: log.bytesIn,
			bytesOut: log.bytesOut,
			candidates: log.candidates,
			warnings: log.warnings,
			...(log.lastErrorCode ? { lastErrorCode: closedEnum(log.lastErrorCode) } : {}),
			...(log.finishReason ? { finishReason: closedEnum(log.finishReason) } : {}),
			...(log.samples
				? {
						samples: log.samples.map((s) => ({
							ms: s.ms,
							...(s.status === undefined ? {} : { status: s.status }),
							...(s.bytesIn === undefined ? {} : { bytesIn: s.bytesIn }),
							...(s.bytesOut === undefined ? {} : { bytesOut: s.bytesOut }),
							...(s.candidates === undefined ? {} : { candidates: s.candidates }),
							...(s.warnings === undefined ? {} : { warnings: s.warnings }),
							...(s.errorCode ? { errorCode: closedEnum(s.errorCode) } : {}),
							...(s.finishReason ? { finishReason: closedEnum(s.finishReason) } : {}),
						})),
					}
				: {}),
			...(log.samplesDropped ? { samplesDropped: log.samplesDropped } : {}),
		};
	}
}
export function bindOcrTelemetry(
	context: OcrContext,
	sink: OcrTelemetrySink,
	options: { backend?: OcrTelemetryBackend; engine?: OcrTelemetryEngine; model?: string } = {},
): OcrContext {
	const metadata = capabilityMetadata(context);
	const backend =
		options.backend ?? (metadata?.backend as OcrTelemetryBackend | undefined) ?? "custom";
	const engine = options.engine ?? (metadata?.engine as OcrTelemetryEngine | undefined) ?? "custom";
	const model = options.model ?? metadata?.model;
	async function run<
		T extends {
			text: string;
			model: string;
			candidates?: readonly unknown[];
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
					bytesIn: inputBytes(input),
					errorCode: errorCode(error),
					finishReason: finishReason(facts.finishReason, true),
					diagnostics: `${capabilityErrorText(error)} ${facts.diagnostics ?? ""}`,
				});
			});
			throw error;
		}
		observeCapability(sink, () =>
			sink.record({
				backend,
				engine,
				model: result.model,
				ms: performance.now() - started,
				status: facts.status,
				bytesIn: inputBytes(input),
				bytesOut: Buffer.byteLength(result.text),
				candidates: result.candidates?.length ?? 0,
				finishReason: finishReason(facts.finishReason, false),
				warnings: result.warnings?.length ?? 0,
			}),
		);
		return result;
	}
	return {
		...context,
		recognize: (request) => run(request.image, () => context.recognize(request)),
		extractCaptchaText: (image, opts) => run(image, () => context.extractCaptchaText(image, opts)),
	};
}
