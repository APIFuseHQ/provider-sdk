import { describe, expect, it } from "bun:test";

import { ContextAccessError, CredentialModeError } from "../errors";
import { createFlowContext, createScratchpad } from "../runtime/auth-flow";
import { createCredentialContext } from "../runtime/credential";
import { createEnvContext } from "../runtime/env";
import type { HttpClient } from "../types";

describe("runtime contexts", () => {
	it("createEnvContext respects the allowlist", () => {
		process.env.TEST_ALLOWED_ENV = "allowed";
		process.env.TEST_BLOCKED_ENV = "blocked";

		const env = createEnvContext(["TEST_ALLOWED_ENV"]);

		expect(env.get("TEST_ALLOWED_ENV")).toBe("allowed");
		expect(env.get("TEST_BLOCKED_ENV")).toBeUndefined();
	});

	it("createCredentialContext enforces declared keys and oauth helpers", () => {
		const credential = createCredentialContext({
			allowedKeys: ["access_token", "refresh_token"],
			mode: "oauth2",
			values: {
				access_token: "token-123",
				refresh_token: "refresh-456",
				scope: "read write",
				cookie: "sid=secret",
			},
		});

		expect(credential.get("access_token")).toBe("token-123");
		expect(credential.get("cookie")).toBeUndefined();
		expect(credential.getAll()).toEqual({
			access_token: "token-123",
			refresh_token: "refresh-456",
		});
		expect(credential.getAccessToken()).toBe("token-123");
		expect(credential.getScopes()).toEqual(["read", "write"]);
	});

	it("createCredentialContext returns empty oauth helpers for non-oauth modes", () => {
		const credential = createCredentialContext({
			allowedKeys: ["cookie"],
			mode: "credentials",
			values: { access_token: "token-123", cookie: "sid=secret" },
		});

		expect(() => credential.getAccessToken()).toThrow(CredentialModeError);
		expect(() => credential.getScopes()).toThrow(CredentialModeError);
	});

	it("createScratchpad only allows declared keys", () => {
		const scratchpad = createScratchpad(["state"], { state: "pending" });

		expect(scratchpad.get("state")).toBe("pending");
		scratchpad.set("state", "complete");
		expect(scratchpad.toJSON()).toEqual({ state: "complete" });
		expect(() => scratchpad.get("missing")).toThrow(ContextAccessError);
		expect(() => scratchpad.set("missing", true)).toThrow(ContextAccessError);
	});

	it("createFlowContext wires runtime dependencies and scratchpad", () => {
		const http = {
			request: async () => ({
				status: 200,
				ok: true,
				headers: {},
				data: {},
				json: async () => ({}),
				text: async () => "",
			}),
			get: async () => ({
				status: 200,
				ok: true,
				headers: {},
				data: {},
				json: async () => ({}),
				text: async () => "",
			}),
			post: async () => ({
				status: 200,
				ok: true,
				headers: {},
				data: {},
				json: async () => ({}),
				text: async () => "",
			}),
			put: async () => ({
				status: 200,
				ok: true,
				headers: {},
				data: {},
				json: async () => ({}),
				text: async () => "",
			}),
			delete: async () => ({
				status: 200,
				ok: true,
				headers: {},
				data: {},
				json: async () => ({}),
				text: async () => "",
			}),
			stream: async () => {
				throw new Error("stream unsupported in runtime context test client");
			},
			sse: async () => {
				throw new Error("sse unsupported in runtime context test client");
			},
		} satisfies HttpClient;

		const context = createFlowContext({
			http,
			env: createEnvContext(),
			tenantId: "tenant-1",
			providerId: "demo-provider",
			connectionId: "conn-1",
			externalRef: "user-1",
			allowedKeys: ["state"],
			initialContext: { state: "draft" },
		});

		expect(context.http).toBe(http);
		expect(context.tenantId).toBe("tenant-1");
		expect(context.providerId).toBe("demo-provider");
		expect(context.context.get("state")).toBe("draft");
	});
});
