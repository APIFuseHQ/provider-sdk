import type { BrowserEngine } from "../types.js";
import { Buffer } from "node:buffer";
export type BrowserTelemetryEngine = BrowserEngine | "host";
import {
	closedEnum,
	type ClosedEnum,
	type SpanIndex,
	type TelemetryContributor,
} from "./request-telemetry.js";

export type BrowserTelemetryPoolAcquireOutcome =
	| "ok"
	| "not_configured"
	| "queue_full"
	| "timed_out"
	| "shutting_down"
	| "unknown_lease"
	| "unknown_method"
	| "missing_allowed_hosts"
	| "transport_failure"
	| "other";

export type BrowserTelemetryErrorCode =
	| "BROWSER_CDP_POOL_REQUIRED"
	| "BROWSER_PROXY_INVALID"
	| "BROWSER_RUNTIME_UNSUPPORTED"
	| "BROWSER_CDP_POOL_ERROR"
	| "other";

export type BrowserTelemetrySampleName =
	| "browser.newPage"
	| "browser.page.goto"
	| "browser.page.fill"
	| "browser.page.click"
	| "browser.page.type"
	| "browser.page.waitForSelector"
	| "browser.evaluate"
	| "browser.content"
	| "browser.screenshot"
	| "other";

export type BrowserTelemetryLogPayload = {
	allocateMs: number;
	pages: number;
	navigations: number;
	actions: number;
	evaluate: number;
	content: number;
	screenshot: number;
	poolAcquireOutcome?: BrowserTelemetryPoolAcquireOutcome;
	poolAcquireAttempts: number;
	poolAcquireFailures: number;
	poolAcquireUnknownCode?: number;
	proxyAuthChallenges: number;
	engine?: BrowserTelemetryEngine;
	lastErrorCode?: BrowserTelemetryErrorCode;
	samples: {
		name: BrowserTelemetrySampleName;
		ms: number;
		status: "ok" | "error";
		diagnostics?: string;
	}[];
	dropped: number;
	telemetryFailed?: true;
};

export type BrowserTelemetryHeaderPayload = {
	allocateMs: number;
	pages: number;
	navigations: number;
	actions: number;
	evaluate: number;
	content: number;
	screenshot: number;
	poolAcquireOutcome?: ClosedEnum<BrowserTelemetryPoolAcquireOutcome>;
	poolAcquireAttempts: number;
	poolAcquireFailures: number;
	proxyAuthChallenges: number;
	engine?: ClosedEnum<BrowserTelemetryEngine>;
	lastErrorCode?: ClosedEnum<BrowserTelemetryErrorCode>;
	samples: {
		name: ClosedEnum<BrowserTelemetrySampleName>;
		ms: number;
		status: ClosedEnum<"ok" | "error">;
	}[];
	dropped: number;
};

export interface BrowserTelemetrySink {
	recordPoolAcquire(outcome: BrowserTelemetryPoolAcquireOutcome): void;
	recordPoolAcquireUnknownCode?(code: number): void;
	recordProxyAuthChallenge(): void;
	recordEngine(engine: BrowserTelemetryEngine): void;
	recordError(code: BrowserTelemetryErrorCode): void;
	markTelemetryFailed?(): void;
}

const MAX_SAMPLES = 24;
const SAMPLE_NAMES = new Set<BrowserTelemetrySampleName>([
	"browser.newPage",
	"browser.page.goto",
	"browser.page.fill",
	"browser.page.click",
	"browser.page.type",
	"browser.page.waitForSelector",
	"browser.evaluate",
	"browser.content",
	"browser.screenshot",
]);
function sampleName(name: string): BrowserTelemetrySampleName {
	if (name === "browser.page.evaluate") return "browser.evaluate";
	if (name === "browser.page.content") return "browser.content";
	if (name === "browser.page.screenshot") return "browser.screenshot";
	return name === "[REDACTION_FAILED]" || !SAMPLE_NAMES.has(name as BrowserTelemetrySampleName)
		? "other"
		: (name as BrowserTelemetrySampleName);
}

function boundedDiagnostics(text: string, redact?: (value: string) => string): string {
	let result: string;
	try {
		result = stripBrowserHeaderMaterial(redact?.(text) ?? text);
	} catch {
		return "[REDACTION_FAILED]";
	}
	const length = Math.min(result.length, 300);
	const units = Buffer.alloc(length * 2);
	for (let i = 0; i < length; i += 1) units.writeUInt16LE(result.charCodeAt(i), i * 2);
	return units.toString("utf16le");
}

function integer(value: number): number {
	return Math.min(
		Number.MAX_SAFE_INTEGER,
		Math.max(0, Math.floor(Number.isFinite(value) ? value : 0)),
	);
}

function add(a: number, b: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, integer(a) + integer(b));
}

export class BrowserTelemetryCollector
	implements
		TelemetryContributor<BrowserTelemetryLogPayload, BrowserTelemetryHeaderPayload>,
		BrowserTelemetrySink
{
	readonly key = "browser" as const;
	#poolAcquireOutcome: BrowserTelemetryPoolAcquireOutcome | undefined;
	#poolAcquireAttempts = 0;
	#poolAcquireFailures = 0;
	#poolAcquireUnknownCode: number | undefined;
	#telemetryFailed = false;
	#proxyAuthChallenges = 0;
	#engine: BrowserTelemetryEngine | undefined;
	#lastErrorCode: BrowserTelemetryErrorCode | undefined;
	readonly #redact: ((value: string) => string) | undefined;

	constructor(options: { redact?: (value: string) => string } = {}) {
		this.#redact = options.redact;
	}

	recordPoolAcquire(outcome: BrowserTelemetryPoolAcquireOutcome): void {
		this.#poolAcquireOutcome = outcome;
		this.#poolAcquireAttempts = add(this.#poolAcquireAttempts, 1);
		if (outcome !== "ok") this.#poolAcquireFailures = add(this.#poolAcquireFailures, 1);
	}
	recordPoolAcquireUnknownCode(code: number): void {
		this.#poolAcquireUnknownCode = code;
	}
	recordProxyAuthChallenge(): void {
		this.#proxyAuthChallenges = add(this.#proxyAuthChallenges, 1);
	}
	recordEngine(engine: BrowserTelemetryEngine): void {
		this.#engine = engine;
	}
	recordError(code: BrowserTelemetryErrorCode): void {
		this.#lastErrorCode = code;
	}
	markTelemetryFailed(): void {
		this.#telemetryFailed = true;
	}

	toLogPayload(spans: SpanIndex): BrowserTelemetryLogPayload | undefined {
		const browserSpans = spans.spans.filter(
			(span) =>
				span.name === "browser.newPage" ||
				span.name === "browser.rawPage" ||
				span.name === "browser.withIsolatedContext" ||
				span.name.startsWith("browser.page.") ||
				/^browser\.(evaluate|content|screenshot)$/.test(span.name),
		);
		const failedSpan = spans.spans.some((span) => span.name === "[REDACTION_FAILED]");
		if (
			browserSpans.length === 0 &&
			!failedSpan &&
			!this.#poolAcquireOutcome &&
			this.#proxyAuthChallenges === 0 &&
			!this.#engine &&
			!this.#lastErrorCode &&
			!this.#telemetryFailed
		)
			return undefined;
		const count = (name: string) => spans.count(name);
		const sampleSpans = failedSpan
			? [...browserSpans, ...spans.spans.filter((span) => span.name === "[REDACTION_FAILED]")]
			: browserSpans;
		const samples: BrowserTelemetryLogPayload["samples"] = sampleSpans
			.slice(0, MAX_SAMPLES)
			.map((span) => ({
				name: sampleName(span.name),
				ms: integer(span.duration_ms),
				status: (span.status === "error" ? "error" : "ok") as "ok" | "error",
				...(span.name === "[REDACTION_FAILED]"
					? { diagnostics: "[REDACTION_FAILED]" }
					: span.error
						? { diagnostics: boundedDiagnostics(span.error, this.#redact) }
						: {}),
			}));
		return {
			allocateMs: integer(
				browserSpans
					.filter((span) => span.name === "browser.newPage")
					.reduce((sum, span) => sum + Number(span.attributes.allocate_ms ?? span.duration_ms), 0),
			),
			pages: add(
				add(count("browser.newPage"), count("browser.rawPage")),
				count("browser.withIsolatedContext"),
			),
			navigations: integer(count("browser.page.goto")),
			actions: ["fill", "click", "type", "waitForSelector"].reduce(
				(sum, method) => add(sum, count(`browser.page.${method}`)),
				0,
			),
			evaluate: add(count("browser.evaluate"), count("browser.page.evaluate")),
			content: add(count("browser.page.content"), count("browser.content")),
			screenshot: add(count("browser.page.screenshot"), count("browser.screenshot")),
			...(this.#poolAcquireOutcome ? { poolAcquireOutcome: this.#poolAcquireOutcome } : {}),
			poolAcquireAttempts: this.#poolAcquireAttempts,
			poolAcquireFailures: this.#poolAcquireFailures,
			...(this.#poolAcquireUnknownCode === undefined
				? {}
				: { poolAcquireUnknownCode: this.#poolAcquireUnknownCode }),
			proxyAuthChallenges: this.#proxyAuthChallenges,
			...(this.#engine ? { engine: this.#engine } : {}),
			...(this.#lastErrorCode ? { lastErrorCode: this.#lastErrorCode } : {}),
			samples,
			dropped: Math.max(0, sampleSpans.length - samples.length),
			...(this.#telemetryFailed ? { telemetryFailed: true as const } : {}),
		};
	}

	toHeaderPayload(log: BrowserTelemetryLogPayload): BrowserTelemetryHeaderPayload {
		return {
			allocateMs: log.allocateMs,
			pages: log.pages,
			navigations: log.navigations,
			actions: log.actions,
			evaluate: log.evaluate,
			content: log.content,
			screenshot: log.screenshot,
			...(log.poolAcquireOutcome ? { poolAcquireOutcome: closedEnum(log.poolAcquireOutcome) } : {}),
			poolAcquireAttempts: log.poolAcquireAttempts,
			poolAcquireFailures: log.poolAcquireFailures,
			proxyAuthChallenges: log.proxyAuthChallenges,
			...(log.engine ? { engine: closedEnum(log.engine) } : {}),
			...(log.lastErrorCode ? { lastErrorCode: closedEnum(log.lastErrorCode) } : {}),
			samples: log.samples.map((sample) => ({
				name: closedEnum(sample.name),
				ms: sample.ms,
				status: closedEnum(sample.status),
			})),
			dropped: log.dropped,
		};
	}
}

/** Defence in depth for diagnostics that accidentally contain protocol headers. */
export function stripBrowserHeaderMaterial(value: string): string {
	return value
		.replace(
			/(^|[^\p{L}\p{N}_-])[\t ]*(?:cookie|set-cookie|authorization)[\t ]*(?::|=)[^\r\n]*/giu,
			"$1[REDACTED]",
		)
		.replace(
			/"(?:cookie|set-cookie|authorization)"[\t ]*:[\t ]*"(?:\\.|[^"\\])*"/giu,
			"[REDACTED]",
		);
}
