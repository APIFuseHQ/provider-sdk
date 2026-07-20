import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
	centered,
	defineHealthJourney,
	defineProvider,
	defineSmsOtpMatcher,
	digestProviderContract,
	every,
	extractProviderContract,
} from "../index.js";
import type { ProviderContext, ProviderDefinition } from "../types.js";

const InputSchema = z.object({ query: z.string() });
const OutputSchema = z.object({ name: z.string(), score: z.number() });

const handler = async (_ctx: ProviderContext, input: { query: string }) => ({
	name: input.query,
	score: 1,
});

function buildProvider(operationIds: readonly [string, string]): ProviderDefinition {
	return defineProvider({
		id: "contract-provider",
		version: "1.2.3",
		runtime: "shared",
		allowedHosts: ["api.example.com", "assets.example.com"],
		auth: {
			mode: "oauth2",
			flow: {
				start: async () => ({ kind: "form", turnId: "start" }),
				continue: async () => ({ kind: "complete", turnId: "complete" }),
			},
		},
		access: { visibility: "early_access" },
		secrets: [{ name: "EXAMPLE_API_KEY", required: true }],
		credential: {
			keys: ["accessToken"],
			storesReusableSecret: true,
			justification: "OAuth access token is required for provider calls.",
		},
		context: { keys: ["workspaceId"] },
		meta: {
			displayName: "Contract Provider",
			descriptionKey: "contract.meta.description",
			category: "test",
			tags: ["contracts", "sdk"],
			publicProfile: {
				category: "test",
				connectionMode: "user_connected",
				availability: { regions: ["US"], supportLevel: "beta" },
			},
			contract: { publicSchemaFieldNames: "normalized" },
		},
		operations: Object.fromEntries(
			operationIds.map((operationId) => [
				operationId,
				{
					descriptionKey: `contract.operations.${operationId}.description`,
					docs: {
						titleKey: `contract.operations.${operationId}.title`,
						requestExample: { query: operationId },
						responseExample: { name: operationId, score: 1 },
					},
					whenToUseKeys: [`contract.operations.${operationId}.whenToUse`],
					whenNotToUseKeys: [`contract.operations.${operationId}.whenNotToUse`],
					derivations: { normalizedName: "name" },
					inputExamples: [
						{
							scenario: "baseline",
							input: { query: operationId },
							rationale: "Stable deterministic example.",
						},
					],
					annotations: { readOnly: true, openWorld: true, timeoutMs: 5000 },
					contract: { version: "1.0.0", lifecycle: "beta" },
					tags: ["search"],
					relatedOperations: { alternatives: ["fallback-search"] },
					toolRouter: {
						name: `${operationId.replaceAll("-", "_")}_tool`,
						riskClass: "read",
						approval: "never",
					},
					observability: { sensitive: { input: ["query"] } },
					transport: { kind: "json" },
					input: InputSchema,
					output: OutputSchema,
					handler,
					fixtures: {
						request: { query: operationId },
						response: { name: operationId, score: 1 },
					},
					upstream: { baseUrl: "https://api.example.com", proxy: false },
					hints: { cache: "short" },
					healthCheck: {
						interval: "5m",
						schedule: { randomize: centered("1m") },
						timeoutMs: 2000,
						degradedThresholdMs: 1000,
						requiresConnection: true,
						cases: [
							{
								name: `${operationId} baseline`,
								description: "Checks baseline search availability.",
								input: { query: operationId },
								expectedStatus: "ok",
								timeoutMs: 1500,
								degradedThresholdMs: 700,
								enabled: () => true,
								assertions: ({ data }) => {
									const output = data as z.infer<typeof OutputSchema>;
									if (output.score < 1) {
										throw new Error("score below baseline");
									}
								},
							},
						],
					},
				},
			]),
		),
		healthMonitor: {
			defaultProbeTimeoutMs: 3000,
			defaultDegradedThresholdMs: 1200,
			requiredSecrets: ["EXAMPLE_API_KEY"],
			credentialInputs: { accessToken: "EXAMPLE_API_KEY" },
		},
		healthJourneys: [
			defineHealthJourney({
				id: "search-journey",
				title: "Search Journey",
				description: "Runs a representative search journey.",
				schedule: every("8h", { jitter: "PT20M" }),
				coversOperations: ["zeta-search"],
				timeout: "PT1M",
				cooldown: "PT10M",
				requiredSecrets: ["EXAMPLE_API_KEY"],
				steps: [{ id: "search", operationId: "zeta-search", kind: "operation" }],
				run: async () => ({ status: "ok" }),
			}),
		],
	});
}

describe("provider contract extraction", () => {
	const smsOtpPattern = /인증번호는\s*\[([0-9]{4})\]/giu;

	it("sorts operations deterministically when provider insertion order differs", () => {
		// Given: two providers with equivalent operations inserted in different orders.
		const provider = buildProvider(["zeta-search", "alpha-search"]);

		// When: extracting the provider contract.
		const snapshot = extractProviderContract(provider);

		// Then: operations are emitted in stable operation id order.
		expect(snapshot.operations.map((operation) => operation.id)).toEqual([
			"alpha-search",
			"zeta-search",
		]);
	});

	it("omits handler and health executable functions from the snapshot", () => {
		// Given: a provider with operation handlers, health assertions, and journey run logic.
		const provider = buildProvider(["zeta-search", "alpha-search"]);

		// When: extracting and serializing the provider contract.
		const snapshot = extractProviderContract(provider);
		const encoded = JSON.stringify(snapshot);

		// Then: executable implementation details are absent from JSON-safe metadata.
		expect(encoded).not.toContain('"handler"');
		expect(encoded).not.toContain('"assertions"');
		expect(encoded).not.toContain('"enabled"');
		expect(encoded).not.toContain('"run"');
	});

	it("produces a stable digest for semantically identical provider definitions", () => {
		// Given: equivalent providers with opposite operation insertion order.
		const first = extractProviderContract(buildProvider(["zeta-search", "alpha-search"]));
		const second = extractProviderContract(buildProvider(["alpha-search", "zeta-search"]));

		// When: digesting both canonical snapshots.
		const firstDigest = digestProviderContract(first);
		const secondDigest = digestProviderContract(second);

		// Then: the canonical SHA-256 digest is identical.
		expect(firstDigest).toBe(secondDigest);
		expect(firstDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("changes snapshot and digest when object schema fields change", () => {
		// Given: two equivalent providers except for the public input/output fields.
		const firstProvider = buildProvider(["zeta-search", "alpha-search"]);
		const secondProvider = buildProvider(["zeta-search", "alpha-search"]);
		const alphaSearch = secondProvider.operations["alpha-search"];
		if (!alphaSearch) throw new Error("alpha-search operation missing");
		secondProvider.operations["alpha-search"] = {
			...alphaSearch,
			input: z.object({ query: z.string(), cursor: z.string().optional() }),
			output: z.object({
				name: z.string(),
				score: z.number(),
				rank: z.number(),
			}),
		};

		// When: extracting snapshots and digesting both contracts.
		const firstSnapshot = extractProviderContract(firstProvider);
		const secondSnapshot = extractProviderContract(secondProvider);
		const firstDigest = digestProviderContract(firstSnapshot);
		const secondDigest = digestProviderContract(secondSnapshot);

		// Then: schema-only contract changes affect the provider snapshot and digest.
		expect(firstSnapshot.operations[0]?.inputSchema).not.toEqual(
			secondSnapshot.operations[0]?.inputSchema,
		);
		expect(firstDigest).not.toBe(secondDigest);
	});

	it("preserves health schedule and coverage metadata without executable functions", () => {
		// Given: a provider with operation health checks and provider health journeys.
		const provider = buildProvider(["zeta-search", "alpha-search"]);

		// When: extracting the provider contract.
		const snapshot = extractProviderContract(provider);
		const operation = snapshot.operations.find((candidate) => candidate.id === "alpha-search");

		// Then: schedules, cases, and journey coverage remain as data metadata only.
		expect(operation?.healthCheck).toEqual({
			interval: "5m",
			schedule: { randomize: { mode: "centered", maxOffset: "PT1M" } },
			timeoutMs: 2000,
			degradedThresholdMs: 1000,
			requiresConnection: true,
			cases: [
				{
					name: "alpha-search baseline",
					description: "Checks baseline search availability.",
					input: { query: "alpha-search" },
					expectedStatus: "ok",
					timeoutMs: 1500,
					degradedThresholdMs: 700,
				},
			],
		});
		expect(snapshot.healthJourneys).toEqual([
			{
				id: "search-journey",
				title: "Search Journey",
				description: "Runs a representative search journey.",
				schedule: { kind: "interval", interval: "PT8H", jitter: "PT20M" },
				coversOperations: ["zeta-search"],
				timeout: "PT1M",
				cooldown: "PT10M",
				requiredSecrets: ["EXAMPLE_API_KEY"],
				steps: [{ id: "search", operationId: "zeta-search", kind: "operation" }],
			},
		]);
	});

	it("serializes health journey SMS matcher regex source and flags", () => {
		// Given: a health journey matcher with a RegExp OTP pattern.
		const provider = buildProvider(["zeta-search", "alpha-search"]);
		provider.healthJourneys = [
			defineHealthJourney({
				id: "sms-journey",
				schedule: every("8h"),
				coversOperations: ["alpha-search"],
				smsMatchers: [
					defineSmsOtpMatcher({
						id: "phone-otp",
						country: "KR",
						origins: [
							{
								kind: "nationalServiceCode",
								country: "KR",
								value: "16615270",
							},
						],
						code: { pattern: smsOtpPattern },
						maxAge: "PT5M",
						waitTimeout: "PT2M30S",
					}),
				],
				steps: [{ id: "search", operationId: "alpha-search", kind: "operation" }],
			}),
		];

		// When: extracting the provider contract.
		const snapshot = extractProviderContract(provider);

		// Then: regex metadata survives JSON serialization instead of becoming {}.
		expect(snapshot.healthJourneys?.[0]).toMatchObject({
			smsMatchers: [
				{
					code: {
						pattern: {
							source: smsOtpPattern.source,
							flags: "giu",
						},
					},
				},
			],
		});
	});
});
