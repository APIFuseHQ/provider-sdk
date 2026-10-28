import {
	isStatefulProviderMetricName,
	STATEFUL_PROVIDER_METRIC_NAMES,
	type StatefulProviderMetricEmitter,
	type StatefulProviderMetricLabelInput,
	type StatefulProviderMetricName,
} from "./stateful-provider-observability.js";

/**
 * The process-wide metric registry: a `StatefulProviderMetricEmitter` that
 * keeps counters, gauges and histograms in memory and renders them in the
 * Prometheus text exposition format. It is the default emitter of a
 * `StatefulSessionRouter` built without one, and every `serve()` in the
 * process renders it on its metrics listener (`/metrics`). A `serve()` whose
 * operations go through the stateful runtime declares their routing counters
 * here at zero before its listeners open. The package exports only its
 * emitter view, `statefulProviderMetricRegistryEmitter` (as
 * `statefulProviderMetricRegistry`); the class, the tables, the class-typed
 * singleton, `render()`, `reset()` and `declareRoutingSeries()` stay inside
 * the SDK.
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

/**
 * The routing counters a `StatefulSessionRouter` counts for every operation it
 * routes, each with the exported labels it carries besides `providerId` and
 * `operationId`. The router counts the deadline under these labels and
 * `declareRoutingSeries` starts every one of them at zero, so the series a
 * declaration creates is the series the router's first increment lands on.
 */
export const STATEFUL_PROVIDER_ROUTING_COUNTER_LABELS = {
	apifuse_stateful_provider_routing_forward_total: {},
	apifuse_stateful_provider_routing_local_total: {},
	apifuse_stateful_provider_routing_reacquire_total: {},
	apifuse_stateful_provider_routing_deadline_expired_total: {
		redactedErrorCode: "deadline_expired",
	},
} as const satisfies Partial<Record<StatefulProviderMetricName, StatefulProviderMetricLabelInput>>;

export type StatefulProviderRoutingCounterName =
	keyof typeof STATEFUL_PROVIDER_ROUTING_COUNTER_LABELS;

/** The operations of one provider whose routing counters start at zero. */
export type StatefulProviderRoutingDeclaration = {
	readonly providerId: string;
	readonly operationIds: readonly string[];
};

type ScalarSeries = { value: number };

type HistogramSeries = {
	/** Cumulative count per bucket of `STATEFUL_PROVIDER_METRIC_MS_BUCKETS`, in its order. */
	readonly buckets: number[];
	sum: number;
	count: number;
};

/**
 * Whether `name` is in the closed set, of `kind`, and `value` a finite
 * number. A metric call that fails this is dropped, never thrown: the
 * emitters call the registry on the request path.
 */
function accepts(
	name: unknown,
	kind: StatefulProviderMetricKind,
	value: unknown,
): name is StatefulProviderMetricName {
	return (
		isStatefulProviderMetricName(name) &&
		STATEFUL_PROVIDER_METRIC_KINDS[name] === kind &&
		typeof value === "number" &&
		Number.isFinite(value)
	);
}

function escapeLabelValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

/**
 * The series' label set rendered in the exposition format without braces:
 * the exported labels the input carries, in the allowlist's order, every
 * other input dropped. An absent or empty label is omitted, never rendered
 * as an empty value. The rendering identifies the series.
 */
function renderLabels(labels: StatefulProviderMetricLabelInput | undefined): string {
	if (!labels) return "";
	const pairs: string[] = [];
	for (const label of STATEFUL_PROVIDER_METRIC_EXPORTED_LABELS) {
		const value = labels[label];
		if (value === undefined || value === "") continue;
		pairs.push(`${label}="${escapeLabelValue(String(value))}"`);
	}
	return pairs.join(",");
}

function braced(labels: string): string {
	return labels === "" ? "" : `{${labels}}`;
}

/** A name's series ordered by their rendered label set. */
function sortedSeries<T>(series: ReadonlyMap<string, T> | undefined): [string, T][] {
	if (!series) return [];
	return [...series].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

export class StatefulProviderMetricRegistry implements StatefulProviderMetricEmitter {
	readonly #scalars = new Map<StatefulProviderMetricName, Map<string, ScalarSeries>>();
	readonly #histograms = new Map<StatefulProviderMetricName, Map<string, HistogramSeries>>();
	/** Rendered label sets of the declared series, per counter name. */
	readonly #declared = new Map<StatefulProviderRoutingCounterName, Set<string>>();

	/**
	 * Declares the routing counters of every listed operation: each counter
	 * of `STATEFUL_PROVIDER_ROUTING_COUNTER_LABELS`, under the provider and
	 * operation ids and the counter's own labels, gets a series at zero now,
	 * so a scrape sees it before the first operation is routed and `rate()`
	 * counts that operation instead of starting from it. A series that
	 * already exists keeps its value; declaring it again changes nothing.
	 */
	declareRoutingSeries(declaration: StatefulProviderRoutingDeclaration): void {
		for (const operationId of declaration.operationIds) {
			for (const name of Object.keys(
				STATEFUL_PROVIDER_ROUTING_COUNTER_LABELS,
			) as StatefulProviderRoutingCounterName[]) {
				const key = renderLabels({
					providerId: declaration.providerId,
					operationId,
					...STATEFUL_PROVIDER_ROUTING_COUNTER_LABELS[name],
				});
				let keys = this.#declared.get(name);
				if (!keys) {
					keys = new Set();
					this.#declared.set(name, keys);
				}
				keys.add(key);
				this.#scalarAt(name, key);
			}
		}
	}

	/** Adds `value` to a counter. Dropped unless `name` is a counter and `value` finite and not negative. */
	increment(
		name: StatefulProviderMetricName,
		labels?: StatefulProviderMetricLabelInput,
		value = 1,
	): void {
		if (!accepts(name, "counter", value) || value < 0) return;
		this.#scalar(name, labels).value += value;
	}

	/** Sets a gauge to `value`. Dropped unless `name` is a gauge and `value` finite. */
	gauge(
		name: StatefulProviderMetricName,
		labels: StatefulProviderMetricLabelInput,
		value: number,
	): void {
		if (!accepts(name, "gauge", value)) return;
		this.#scalar(name, labels).value = value;
	}

	/** Observes `value` in a histogram. Dropped unless `name` is a histogram and `value` finite and not negative. */
	observe(
		name: StatefulProviderMetricName,
		labels: StatefulProviderMetricLabelInput,
		value: number,
	): void {
		if (!accepts(name, "histogram", value) || value < 0) return;
		const series = this.#histogram(name, labels);
		STATEFUL_PROVIDER_METRIC_MS_BUCKETS.forEach((bound, index) => {
			if (value <= bound) series.buckets[index] += 1;
		});
		series.sum += value;
		series.count += 1;
	}

	/**
	 * The registry in the Prometheus text exposition format (version 0.0.4):
	 * for every name in the closed metric set, in the set's order, a `# HELP`
	 * and `# TYPE` line, then the name's series in the order of their
	 * rendered label sets. A histogram series renders its buckets (`le` last,
	 * ending at `+Inf`), `_sum` and `_count`.
	 */
	render(): string {
		const lines: string[] = [];
		for (const name of STATEFUL_PROVIDER_METRIC_NAMES) {
			lines.push(`# HELP ${name} ${STATEFUL_PROVIDER_METRIC_HELP[name]}`);
			lines.push(`# TYPE ${name} ${STATEFUL_PROVIDER_METRIC_KINDS[name]}`);
			if (STATEFUL_PROVIDER_METRIC_KINDS[name] === "histogram") {
				for (const [labels, series] of sortedSeries(this.#histograms.get(name))) {
					const prefix = labels === "" ? "" : `${labels},`;
					STATEFUL_PROVIDER_METRIC_MS_BUCKETS.forEach((bound, index) => {
						lines.push(`${name}_bucket{${prefix}le="${bound}"} ${series.buckets[index]}`);
					});
					lines.push(`${name}_bucket{${prefix}le="+Inf"} ${series.count}`);
					lines.push(`${name}_sum${braced(labels)} ${series.sum}`);
					lines.push(`${name}_count${braced(labels)} ${series.count}`);
				}
				continue;
			}
			for (const [labels, series] of sortedSeries(this.#scalars.get(name))) {
				lines.push(`${name}${braced(labels)} ${series.value}`);
			}
		}
		return `${lines.join("\n")}\n`;
	}

	/**
	 * Forgets every series except the declared ones, which go back to zero.
	 * For tests that assert counts across pods in one process.
	 */
	reset(): void {
		this.#scalars.clear();
		this.#histograms.clear();
		for (const [name, keys] of this.#declared) {
			for (const key of keys) this.#scalarAt(name, key);
		}
	}

	#scalar(
		name: StatefulProviderMetricName,
		labels: StatefulProviderMetricLabelInput | undefined,
	): ScalarSeries {
		return this.#scalarAt(name, renderLabels(labels));
	}

	/** The scalar series of `name` whose rendered label set is `key`, created at zero if absent. */
	#scalarAt(name: StatefulProviderMetricName, key: string): ScalarSeries {
		let byLabels = this.#scalars.get(name);
		if (!byLabels) {
			byLabels = new Map();
			this.#scalars.set(name, byLabels);
		}
		let series = byLabels.get(key);
		if (!series) {
			series = { value: 0 };
			byLabels.set(key, series);
		}
		return series;
	}

	#histogram(
		name: StatefulProviderMetricName,
		labels: StatefulProviderMetricLabelInput | undefined,
	): HistogramSeries {
		const key = renderLabels(labels);
		let byLabels = this.#histograms.get(name);
		if (!byLabels) {
			byLabels = new Map();
			this.#histograms.set(name, byLabels);
		}
		let series = byLabels.get(key);
		if (!series) {
			series = { buckets: STATEFUL_PROVIDER_METRIC_MS_BUCKETS.map(() => 0), sum: 0, count: 0 };
			byLabels.set(key, series);
		}
		return series;
	}
}

/**
 * One registry per process. A router built without a `metricEmitter` counts
 * into it, and every `serve()` metrics listener in the process renders it.
 */
export const statefulProviderMetricRegistry = new StatefulProviderMetricRegistry();

/**
 * The process's stateful metric registry, as the `metricEmitter` a provider
 * passes to its own components (for example a write ledger counting
 * `apifuse_stateful_provider_write_ledger_*_total`). There is one per
 * process: a `StatefulSessionRouter` built without a `metricEmitter` counts
 * into the same registry, and the metrics listener every `serve()` starts
 * renders it on `GET /metrics`, so what a provider emits here is scraped
 * next to the routing counters. It stores only names in the closed
 * `STATEFUL_PROVIDER_METRIC_NAMES` set, each through the method of its kind
 * (`_total` counters through `increment`, `_ms` histograms through
 * `observe`, the two gauges through `gauge`), and of the labels it is given
 * keeps only `providerId`, `operationId`, `redactedErrorCode`, `eventType`,
 * `subjectKind`, `capacityClass`, `ledgerState` and `healthStatus`. It never
 * throws: an unknown name, a method that does not match the name's kind, a
 * value that is not finite, or a negative count or observation is dropped.
 * Only the three emitter methods are reachable, so provider code cannot
 * render or reset the pod's metrics.
 *
 * The stateful entry point exports it as `statefulProviderMetricRegistry`;
 * inside the SDK that name is the class-typed registry above.
 */
export const statefulProviderMetricRegistryEmitter: StatefulProviderMetricEmitter =
	Object.freeze<StatefulProviderMetricEmitter>({
		increment: (name, labels, value) =>
			statefulProviderMetricRegistry.increment(name, labels, value),
		gauge: (name, labels, value) => statefulProviderMetricRegistry.gauge(name, labels, value),
		observe: (name, labels, value) => statefulProviderMetricRegistry.observe(name, labels, value),
	});
