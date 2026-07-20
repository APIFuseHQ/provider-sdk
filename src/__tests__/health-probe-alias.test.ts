import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { defineProvider } from "../define.js";
import { ValidationError } from "../errors.js";
import type { ProviderHealthMonitorConfig } from "../types.js";

function baseConfig(
	health: {
		healthMonitor?: ProviderHealthMonitorConfig;
		healthProbe?: ProviderHealthMonitorConfig;
	} = {},
) {
	return {
		id: "alias-provider",
		version: "1.0.0",
		runtime: "standard" as const,
		meta: {
			displayName: "Alias Provider",
			descriptionKey: "meta.description",
			category: "demo",
		},
		operations: {
			ping: {
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				async handler() {
					return { ok: true };
				},
				healthCheck: {
					interval: "5m" as const,
					cases: [
						{
							name: "ping baseline",
							input: {},
							assertions: () => {},
						},
					] as [
						{
							name: string;
							input: Record<string, never>;
							assertions: () => void;
						},
					],
				},
			},
		},
		...health,
	};
}

const sampleConfig: ProviderHealthMonitorConfig = {
	requiredSecrets: ["APIFUSE__HEALTH_MONITOR__ALIAS_TOKEN"],
	credentialInputs: { token: "APIFUSE__HEALTH_MONITOR__ALIAS_TOKEN" },
};

describe("healthProbe alias for healthMonitor", () => {
	it("accepts healthProbe and mirrors it onto healthMonitor", () => {
		const provider = defineProvider(baseConfig({ healthProbe: sampleConfig }));
		expect(provider.healthProbe).toEqual(sampleConfig);
		expect(provider.healthMonitor).toEqual(sampleConfig);
	});

	it("accepts healthMonitor and mirrors it onto healthProbe", () => {
		const provider = defineProvider(baseConfig({ healthMonitor: sampleConfig }));
		expect(provider.healthMonitor).toEqual(sampleConfig);
		expect(provider.healthProbe).toEqual(sampleConfig);
	});

	it("leaves both undefined when neither is declared", () => {
		const provider = defineProvider(baseConfig());
		expect(provider.healthMonitor).toBeUndefined();
		expect(provider.healthProbe).toBeUndefined();
	});

	it("rejects declaring both healthMonitor and healthProbe", () => {
		expect(() =>
			defineProvider(
				baseConfig({
					healthMonitor: sampleConfig,
					healthProbe: sampleConfig,
				}),
			),
		).toThrow(ValidationError);
		expect(() =>
			defineProvider(
				baseConfig({
					healthMonitor: sampleConfig,
					healthProbe: sampleConfig,
				}),
			),
		).toThrow(/declares both healthMonitor and healthProbe/);
	});

	it("validates healthProbe identically to healthMonitor and names the field in errors", () => {
		expect(() =>
			defineProvider(
				baseConfig({
					healthProbe: {
						bogusField: true,
					} as unknown as ProviderHealthMonitorConfig,
				}),
			),
		).toThrow(/healthProbe/);
		expect(() =>
			defineProvider(
				baseConfig({
					healthProbe: {
						credentialInputs: { token: "SOME_ENV" },
						requiredSecrets: ["OTHER_ENV"],
					},
				}),
			),
		).toThrow(/healthProbe\.credentialInputs\.token references SOME_ENV/);
		expect(() =>
			defineProvider(
				baseConfig({
					healthMonitor: {
						bogusField: true,
					} as unknown as ProviderHealthMonitorConfig,
				}),
			),
		).toThrow(/healthMonitor/);
	});
});
