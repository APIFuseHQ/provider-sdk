import { describe, expect, it } from "bun:test";

import {
	assertReleaseEvidence,
	parseAndAssertReleaseEvidence,
	RELEASE_CHECKS,
} from "../../scripts/release-evidence.js";

const CANDIDATE_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("release evidence decision logic", () => {
	it("accepts complete successful evidence for the candidate SHA", () => {
		expect(assertReleaseEvidence(successfulEvidence(), CANDIDATE_SHA).candidateSha).toBe(
			CANDIDATE_SHA,
		);
	});

	it("fails closed when required evidence is absent", () => {
		const evidence = successfulEvidence();
		expect(() =>
			assertReleaseEvidence({ ...evidence, checks: evidence.checks.slice(1) }, CANDIDATE_SHA),
		).toThrow(`missing required check: ${RELEASE_CHECKS[0].id}`);
	});

	it("fails closed when a required check failed", () => {
		const evidence = successfulEvidence();
		expect(() =>
			assertReleaseEvidence(
				{
					...evidence,
					checks: evidence.checks.map((check, index) =>
						index === 1 ? { ...check, exitCode: 9 } : check,
					),
				},
				CANDIDATE_SHA,
			),
		).toThrow(`check failed: ${RELEASE_CHECKS[1].id}`);
	});

	it("fails closed when evidence belongs to another SHA", () => {
		expect(() =>
			assertReleaseEvidence(
				{ ...successfulEvidence(), candidateSha: "f".repeat(40) },
				CANDIDATE_SHA,
			),
		).toThrow(`expected ${CANDIDATE_SHA}`);
	});

	it("rejects the old checked-box bypass without machine evidence", () => {
		const body = `## Release-candidate validation

Candidate SHA: ${CANDIDATE_SHA}

- [x] SDK unit/integration gates
- [x] generated provider scaffold check/test/submit-check
- [x] pack/package validation
- [x] clean consumer install smoke
- [x] dev-server HTTP smoke
- [x] monorepo compatibility smoke
`;
		expect(() => parseAndAssertReleaseEvidence(body, CANDIDATE_SHA)).toThrow(
			"PR body text is not evidence",
		);
	});
});

function successfulEvidence() {
	return {
		schemaVersion: 1 as const,
		candidateSha: CANDIDATE_SHA,
		generatedAt: "2026-08-28T00:00:00.000Z",
		checks: RELEASE_CHECKS.map((check) => ({
			id: check.id,
			command: check.command,
			exitCode: 0,
			summary: `${check.summary}: passed`,
		})),
	};
}
