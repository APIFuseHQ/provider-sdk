import { describe, expect, it } from "bun:test";

import {
	STATEFUL_PROVIDER_METRIC_NAMES,
	type StatefulProviderMetricLabelInput,
	type StatefulProviderMetricName,
} from "../stateful/stateful-provider-observability.js";
import {
	STATEFUL_PROVIDER_METRIC_HELP,
	STATEFUL_PROVIDER_METRIC_KINDS,
	StatefulProviderMetricRegistry,
} from "../stateful/stateful-provider-metric-registry.js";

// Pins the registry's Prometheus text exposition, line for line: what each
// kind renders, which label input survives, how values are escaped and
// series ordered, and which calls are dropped. Every test uses its own
// registry; the process-wide one is exercised by
// stateful-router-default-metrics-assembly.test.ts.

const FORWARD = "apifuse_stateful_provider_routing_forward_total";
const DEADLINE = "apifuse_stateful_provider_routing_deadline_expired_total";
const ACTIVE_SESSIONS = "apifuse_stateful_provider_active_sessions";
const QUEUE_DEPTH = "apifuse_stateful_provider_session_operation_queue_depth";
const DURATION = "apifuse_stateful_provider_session_operation_duration_ms";
const EVENT_LAG = "apifuse_stateful_provider_event_lag_ms";

// The label input the router passes on every routed operation
// (stateful-provider-session-routing.ts metricLabels): six of its eight names
// identify one request, session, tenant or pod and must not reach a series.
function routerLabels(
	requestId: string,
	operationId = "send-message",
): StatefulProviderMetricLabelInput {
	return {
		requestId,
		providerId: "kakaotalk",
		connectionId: "connection-1",
		serviceAccountId: "account-1",
		operationId,
		sessionKey: "kakaotalk:account-1:connection-1",
		ownerPodId: "pod-owner",
		generation: 7,
	};
}

// The HELP, TYPE and sample lines of one name, as rendered.
function section(body: string, name: StatefulProviderMetricName): string {
	return body
		.split("\n")
		.filter(
			(line) =>
				line === `# HELP ${name} ${STATEFUL_PROVIDER_METRIC_HELP[name]}` ||
				line === `# TYPE ${name} ${STATEFUL_PROVIDER_METRIC_KINDS[name]}` ||
				line.startsWith(`${name}{`) ||
				line.startsWith(`${name} `) ||
				line.startsWith(`${name}_bucket{`) ||
				line.startsWith(`${name}_sum`) ||
				line.startsWith(`${name}_count`),
		)
		.join("\n");
}

function header(name: StatefulProviderMetricName): string {
	return [
		`# HELP ${name} ${STATEFUL_PROVIDER_METRIC_HELP[name]}`,
		`# TYPE ${name} ${STATEFUL_PROVIDER_METRIC_KINDS[name]}`,
	].join("\n");
}

describe("StatefulProviderMetricRegistry", () => {
	it("declares every name in the closed set, in its order, before any series exists", () => {
		const body = new StatefulProviderMetricRegistry().render();
		expect(body).toBe(`${STATEFUL_PROVIDER_METRIC_NAMES.map(header).join("\n")}\n`);
		expect(body.split("\n")).toHaveLength(STATEFUL_PROVIDER_METRIC_NAMES.length * 2 + 1);
		expect(body.endsWith("\n")).toBe(true);
		expect(body.endsWith("\n\n")).toBe(false);
	});

	it("renders a counter as one series per exported label set, dropping per-request labels", () => {
		const registry = new StatefulProviderMetricRegistry();
		registry.increment(FORWARD, routerLabels("request-1"));
		registry.increment(FORWARD, routerLabels("request-2"));
		registry.increment(FORWARD, routerLabels("request-3"), 3);

		expect(section(registry.render(), FORWARD)).toBe(
			[
				`# HELP ${FORWARD} Operations this pod forwarded to the session's owner pod.`,
				`# TYPE ${FORWARD} counter`,
				`${FORWARD}{providerId="kakaotalk",operationId="send-message"} 5`,
			].join("\n"),
		);
	});

	it("exports the allowlisted labels only, in the allowlist's order whatever the input's order", () => {
		const registry = new StatefulProviderMetricRegistry();
		// Every label input name, the eight exported ones given last and reversed.
		registry.increment(DEADLINE, {
			requestId: "request-1",
			eventId: "event-1",
			deliveryId: "delivery-1",
			connectionId: "connection-1",
			serviceAccountId: "account-1",
			sessionKey: "kakaotalk:account-1:connection-1",
			sessionKeyHash: "session_sha256:abc",
			ownerPodId: "pod-owner",
			generation: 7,
			leaseExpiresAt: "2026-10-27T00:00:00.000Z",
			queueDepth: 4,
			subjectId: "subject-1",
			retryCount: 2,
			healthStatus: "healthy",
			ledgerState: "pending",
			capacityClass: "standard",
			subjectKind: "chat",
			eventType: "message",
			redactedErrorCode: "deadline_expired",
			operationId: "send-message",
			providerId: "kakaotalk",
		});

		const body = registry.render();
		expect(section(body, DEADLINE)).toBe(
			[
				header(DEADLINE),
				`${DEADLINE}{providerId="kakaotalk",operationId="send-message",redactedErrorCode="deadline_expired",eventType="message",subjectKind="chat",capacityClass="standard",ledgerState="pending",healthStatus="healthy"} 1`,
			].join("\n"),
		);
		for (const dropped of [
			"requestId",
			"request-1",
			"event-1",
			"delivery-1",
			"connection-1",
			"account-1",
			"sessionKey",
			"session_sha256",
			"pod-owner",
			"generation",
			"leaseExpiresAt",
			"queueDepth",
			"subject-1",
			"retryCount",
		]) {
			expect(body).not.toContain(dropped);
		}
	});

	it("orders a name's series by their rendered label sets, the unlabelled series first", () => {
		const registry = new StatefulProviderMetricRegistry();
		registry.increment(FORWARD, routerLabels("request-1", "zeta"));
		registry.increment(FORWARD, routerLabels("request-2", "alpha"));
		registry.increment(FORWARD);
		registry.increment(FORWARD, { providerId: "kakaotalk" });

		expect(section(registry.render(), FORWARD)).toBe(
			[
				header(FORWARD),
				`${FORWARD} 1`,
				`${FORWARD}{providerId="kakaotalk"} 1`,
				`${FORWARD}{providerId="kakaotalk",operationId="alpha"} 1`,
				`${FORWARD}{providerId="kakaotalk",operationId="zeta"} 1`,
			].join("\n"),
		);
	});

	it("omits an absent or empty label instead of rendering an empty value", () => {
		const registry = new StatefulProviderMetricRegistry();
		registry.increment(FORWARD, { providerId: "kakaotalk", operationId: "" });
		registry.increment(FORWARD, { providerId: "kakaotalk", operationId: undefined });
		registry.increment(FORWARD, { operationId: "" });
		// test-invalid: a JavaScript caller can pass null labels; they count as none.
		registry.increment(FORWARD, null as never);

		expect(section(registry.render(), FORWARD)).toBe(
			[header(FORWARD), `${FORWARD} 2`, `${FORWARD}{providerId="kakaotalk"} 2`].join("\n"),
		);
	});

	it("escapes backslash, double quote and newline in label values", () => {
		const registry = new StatefulProviderMetricRegistry();
		registry.increment(DEADLINE, {
			providerId: 'a\\b"c\nd',
			redactedErrorCode: "deadline_expired",
		});

		expect(section(registry.render(), DEADLINE)).toBe(
			[
				header(DEADLINE),
				`${DEADLINE}{providerId="a\\\\b\\"c\\nd",redactedErrorCode="deadline_expired"} 1`,
			].join("\n"),
		);
	});

	it("sets a gauge to the last value, negative values included", () => {
		const registry = new StatefulProviderMetricRegistry();
		registry.gauge(ACTIVE_SESSIONS, { providerId: "kakaotalk", ownerPodId: "pod-owner" }, 3);
		registry.gauge(ACTIVE_SESSIONS, { providerId: "kakaotalk", ownerPodId: "pod-other" }, 2);
		registry.gauge(QUEUE_DEPTH, {}, 4);
		registry.gauge(QUEUE_DEPTH, {}, -1.5);

		const body = registry.render();
		expect(section(body, ACTIVE_SESSIONS)).toBe(
			[header(ACTIVE_SESSIONS), `${ACTIVE_SESSIONS}{providerId="kakaotalk"} 2`].join("\n"),
		);
		expect(section(body, QUEUE_DEPTH)).toBe(
			[header(QUEUE_DEPTH), `${QUEUE_DEPTH} -1.5`].join("\n"),
		);
	});

	it("renders a histogram as cumulative millisecond buckets ending at +Inf, then _sum and _count", () => {
		const registry = new StatefulProviderMetricRegistry();
		// 5 sits on a bucket's upper bound (counted in it), 70 000 above the last.
		for (const value of [5, 30, 70_000]) {
			registry.observe(DURATION, routerLabels(`request-${value}`), value);
		}

		const labels = 'providerId="kakaotalk",operationId="send-message"';
		expect(section(registry.render(), DURATION)).toBe(
			[
				`# HELP ${DURATION} Milliseconds a session operation took on this pod.`,
				`# TYPE ${DURATION} histogram`,
				`${DURATION}_bucket{${labels},le="5"} 1`,
				`${DURATION}_bucket{${labels},le="10"} 1`,
				`${DURATION}_bucket{${labels},le="25"} 1`,
				`${DURATION}_bucket{${labels},le="50"} 2`,
				`${DURATION}_bucket{${labels},le="100"} 2`,
				`${DURATION}_bucket{${labels},le="250"} 2`,
				`${DURATION}_bucket{${labels},le="500"} 2`,
				`${DURATION}_bucket{${labels},le="1000"} 2`,
				`${DURATION}_bucket{${labels},le="2500"} 2`,
				`${DURATION}_bucket{${labels},le="5000"} 2`,
				`${DURATION}_bucket{${labels},le="15000"} 2`,
				`${DURATION}_bucket{${labels},le="60000"} 2`,
				`${DURATION}_bucket{${labels},le="+Inf"} 3`,
				`${DURATION}_sum{${labels}} 70035`,
				`${DURATION}_count{${labels}} 3`,
			].join("\n"),
		);
	});

	it("renders an unlabelled histogram with le as its only bucket label and bare _sum and _count", () => {
		const registry = new StatefulProviderMetricRegistry();
		registry.observe(EVENT_LAG, {}, 0.5);

		expect(section(registry.render(), EVENT_LAG)).toBe(
			[
				header(EVENT_LAG),
				`${EVENT_LAG}_bucket{le="5"} 1`,
				`${EVENT_LAG}_bucket{le="10"} 1`,
				`${EVENT_LAG}_bucket{le="25"} 1`,
				`${EVENT_LAG}_bucket{le="50"} 1`,
				`${EVENT_LAG}_bucket{le="100"} 1`,
				`${EVENT_LAG}_bucket{le="250"} 1`,
				`${EVENT_LAG}_bucket{le="500"} 1`,
				`${EVENT_LAG}_bucket{le="1000"} 1`,
				`${EVENT_LAG}_bucket{le="2500"} 1`,
				`${EVENT_LAG}_bucket{le="5000"} 1`,
				`${EVENT_LAG}_bucket{le="15000"} 1`,
				`${EVENT_LAG}_bucket{le="60000"} 1`,
				`${EVENT_LAG}_bucket{le="+Inf"} 1`,
				`${EVENT_LAG}_sum 0.5`,
				`${EVENT_LAG}_count 1`,
			].join("\n"),
		);
	});

	it("drops, without throwing, a name outside the set, a kind mismatch, a non-finite value and a negative counter or histogram value", () => {
		const registry = new StatefulProviderMetricRegistry();
		const empty = registry.render();
		const labels = routerLabels("request-dropped");
		const unknown = "apifuse_stateful_provider_unknown_total" as StatefulProviderMetricName;

		expect(() => {
			registry.increment(unknown, labels);
			registry.gauge(unknown, labels, 1);
			registry.observe(unknown, labels, 1);
			// A counter only increments, a gauge only sets, a histogram only observes.
			registry.gauge(FORWARD, labels, 1);
			registry.observe(FORWARD, labels, 1);
			registry.increment(ACTIVE_SESSIONS, labels);
			registry.observe(ACTIVE_SESSIONS, labels, 1);
			registry.increment(DURATION, labels);
			registry.gauge(DURATION, labels, 1);
			for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
				registry.increment(FORWARD, labels, value);
				registry.gauge(ACTIVE_SESSIONS, labels, value);
				registry.observe(DURATION, labels, value);
			}
			registry.increment(FORWARD, labels, -1);
			registry.observe(DURATION, labels, -1);
			// test-invalid: a JavaScript caller can pass a value that is not a number.
			registry.increment(FORWARD, labels, "1" as never);
			// test-invalid: a JavaScript caller can omit a gauge's labels.
			registry.gauge(ACTIVE_SESSIONS, undefined as never, Number.NaN);
		}).not.toThrow();
		expect(registry.render()).toBe(empty);
	});

	it("forgets every series on reset", () => {
		const registry = new StatefulProviderMetricRegistry();
		const empty = registry.render();
		registry.increment(FORWARD, routerLabels("request-1"));
		registry.gauge(ACTIVE_SESSIONS, {}, 1);
		registry.observe(DURATION, {}, 1);
		expect(registry.render()).not.toBe(empty);

		registry.reset();
		expect(registry.render()).toBe(empty);
	});
});
