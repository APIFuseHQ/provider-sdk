import type { ProviderEventMetricEmitter } from "./provider-event-pipeline-metrics.js";
import type { ProviderEvent } from "./provider-events.js";

export type { ProviderEventMetricEmitter } from "./provider-event-pipeline-metrics.js";

export type ProviderEventOwnerFence = {
	readonly ownerPodId: string;
	readonly ownerEndpoint: string;
	readonly sessionKey: string;
	readonly generation: number;
};

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

export interface ProviderEventPipeline {
	appendAndFanout(
		event: ProviderEvent,
		options?: ProviderEventPipelineAppendOptions,
	): Promise<AppendProviderEventAndEnqueueWebhooksResult>;
}
