import { describe, expect, it } from "bun:test";

import { buildPromptAssetPlanEntriesSync } from "../cli/prompt-assets.js";

const SKILL_PATH = ".agents/skills/health-checks-and-fail-closed/SKILL.md";

function healthCheckSkill(): string {
	const entry = buildPromptAssetPlanEntriesSync().find((asset) => asset.path === SKILL_PATH);
	if (entry === undefined) throw new Error(`${SKILL_PATH} is not a managed prompt asset`);
	return entry.content;
}

/**
 * This asset is rendered into every provider repository and is the guidance a
 * provider author follows verbatim. While it documented only the imperative
 * `assertions` form, an author following it exactly produced an operation the
 * platform monitor never executes (`monitoring_unavailable`), which is how 401
 * of the fleet's published probes came to be coverage-on-paper. These
 * assertions pin the parts that stop that from recurring.
 */
describe("health-checks-and-fail-closed prompt asset", () => {
	it("names scenario as the surface the monitor executes", () => {
		const skill = healthCheckSkill();

		expect(skill).toContain("Only `scenario` is monitored in production");
		expect(skill).toContain("monitoring_unavailable");
		expect(skill).toContain("defineHealthScenario");
	});

	it("teaches the served_stale_cache guard with the attribution the schema admits", () => {
		const skill = healthCheckSkill();

		expect(skill).toContain("staleIfErrorMs");
		expect(skill).toContain("served_stale_cache");
		expect(skill).toContain('operator: "not_equals"');
		expect(skill).toContain('reasonCode: "served_stale_cache"');
		expect(skill).toContain('status: "degraded"');
		expect(skill).toContain("`expected_absence` is published as a non-incident status");
	});

	it("teaches maintenanceWindows as the declaration for an announced upstream maintenance", () => {
		const skill = healthCheckSkill();
		const section = skill.slice(
			skill.indexOf("## Announced upstream maintenance"),
			skill.indexOf("## Fail-closed: envelope level"),
		);

		expect(section).toContain("healthProbe: {");
		expect(section).toContain("maintenanceWindows: [");
		expect(section).toContain('startsAt: "2026-10-13T17:00:00Z"');
		expect(section).toContain("sourceUrl:");
		expect(section).toContain("declaredAt:");
		expect(section).toContain("UTC only");
		expect(section).toContain("an outage from `endsAt` on");
		expect(section).toContain("90 days");
		expect(skill).toContain("Each announced upstream maintenance is a `maintenanceWindows` entry");
	});

	it("teaches expectedErrors as the declaration for an absence served as an error", () => {
		const skill = healthCheckSkill();
		const section = skill.slice(
			skill.indexOf("## Declared absence served as an error"),
			skill.indexOf("## Fail-closed: envelope level"),
		);

		// The guard cannot see a non-2xx; the declaration lives on the step.
		expect(section).toContain("before any guard runs");
		expect(section).toContain("expectedErrors: [");
		expect(section).toContain("status: 404");
		expect(section).toContain('code: "NO_DATA"');
		expect(section).toContain('reasonCode: "expected_absence"');
		expect(section).toContain("never retries");
		// The lint contract the author has to satisfy, and what is never an absence.
		expect(section).toContain("`errorCodes`");
		expect(section).toContain("401/403/429");
		expect(section).toContain("Keep the row guard");
	});

	it("orders the freshness guard before any row or emptiness guard", () => {
		expect(healthCheckSkill()).toContain(
			"Place the freshness guard BEFORE any row or emptiness guard",
		);
	});

	it("never presents assertions as the monitored contract", () => {
		const skill = healthCheckSkill();
		const assertionsSection = skill.slice(skill.indexOf("## Self-test assertions"));

		expect(assertionsSection).toContain("not monitored");
		expect(assertionsSection).toContain("Never use it as the only check");
		// No imperative `assertions: ({ ... }) => { ... }` example anywhere: that
		// snippet is what the previous revision presented as the contract.
		expect(skill).not.toContain("assertions:");
	});

	it("keeps the checklist asking for both the scenario and the freshness guard", () => {
		const checklist = healthCheckSkill().slice(healthCheckSkill().indexOf("## Checklist"));

		expect(checklist).toContain("carries `scenario` (not only `assertions`)");
		expect(checklist).toContain("`served_stale_cache` guard");
	});
});
