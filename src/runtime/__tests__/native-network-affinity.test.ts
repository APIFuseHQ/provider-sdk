import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";

import { clearProxyResolutionCache, SMARTPROXY_APP_KEY_ENV } from "../../config/loader.js";
import {
	createEnvVendorCredentialResolver,
	createNativeNetworkClient,
	deriveNativeCredentialAffinityKey,
	resolveNativeGatewayProxy,
	type NativeGatewayProxySynthesizer,
} from "../native-network.js";

const POLICY = {
	mode: "required",
	providers: ["nodemaven"],
	session: { affinity: "connection", lifetimeMinutes: 60 },
} as const;

let usernameBefore: string | undefined;
let passwordBefore: string | undefined;

beforeEach(() => {
	usernameBefore = process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME;
	passwordBefore = process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD;
	process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = `fixture-${randomUUID()}`;
	process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = randomUUID();
});

afterEach(() => {
	clearProxyResolutionCache();
	if (usernameBefore === undefined) delete process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME;
	else process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = usernameBefore;
	if (passwordBefore === undefined) delete process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD;
	else process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = passwordBefore;
});

describe("native credential affinity", () => {
	it("derives a hashed default before offering affinity to a gateway synthesizer", async () => {
		const identity = `account-${randomUUID()}`;
		let offeredAffinity: string | undefined;
		const capture: NativeGatewayProxySynthesizer = (input) => {
			offeredAffinity = input.affinityKey;
			return undefined;
		};
		const client = createNativeNetworkClient({
			proxyPolicy: POLICY,
			credentialIdentity: identity,
			gatewaySynthesizers: [capture],
		});

		await expect(client.connectTcp({ host: "127.0.0.1", port: 9 })).rejects.toMatchObject({
			code: "PROXY_REQUIRED",
		});
		expect(offeredAffinity).toBe(deriveNativeCredentialAffinityKey(identity));
		expect(offeredAffinity).not.toContain(identity);
	});

	it("reproduces the same NodeMaven sid across processes for one account", async () => {
		const identity = `account-${randomUUID()}`;
		const deriveInProcess = () => {
			const child = Bun.spawnSync([
				"bun",
				"-e",
				'import { deriveNativeCredentialAffinityKey } from "./src/runtime/native-network.ts"; process.stdout.write(deriveNativeCredentialAffinityKey(process.argv.at(-1) ?? ""));',
				identity,
			]);
			expect(child.exitCode).toBe(0);
			return child.stdout.toString();
		};
		const firstProcessKey = deriveInProcess();
		const secondProcessKey = deriveInProcess();
		const first = await resolveNativeGatewayProxy({ policy: POLICY, affinityKey: firstProcessKey });
		const second = await resolveNativeGatewayProxy({
			policy: POLICY,
			affinityKey: secondProcessKey,
		});

		expect(firstProcessKey).toBe(deriveNativeCredentialAffinityKey(identity));
		expect(firstProcessKey).toBe(secondProcessKey);
		expect(first?.sessionId).toBe(second?.sessionId);
	});

	it("produces different NodeMaven sids for different account identities", async () => {
		const first = await resolveNativeGatewayProxy({
			policy: POLICY,
			affinityKey: deriveNativeCredentialAffinityKey(`account-a-${randomUUID()}`),
		});
		const second = await resolveNativeGatewayProxy({
			policy: POLICY,
			affinityKey: deriveNativeCredentialAffinityKey(`account-b-${randomUUID()}`),
		});

		expect(first?.sessionId).not.toBe(second?.sessionId);
	});

	it("aligns NodeMaven sid rotation and expiry to a process-independent session window", async () => {
		const affinityKey = deriveNativeCredentialAffinityKey(`account-${randomUUID()}`);
		const first = await resolveNativeGatewayProxy({
			policy: POLICY,
			affinityKey,
			now: Date.parse("2026-07-30T12:34:00.000Z"),
		});
		const sameWindow = await resolveNativeGatewayProxy({
			policy: POLICY,
			affinityKey,
			now: Date.parse("2026-07-30T12:59:59.999Z"),
		});
		const nextWindow = await resolveNativeGatewayProxy({
			policy: POLICY,
			affinityKey,
			now: Date.parse("2026-07-30T13:00:00.000Z"),
		});

		expect(first?.expiresAt).toBe("2026-07-30T13:00:00.000Z");
		expect(first?.sessionId).toBe(sameWindow?.sessionId);
		expect(first?.sessionId).not.toBe(nextWindow?.sessionId);
	});

	it("keeps Smartproxy allocation sticky per affinity and separates different affinities", async () => {
		const originalFetch = globalThis.fetch;
		let allocations = 0;
		globalThis.fetch = (async () => {
			allocations += 1;
			return new Response(`127.0.0.${allocations}:8080`, { status: 200 });
		}) as typeof fetch;
		const credentials = () => ({
			kind: "present" as const,
			values: { [SMARTPROXY_APP_KEY_ENV]: "injected-smartproxy-key" },
		});
		const policy = {
			mode: "required",
			providers: ["smartproxy"],
			session: { affinity: "connection", lifetimeMinutes: 60, poolSize: 1 },
		} as const;
		try {
			const first = await resolveNativeGatewayProxy({
				policy,
				affinityKey: "account-a",
				credentials,
			});
			const same = await resolveNativeGatewayProxy({
				policy,
				affinityKey: "account-a",
				credentials,
			});
			const different = await resolveNativeGatewayProxy({
				policy,
				affinityKey: "account-b",
				credentials,
			});

			expect(first?.url).toBe("http://127.0.0.1:8080");
			expect(same?.url).toBe(first?.url);
			expect(different?.url).toBe("http://127.0.0.2:8080");
			expect(allocations).toBe(2);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("synthesizes from injected credentials while the ambient env is empty", async () => {
		delete process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME;
		delete process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD;
		const values = {
			APIFUSE__PROXY__NODEMAVEN_USERNAME: "injected-user",
			APIFUSE__PROXY__NODEMAVEN_PASSWORD: "injected-password",
		};
		const resolved = await resolveNativeGatewayProxy({
			policy: POLICY,
			affinityKey: "injected-affinity",
			credentials: createEnvVendorCredentialResolver({
				get: (name) => values[name as keyof typeof values],
			}),
		});

		expect(resolved?.vendor).toBe("nodemaven");
		expect(resolved?.url).toMatch(/^http:\/\//);
		expect(resolved?.sessionId).toBeDefined();
	});

	it("lets an explicit per-connect affinity key win", async () => {
		let offeredAffinity: string | undefined;
		const client = createNativeNetworkClient({
			proxyPolicy: POLICY,
			credentialIdentity: `account-${randomUUID()}`,
			affinityKey: "factory-explicit",
			gatewaySynthesizers: [
				(input) => {
					offeredAffinity = input.affinityKey;
					return undefined;
				},
			],
		});

		await expect(
			client.connectTcp({ host: "127.0.0.1", port: 9, affinityKey: "connect-explicit" }),
		).rejects.toMatchObject({ code: "PROXY_REQUIRED" });
		expect(offeredAffinity).toBe("connect-explicit");
	});

	it("does not derive account affinity for request-rotating policies", async () => {
		let offeredAffinity: string | undefined = "not-called";
		const client = createNativeNetworkClient({
			proxyPolicy: {
				mode: "required",
				providers: ["nodemaven"],
				session: { affinity: "request" },
			},
			credentialIdentity: `account-${randomUUID()}`,
			gatewaySynthesizers: [
				(input) => {
					offeredAffinity = input.affinityKey;
					return undefined;
				},
			],
		});

		await expect(client.connectTcp({ host: "127.0.0.1", port: 9 })).rejects.toMatchObject({
			code: "PROXY_REQUIRED",
		});
		expect(offeredAffinity).toBeUndefined();
	});
});
