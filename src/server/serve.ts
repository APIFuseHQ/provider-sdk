import { createRequire } from "node:module";

import type { Hono } from "hono";
import type { ProviderDefinition } from "../types.js";
import type { OperationRequest } from "./types.js";
import type {
	ProviderServerHandle,
	ProviderServerOptions,
	ServeOptions,
} from "./serve-implementation.js";

export type {
	ErrorObservabilityDetails,
	ProviderServerCloseOptions,
	ProviderServerHandle,
	ProviderServerLogEvent,
	ProviderServerLogger,
	ProviderServerOperationExecutor,
	ProviderServerOperationExecutorInput,
	ProviderServerOptions,
	ProviderServerStatefulForwardEnvelope,
	ProviderServerStatefulOwnerFence,
	ProviderServerStatefulOwnerFenceValidator,
	ServeOptions,
} from "./serve-implementation.js";

type ServeImplementation = typeof import("./serve-implementation.js");

const require = createRequire(import.meta.url);

function loadImplementationSync(): ServeImplementation {
	return require("./serve-implementation.js") as ServeImplementation;
}

export const ERROR_OBSERVABILITY_HEADER = "X-ApiFuse-Error-Observability";

// This schema is not part of the package export map, but retaining the direct
// module binding avoids breaking internal consumers while keeping the server
// implementation out of the import-only path.
export const ProviderServerStatefulForwardEnvelopeSchema = new Proxy(
	{},
	{
		get(_target, property) {
			const schema = loadImplementationSync().ProviderServerStatefulForwardEnvelopeSchema;
			return Reflect.get(schema, property, schema);
		},
		getPrototypeOf() {
			return Reflect.getPrototypeOf(
				loadImplementationSync().ProviderServerStatefulForwardEnvelopeSchema,
			);
		},
	},
) as ServeImplementation["ProviderServerStatefulForwardEnvelopeSchema"];

export function resolveProviderProxyAffinityKey(
	provider: ProviderDefinition,
	request: OperationRequest,
	operationId: string,
): string {
	const connectionKey =
		request.connection?.id ?? request.connectionId ?? request.connection?.externalRef;
	const affinity =
		typeof provider.proxy === "object" ? provider.proxy.session?.affinity : undefined;
	if (affinity === "operation") {
		return `${provider.id}/${operationId}`;
	}
	return connectionKey ?? provider.id;
}

export function resolveProviderResolverIdentityScope(
	provider: ProviderDefinition,
	affinityKey: string,
	contextId: string,
): string {
	return JSON.stringify({
		proxy: provider.proxy ?? null,
		affinityKey,
		contextId,
	});
}

export function createServerApp(
	provider: ProviderDefinition,
	options: ProviderServerOptions = {},
): Hono {
	return loadImplementationSync().createServerApp(provider, options);
}

export async function serve(
	provider: ProviderDefinition,
	options: ServeOptions = {},
): Promise<ProviderServerHandle> {
	const implementation = await import("./serve-implementation.js");
	return implementation.serve(provider, options);
}
