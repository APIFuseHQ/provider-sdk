import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";

import {
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

	it("reproduces the same sid across processes for one account", () => {
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
		const first = resolveNativeGatewayProxy({ policy: POLICY, affinityKey: firstProcessKey });
		const second = resolveNativeGatewayProxy({ policy: POLICY, affinityKey: secondProcessKey });

		expect(firstProcessKey).toBe(deriveNativeCredentialAffinityKey(identity));
		expect(firstProcessKey).toBe(secondProcessKey);
		expect(first?.sessionId).toBe(second?.sessionId);
	});

	it("produces different sids for different account identities", () => {
		const first = resolveNativeGatewayProxy({
			policy: POLICY,
			affinityKey: deriveNativeCredentialAffinityKey(`account-a-${randomUUID()}`),
		});
		const second = resolveNativeGatewayProxy({
			policy: POLICY,
			affinityKey: deriveNativeCredentialAffinityKey(`account-b-${randomUUID()}`),
		});

		expect(first?.sessionId).not.toBe(second?.sessionId);
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
