import type { JsonValue } from "./contract-json";
import type { ProviderDefinition } from "./types";

export const PROVIDER_CONTRACT_SCHEMA_VERSION = "2026-06-23";

export interface ProviderContractSnapshot {
	readonly schemaVersion: typeof PROVIDER_CONTRACT_SCHEMA_VERSION;
	readonly provider: {
		readonly id: string;
		readonly version: string;
		readonly runtime: ProviderDefinition["runtime"];
	};
	readonly allowedHosts?: readonly string[];
	readonly native?: JsonValue;
	readonly stealth?: JsonValue;
	readonly proxy?: JsonValue;
	readonly stt?: JsonValue;
	readonly browser?: JsonValue;
	readonly auth?: JsonValue;
	readonly reviewed?: JsonValue;
	readonly access?: JsonValue;
	readonly secrets?: JsonValue;
	readonly credential?: JsonValue;
	readonly context?: JsonValue;
	readonly meta: JsonValue;
	readonly healthMonitor?: JsonValue;
	readonly healthJourneys?: readonly JsonValue[];
	readonly operations: readonly ProviderContractOperation[];
}

export interface ProviderContractOperation {
	readonly id: string;
	readonly descriptionKey?: JsonValue;
	readonly docs?: JsonValue;
	readonly whenToUseKeys?: JsonValue;
	readonly whenNotToUseKeys?: JsonValue;
	readonly derivations?: JsonValue;
	readonly inputExamples?: JsonValue;
	readonly annotations?: JsonValue;
	readonly contract?: JsonValue;
	readonly tags?: JsonValue;
	readonly relatedOperations?: JsonValue;
	readonly toolRouter?: JsonValue;
	readonly observability?: JsonValue;
	readonly transport?: JsonValue;
	readonly inputSchema: JsonValue;
	readonly outputSchema: JsonValue;
	readonly fixtures?: JsonValue;
	readonly upstream?: JsonValue;
	readonly hints?: JsonValue;
	readonly healthCheck?: JsonValue;
	readonly healthCheckUnsupported?: JsonValue;
}
