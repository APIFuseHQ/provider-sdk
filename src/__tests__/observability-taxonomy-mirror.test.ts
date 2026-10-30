import { describe, expect, it } from "bun:test";

import {
	categoryForStatus,
	isPlatformFaultCategory,
	isProviderFailureCategory,
	isRetryableCategory,
	PLATFORM_FAULT_CATEGORIES,
	PROVIDER_ERROR_CATEGORIES,
	PROVIDER_ERROR_CATEGORIES_LIST_BOTH_SETS,
	PROVIDER_FAILURE_CATEGORIES,
	PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
	sourceForCategory,
	sourceForPlatformFault,
} from "../observability.js";

// src/observability.ts is a hand-kept copy of the platform monorepo's
// packages/provider-observability (the SoT). Nothing syncs the two, so this
// file pins the copy to the SoT values it was last synced with (monorepo
// commit f41750d, taxonomy 2026-10-23). Re-sync the copy and these values
// together whenever the SoT changes; the gateway rejects categories and
// versions it does not know.
const SOT_TAXONOMY_VERSION = "2026-10-23";
const SOT_PROVIDER_ERROR_CATEGORIES = [
	"ok",
	"timeout",
	"stateful_forwarding_deadline",
	"network",
	"upstream_http",
	"upstream_rate_limited",
	"upstream_auth",
	"upstream_rejected",
	"upstream_schema_drift",
	"proxy_pool",
	"anti_bot_blocked",
	"credential_expired",
	"credential_unavailable",
	"input_validation",
	"output_validation",
	"provider_error",
	"internal_error",
	"dependency_unavailable",
	"unsupported_transport",
	"client_cancelled",
	"unclassified",
];
const SOT_PLATFORM_FAULT_CATEGORIES = [
	"ok",
	"stateful_forwarding_deadline",
	"proxy_pool",
	"credential_unavailable",
	"output_validation",
	"internal_error",
	"dependency_unavailable",
	"unsupported_transport",
	"client_cancelled",
	"unclassified",
];
const SOT_PROVIDER_FAILURE_CATEGORIES = [
	"timeout",
	"network",
	"upstream_http",
	"upstream_rate_limited",
	"upstream_auth",
	"upstream_rejected",
	"upstream_schema_drift",
	"anti_bot_blocked",
	"credential_expired",
	"credential_unavailable",
	"input_validation",
	"provider_error",
];

describe("observability taxonomy mirror", () => {
	it("carries the SoT taxonomy version and category list, in SoT order", () => {
		expect(PROVIDER_OBSERVABILITY_TAXONOMY_VERSION).toBe(SOT_TAXONOMY_VERSION);
		const mirrored: readonly string[] = PROVIDER_ERROR_CATEGORIES;
		expect([...mirrored]).toEqual(SOT_PROVIDER_ERROR_CATEGORIES);
	});

	it("carries the SoT origin sets, in SoT order, and the union is exactly their members", () => {
		const platform: readonly string[] = PLATFORM_FAULT_CATEGORIES;
		const provider: readonly string[] = PROVIDER_FAILURE_CATEGORIES;
		expect([...platform]).toEqual(SOT_PLATFORM_FAULT_CATEGORIES);
		expect([...provider]).toEqual(SOT_PROVIDER_FAILURE_CATEGORIES);
		const union: readonly string[] = PROVIDER_ERROR_CATEGORIES;
		expect(new Set(union).size).toBe(union.length);
		expect([...union].toSorted()).toEqual([...new Set([...platform, ...provider])].toSorted());
		expect(PROVIDER_ERROR_CATEGORIES_LIST_BOTH_SETS).toBe(true);
		// credential_unavailable is the one word both reporters use.
		expect(platform.filter((category) => provider.includes(category))).toEqual([
			"credential_unavailable",
		]);
	});

	it("predicates follow the sets and reject words outside the taxonomy", () => {
		for (const category of PROVIDER_ERROR_CATEGORIES) {
			expect(isPlatformFaultCategory(category) || isProviderFailureCategory(category)).toBe(true);
		}
		expect(isPlatformFaultCategory("timeout")).toBe(false);
		expect(isProviderFailureCategory("internal_error")).toBe(false);
		for (const word of ["", "not_a_category", "OK", "platform", "provider"]) {
			expect(isPlatformFaultCategory(word)).toBe(false);
			expect(isProviderFailureCategory(word)).toBe(false);
		}
	});

	it("projects a platform fault to apifuse, except an inbound cancellation", () => {
		for (const category of PLATFORM_FAULT_CATEGORIES) {
			expect(sourceForPlatformFault(category)).toBe(
				category === "client_cancelled" ? "client" : "apifuse",
			);
		}
	});

	it("keeps the SoT projections for the stateful-forwarding deadline category", () => {
		expect(isRetryableCategory("stateful_forwarding_deadline")).toBe(false);
		expect(sourceForCategory("stateful_forwarding_deadline")).toBe("apifuse");
		// The category comes from the deadline error instance, never from a
		// status: a bare 504 stays timeout, which stays retryable.
		expect(categoryForStatus(504)).toBe("timeout");
		expect(isRetryableCategory("timeout")).toBe(true);
		expect(sourceForCategory("timeout")).toBe("upstream_failure");
	});
});
