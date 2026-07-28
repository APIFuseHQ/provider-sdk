export interface StatefulLocalRuntimeContext {
	readonly providerContext?: unknown;
}

export interface StatefulForwardingRuntimeContext {
	readonly operationRequest?: {
		readonly requestId: string;
		readonly connection?: unknown;
		readonly headers?: Record<string, string>;
		readonly trace?: Record<string, string>;
	};
}

export interface StatefulOperationRuntimeContext {
	readonly local?: StatefulLocalRuntimeContext;
	readonly forwarding?: StatefulForwardingRuntimeContext;
}

/**
 * Attaches provider-process-only context for local execution. This value must
 * never be serialized into owner-forwarding envelopes.
 */
export function withStatefulLocalProviderContext(
	providerContext: unknown,
	forwarding?: StatefulForwardingRuntimeContext,
): StatefulOperationRuntimeContext {
	return {
		local: { providerContext },
		...(forwarding ? { forwarding } : {}),
	};
}

/**
 * Copies only operation metadata that is safe to serialize across owner pods.
 */
export function statefulForwardingContextFromProviderRequest(request: {
	readonly requestId: string;
	readonly connection?: unknown;
	readonly headers?: Record<string, string>;
	readonly trace?: Record<string, string>;
}): StatefulForwardingRuntimeContext {
	return {
		operationRequest: {
			requestId: request.requestId,
			...(request.connection !== undefined ? { connection: request.connection } : {}),
			...(request.headers ? { headers: request.headers } : {}),
			...(request.trace ? { trace: request.trace } : {}),
		},
	};
}

export function isStatefulOperationRuntimeContext(
	value: unknown,
): value is StatefulOperationRuntimeContext {
	if (value === null || typeof value !== "object") return false;
	return (
		"local" in value ||
		"forwarding" in value ||
		"operationRequest" in value ||
		"providerContext" in value
	);
}

export function providerContextFromStatefulRuntimeContext(value: unknown): unknown {
	if (!isStatefulOperationRuntimeContext(value)) return undefined;
	if ("local" in value) return value.local?.providerContext;
	// Backward-compatible read for pre-split runtimeContext objects. New code
	// should always use `withStatefulLocalProviderContext` instead.
	if ("providerContext" in value) return value.providerContext;
	return undefined;
}

export function forwardingContextFromStatefulRuntimeContext(
	value: unknown,
): StatefulForwardingRuntimeContext | undefined {
	if (!isStatefulOperationRuntimeContext(value)) return undefined;
	if ("forwarding" in value) return value.forwarding;
	if ("operationRequest" in value) {
		const operationRequest = value.operationRequest;
		if (isForwardingOperationRequest(operationRequest)) {
			return { operationRequest };
		}
	}
	return undefined;
}

function isForwardingOperationRequest(
	value: unknown,
): value is StatefulForwardingRuntimeContext["operationRequest"] {
	if (value === null || typeof value !== "object") return false;
	return "requestId" in value && typeof value.requestId === "string";
}
