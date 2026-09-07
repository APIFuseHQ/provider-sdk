import { expect, setSystemTime, spyOn, test } from "bun:test";
import { z } from "zod";
import packageJson from "../../package.json";
import { createSelfTestApp as head, SELF_TEST_PATH } from "../server/self-test.js";
import { deriveSelfTestToken } from "../server/self-test-token.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

test("self-test HTTP response preserves the reviewed base bytes", async () => {
	setSystemTime(new Date("2026-09-07T00:00:00Z"));
	const timer = spyOn(performance, "now").mockReturnValue(1000);
	try {
		const env = {
			APIFUSE__PROVIDER_RUNTIME__SELF_TEST_MASTER_SECRET: "master-apple",
			APIFUSE__PROVIDER_RUNTIME__SELF_TEST_MASTER_SECRET_PREVIOUS: "previous-pear",
			DECLARED: "provider-orchard",
			PROBE: "health-apricot",
			HEALTH: "health-peach",
		};
		const text = Object.values(env).join(" | ") + " | request-plum";
		const provider = createProviderDefinitionDouble({
			id: "parity-provider",
			secrets: [{ name: "DECLARED" }],
			healthProbe: { requiredSecrets: ["PROBE"], credentialInputs: { password: "HEALTH" } },
			operations: {
				probe: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({}),
					handler: async () => ({}),
					healthCheck: {
						interval: "5m",
						timeoutMs: 1000,
						cases: [
							{
								name: "probe-case",
								description: text,
								input: {},
								assertions: () => {
									throw new Error(text);
								},
							},
						],
					},
				},
			},
		});
		const options = {
			secrets: { current: env.APIFUSE__PROVIDER_RUNTIME__SELF_TEST_MASTER_SECRET },
			env,
			invoke: async () => ({ status: 200, data: {} }),
		};
		// Reference bytes captured from 819708d by registry/full-parity.test.ts.
		const outputs: string[] = [];
		for (const fn of [head]) {
			const app = fn(provider, options);
			const response = await app.request(SELF_TEST_PATH, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer " + deriveSelfTestToken(options.secrets.current, provider.id),
				},
				body: JSON.stringify({
					schemaVersion: 1,
					requestId: "parity",
					operationId: "probe",
					caseName: "probe-case",
					credentials: { inputs: { password: "request-plum" } },
				}),
			});
			expect(response.status).toBe(200);
			outputs.push(await response.text());
		}
		const golden =
			'{"schemaVersion":1,"providerId":"parity-provider","sdkVersion":"2.2.0-beta.58","planDigest":"550a8213a97408ea0cf5b35169b74f971cb98b0366940c08f6d70271a9e35e17","result":{"operationId":"probe","caseName":"probe-case","startedAt":"2026-09-07T00:00:00.000Z","finishedAt":"2026-09-07T00:00:00.000Z","responseTimeMs":0,"status":"failed","label":"[REDACTED] | [REDACTED] | [REDACTED] | [REDACTED] | [REDACTED] | [REDACTED]","httpStatus":200,"assertion":{"passed":false,"message":"[REDACTED] | [REDACTED] | [REDACTED] | [REDACTED] | [REDACTED] | [REDACTED]"}},"results":[{"operationId":"probe","caseName":"probe-case","startedAt":"2026-09-07T00:00:00.000Z","finishedAt":"2026-09-07T00:00:00.000Z","responseTimeMs":0,"status":"failed","label":"[REDACTED] | [REDACTED] | [REDACTED] | [REDACTED] | [REDACTED] | [REDACTED]","httpStatus":200,"assertion":{"passed":false,"message":"[REDACTED] | [REDACTED] | [REDACTED] | [REDACTED] | [REDACTED] | [REDACTED]"}}]}';
		expect(outputs[0]).toBe(golden.replace("2.2.0-beta.58", packageJson.version));
	} finally {
		timer.mockRestore();
		setSystemTime();
	}
});
