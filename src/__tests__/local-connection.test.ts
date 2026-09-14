import { describe, expect, it } from "bun:test";

import {
	LOCAL_CONNECTION_ID,
	LOCAL_CONNECTION_SECRETS_ENV,
	parseCredentialOverrides,
	parseEnvironmentSecrets,
	providerRequiresConnection,
	resolveLocalConnection,
} from "../cli/local-connection.js";
import { createCredentialContext } from "../runtime/credential.js";
import { createCaptureContext } from "../../bin/apifuse-record.js";
import { scoreSmoke } from "../../bin/apifuse-submit-check.js";
import { defineProvider, z } from "../index.js";
import { OperationRequestSchema } from "../server/types.js";

const platformManaged = {
	id: "korea-building-register",
	auth: { mode: "platform-managed" as const },
};
const noAuth = { id: "korea-holiday", auth: { mode: "none" as const } };
const undeclaredAuth = { id: "seoul-bike", auth: undefined };

describe("providerRequiresConnection", () => {
	it("is true for every mode whose credential the gateway resolves", () => {
		for (const mode of ["platform-managed", "credentials", "oauth2", "oauth2_proxied"] as const) {
			expect(providerRequiresConnection({ auth: { mode } })).toBe(true);
		}
	});

	it("is false for an absent or explicit none auth declaration", () => {
		expect(providerRequiresConnection(noAuth)).toBe(false);
		expect(providerRequiresConnection(undeclaredAuth)).toBe(false);
	});
});

describe("parseCredentialOverrides", () => {
	it("splits on the first = so a base64 or URL value survives intact", () => {
		const parsed = parseCredentialOverrides(["serviceKey=abc==def", "url=https://h/p?a=b"]);
		expect(parsed).toEqual({
			ok: true,
			secrets: { serviceKey: "abc==def", url: "https://h/p?a=b" },
		});
	});

	it("accepts an empty value", () => {
		expect(parseCredentialOverrides(["serviceKey="])).toEqual({
			ok: true,
			secrets: { serviceKey: "" },
		});
	});

	it("rejects an argument with no separator or no key", () => {
		expect(parseCredentialOverrides(["serviceKey"]).ok).toBe(false);
		expect(parseCredentialOverrides(["=value"]).ok).toBe(false);
	});
});

describe("parseEnvironmentSecrets", () => {
	it("reads a JSON object of string values", () => {
		expect(parseEnvironmentSecrets('{"serviceKey":"k"}')).toEqual({
			ok: true,
			secrets: { serviceKey: "k" },
		});
	});

	it("treats absence and whitespace as no secrets", () => {
		expect(parseEnvironmentSecrets(undefined)).toEqual({ ok: true, secrets: {} });
		expect(parseEnvironmentSecrets("   ")).toEqual({ ok: true, secrets: {} });
	});

	it("rejects malformed JSON, a non-object, and a non-string value", () => {
		expect(parseEnvironmentSecrets("{oops")).toMatchObject({ ok: false });
		expect(parseEnvironmentSecrets('["serviceKey"]')).toMatchObject({ ok: false });
		expect(parseEnvironmentSecrets('{"serviceKey":1}')).toMatchObject({ ok: false });
	});
});

describe("resolveLocalConnection", () => {
	it("builds the envelope shape the gateway injects", () => {
		const resolved = resolveLocalConnection(platformManaged, {
			env: { [LOCAL_CONNECTION_SECRETS_ENV]: '{"serviceKey":"platform-key"}' },
		});

		expect(resolved).toEqual({
			ok: true,
			connection: {
				id: LOCAL_CONNECTION_ID,
				mode: "platform-managed",
				secrets: { serviceKey: "platform-key" },
				metadata: {},
				// Required by OperationConnectionSchema; the gateway leaves it empty
				// on a platform-managed injection.
				externalRef: "",
			},
		});
	});

	it("lets a CLI override win over the environment", () => {
		const resolved = resolveLocalConnection(platformManaged, {
			env: { [LOCAL_CONNECTION_SECRETS_ENV]: '{"serviceKey":"from-env"}' },
			overrides: ["serviceKey=from-flag"],
		});

		expect(resolved).toMatchObject({
			ok: true,
			connection: { secrets: { serviceKey: "from-flag" } },
		});
	});

	it("fails with an actionable message when a needed credential is absent", () => {
		// The whole defect: before this, the recorder silently used
		// `{ mode: "none" }` here and the run died inside the provider on its own
		// MISSING_SECRET, which reads like an upstream or key problem.
		const resolved = resolveLocalConnection(platformManaged, { env: {} });

		expect(resolved.ok).toBe(false);
		if (resolved.ok) throw new Error("unreachable");
		expect(resolved.reason).toContain("platform-managed");
		expect(resolved.reason).toContain("--credential");
		expect(resolved.reason).toContain(LOCAL_CONNECTION_SECRETS_ENV);
		expect(resolved.reason).toContain("--no-credential");
	});

	it("needs nothing for a provider that takes no credential", () => {
		expect(resolveLocalConnection(noAuth, { env: {} })).toEqual({
			ok: true,
			connection: undefined,
		});
		expect(resolveLocalConnection(undeclaredAuth, { env: {} })).toEqual({
			ok: true,
			connection: undefined,
		});
	});

	it("refuses a credential for a provider that takes none, rather than ignoring it", () => {
		const resolved = resolveLocalConnection(noAuth, {
			overrides: ["serviceKey=k"],
		});
		expect(resolved.ok).toBe(false);
	});

	it("surfaces a malformed environment value instead of falling back to no credential", () => {
		expect(
			resolveLocalConnection(platformManaged, {
				env: { [LOCAL_CONNECTION_SECRETS_ENV]: "{oops" },
			}).ok,
		).toBe(false);
	});
});

describe("credential context built from a local connection", () => {
	it("serves the platform key the provider reads, exactly as serve does", () => {
		const resolved = resolveLocalConnection(platformManaged, {
			overrides: ["serviceKey=platform-key"],
		});
		if (!resolved.ok || !resolved.connection) throw new Error("unreachable");

		// platform-managed forbids declaring credential.keys, so allowedKeys is
		// absent and every supplied key is readable - the same fallback serve
		// takes.
		const credential = createCredentialContext({
			mode: resolved.connection.mode,
			values: resolved.connection.secrets,
		});

		expect(credential.mode).toBe("platform-managed");
		expect(credential.get("serviceKey")).toBe("platform-key");
		expect(credential.getAll()).toEqual({ serviceKey: "platform-key" });
	});

	it("reproduces the old stub behaviour when no connection is attached", () => {
		const credential = createCredentialContext();
		expect(credential.mode).toBe("none");
		expect(credential.get("serviceKey")).toBeUndefined();
	});
});

describe("smoke envelope conformance", () => {
	it("is accepted by the operation request schema the dev server validates", () => {
		// `OperationConnectionSchema` requires `externalRef`, and `submit-check
		// --smoke` POSTs this object straight at /v1/<operation>. A shape that is
		// one required field short would be rejected before the provider ran, and
		// the smoke result would look like a provider fault.
		const resolved = resolveLocalConnection(platformManaged, {
			overrides: ["serviceKey=platform-key"],
		});
		if (!resolved.ok || !resolved.connection) throw new Error("unreachable");

		const parsed = OperationRequestSchema.safeParse({
			requestId: "req_submit_check_smoke_list",
			input: {},
			connection: resolved.connection,
		});

		expect(parsed.success).toBe(true);
	});
});

describe("smoke scoring with a needed credential", () => {
	const success = {
		operationId: "public-op",
		status: "success" as const,
		httpStatus: 200,
		message: "schema-valid success",
	};

	it("does not award full points when the credential was never supplied", () => {
		// codex review caught this: the success branch ran first, so one
		// unauthenticated operation returning a schema-valid response bought full
		// smoke points for a run that never exercised the credentialed path.
		const check = scoreSmoke(
			{
				measured: true,
				healthOk: true,
				operations: [success],
				credential: { required: true, supplied: false, mode: "platform-managed" },
			},
			undefined,
		);

		expect(check.status).toBe("warn");
		expect(check.points).toBeLessThan(check.maxPoints);
		expect(check.message).toContain("platform-managed");
		expect(check.evidence?.join("\n")).toContain("credential: NOT supplied");
	});

	it("awards full points once the credential is supplied and an operation succeeds", () => {
		const check = scoreSmoke(
			{
				measured: true,
				healthOk: true,
				operations: [success],
				credential: { required: true, supplied: true, mode: "platform-managed" },
			},
			undefined,
		);

		expect(check.status).toBe("pass");
		expect(check.points).toBe(check.maxPoints);
		expect(check.evidence?.join("\n")).toContain("credential: supplied");
	});

	it("is unchanged for a provider that needs no credential", () => {
		const check = scoreSmoke(
			{
				measured: true,
				healthOk: true,
				operations: [success],
				credential: { required: false, supplied: false, mode: "none" },
			},
			undefined,
		);

		expect(check.status).toBe("pass");
		expect(check.evidence?.join("\n")).not.toContain("credential:");
	});

	it("still blocks on an incoherent runtime before it looks at credentials", () => {
		const check = scoreSmoke(
			{
				measured: true,
				healthOk: false,
				operations: [],
				credential: { required: true, supplied: false, mode: "platform-managed" },
			},
			undefined,
		);

		expect(check.status).toBe("fail");
	});
});

describe("credential values never reach a diagnostic", () => {
	it("does not echo a malformed --credential argument", () => {
		// codex review caught this: quoting the offending argument to be helpful
		// printed the credential to stderr, before any redaction context exists.
		for (const argument of ["=super-secret-value", "super-secret-value"]) {
			const parsed = parseCredentialOverrides([argument]);
			expect(parsed.ok).toBe(false);
			if (parsed.ok) throw new Error("unreachable");
			expect(parsed.reason).not.toContain("super-secret-value");
			expect(parsed.reason).toContain("--credential #1");
		}
	});

	it("does not echo a non-string environment value", () => {
		const parsed = parseEnvironmentSecrets('{"serviceKey":{"nested":"super-secret-value"}}');
		expect(parsed.ok).toBe(false);
		if (parsed.ok) throw new Error("unreachable");
		expect(parsed.reason).not.toContain("super-secret-value");
		expect(parsed.reason).toContain("serviceKey");
	});
});

describe("smoke scoring with an invalid credential configuration", () => {
	const success = {
		operationId: "public-op",
		status: "success" as const,
		httpStatus: 200,
		message: "schema-valid success",
	};

	it("names the configuration error instead of reporting a plain absence", () => {
		const check = scoreSmoke(
			{
				measured: true,
				healthOk: true,
				operations: [success],
				credential: {
					required: true,
					supplied: false,
					mode: "platform-managed",
					error: `${LOCAL_CONNECTION_SECRETS_ENV} is not valid JSON: unexpected token`,
				},
			},
			undefined,
		);

		expect(check.status).toBe("warn");
		expect(check.evidence?.join("\n")).toContain("CONFIGURED BUT INVALID");
		expect(check.remediation).toContain("Fix the local credential configuration");
	});

	it("reports an invalid configuration even for a provider that needs no credential", () => {
		const check = scoreSmoke(
			{
				measured: true,
				healthOk: true,
				operations: [success],
				credential: {
					required: false,
					supplied: false,
					mode: "none",
					error: `${LOCAL_CONNECTION_SECRETS_ENV} is not valid JSON: unexpected token`,
				},
			},
			undefined,
		);

		expect(check.status).toBe("pass");
		expect(check.evidence?.join("\n")).toContain("CONFIGURED BUT INVALID");
	});
});

describe("recorder redaction seeding", () => {
	const provider = defineProvider({
		id: "redaction-fixture",
		version: "1.0.0",
		runtime: "standard",
		http: true,
		allowedHosts: ["example.com"],
		reviewed: "community",
		auth: { mode: "platform-managed" },
		meta: {
			displayName: "Redaction Fixture",
			descriptionKey: "redaction-fixture.description",
			category: "test",
		},
	})({
		operations: {
			lookup: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async () => ({ ok: true }),
				healthCheckUnsupported: { reason: "CLI redaction unit test" },
			},
		},
	});

	it("registers credential values for redaction but never their key names", () => {
		// codex review caught the second half: `sensitiveParamNames` means
		// "declared query-key position", and `redactFixture` deliberately SKIPS
		// common-field sanitization for a key listed there. Seeding `access_token`
		// would have written a newly issued upstream `access_token` — which does
		// not equal the injected value — to raw.json in plaintext.
		const { getCapturedSensitiveParams } = createCaptureContext(
			provider,
			"https://example.com",
			true,
			{
				id: "local-connection",
				mode: "platform-managed",
				secrets: { access_token: "injected-token", serviceKey: "injected-key" },
				metadata: {},
				externalRef: "",
			},
		);

		const captured = getCapturedSensitiveParams();
		expect(captured.names).toEqual([]);
		expect([...captured.values].sort()).toEqual(["injected-key", "injected-token"]);
	});

	it("registers nothing when no connection is attached", () => {
		const { getCapturedSensitiveParams } = createCaptureContext(
			provider,
			"https://example.com",
			true,
		);

		expect(getCapturedSensitiveParams()).toEqual({ names: [], values: [] });
	});
});
