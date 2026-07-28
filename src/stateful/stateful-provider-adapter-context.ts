import type { StatefulProviderSessionContext } from "./stateful-provider-adapter.js";
import type { StatefulOperationRequest } from "./stateful-provider-session-routing.js";
import type { ManagedSession, SessionOwnerRecord } from "./stateful-provider-session-runtime.js";

export function makeStatefulProviderSessionContext(
	providerId: string,
	owner: SessionOwnerRecord,
	request: StatefulOperationRequest,
	signal: AbortSignal,
): StatefulProviderSessionContext {
	const ctx: StatefulProviderSessionContext = {
		sessionKey: owner.sessionKey,
		providerId,
		connectionId: request.connectionId,
		serviceAccountId: request.serviceAccountId,
		ownerPodId: owner.ownerPodId,
		ownerEndpoint: owner.ownerEndpoint,
		ownerStatus: owner.status,
		generation: owner.generation,
		signal,
		requestId: request.requestId,
		operationId: request.operationId,
		...(request.runtimeContext !== undefined ? { runtimeContext: request.runtimeContext } : {}),
	};
	return withOptionalRequestMetadata(ctx, request);
}

export function makeStatefulProviderCloseContext<TSession>(
	providerId: string,
	session: ManagedSession<TSession>,
): StatefulProviderSessionContext {
	const identity = session.identity;
	return {
		sessionKey: session.sessionKey,
		providerId,
		...(identity
			? {
					connectionId: identity.connectionId,
					serviceAccountId: identity.serviceAccountId,
					ownerPodId: identity.ownerPodId,
					ownerEndpoint: identity.ownerEndpoint,
					ownerStatus: identity.ownerStatus,
				}
			: {}),
		generation: session.generation,
		signal: new AbortController().signal,
	};
}

function withOptionalRequestMetadata(
	ctx: StatefulProviderSessionContext,
	request: StatefulOperationRequest,
): StatefulProviderSessionContext {
	return {
		...ctx,
		...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
		...(request.deadlineAt ? { deadlineAt: request.deadlineAt } : {}),
	};
}
