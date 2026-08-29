export const RELEASE_CHECKS = [
	{
		id: "sdk-check",
		command: "bun run check",
		argv: ["bun", "run", "check"],
		summary: "SDK lint, type, deprecated-usage, test-safety, and build checks",
	},
	{
		id: "sdk-unit-integration",
		command: "bun test",
		argv: ["bun", "test"],
		summary: "SDK unit and integration tests",
	},
	{
		id: "pack-package",
		command: "bun run pack:check",
		argv: ["bun", "run", "pack:check"],
		summary: "Published package contents and public CLI validation",
	},
	{
		id: "packed-consumer-scaffold-dev",
		command: "bun run pack:smoke",
		argv: ["bun", "run", "pack:smoke"],
		summary:
			"Clean packed-SDK install, generated-provider check/test/submit-check, and dev-server /health and /v1/ping smoke",
	},
] as const;

export type ReleaseCheckId = (typeof RELEASE_CHECKS)[number]["id"];

export type ReleaseCheckEvidence = {
	readonly id: string;
	readonly command: string;
	readonly exitCode: number;
	readonly summary: string;
};

export type ReleaseEvidence = {
	readonly schemaVersion: 1;
	readonly candidateSha: string;
	readonly generatedAt: string;
	readonly checks: readonly ReleaseCheckEvidence[];
};

export function parseAndAssertReleaseEvidence(raw: string, expectedSha: string): ReleaseEvidence {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(
			"Release evidence must be a structured JSON artifact; PR body text is not evidence.",
		);
	}
	return assertReleaseEvidence(value, expectedSha);
}

export function assertReleaseEvidence(value: unknown, expectedSha: string): ReleaseEvidence {
	if (!isRecord(value) || value.schemaVersion !== 1) {
		throw new Error("Release evidence is missing schemaVersion 1.");
	}
	if (typeof value.candidateSha !== "string") {
		throw new Error("Release evidence is missing candidateSha.");
	}
	if (value.candidateSha.toLowerCase() !== expectedSha.toLowerCase()) {
		throw new Error(
			`Release evidence belongs to candidate SHA ${value.candidateSha}, expected ${expectedSha}.`,
		);
	}
	if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) {
		throw new Error("Release evidence is missing a valid generatedAt timestamp.");
	}
	if (!Array.isArray(value.checks)) {
		throw new Error("Release evidence is missing its checks array.");
	}

	const checks = value.checks.map(parseCheckEvidence);
	const checksById = new Map<string, ReleaseCheckEvidence>();
	for (const check of checks) {
		if (checksById.has(check.id)) {
			throw new Error(`Release evidence contains duplicate check id: ${check.id}`);
		}
		checksById.set(check.id, check);
	}

	for (const required of RELEASE_CHECKS) {
		const evidence = checksById.get(required.id);
		if (!evidence) {
			throw new Error(`Release evidence is missing required check: ${required.id}`);
		}
		if (evidence.command !== required.command) {
			throw new Error(
				`Release evidence command mismatch for ${required.id}: expected '${required.command}', got '${evidence.command}'.`,
			);
		}
		if (evidence.exitCode !== 0) {
			throw new Error(
				`Release evidence check failed: ${required.id} (${required.command}) exited ${evidence.exitCode}.`,
			);
		}
	}

	return {
		schemaVersion: 1,
		candidateSha: value.candidateSha,
		generatedAt: value.generatedAt,
		checks,
	};
}

function parseCheckEvidence(value: unknown): ReleaseCheckEvidence {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.command !== "string" ||
		typeof value.exitCode !== "number" ||
		!Number.isInteger(value.exitCode) ||
		typeof value.summary !== "string"
	) {
		throw new Error("Release evidence contains a malformed check result.");
	}
	return {
		id: value.id,
		command: value.command,
		exitCode: value.exitCode,
		summary: value.summary,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
