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
		expect(skill).toContain('reasonCode: "expected_absence"');
		expect(skill).toContain('status: "degraded"');
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
