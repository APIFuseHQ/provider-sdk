import { statefulSignedHeaders } from "../stateful-signing.js";
import type {
	ProviderEventDeliveryFailureReason,
	ProviderEventDeliveryFailureRecorder,
} from "./provider-event-delivery-failures.js";
import type {
	ProviderEventPublisher,
	ProviderEventPublishOptions,
	PublishAck,
} from "./provider-event-pipeline.js";
import {
	NOOP_PROVIDER_EVENT_METRIC_EMITTER,
	providerEventMetricLabels,
	type ProviderEventMetricEmitter,
} from "./provider-event-pipeline-metrics.js";
import type { ProviderEvent } from "./provider-events.js";

type FetchTransport = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type HttpProviderEventEmitterOptions = {
	readonly baseUrl: string;
	readonly secret: string;
	readonly fetch?: FetchTransport;
	readonly clock?: () => Date;
	readonly random?: () => number;
	readonly metricEmitter?: ProviderEventMetricEmitter;
	readonly failureRecorder?: ProviderEventDeliveryFailureRecorder;
	readonly maxBufferedEvents?: number;
	readonly retryBaseMs?: number;
	readonly retryMaxMs?: number;
	readonly maxAttempts?: number;
	readonly jitterRatio?: number;
};

type BufferedEvent = {
	readonly event: ProviderEvent;
	readonly rawBody: string;
	readonly idempotencyKey: string;
	attempts: number;
	dropped: boolean;
	abortController?: AbortController;
};

const DEFAULT_MAX_BUFFERED_EVENTS = 1_000;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_JITTER_RATIO = 0.2;

export type ProviderEventFlushReport = {
	/** Events delivered during this emitter's lifetime. */
	readonly delivered: number;
	/** Events permanently dropped during this emitter's lifetime. */
	readonly failed: number;
	/** Events still buffered when flush returned. */
	readonly pending: number;
};

const CONSOLE_PROVIDER_EVENT_DELIVERY_FAILURE_RECORDER = {
	record(failure) {
		console.error(
			JSON.stringify({
				event: "provider_event_delivery_failed",
				eventId: failure.eventId,
				reason: failure.reason,
				attempts: failure.attempts,
			}),
		);
	},
} satisfies ProviderEventDeliveryFailureRecorder;

/**
 * Provider-pod HTTP publication with a bounded best-effort delivery guarantee and at-least-once
 * transport retries. This is not durable at-least-once delivery: buffered events can be lost if
 * the process is killed. Graceful shutdown should drain the in-memory buffer with flush().
 */
export class HttpProviderEventEmitter implements ProviderEventPublisher {
	readonly #baseUrl: string;
	readonly #secret: string;
	readonly #fetch: FetchTransport;
	readonly #clock: () => Date;
	readonly #random: () => number;
	readonly #metricEmitter: ProviderEventMetricEmitter;
	readonly #failureRecorder: ProviderEventDeliveryFailureRecorder;
	readonly #maxBufferedEvents: number;
	readonly #retryBaseMs: number;
	readonly #retryMaxMs: number;
	readonly #maxAttempts: number;
	readonly #jitterRatio: number;
	readonly #queue: BufferedEvent[] = [];
	#drainPromise?: Promise<void>;
	#deliveredCount = 0;
	#failedCount = 0;

	constructor(options: HttpProviderEventEmitterOptions) {
		if (options.baseUrl.trim().length === 0) {
			throw new Error("Provider event ingest baseUrl is required.");
		}
		if (options.secret.trim().length === 0) {
			throw new Error("Provider event ingest secret is required.");
		}
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#secret = options.secret;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#clock = options.clock ?? (() => new Date());
		this.#random = options.random ?? Math.random;
		this.#metricEmitter = options.metricEmitter ?? NOOP_PROVIDER_EVENT_METRIC_EMITTER;
		this.#failureRecorder =
			options.failureRecorder ?? CONSOLE_PROVIDER_EVENT_DELIVERY_FAILURE_RECORDER;
		this.#maxBufferedEvents = positiveInteger(
			options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS,
			"maxBufferedEvents",
		);
		this.#retryBaseMs = nonnegativeFinite(
			options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
			"retryBaseMs",
		);
		this.#retryMaxMs = nonnegativeFinite(options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS, "retryMaxMs");
		this.#maxAttempts = positiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts");
		this.#jitterRatio = boundedRatio(options.jitterRatio ?? DEFAULT_JITTER_RATIO, "jitterRatio");
		if (this.#retryMaxMs < this.#retryBaseMs) {
			throw new Error("Provider event retryMaxMs must be greater than or equal to retryBaseMs.");
		}
	}

	publish(event: ProviderEvent, options: ProviderEventPublishOptions): PublishAck {
		const accepted = this.#enqueue(event, options);
		return { accepted, queued: this.#queue.length };
	}

	pendingCount(): number {
		return this.#queue.length;
	}

	async flush(timeoutMs = 30_000): Promise<ProviderEventFlushReport> {
		nonnegativeFinite(timeoutMs, "flush timeout");
		this.#ensureDrain();
		if (this.#queue.length === 0 || timeoutMs === 0) return this.#flushReport();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<void>((resolve) => {
			timeout = setTimeout(resolve, timeoutMs);
		});
		await Promise.race([this.#drainPromise ?? Promise.resolve(), timedOut]);
		if (timeout) clearTimeout(timeout);
		return this.#flushReport();
	}

	#flushReport(): ProviderEventFlushReport {
		return {
			delivered: this.#deliveredCount,
			failed: this.#failedCount,
			pending: this.#queue.length,
		};
	}

	#enqueue(event: ProviderEvent, options: ProviderEventPublishOptions): boolean {
		let rawBody: string;
		try {
			rawBody = JSON.stringify({
				...event,
				ownerFence: options.ownerFence,
			});
		} catch (error) {
			this.#recordFailure(event, "attempts_exhausted", 0, error);
			return false;
		}
		if (this.#queue.length >= this.#maxBufferedEvents) {
			const oldest = this.#queue.shift();
			if (oldest) {
				oldest.dropped = true;
				oldest.abortController?.abort();
				this.#recordFailure(oldest.event, "buffer_overflow", oldest.attempts);
			}
		}
		this.#queue.push({
			event,
			rawBody,
			idempotencyKey: options.idempotencyKey ?? event.eventId,
			attempts: 0,
			dropped: false,
		});
		this.#ensureDrain();
		return true;
	}

	#ensureDrain(): void {
		if (this.#drainPromise || this.#queue.length === 0) return;
		this.#drainPromise = Promise.resolve()
			.then(() => this.#drain())
			.finally(() => {
				this.#drainPromise = undefined;
				if (this.#queue.length > 0) this.#ensureDrain();
			});
	}

	async #drain(): Promise<void> {
		while (this.#queue.length > 0) {
			const current = this.#queue[0];
			if (!current) return;
			current.attempts += 1;
			const delivered = await this.#send(current);
			if (current.dropped) continue;
			if (delivered) {
				if (this.#queue[0] === current) this.#queue.shift();
				this.#deliveredCount += 1;
				continue;
			}
			if (current.attempts >= this.#maxAttempts) {
				if (this.#queue[0] === current) this.#queue.shift();
				this.#recordFailure(current.event, "attempts_exhausted", current.attempts);
				continue;
			}
			await delay(this.#retryDelay(current.attempts));
		}
	}

	async #send(buffered: BufferedEvent): Promise<boolean> {
		const timestamp = this.#clock().toISOString();
		const abortController = new AbortController();
		buffered.abortController = abortController;
		try {
			const response = await this.#fetch(`${this.#baseUrl}/v1/stateful/events`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-apifuse-event-id": buffered.idempotencyKey,
					...statefulSignedHeaders({
						secret: this.#secret,
						timestamp,
						rawBody: buffered.rawBody,
					}),
				},
				body: buffered.rawBody,
				signal: abortController.signal,
			});
			return response.ok;
		} catch {
			return false;
		} finally {
			if (buffered.abortController === abortController) {
				buffered.abortController = undefined;
			}
		}
	}

	#retryDelay(attempts: number): number {
		const exponential = Math.min(
			this.#retryMaxMs,
			this.#retryBaseMs * 2 ** Math.max(0, attempts - 1),
		);
		const jitter = 1 + (this.#random() * 2 - 1) * this.#jitterRatio;
		return Math.max(0, Math.round(exponential * jitter));
	}

	#recordFailure(
		event: ProviderEvent,
		reason: ProviderEventDeliveryFailureReason,
		attempts: number,
		error?: unknown,
	): void {
		this.#failedCount += 1;
		this.#incrementDropMetric(event);
		try {
			const recorded = this.#failureRecorder.record({
				eventId: event.eventId,
				reason,
				attempts,
				failedAt: this.#clock().toISOString(),
				...(error ? { error: "Provider event could not be serialized." } : {}),
			});
			void Promise.resolve(recorded).catch(() => {});
		} catch {}
	}

	#incrementDropMetric(
		event: ProviderEvent,
		emitter: ProviderEventMetricEmitter = this.#metricEmitter,
	): void {
		try {
			emitter.increment(
				"apifuse_stateful_provider_event_drop_total",
				providerEventMetricLabels(event),
			);
		} catch {}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`Provider event ${name} must be a positive integer.`);
	}
	return value;
}

function nonnegativeFinite(value: number, name: string): number {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Provider event ${name} must be a non-negative finite number.`);
	}
	return value;
}

function boundedRatio(value: number, name: string): number {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`Provider event ${name} must be between 0 and 1.`);
	}
	return value;
}
