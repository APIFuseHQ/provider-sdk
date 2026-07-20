import { describe, expect, it } from "bun:test";

import { ContextAccessError, CredentialModeError } from "../errors.js";
import { createFlowContext, createScratchpad } from "../runtime/auth-flow.js";
import { createCredentialContext } from "../runtime/credential.js";
import { createEnvContext } from "../runtime/env.js";
import type { HttpClient } from "../types.js";

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
		const bodyBytes = new Uint8Array();
		const response = async () => ({
			status: 200,
			ok: true,
			headers: {},
			data: {},
			json: async <T = unknown>() => ({}) as T,
			text: async () => "",
			arrayBuffer: async () => bodyBytes.buffer.slice(0),
			bytes: async () => bodyBytes.slice(0),
		});
		const http = {
			request: response,
			get: response,
			post: response,
			put: response,
			delete: response,
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
