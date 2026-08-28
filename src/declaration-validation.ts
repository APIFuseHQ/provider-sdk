import { describeSchema } from "./contract-serialization.js";
import { ProviderError } from "./errors.js";
import { HealthScenarioSchema } from "./health-scenario.js";
import type {
	HealthJourneyDefinition,
	ProviderDefinition,
	ProviderProxyPolicy,
	ProviderProxyProvider,
} from "./types.js";

export const DECLARATION_INVALID_CODE = "DECLARATION_INVALID";

export const DECLARATION_RULE_IDS = {
	challengeShape: "credentials-challenge-shape",
	journeyExecutable: "health-journey-executable",
	journeyRunScenarioExclusive: "health-journey-run-scenario-exclusive",
	journeyScenarioValid: "health-journey-scenario-valid",
	schemaSerializable: "operation-schema-serializable",
	proxyExplicitPolicy: "proxy-explicit-policy",
	proxyVendorExclusive: "proxy-vendor-fields-exclusive",
	proxyNoMixedVendors: "proxy-no-mixed-vendors",
	proxySmartproxyGeo: "proxy-smartproxy-country-only",
	operationUpstreamProxy: "operation-upstream-proxy-unsupported",
} as const;

export type DeclarationRuleId =
	(typeof DECLARATION_RULE_IDS)[keyof typeof DECLARATION_RULE_IDS];

export type DeclarationViolation = {
	ruleId: DeclarationRuleId;
	path: string;
	message: string;
	fix: string;
};

export function declarationInvalidError(
	violations: readonly DeclarationViolation[],
): ProviderError {
	const summary = violations
		.map((violation) => `${violation.path} [${violation.ruleId}]: ${violation.message}`)
		.join("\n");
	return new ProviderError(
		`Provider declaration is invalid (${violations.length} violation${violations.length === 1 ? "" : "s"}).${summary ? `\n${summary}` : ""}`,
		{
			code: DECLARATION_INVALID_CODE,
			details: { violations: [...violations] },
			fix: "Apply every violation's fix hint, then validate the declaration again.",
		},
	);
}

/** Enforces declaration rules whose runtime behavior would otherwise fail open. */
export function validateFailClosedDeclaration(provider: ProviderDefinition): void {
	const violations: DeclarationViolation[] = [];
	validateHealthDeclaration(provider, violations);
	validateSchemaDeclaration(provider, violations);
	validateProxyDeclaration(provider, violations);
	validateOperationDeclaration(provider, violations);
	if (violations.length > 0) throw declarationInvalidError(violations);
}

type ProviderDeclarationRulesInput = Pick<ProviderDefinition, "healthJourneys" | "proxy">;
type OperationDeclarationRulesInput = Pick<ProviderDefinition, "operations">;

/** Enforces fail-closed rules that only depend on the provider declaration. */
export function validateFailClosedProviderDeclaration(
	provider: ProviderDeclarationRulesInput,
): void {
	const violations: DeclarationViolation[] = [];
	collectProviderDeclarationViolations(provider, violations);
	if (violations.length > 0) throw declarationInvalidError(violations);
}

/** Enforces fail-closed rules that depend on the operation implementation. */
export function validateFailClosedOperationDeclaration(
	provider: OperationDeclarationRulesInput,
): void {
	const violations: DeclarationViolation[] = [];
	collectOperationDeclarationViolations(provider, violations);
	if (violations.length > 0) throw declarationInvalidError(violations);
}

function collectProviderDeclarationViolations(
	provider: ProviderDeclarationRulesInput,
	violations: DeclarationViolation[],
): void {
	validateHealthDeclaration(provider, violations);
	validateProxyDeclaration(provider, violations);
}

function collectOperationDeclarationViolations(
	provider: OperationDeclarationRulesInput,
	violations: DeclarationViolation[],
): void {
	validateSchemaDeclaration(provider, violations);
	validateOperationDeclaration(provider, violations);
}

function validateHealthDeclaration(
	provider: ProviderDeclarationRulesInput,
	violations: DeclarationViolation[],
): void {
	for (const [index, journey] of (provider.healthJourneys ?? []).entries()) {
		if (!journey || typeof journey !== "object") continue;
		const hasRun = journey.run !== undefined;
		const hasScenario = journey.scenario !== undefined;
		if (hasRun && hasScenario) {
			const journeyPath = healthJourneyPath(journey, index);
			violations.push({
				ruleId: DECLARATION_RULE_IDS.journeyRunScenarioExclusive,
				path: journeyPath,
				message: "A health journey must declare exactly one of run or scenario, not both.",
				fix: `Remove either ${journeyPath}.run or ${journeyPath}.scenario.`,
			});
		}
		if (!hasRun && !hasScenario) {
			const journeyPath = healthJourneyPath(journey, index);
			violations.push({
				ruleId: DECLARATION_RULE_IDS.journeyExecutable,
				path: `${journeyPath}.run`,
				message:
					"coversOperations cannot provide health coverage without run or a declarative scenario.",
				fix: `Add an async run(ctx) implementation or a valid scenario to ${journeyPath}.`,
			});
		}
		if (hasScenario) {
			const parsed = HealthScenarioSchema.safeParse(journey.scenario);
			if (!parsed.success) {
				const journeyPath = healthJourneyPath(journey, index);
				violations.push({
					ruleId: DECLARATION_RULE_IDS.journeyScenarioValid,
					path: `${journeyPath}.scenario`,
					message: "scenario must conform to HealthScenario.",
					fix: "Build the scenario with defineHealthScenario().",
				});
			}
		}
	}

	// NOTE: healthCheck.cases[].enabled is intentionally NOT validated here.
	// self-test.ts reports a gated case as status "skipped" with skipReason
	// "disabled", so the skip is visible in results rather than silent — it is a
	// supported conditional-execution feature, not a class-1 silent no-op.
}

function healthJourneyPath(journey: HealthJourneyDefinition, index: number): string {
	return typeof journey.id === "string" && journey.id.length > 0
		? `healthJourneys.${journey.id}`
		: `healthJourneys[${index}]`;
}

function validateSchemaDeclaration(
	provider: OperationDeclarationRulesInput,
	violations: DeclarationViolation[],
): void {
	for (const [operationId, operation] of Object.entries(provider.operations ?? {})) {
		const schemaEntries: Array<[string, unknown]> = [
			[`operations.${operationId}.input`, operation.input],
			[`operations.${operationId}.output`, operation.output],
		];
		// SSE event schemas reach contract extraction the same way input/output do,
		// so a transform-bearing event schema would abort extraction at runtime while
		// passing declaration checks. Validate them under the same rule.
		const transport = operation.transport;
		if (transport?.kind === "sse") {
			for (const [eventName, eventSchema] of Object.entries(transport.events ?? {})) {
				schemaEntries.push([
					`operations.${operationId}.transport.events.${eventName}`,
					eventSchema,
				]);
			}
		}
		for (const [path, schema] of schemaEntries) {
			try {
				describeSchema(schema as Parameters<typeof describeSchema>[0]);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				violations.push({
					ruleId: DECLARATION_RULE_IDS.schemaSerializable,
					path,
					message: `schema conversion to JSON Schema failed: ${reason}`,
					fix: `Replace unsupported constructs in ${path} so z.toJSONSchema() succeeds.`,
				});
			}
		}
	}
}

const MANAGED_PROXY_VENDORS = new Set<ProviderProxyProvider>(["smartproxy", "nodemaven"]);
const STATIC_PROXY_VENDORS = new Set<ProviderProxyProvider>(["custom", "decodo"]);

function validateProxyDeclaration(
	provider: ProviderDeclarationRulesInput,
	violations: DeclarationViolation[],
): void {
	if (provider.proxy === true) {
		violations.push({
			ruleId: DECLARATION_RULE_IDS.proxyExplicitPolicy,
			path: "proxy",
			message: "proxy: true does not require resolvable proxy egress.",
			fix: 'Replace proxy: true with an explicit policy such as proxy: { mode: "required", providers: ["smartproxy"] }.',
		});
		return;
	}
	if (!provider.proxy || typeof provider.proxy !== "object") return;

	const policy = provider.proxy as ProviderProxyPolicy;
	const hasProvider = policy.provider !== undefined;
	const hasProviders = policy.providers !== undefined;
	if (hasProvider && hasProviders) {
		violations.push({
			ruleId: DECLARATION_RULE_IDS.proxyVendorExclusive,
			path: "proxy",
			message: "provider and providers are ambiguous when declared together.",
			fix: "Keep either proxy.provider or proxy.providers, and remove the other field.",
		});
	}

	const vendors = declaredProxyVendors(policy);
	if (
		vendors.some((vendor) => MANAGED_PROXY_VENDORS.has(vendor)) &&
		vendors.some((vendor) => STATIC_PROXY_VENDORS.has(vendor))
	) {
		violations.push({
			ruleId: DECLARATION_RULE_IDS.proxyNoMixedVendors,
			path: hasProviders ? "proxy.providers" : "proxy.provider",
			message: "managed and deprecated static proxy vendors cannot share a chain.",
			fix: "Use only smartproxy/nodemaven vendors, or only deprecated static markers, in one policy.",
		});
	}

	if (vendors.includes("smartproxy")) {
		for (const field of ["subdivision", "city"] as const) {
			if (policy.geo?.[field] === undefined) continue;
			const path = `proxy.geo.${field}`;
			violations.push({
				ruleId: DECLARATION_RULE_IDS.proxySmartproxyGeo,
				path,
				message: `smartproxy cannot honor ${field}-level geo targeting.`,
				fix: `Remove ${path} or use a vendor chain that can honor it.`,
			});
		}
	}
}

function declaredProxyVendors(policy: ProviderProxyPolicy): ProviderProxyProvider[] {
	const vendors = [...(policy.providers ?? [])];
	if (policy.provider !== undefined) vendors.push(policy.provider);
	return vendors;
}

function validateOperationDeclaration(
	provider: OperationDeclarationRulesInput,
	violations: DeclarationViolation[],
): void {
	for (const [operationId, operation] of Object.entries(provider.operations ?? {})) {
		if (!operation.upstream?.proxy) continue;
		const path = `operations.${operationId}.upstream.proxy`;
		violations.push({
			ruleId: DECLARATION_RULE_IDS.operationUpstreamProxy,
			path,
			message: "operation-level proxy policy is not wired into operation execution.",
			fix: `Remove ${path} and declare the effective policy at provider.proxy.`,
		});
	}
}
