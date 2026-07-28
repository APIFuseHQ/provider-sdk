import type { ProviderEventMetricEmitter } from "./provider-event-pipeline-metrics.js";
import type { ProviderEvent } from "./provider-events.js";
import type { SessionKey } from "./session-key.js";

export type { ProviderEventMetricEmitter } from "./provider-event-pipeline-metrics.js";

export type ProviderEventOwnerFence = {
	readonly ownerPodId: string;
	readonly ownerEndpoint: string;
	readonly sessionKey: SessionKey;
	readonly generation: number;
};

export type ProviderEventPublishOptions = {
	/** Required ownership proof forwarded to the durable platform write boundary. */
	readonly ownerFence: ProviderEventOwnerFence;
	/** Overrides the transport idempotency key; defaults to the event id. */
	readonly idempotencyKey?: string;
};

export type PublishAck = {
	/** Whether this event was accepted into the pod-local retry buffer. */
	readonly accepted: boolean;
	/** Number of events currently held in the pod-local retry buffer. */
	readonly queued: number;
};

/** Fire-and-forget publication from a provider pod into the platform ingest boundary. */
export interface ProviderEventPublisher {
	publish(event: ProviderEvent, options: ProviderEventPublishOptions): PublishAck;
}

export type AppendProviderEventAndEnqueueWebhooksResult = {
	readonly appended: boolean;
	readonly appendedCount: number;
	readonly matchedSubscriptionCount: number;
	readonly enqueuedCount: number;
	readonly recoveredFanoutCount?: number;
	readonly fenced?: boolean;
};

export type ProviderEventPipelineAppendOptions = {
	readonly now?: string;
	readonly idFactory?: () => string;
	readonly metricEmitter?: ProviderEventMetricEmitter;
	readonly beforeAppend?: () => Promise<boolean> | boolean;
	readonly ownerFence?: ProviderEventOwnerFence;
};

/**
 * Durable append-and-fanout contract implemented on the platform side.
 *
 * Provider-pod code must depend on ProviderEventPublisher, never ProviderEventPipeline: a pod-local
 * publisher cannot truthfully report a durable append or downstream webhook fanout.
 */
export interface ProviderEventPipeline {
	appendAndFanout(
		event: ProviderEvent,
		options?: ProviderEventPipelineAppendOptions,
	): Promise<AppendProviderEventAndEnqueueWebhooksResult>;
}
