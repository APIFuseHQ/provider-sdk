import {
	type StatefulProviderMetricEmitter,
	type StatefulProviderMetricName,
	STATEFUL_PROVIDER_METRIC_NAMES,
} from "./stateful-provider-observability.js";

/**
 * The process-wide metric registry: a `StatefulProviderMetricEmitter` that
 * keeps counters, gauges and histograms in memory and renders them in the
 * Prometheus text exposition format. It is the default emitter of a
 * `StatefulSessionRouter` built without one, and every `serve()` in the
 * process renders it on its metrics listener (`/metrics`). Not re-exported
 * from the package entry points: providers reach it only through the router
 * default and the listener.
 */

export type StatefulProviderMetricKind = "counter" | "gauge" | "histogram";

/**
 * The kind of every name in the closed metric set. `_total` names are
 * counters, `_ms` names are histograms, the two remaining names are gauges.
 * `satisfies Record<..>` keeps the table complete when the set changes.
 */
export const STATEFUL_PROVIDER_METRIC_KINDS = {
	apifuse_stateful_provider_session_owner_acquire_total: "counter",
	apifuse_stateful_provider_session_owner_renew_total: "counter",
	apifuse_stateful_provider_session_owner_release_total: "counter",
	apifuse_stateful_provider_session_owner_conflict_total: "counter",
	apifuse_stateful_provider_session_owner_fencing_stale_total: "counter",
	apifuse_stateful_provider_active_sessions: "gauge",
	apifuse_stateful_provider_lru_evictions_total: "counter",
	apifuse_stateful_provider_session_invalidations_total: "counter",
	apifuse_stateful_provider_session_operation_queue_depth: "gauge",
	apifuse_stateful_provider_session_operation_queue_wait_ms: "histogram",
	apifuse_stateful_provider_session_operation_duration_ms: "histogram",
	apifuse_stateful_provider_routing_forward_total: "counter",
	apifuse_stateful_provider_routing_local_total: "counter",
	apifuse_stateful_provider_routing_reacquire_total: "counter",
	apifuse_stateful_provider_routing_deadline_expired_total: "counter",
	apifuse_stateful_provider_event_append_total: "counter",
	apifuse_stateful_provider_event_dedupe_total: "counter",
	apifuse_stateful_provider_event_drop_total: "counter",
	apifuse_stateful_provider_event_lag_ms: "histogram",
	apifuse_stateful_provider_webhook_enqueue_total: "counter",
	apifuse_stateful_provider_webhook_fanout_recovered_total: "counter",
	apifuse_stateful_provider_webhook_delivered_total: "counter",
	apifuse_stateful_provider_webhook_retry_total: "counter",
	apifuse_stateful_provider_webhook_dead_letter_total: "counter",
	apifuse_stateful_provider_webhook_canceled_total: "counter",
	apifuse_stateful_provider_webhook_replay_total: "counter",
	apifuse_stateful_provider_webhook_latency_ms: "histogram",
	apifuse_stateful_provider_write_ledger_ambiguous_total: "counter",
	apifuse_stateful_provider_write_ledger_reconciled_total: "counter",
	apifuse_stateful_provider_write_ledger_failed_total: "counter",
} as const satisfies Record<StatefulProviderMetricName, StatefulProviderMetricKind>;

/** The `# HELP` line of every name in the closed metric set. */
export const STATEFUL_PROVIDER_METRIC_HELP = {
	apifuse_stateful_provider_session_owner_acquire_total:
		"Session owner leases this pod acquired in the owner registry.",
	apifuse_stateful_provider_session_owner_renew_total:
		"Session owner leases this pod renewed in the owner registry.",
	apifuse_stateful_provider_session_owner_release_total:
		"Session owner leases this pod released in the owner registry.",
	apifuse_stateful_provider_session_owner_conflict_total:
		"Session owner acquisitions that lost to another pod's live lease.",
	apifuse_stateful_provider_session_owner_fencing_stale_total:
		"Operations rejected because the owner fence they carried was stale.",
	apifuse_stateful_provider_active_sessions: "Provider sessions currently open on this pod.",
	apifuse_stateful_provider_lru_evictions_total:
		"Provider sessions this pod closed to stay within its pool capacity.",
	apifuse_stateful_provider_session_invalidations_total:
		"Provider sessions this pod invalidated, by the adapter's reason code.",
	apifuse_stateful_provider_session_operation_queue_depth:
		"Operations waiting for a session's concurrency slot on this pod.",
	apifuse_stateful_provider_session_operation_queue_wait_ms:
		"Milliseconds an operation waited for a session's concurrency slot.",
	apifuse_stateful_provider_session_operation_duration_ms:
		"Milliseconds a session operation took on this pod.",
	apifuse_stateful_provider_routing_forward_total:
		"Operations this pod forwarded to the session's owner pod.",
	apifuse_stateful_provider_routing_local_total:
		"Operations this pod executed locally as the session's owner.",
	apifuse_stateful_provider_routing_reacquire_total:
		"Operations for which this pod acquired the session's ownership before executing.",
	apifuse_stateful_provider_routing_deadline_expired_total:
		"Operations whose deadline expired before routing, while forwarding or during local execution.",
	apifuse_stateful_provider_event_append_total: "Provider events appended to the event pipeline.",
	apifuse_stateful_provider_event_dedupe_total:
		"Provider events the event pipeline dropped as duplicates.",
	apifuse_stateful_provider_event_drop_total: "Provider events dropped before delivery.",
	apifuse_stateful_provider_event_lag_ms: "Provider event lag in milliseconds.",
	apifuse_stateful_provider_webhook_enqueue_total: "Webhook deliveries enqueued.",
	apifuse_stateful_provider_webhook_fanout_recovered_total:
		"Webhook deliveries recovered by fan-out after a partial failure.",
	apifuse_stateful_provider_webhook_delivered_total: "Webhook deliveries acknowledged.",
	apifuse_stateful_provider_webhook_retry_total:
		"Webhook deliveries scheduled for another attempt.",
	apifuse_stateful_provider_webhook_dead_letter_total:
		"Webhook deliveries moved to the dead letter queue.",
	apifuse_stateful_provider_webhook_canceled_total: "Webhook deliveries canceled.",
	apifuse_stateful_provider_webhook_replay_total: "Webhook deliveries replayed on request.",
	apifuse_stateful_provider_webhook_latency_ms:
		"Milliseconds from a webhook delivery's scheduled attempt to its completion.",
	apifuse_stateful_provider_write_ledger_ambiguous_total:
		"Write ledger entries whose upstream outcome stayed ambiguous.",
	apifuse_stateful_provider_write_ledger_reconciled_total:
		"Write ledger entries reconciled against the upstream.",
	apifuse_stateful_provider_write_ledger_failed_total: "Write ledger entries that failed.",
} as const satisfies Record<StatefulProviderMetricName, string>;

/**
 * The label names the registry exports. Every other label input the emitters
 * pass (request, event, delivery and session identifiers, tenant identifiers,
 * owner pod and generation, timestamps and numeric readings) is dropped before
 * storage: each of those is unbounded and would make one series per request.
 * `sessionKey` never reaches the registry, so it cannot leak into a series.
 */
export const STATEFUL_PROVIDER_METRIC_EXPORTED_LABELS = [
	"providerId",
	"operationId",
	"redactedErrorCode",
	"eventType",
	"subjectKind",
	"capacityClass",
	"ledgerState",
	"healthStatus",
] as const;

export type StatefulProviderMetricExportedLabel =
	(typeof STATEFUL_PROVIDER_METRIC_EXPORTED_LABELS)[number];

/**
 * Histogram bucket upper bounds, in milliseconds, of every `_ms` metric. The
 * metric names keep their `_ms` unit; the buckets follow it. 15 000 covers a
 * provider transport's own connection timeout; 60 000 closes the histogram
 * at one minute.
 */
export const STATEFUL_PROVIDER_METRIC_MS_BUCKETS = [
	5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 15_000, 60_000,
] as const;

export class StatefulProviderMetricRegistry implements StatefulProviderMetricEmitter {
	increment(): void {}

	gauge(): void {}

	observe(): void {}

	/**
	 * The registry in the Prometheus text exposition format (version 0.0.4):
	 * a `# HELP` and `# TYPE` line for every name in the closed metric set,
	 * in the set's order, then the series that were touched.
	 */
	render(): string {
		const lines: string[] = [];
		for (const name of STATEFUL_PROVIDER_METRIC_NAMES) {
			lines.push(`# HELP ${name} ${STATEFUL_PROVIDER_METRIC_HELP[name]}`);
			lines.push(`# TYPE ${name} ${STATEFUL_PROVIDER_METRIC_KINDS[name]}`);
		}
		return `${lines.join("\n")}\n`;
	}

	/** Forgets every series. For tests that assert counts across pods in one process. */
	reset(): void {}
}

/**
 * One registry per process. A router built without a `metricEmitter` counts
 * into it, and every `serve()` metrics listener in the process renders it.
 */
export const statefulProviderMetricRegistry = new StatefulProviderMetricRegistry();
