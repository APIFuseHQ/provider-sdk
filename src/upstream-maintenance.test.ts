import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
	digestProviderContract,
	extractProviderContract,
	UPSTREAM_MAINTENANCE_LOOKBACK_DAYS,
	type UpstreamMaintenanceWindow,
	UpstreamMaintenanceWindowSchema,
	UpstreamMaintenanceWindowsSchema,
	ValidationError,
} from "./index.js";
import { defineTestProvider as defineProvider } from "./__tests__/test-utils.js";

// Buyee's notice info_3077 (published 2026-10-09): JST 2026-10-14 02:00-08:00,
// i.e. 2026-10-13 17:00-23:00Z, declared after the fact on 2026-10-14.
function buyeeWindow(
	overrides: Partial<UpstreamMaintenanceWindow> = {},
): UpstreamMaintenanceWindow {
	return {
		startsAt: "2026-10-13T17:00:00Z",
		endsAt: "2026-10-13T23:00:00Z",
		sourceUrl: "https://buyee.jp/information/public/info_3077",
		declaredAt: "2026-10-14T09:00:00Z",
		...overrides,
	};
}

function issuesOf(input: unknown): string[] {
	const result = UpstreamMaintenanceWindowSchema.safeParse(input);
	if (result.success) return [];
	return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

function providerWith(
	healthProbe: Record<string, unknown>,
	alias: "healthProbe" | "healthMonitor" = "healthProbe",
) {
	return defineProvider({
		allowedHosts: ["example.com"],
		reviewed: "community",
		id: "maintenance-test",
		version: "1.0.0",
		runtime: "standard",
		meta: {
			displayName: "Maintenance test",
			descriptionKey: "meta.description",
			category: "demo",
		},
		[alias]: healthProbe,
		operations: {
			search: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				async handler() {
					return { ok: true };
				},
				healthCheck: {
					interval: "30m",
					cases: [{ name: "search", input: {}, assertions: () => {} }],
				},
			},
			"get-item": {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				async handler() {
					return { ok: true };
				},
				healthCheck: {
					interval: "30m",
					cases: [{ name: "get item", input: {}, assertions: () => {} }],
				},
			},
		},
	});
}

describe("UpstreamMaintenanceWindowSchema", () => {
	it("accepts a window declared after it happened and one declared ahead of time", () => {
		expect(issuesOf(buyeeWindow())).toEqual([]);
		expect(
			issuesOf(
				buyeeWindow({
					startsAt: "2026-11-11T17:00:00Z",
					endsAt: "2026-11-11T23:00:00Z",
					declaredAt: "2026-10-14T09:00:00Z",
				}),
			),
		).toEqual([]);
		expect(issuesOf(buyeeWindow({ operations: ["search"] }))).toEqual([]);
	});

	describe("UTC only", () => {
		it.each([
			["a +09:00 offset", "2026-10-14T02:00:00+09:00"],
			["a -00:00 offset", "2026-10-13T17:00:00-00:00"],
			["no zone designator", "2026-10-13T17:00:00"],
			["a calendar date", "2026-10-13"],
			["a day that does not exist", "2026-02-30T00:00:00Z"],
			["epoch milliseconds", 1_792_000_000_000],
		])("rejects %s", (_label, instant) => {
			for (const field of ["startsAt", "endsAt", "declaredAt"] as const) {
				const issues = issuesOf({ ...buyeeWindow(), [field]: instant });
				expect(issues).toContain(
					`${field}: ${field} must be an ISO 8601 instant in UTC ending in Z, e.g. 2026-10-13T17:00:00Z`,
				);
			}
		});

		it("accepts Z instants with or without fractional seconds", () => {
			expect(issuesOf(buyeeWindow({ startsAt: "2026-10-13T17:00:00.000Z" }))).toEqual([]);
			expect(issuesOf(buyeeWindow({ endsAt: "2026-10-13T23:00:00.5Z" }))).toEqual([]);
		});
	});

	describe("end after start", () => {
		it("rejects a window that ends when it starts", () => {
			expect(issuesOf(buyeeWindow({ endsAt: "2026-10-13T17:00:00Z" }))).toEqual([
				"endsAt: endsAt must be later than startsAt",
			]);
		});

		it("rejects a window that ends before it starts", () => {
			expect(
				issuesOf(buyeeWindow({ startsAt: "2026-10-13T23:00:00Z", endsAt: "2026-10-13T17:00:00Z" })),
			).toEqual(["endsAt: endsAt must be later than startsAt"]);
		});

		it("reports only the format issue when an instant is malformed", () => {
			expect(issuesOf(buyeeWindow({ endsAt: "2026-10-13 23:00" }))).toEqual([
				"endsAt: endsAt must be an ISO 8601 instant in UTC ending in Z, e.g. 2026-10-13T17:00:00Z",
			]);
		});
	});

	describe(`${UPSTREAM_MAINTENANCE_LOOKBACK_DAYS}-day lookback`, () => {
		const declaredAt = "2026-10-14T09:00:00Z";
		const lookbackStart = new Date(
			Date.parse(declaredAt) - UPSTREAM_MAINTENANCE_LOOKBACK_DAYS * 86_400_000,
		).toISOString();

		it("is 90 days", () => {
			expect(UPSTREAM_MAINTENANCE_LOOKBACK_DAYS).toBe(90);
			expect(lookbackStart).toBe("2026-07-16T09:00:00.000Z");
		});

		it("accepts a past window that starts exactly 90 days before its declaration", () => {
			expect(
				issuesOf(
					buyeeWindow({ startsAt: lookbackStart, endsAt: "2026-07-16T15:00:00Z", declaredAt }),
				),
			).toEqual([]);
		});

		it("rejects a past window that starts more than 90 days before its declaration", () => {
			expect(
				issuesOf(
					buyeeWindow({
						startsAt: "2026-07-16T08:59:59Z",
						endsAt: "2026-07-16T15:00:00Z",
						declaredAt,
					}),
				),
			).toEqual([
				"startsAt: startsAt must be at most 90 days before declaredAt: the platform keeps health samples for 90 days",
			]);
		});

		it("rejects the 09-16 buyee window when it is declared in 2027", () => {
			expect(
				issuesOf(
					buyeeWindow({
						startsAt: "2026-09-16T17:00:00Z",
						endsAt: "2026-09-16T23:00:00Z",
						sourceUrl: "https://buyee.jp/information/public/list",
						declaredAt: "2027-01-05T00:00:00Z",
					}),
				),
			).toHaveLength(1);
		});
	});

	it("requires an absolute http(s) announcement URL", () => {
		const message =
			"sourceUrl: sourceUrl must be an absolute http(s) URL of the upstream's announcement";
		expect(issuesOf(buyeeWindow({ sourceUrl: "/information/public/info_3077" }))).toEqual([
			message,
		]);
		expect(issuesOf(buyeeWindow({ sourceUrl: "ftp://buyee.jp/info_3077" }))).toEqual([message]);
		expect(issuesOf(buyeeWindow({ sourceUrl: "http://www.data.go.kr/notice/1" }))).toEqual([]);
	});

	it("rejects unknown fields, an empty operation list and a repeated operation", () => {
		expect(issuesOf({ ...buyeeWindow(), note: "monthly" })).toHaveLength(1);
		// test-invalid: the schema must reject an empty operation list the NonEmpty type forbids.
		expect(issuesOf(buyeeWindow({ operations: [] as never }))).toHaveLength(1);
		expect(issuesOf(buyeeWindow({ operations: ["search", "search"] }))).toEqual([
			"operations.1: duplicate operation search",
		]);
		const { sourceUrl: _sourceUrl, ...withoutSource } = buyeeWindow();
		expect(issuesOf(withoutSource)).toHaveLength(1);
	});

	it("requires a non-empty list", () => {
		expect(UpstreamMaintenanceWindowsSchema.safeParse([]).success).toBe(false);
		expect(UpstreamMaintenanceWindowsSchema.safeParse([buyeeWindow()]).success).toBe(true);
	});
});

describe("healthProbe.maintenanceWindows", () => {
	it("is accepted on healthProbe and mirrored onto healthMonitor", () => {
		const provider = providerWith({ maintenanceWindows: [buyeeWindow()] });
		expect(provider.healthProbe?.maintenanceWindows).toEqual([buyeeWindow()]);
		expect(provider.healthMonitor?.maintenanceWindows).toEqual([buyeeWindow()]);
	});

	it("is accepted on the healthMonitor alias", () => {
		const provider = providerWith({ maintenanceWindows: [buyeeWindow()] }, "healthMonitor");
		expect(provider.healthProbe?.maintenanceWindows).toEqual([buyeeWindow()]);
	});

	it("names the offending field of an invalid window", () => {
		expect(() =>
			providerWith({
				maintenanceWindows: [buyeeWindow(), buyeeWindow({ endsAt: "2026-10-13T16:00:00Z" })],
			}),
		).toThrow(
			'Provider "maintenance-test" has invalid healthProbe.maintenanceWindows[1].endsAt: endsAt must be later than startsAt.',
		);
		expect(() =>
			providerWith(
				{ maintenanceWindows: [buyeeWindow({ startsAt: "2026-10-14T02:00:00+09:00" })] },
				"healthMonitor",
			),
		).toThrow("healthMonitor.maintenanceWindows[0].startsAt");
		expect(() => providerWith({ maintenanceWindows: [] })).toThrow(ValidationError);
	});

	it("rejects a window that names an operation the provider does not define", () => {
		expect(() =>
			providerWith({
				maintenanceWindows: [buyeeWindow({ operations: ["search", "quote-shipping"] })],
			}),
		).toThrow(
			'Provider "maintenance-test" healthProbe.maintenanceWindows[0].operations[1] names unknown operation "quote-shipping".',
		);
		expect(
			providerWith({ maintenanceWindows: [buyeeWindow({ operations: ["get-item"] })] }).healthProbe
				?.maintenanceWindows?.[0]?.operations,
		).toEqual(["get-item"]);
	});

	it("travels in the provider contract and changes its digest", () => {
		const declared = extractProviderContract(providerWith({ maintenanceWindows: [buyeeWindow()] }));
		const undeclared = extractProviderContract(providerWith({}));
		expect(declared.healthMonitor).toEqual({ maintenanceWindows: [buyeeWindow()] });
		expect(digestProviderContract(declared)).not.toBe(digestProviderContract(undeclared));
	});
});
