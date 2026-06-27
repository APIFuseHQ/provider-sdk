import { createHash } from "node:crypto";
import {
	canonicalJson,
	compactObject,
	copyRecordWithout,
	type JsonPrimitive,
	type JsonValue,
	toJsonValue,
} from "./contract-json";
import { describeSchema, serializeSmsMatcher } from "./contract-serialization";
import {
	PROVIDER_CONTRACT_SCHEMA_VERSION,
	type ProviderContractOperation,
	type ProviderContractSnapshot,
} from "./contract-types";
import type {
	HealthCheckSuite,
	HealthCheckUnsupported,
	HealthJourneyDefinition,
	OperationDefinition,
	OperationTransport,
	ProviderDefinition,
} from "./types";

export {
	canonicalJson,
	type JsonPrimitive,
	type JsonValue,
	PROVIDER_CONTRACT_SCHEMA_VERSION,
	type ProviderContractOperation,
	type ProviderContractSnapshot,
};

export function extractProviderContract(
	provider: ProviderDefinition,
): ProviderContractSnapshot {
	const auth = extractAuth(provider.auth);
	const stealth = toJsonValue(provider.stealth);
	const proxy = toJsonValue(provider.proxy);
	const stt = toJsonValue(provider.stt);
	const browser = toJsonValue(provider.browser);
	const reviewed = toJsonValue(provider.reviewed);
	const access = toJsonValue(provider.access);
	const secrets = toJsonValue(provider.secrets);
	const credential = toJsonValue(provider.credential);
	const context = toJsonValue(provider.context);
	const healthMonitor = toJsonValue(provider.healthMonitor);
	const healthJourneys = provider.healthJourneys?.map(extractHealthJourney);

	return {
		schemaVersion: PROVIDER_CONTRACT_SCHEMA_VERSION,
		provider: {
			id: provider.id,
			version: provider.version,
			runtime: provider.runtime,
		},
		meta: toJsonValue(provider.meta) ?? null,
		operations: Object.entries(provider.operations)
			.sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
			.map(([operationId, operation]) =>
				extractOperation(operationId, operation),
			),
		...(provider.allowedHosts
			? { allowedHosts: [...provider.allowedHosts].sort() }
			: {}),
		...(stealth === undefined ? {} : { stealth }),
		...(proxy === undefined ? {} : { proxy }),
		...(stt === undefined ? {} : { stt }),
		...(browser === undefined ? {} : { browser }),
		...(auth === undefined ? {} : { auth }),
		...(reviewed === undefined ? {} : { reviewed }),
		...(access === undefined ? {} : { access }),
		...(secrets === undefined ? {} : { secrets }),
		...(credential === undefined ? {} : { credential }),
		...(context === undefined ? {} : { context }),
		...(healthMonitor === undefined ? {} : { healthMonitor }),
		...(healthJourneys === undefined ? {} : { healthJourneys }),
	};
}

export function digestProviderContract(
	snapshot: ProviderContractSnapshot,
): string {
	return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

function extractOperation(
	operationId: string,
	operation: OperationDefinition,
): ProviderContractOperation {
	const descriptionKey = toJsonValue(operation.descriptionKey);
	const docs = toJsonValue(operation.docs);
	const whenToUseKeys = toJsonValue(operation.whenToUseKeys);
	const whenNotToUseKeys = toJsonValue(operation.whenNotToUseKeys);
	const derivations = toJsonValue(operation.derivations);
	const inputExamples = toJsonValue(operation.inputExamples);
	const annotations = toJsonValue(operation.annotations);
	const contract = toJsonValue(operation.contract);
	const tags = toJsonValue(operation.tags);
	const relatedOperations = toJsonValue(operation.relatedOperations);
	const toolRouter = toJsonValue(operation.toolRouter);
	const observability = toJsonValue(operation.observability);
	const transport = extractTransport(operation.transport);
	const fixtures = toJsonValue(operation.fixtures);
	const upstream = toJsonValue(operation.upstream);
	const hints = toJsonValue(operation.hints);
	const healthCheck = extractHealthCheck(operation.healthCheck);
	const healthCheckUnsupported = extractHealthCheckUnsupported(
		operation.healthCheckUnsupported,
	);

	return {
		id: operationId,
		inputSchema: describeSchema(operation.input),
		outputSchema: describeSchema(operation.output),
		...(descriptionKey === undefined ? {} : { descriptionKey }),
		...(docs === undefined ? {} : { docs }),
		...(whenToUseKeys === undefined ? {} : { whenToUseKeys }),
		...(whenNotToUseKeys === undefined ? {} : { whenNotToUseKeys }),
		...(derivations === undefined ? {} : { derivations }),
		...(inputExamples === undefined ? {} : { inputExamples }),
		...(annotations === undefined ? {} : { annotations }),
		...(contract === undefined ? {} : { contract }),
		...(tags === undefined ? {} : { tags }),
		...(relatedOperations === undefined ? {} : { relatedOperations }),
		...(toolRouter === undefined ? {} : { toolRouter }),
		...(observability === undefined ? {} : { observability }),
		...(transport === undefined ? {} : { transport }),
		...(fixtures === undefined ? {} : { fixtures }),
		...(upstream === undefined ? {} : { upstream }),
		...(hints === undefined ? {} : { hints }),
		...(healthCheck === undefined ? {} : { healthCheck }),
		...(healthCheckUnsupported === undefined ? {} : { healthCheckUnsupported }),
	};
}

function extractAuth(value: ProviderDefinition["auth"]): JsonValue | undefined {
	if (!value) return undefined;
	return compactObject({
		mode: value.mode,
		flow: value.flow
			? compactObject({
					start: true,
					continue: true,
					poll: value.flow.poll === undefined ? undefined : true,
					abort: value.flow.abort === undefined ? undefined : true,
				})
			: undefined,
	});
}

function extractTransport(
	value: OperationTransport | undefined,
): JsonValue | undefined {
	if (!value) return undefined;
	if (value.kind !== "sse") return toJsonValue(value);
	return compactObject({
		...copyRecordWithout(value, new Set(["events"])),
		events: Object.fromEntries(
			Object.entries(value.events)
				.sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
				.map(([eventName, schema]) => [eventName, describeSchema(schema)]),
		),
	});
}

function extractHealthCheck(
	value: HealthCheckSuite | undefined,
): JsonValue | undefined {
	if (!value) return undefined;
	return compactObject({
		interval: value.interval,
		timeoutMs: value.timeoutMs,
		degradedThresholdMs: value.degradedThresholdMs,
		requiresConnection: value.requiresConnection,
		cases: value.cases.map((item) =>
			compactObject({
				name: item.name,
				description: item.description,
				input: toJsonValue(item.input),
				degradedThresholdMs: item.degradedThresholdMs,
				timeoutMs: item.timeoutMs,
				expectedStatus: item.expectedStatus,
			}),
		),
	});
}

function extractHealthCheckUnsupported(
	value: HealthCheckUnsupported | undefined,
): JsonValue | undefined {
	return toJsonValue(value);
}

function extractHealthJourney(value: HealthJourneyDefinition): JsonValue {
	return compactObject({
		id: value.id,
		title: value.title,
		description: value.description,
		schedule: toJsonValue(value.schedule),
		coversOperations: toJsonValue(value.coversOperations),
		timeout: value.timeout,
		cooldown: value.cooldown,
		smsMatchers: toJsonValue(
			value.smsMatchers?.map((matcher) =>
				serializeSmsMatcher(
					copyRecordWithout(matcher, new Set(["extractOtp"])),
				),
			),
		),
		requiredSecrets: toJsonValue(value.requiredSecrets),
		manualTrigger: toJsonValue(value.manualTrigger),
		steps: toJsonValue(value.steps),
	});
}
