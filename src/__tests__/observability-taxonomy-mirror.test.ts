import { describe, expect, it } from "bun:test";

import {
	categoryForStatus,
	isRetryableCategory,
	PROVIDER_ERROR_CATEGORIES,
	PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
	sourceForCategory,
} from "../observability.js";

// src/observability.ts is a hand-kept copy of the platform monorepo's
// packages/provider-observability (the SoT). Nothing syncs the two, so this
// file pins the copy to the SoT values it was last synced with (monorepo
// commit 0270d4c901, taxonomy 2026-10-23). Re-sync the copy and these values
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

describe("observability taxonomy mirror", () => {
	it("carries the SoT taxonomy version and category list, in SoT order", () => {
		expect(PROVIDER_OBSERVABILITY_TAXONOMY_VERSION).toBe(SOT_TAXONOMY_VERSION);
		const mirrored: readonly string[] = PROVIDER_ERROR_CATEGORIES;
		expect([...mirrored]).toEqual(SOT_PROVIDER_ERROR_CATEGORIES);
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
