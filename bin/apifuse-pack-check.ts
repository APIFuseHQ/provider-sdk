#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";

const PACK_RESULT_SCHEMA = z.array(
	z.object({
		filename: z.string(),
		files: z
			.array(
				z.object({
					path: z.string(),
				}),
			)
			.optional(),
	}),
);

const raw = execFileSync("npm", ["pack", "--json", "--dry-run"], {
	cwd: process.cwd(),
	encoding: "utf8",
});
const parsed = PACK_RESULT_SCHEMA.parse(JSON.parse(raw));
const first = parsed[0];

if (!first) {
	throw new Error("npm pack --json --dry-run returned no package metadata.");
}

const filePaths = (first.files ?? []).map((file) => file.path);
const requiredPaths = [
	"bin/apifuse.ts",
	"bin/apifuse-create.ts",
	"bin/apifuse-pack-smoke.ts",
	"bin/apifuse-submit-check.ts",
	"SUBMISSION.md",
	"src/cli/create.ts",
	"src/cli/templates/provider/.dockerignore.tpl",
	"src/cli/templates/provider/.gitignore.tpl",
	"src/cli/templates/provider/Dockerfile.tpl",
	"src/cli/templates/provider/index.ts.tpl",
	"src/cli/templates/provider/README.md.tpl",
	"src/cli/templates/provider/meta.ts.tpl",
	"src/cli/templates/provider/domain/README.md.tpl",
	"src/cli/templates/provider/mappers/README.md.tpl",
	"src/cli/templates/provider/operations/index.ts.tpl",
	"src/cli/templates/provider/operations/ping.ts.tpl",
	"src/cli/templates/provider/schemas/ping.ts.tpl",
	"src/cli/templates/provider/upstream/README.md.tpl",
	"src/cli/templates/provider/AGENTS.md.tpl",
	"src/cli/templates/provider/.agents/skills/normalization-standards/SKILL.md.tpl",
	"src/cli/templates/provider/.agents/skills/upstream-contract-verification/SKILL.md.tpl",
	"src/cli/templates/provider/.agents/skills/fixtures-and-recording/SKILL.md.tpl",
	"src/cli/templates/provider/.agents/skills/pagination-and-counts/SKILL.md.tpl",
	"src/cli/templates/provider/.agents/skills/health-checks-and-fail-closed/SKILL.md.tpl",
	"src/cli/templates/provider/.agents/skills/upstream-notes/README.md.tpl",
	"dist/cli/templates/provider/.dockerignore.tpl",
	"dist/cli/templates/provider/.gitignore.tpl",
	"dist/cli/templates/provider/Dockerfile.tpl",
	"dist/cli/templates/provider/index.ts.tpl",
	"dist/cli/templates/provider/README.md.tpl",
	"dist/cli/templates/provider/meta.ts.tpl",
	"dist/cli/templates/provider/domain/README.md.tpl",
	"dist/cli/templates/provider/mappers/README.md.tpl",
	"dist/cli/templates/provider/operations/index.ts.tpl",
	"dist/cli/templates/provider/operations/ping.ts.tpl",
	"dist/cli/templates/provider/schemas/ping.ts.tpl",
	"dist/cli/templates/provider/upstream/README.md.tpl",
	"dist/cli/templates/provider/AGENTS.md.tpl",
	"dist/cli/templates/provider/.agents/skills/normalization-standards/SKILL.md.tpl",
	"dist/cli/templates/provider/.agents/skills/upstream-contract-verification/SKILL.md.tpl",
	"dist/cli/templates/provider/.agents/skills/fixtures-and-recording/SKILL.md.tpl",
	"dist/cli/templates/provider/.agents/skills/pagination-and-counts/SKILL.md.tpl",
	"dist/cli/templates/provider/.agents/skills/health-checks-and-fail-closed/SKILL.md.tpl",
	"dist/cli/templates/provider/.agents/skills/upstream-notes/README.md.tpl",
	"dist/auth-turn/index.js",
	"dist/auth-turn/index.d.ts",
	"dist/auth-turn/auth-turn.v1.schema.json",
	"dist/auth-turn/fixtures/valid/abort.json",
	"dist/auth-turn/fixtures/valid/complete.json",
	"dist/auth-turn/fixtures/invalid/unknown-top-level-field.json",
	"src/auth-turn/auth-turn.v1.schema.json",
];
const forbiddenMatches = filePaths.filter(
	(path) =>
		path.startsWith("src/__tests__/") ||
		path === "src/index.test.ts" ||
		path === "bin/apifuse-init.ts",
);
const missingRequiredPaths = requiredPaths.filter(
	(path) => !filePaths.includes(path),
);

if (forbiddenMatches.length > 0) {
	throw new Error(
		`Packed artifact still includes forbidden files:\n${forbiddenMatches.join("\n")}`,
	);
}

if (missingRequiredPaths.length > 0) {
	throw new Error(
		`Packed artifact is missing required public SDK files:\n${missingRequiredPaths.join("\n")}`,
	);
}

const packageJsonInput: unknown = JSON.parse(
	readFileSync("package.json", "utf8"),
);
const packageJson = z
	.object({
		dependencies: z.record(z.string(), z.string()).optional(),
		devDependencies: z.record(z.string(), z.string()).optional(),
	})
	.parse(packageJsonInput);

if (!packageJson.dependencies?.["@clack/prompts"]) {
	throw new Error(
		"@clack/prompts is imported by the public create CLI and must be listed in dependencies.",
	);
}

if (packageJson.devDependencies?.["@clack/prompts"]) {
	throw new Error(
		"@clack/prompts must not be devDependency-only because the published create CLI imports it at runtime.",
	);
}

assertPublicSmokeDocs("README.md", readFileSync("README.md", "utf8"));
assertPublicSmokeDocs(
	"src/cli/templates/provider/README.md.tpl",
	readFileSync("src/cli/templates/provider/README.md.tpl", "utf8"),
);

console.log(`Packed artifact OK: ${first.filename}`);
for (const filePath of filePaths) {
	console.log(`  - ${filePath}`);
}

function assertPublicSmokeDocs(label: string, content: string): void {
	if (!content.includes('"requestId":"req_local_ping"')) {
		throw new Error(
			`${label} must document the current provider server request envelope with requestId.`,
		);
	}

	if (content.includes('"connection":null')) {
		throw new Error(
			`${label} must not tell public users to send connection:null; omit connection for no-auth operations.`,
		);
	}

	if (!content.includes("bunx playwright install chromium")) {
		throw new Error(
			`${label} must include browser runtime troubleshooting for public SDK-only debugging.`,
		);
	}

	if (!content.includes("impit")) {
		throw new Error(
			`${label} must include impit stealth runtime guidance for TLS/browser bounties.`,
		);
	}

	if (!content.includes("submit-check")) {
		throw new Error(
			`${label} must document the submit-check pre-submission workflow.`,
		);
	}

	if (
		!content.includes('browser.engine: "playwright-stealth"') ||
		!content.includes("nodriver")
	) {
		throw new Error(
			`${label} must clarify that TypeScript browser providers use playwright-stealth and nodriver is not the TypeScript happy path.`,
		);
	}

	if (
		label.includes("templates/provider/README.md.tpl") &&
		!content.includes("bun run record -- --operation <operation>")
	) {
		throw new Error(
			`${label} must document fixture recording through a generated package script, not a shell-global apifuse command.`,
		);
	}
}
