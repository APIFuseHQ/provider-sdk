import { afterAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

import { ProviderError } from "../errors.js";
import { platformFaultOf } from "../sdk-issued-errors.js";
import {
	createServerApp,
	ERROR_OBSERVABILITY_HEADER,
	type ProviderServerLogEvent,
} from "../server/serve.js";
import type { OperationRiskClass, ProviderDefinition } from "../types.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

const READ_RISK_CLASS: OperationRiskClass = "read";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// A second, complete copy of the SDK source: its own module graph, so every
// module-scoped value (constructors, the WeakMap behind issueSdkError) is
// distinct from this test's. That is the shape of `apifuse dev` (server from
// the package's src/*, provider importing dist/*) and of a dual install. The
// query-string re-import the other cross-copy tests use shares transitive
// modules, so it cannot model the fault record's realm.
const copyRoot = mkdtempSync(join(tmpdir(), "apifuse-sdk-second-copy-"));
cpSync(join(repoRoot, "src"), join(copyRoot, "src"), {
	recursive: true,
	filter: (source) => !source.includes(`${join("src", "__tests__")}`),
});
symlinkSync(join(repoRoot, "node_modules"), join(copyRoot, "node_modules"), "dir");
const secondCopy: Promise<typeof import("../errors.js")> = import(
	pathToFileURL(join(copyRoot, "src", "errors.ts")).href
);

afterAll(() => {
	rmSync(copyRoot, { recursive: true, force: true });
});

type Served = {
	status: number;
	body: { error: { code: string; retryable: boolean; source: string; fix?: string } };
	header: { origin: string; category: string; retryable: boolean };
	failure: ProviderServerLogEvent | undefined;
};

async function serve(createError: () => Error): Promise<Served> {
	const events: ProviderServerLogEvent[] = [];
	const definition: ProviderDefinition = createProviderDefinitionDouble({
		id: "second-copy-refusal",
		operations: {
			probe: {
				riskClass: READ_RISK_CLASS,
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw createError();
				},
			},
		},
	});
	const app = createServerApp(definition, { logger: (event) => events.push(event) });
	const response = await app.request("/v1/probe", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: "req_probe", input: { value: "x" } }),
	});
	return {
		status: response.status,
		body: (await response.json()) as Served["body"],
		header: JSON.parse(response.headers.get(ERROR_OBSERVABILITY_HEADER) ?? "null"),
		failure: events.find((event) => event.event === "provider_request_failed"),
	};
}

describe("the per-throw refusal built by another SDK copy", () => {
	it("is a distinct module graph, not a re-evaluation sharing this copy's records", async () => {
		const Dup = await secondCopy;
		expect(Dup.ProviderError).not.toBe(ProviderError);
		const refusal = (() => {
			try {
				new Dup.ProviderError(
					"x",
					{
						code: "UPSTREAM_ERROR",
						retryable: true,
					} as never /* test-invalid: the options were removed from the type; the refusal is under test */,
				);
			} catch (error) {
				return error;
			}
			return undefined;
		})();
		expect(refusal).toBeDefined();
		// This copy's issueSdkError record never saw the other copy's throw.
		expect(platformFaultOf(refusal)).toBeUndefined();
	});

	for (const [name, construct] of [
		[
			"ProviderError with retryable",
			(Dup: typeof import("../errors.js")) =>
				new Dup.ProviderError(
					"x",
					{
						code: "UPSTREAM_ERROR",
						retryable: true,
					} as never /* test-invalid: the options were removed from the type; the refusal is under test */,
				),
		],
		[
			"AuthError with category",
			(Dup: typeof import("../errors.js")) =>
				new Dup.AuthError(
					"x",
					{
						code: "AUTH_REQUIRED",
						category: "upstream_auth",
					} as never /* test-invalid: the options were removed from the type; the refusal is under test */,
				),
		],
		[
			"ValidationError with both",
			(Dup: typeof import("../errors.js")) =>
				new Dup.ValidationError(
					"x",
					{
						code: "INVALID_INPUT",
						category: "input_validation",
						retryable: false,
					} as never /* test-invalid: the options were removed from the type; the refusal is under test */,
				),
		],
	] as const) {
		it(`serves ${name} as the platform fault with the author guidance in the log`, async () => {
			const Dup = await secondCopy;
			const served = await serve(() => construct(Dup));

			expect(served.status).toBe(500);
			expect(served.body.error).toMatchObject({
				code: "PER_THROW_ERROR_OPTIONS_RETIRED",
				source: "apifuse",
				retryable: false,
			});
			expect(served.body.error.fix).toBeUndefined();
			expect(served.header).toMatchObject({
				origin: "platform",
				category: "internal_error",
				retryable: false,
			});
			expect(served.failure).toMatchObject({
				status: 500,
				code: "PER_THROW_ERROR_OPTIONS_RETIRED",
				errorOrigin: "platform",
				errorCategory: "internal_error",
				signal: "per_throw_error_options_retired",
			});
			expect((served.failure as { signalFix?: string }).signalFix).toContain(
				"apifuse migrate --only errors-factory",
			);
		});
	}
});
