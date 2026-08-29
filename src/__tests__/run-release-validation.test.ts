import { describe, expect, it } from "bun:test";

import { RELEASE_CHECKS } from "../../scripts/release-evidence.js";
import { runReleaseChecks } from "../../scripts/run-release-validation.js";

describe("release validation runner", () => {
	it("runs every declared command and records its real exit code", () => {
		const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
		const evidence = runReleaseChecks(
			"a".repeat(40),
			"/candidate",
			(argv, cwd) => {
				calls.push({ argv, cwd });
				return { exitCode: calls.length === 2 ? 7 : 0 };
			},
			() => new Date("2026-08-28T12:00:00.000Z"),
		);

		expect(calls).toEqual(RELEASE_CHECKS.map((check) => ({ argv: check.argv, cwd: "/candidate" })));
		expect(evidence.candidateSha).toBe("a".repeat(40));
		expect(evidence.generatedAt).toBe("2026-08-28T12:00:00.000Z");
		expect(evidence.checks.map((check) => check.exitCode)).toEqual([0, 7, 0, 0]);
		expect(evidence.checks[1]?.summary).toContain("failed with exit code 7");
	});
});
