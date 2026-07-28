import { createHash } from "node:crypto";

export const STATEFUL_PROVIDER_METRIC_NAMES = [
	"apifuse_stateful_provider_session_owner_acquire_total",
	"apifuse_stateful_provider_session_owner_renew_total",
	"apifuse_stateful_provider_session_owner_release_total",
	"apifuse_stateful_provider_session_owner_conflict_total",
	"apifuse_stateful_provider_session_owner_fencing_stale_total",
	"apifuse_stateful_provider_active_sessions",
	"apifuse_stateful_provider_lru_evictions_total",
	"apifuse_stateful_provider_session_operation_queue_depth",
	"apifuse_stateful_provider_session_operation_queue_wait_ms",
	"apifuse_stateful_provider_session_operation_duration_ms",
	"apifuse_stateful_provider_routing_forward_total",
	"apifuse_stateful_provider_routing_local_total",
	"apifuse_stateful_provider_routing_reacquire_total",
	"apifuse_stateful_provider_routing_deadline_expired_total",
	"apifuse_stateful_provider_event_append_total",
	"apifuse_stateful_provider_event_dedupe_total",
	"apifuse_stateful_provider_event_drop_total",
	"apifuse_stateful_provider_event_lag_ms",
	"apifuse_stateful_provider_webhook_enqueue_total",
	"apifuse_stateful_provider_webhook_fanout_recovered_total",
	"apifuse_stateful_provider_webhook_delivered_total",
	"apifuse_stateful_provider_webhook_retry_total",
	"apifuse_stateful_provider_webhook_dead_letter_total",
	"apifuse_stateful_provider_webhook_canceled_total",
	"apifuse_stateful_provider_webhook_replay_total",
	"apifuse_stateful_provider_webhook_latency_ms",
	"apifuse_stateful_provider_write_ledger_ambiguous_total",
	"apifuse_stateful_provider_write_ledger_reconciled_total",
	"apifuse_stateful_provider_write_ledger_failed_total",
] as const;

export type StatefulProviderMetricName = (typeof STATEFUL_PROVIDER_METRIC_NAMES)[number];

export const STATEFUL_PROVIDER_LOG_FIELDS = [
	"requestId",
	"eventId",
	"deliveryId",
	"providerId",
	"connectionId",
	"serviceAccountId",
	"operationId",
	"sessionKeyHash",
	"ownerPodId",
	"generation",
	"leaseExpiresAt",
	"capacityClass",
	"queueDepth",
	"eventType",
	"subjectKind",
	"subjectId",
	"retryCount",
	"ledgerState",
	"healthStatus",
	"redactedErrorCode",
] as const;

export type StatefulProviderLogField = (typeof STATEFUL_PROVIDER_LOG_FIELDS)[number];

export const STATEFUL_PROVIDER_AUTOSCALING_SIGNALS = [
	"active_sessions",
	"session_queue_depth",
	"session_queue_wait_ms",
	"reconnect_rate",
	"provider_event_lag_ms",
	"webhook_outbox_depth",
	"webhook_due_retry_depth",
	"memory_pressure",
	"file_descriptor_pressure",
	"socket_pressure",
] as const;

export type StatefulProviderAutoscalingSignal =
	(typeof STATEFUL_PROVIDER_AUTOSCALING_SIGNALS)[number];

export const STATEFUL_PROVIDER_HEALTH_DIMENSIONS = [
	"registry_connectivity",
	"owner_lease_freshness",
	"pool_capacity",
	"upstream_auth_validity",
	"push_loop_lag",
	"event_append_lag",
	"webhook_backlog",
] as const;

export type StatefulProviderHealthDimension = (typeof STATEFUL_PROVIDER_HEALTH_DIMENSIONS)[number];

export const STATEFUL_PROVIDER_ROLLOUT_STATES = [
	"disabled",
	"tenant_allowlist",
	"connection_allowlist",
	"shadow",
	"canary",
	"production",
	"rollback",
] as const;

export type StatefulProviderRolloutState = (typeof STATEFUL_PROVIDER_ROLLOUT_STATES)[number];

export interface StatefulProviderMetricLabelInput {
	readonly requestId?: string;
	readonly eventId?: string;
	readonly deliveryId?: string;
	readonly providerId?: string;
	readonly connectionId?: string;
	readonly serviceAccountId?: string;
	readonly operationId?: string;
	readonly sessionKey?: string;
	readonly sessionKeyHash?: string;
	readonly ownerPodId?: string;
	readonly generation?: number | string;
	readonly leaseExpiresAt?: string;
	readonly capacityClass?: string;
	readonly queueDepth?: number | string;
	readonly eventType?: string;
	readonly subjectKind?: string;
	readonly subjectId?: string;
	readonly retryCount?: number | string;
	readonly ledgerState?: string;
	readonly healthStatus?: string;
	readonly redactedErrorCode?: string;
}

export type StatefulProviderMetricLabels = Partial<Record<StatefulProviderLogField, string>>;

export interface StatefulProviderMetricEmitter {
	increment(
		name: StatefulProviderMetricName,
		labels?: StatefulProviderMetricLabelInput,
		value?: number,
	): void;
	gauge(
		name: StatefulProviderMetricName,
		labels: StatefulProviderMetricLabelInput,
		value: number,
	): void;
	observe(
		name: StatefulProviderMetricName,
		labels: StatefulProviderMetricLabelInput,
		value: number,
	): void;
}

export type StatefulProviderRecordedMetric = {
	readonly kind: "increment" | "gauge" | "observe";
	readonly name: StatefulProviderMetricName;
	readonly labels: StatefulProviderMetricLabels;
	readonly value: number;
};

const METRIC_NAME_SET = new Set<string>(STATEFUL_PROVIDER_METRIC_NAMES);
const LOG_FIELD_SET = new Set<string>(STATEFUL_PROVIDER_LOG_FIELDS);
const AUTOSCALING_SIGNAL_SET = new Set<string>(STATEFUL_PROVIDER_AUTOSCALING_SIGNALS);

export const NOOP_STATEFUL_PROVIDER_METRIC_EMITTER = {
	increment() {},
	gauge() {},
	observe() {},
} satisfies StatefulProviderMetricEmitter;

export class RecordingStatefulProviderMetricEmitter implements StatefulProviderMetricEmitter {
	readonly metrics: StatefulProviderRecordedMetric[] = [];

	increment(
		name: StatefulProviderMetricName,
		labels: StatefulProviderMetricLabelInput = {},
		value = 1,
	): void {
		this.metrics.push({
			kind: "increment",
			name,
			labels: statefulProviderMetricLabels(labels),
			value,
		});
	}

	gauge(
		name: StatefulProviderMetricName,
		labels: StatefulProviderMetricLabelInput,
		value: number,
	): void {
		this.metrics.push({
			kind: "gauge",
			name,
			labels: statefulProviderMetricLabels(labels),
			value,
		});
	}

	observe(
		name: StatefulProviderMetricName,
		labels: StatefulProviderMetricLabelInput,
		value: number,
	): void {
		this.metrics.push({
			kind: "observe",
			name,
			labels: statefulProviderMetricLabels(labels),
			value,
		});
	}
}

export function isStatefulProviderMetricName(value: unknown): value is StatefulProviderMetricName {
	return typeof value === "string" && METRIC_NAME_SET.has(value);
}

export function isStatefulProviderLogField(value: unknown): value is StatefulProviderLogField {
	return typeof value === "string" && LOG_FIELD_SET.has(value);
}

export function isStatefulProviderAutoscalingSignal(
	value: unknown,
): value is StatefulProviderAutoscalingSignal {
	return typeof value === "string" && AUTOSCALING_SIGNAL_SET.has(value);
}

export function sanitizeSessionKeyForLog(sessionKey: string): string {
	return `session_sha256:${createHash("sha256").update(sessionKey).digest("hex")}`;
}

export function statefulProviderMetricLabels(
	input: StatefulProviderMetricLabelInput,
): StatefulProviderMetricLabels {
	const labels: StatefulProviderMetricLabels = {};
	for (const field of STATEFUL_PROVIDER_LOG_FIELDS) {
		if (field === "sessionKeyHash") continue;
		const value = input[field];
		if (value !== undefined) {
			labels[field] = String(value);
		}
	}

	const sessionKeyHash =
		input.sessionKeyHash ??
		(input.sessionKey ? sanitizeSessionKeyForLog(input.sessionKey) : undefined);
	if (sessionKeyHash) {
		labels.sessionKeyHash = sessionKeyHash;
	}

	if (input.sessionKey) {
		assertNoRawSessionKeyInLabels(labels, input.sessionKey);
	}

	return labels;
}

export function assertNoRawSessionKeyInLabels(
	labels: Record<string, string | number | boolean | null | undefined>,
	rawSessionKey: string,
): void {
	if (!rawSessionKey) return;
	for (const [key, value] of Object.entries(labels)) {
		if (String(value ?? "").includes(rawSessionKey)) {
			throw new Error(`Stateful provider metric label "${key}" contains a raw session key.`);
		}
	}
}
