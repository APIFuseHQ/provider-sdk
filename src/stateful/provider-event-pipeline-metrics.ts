import type { ProviderEvent } from "./provider-events.js";

export const PROVIDER_EVENT_METRIC_NAMES = [
	"apifuse_stateful_provider_event_append_total",
	"apifuse_stateful_provider_event_dedupe_total",
	"apifuse_stateful_provider_event_drop_total",
	"apifuse_stateful_provider_webhook_enqueue_total",
	"apifuse_stateful_provider_webhook_fanout_recovered_total",
	"apifuse_stateful_provider_webhook_delivered_total",
	"apifuse_stateful_provider_webhook_retry_total",
	"apifuse_stateful_provider_webhook_dead_letter_total",
	"apifuse_stateful_provider_webhook_canceled_total",
	"apifuse_stateful_provider_webhook_latency_ms",
] as const;

export type ProviderEventMetricName = (typeof PROVIDER_EVENT_METRIC_NAMES)[number];

export type ProviderEventMetricLabelInput = {
	readonly eventId?: string;
	readonly deliveryId?: string;
	readonly providerId?: string;
	readonly connectionId?: string;
	readonly serviceAccountId?: string;
	readonly eventType?: string;
	readonly subjectKind?: string;
	readonly subjectId?: string;
	readonly sessionKey?: string;
	readonly generation?: number | string;
};

export interface ProviderEventMetricEmitter {
	increment(
		name: ProviderEventMetricName,
		labels?: ProviderEventMetricLabelInput,
		value?: number,
	): void;
	observe(
		name: ProviderEventMetricName,
		labels: ProviderEventMetricLabelInput,
		value: number,
	): void;
}

export const NOOP_PROVIDER_EVENT_METRIC_EMITTER = {
	increment() {},
	observe() {},
} satisfies ProviderEventMetricEmitter;

export function providerEventMetricLabels(event: ProviderEvent) {
	return {
		eventId: event.eventId,
		providerId: event.providerId,
		connectionId: event.connectionId,
		serviceAccountId: event.serviceAccountId,
		eventType: event.eventType,
		subjectKind: event.subject.kind,
		subjectId: event.subject.id,
		sessionKey: event.session.sessionKey,
		generation: event.session.generation,
	};
}

export function providerWebhookDeliveryMetricLabels(delivery: { readonly deliveryId: string }) {
	return { deliveryId: delivery.deliveryId };
}

export function emitProviderWebhookDeliveryFailureMetric(
	metricEmitter: ProviderEventMetricEmitter,
	delivery: { readonly deliveryId: string },
	status: string,
): void {
	if (status === "retrying") {
		metricEmitter.increment(
			"apifuse_stateful_provider_webhook_retry_total",
			providerWebhookDeliveryMetricLabels(delivery),
		);
		return;
	}
	if (status === "dead_lettered") {
		metricEmitter.increment(
			"apifuse_stateful_provider_webhook_dead_letter_total",
			providerWebhookDeliveryMetricLabels(delivery),
		);
	}
}

export function providerWebhookDeliveryLatencyMs(
	delivery: { readonly lastAttemptAt?: string; readonly nextAttemptAt: string },
	now: string,
): number {
	const startedAt = Date.parse(delivery.lastAttemptAt ?? delivery.nextAttemptAt);
	const completedAt = Date.parse(now);
	if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return 0;
	return Math.max(0, completedAt - startedAt);
}
