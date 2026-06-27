import { ProviderError, SessionExpiredError } from "../errors";
import { parseSchema } from "../schema";
import type { ProviderContext, ProviderDefinition } from "../types";

export function isStreamingOperation(
	provider: ProviderDefinition,
	operationId: string,
): boolean {
	const kind = provider.operations[operationId]?.transport?.kind ?? "json";
	return kind !== "json";
}

/**
 * Execute a provider operation by calling its handler.
 *
 * SDK auto-wraps every handler call with:
 * 1. Input Zod validation
 * 2. Auth auto-refresh (if auth configured)
 * 3. Trace span
 * 4. Output Zod validation
 *
 * @see openspec/provider-sdk/03-sdk-core.md §3.6
 */
export async function executeOperation(
	provider: ProviderDefinition,
	operationId: string,
	ctx: ProviderContext,
	input: unknown,
	_options?: { skipAuth?: boolean },
): Promise<unknown> {
	const operation = provider.operations[operationId];

	if (!operation) {
		throw new ProviderError(
			`Unknown operation: ${provider.id}/${operationId}`,
			{
				code: "NOT_FOUND",
				fix: `Valid operations: ${Object.keys(provider.operations).join(", ")}`,
			},
		);
	}

	const validatedInput = await parseSchema(
		operation.input,
		input,
		`operations.${operationId}.input`,
	);

	const execute = () =>
		ctx.trace.span(`handler:${operationId}`, () =>
			Promise.resolve(operation.handler(ctx, validatedInput)),
		);

	let result: unknown;
	try {
		result = await execute();
	} catch (error) {
		// Session expiry is renewed by Credential Service via the /auth/refresh
		// route, NOT in-process here: this executor cannot mutate ctx.credential,
		// so an in-process retry would just repeat the call with the same stale
		// credential (and risk repeating partial side-effects). Instead we surface
		// the expiry so Credential Service refreshes and re-drives the operation
		// with a fresh credential. `retryOnAuthRefresh` declares that this
		// operation is safe to re-drive after refresh, which we signal by marking
		// the surfaced error retryable; non-idempotent operations (the default)
		// stay non-retryable so they are not auto-re-driven. See design.md §4.3 D3.
		if (error instanceof SessionExpiredError && operation.retryOnAuthRefresh) {
			throw new SessionExpiredError(error.message, { retryable: true });
		}
		throw error;
	}

	if (isStreamingOperation(provider, operationId)) {
		return result;
	}

	return parseSchema(
		operation.output,
		result,
		`operations.${operationId}.output`,
	);
}
