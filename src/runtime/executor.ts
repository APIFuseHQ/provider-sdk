import {
	isValidationError,
	ProviderError,
	ValidationError,
} from "../errors.js";
import { z } from "zod";
import { parseSchema } from "../schema.js";
import type { EnvContext, ProviderDefinition } from "../types.js";
import { assertRequiredSecretsPresent } from "./secrets.js";

export function isStreamingOperation(provider: ProviderDefinition, operationId: string): boolean {
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
export async function executeOperation<
	const TProvider extends ProviderDefinition,
	const TOperationId extends keyof TProvider["operations"] & string,
>(
	provider: TProvider,
	operationId: TOperationId,
	ctx: NoInfer<Parameters<TProvider["operations"][TOperationId]["handler"]>[0]>,
	input: unknown,
	_options?: { skipAuth?: boolean; env?: EnvContext },
): Promise<unknown> {
	const operation = provider.operations[operationId];

	if (!operation) {
		throw new ProviderError(`Unknown operation: ${provider.id}/${operationId}`, {
			code: "NOT_FOUND",
			fix: `Valid operations: ${Object.keys(provider.operations).join(", ")}`,
		});
	}

	// SDK-owned secret presence gate (single source of truth): declared
	// `required: true` secrets are validated here, before input parsing and the
	// handler, so every invocation path (serve /v1, self-test probes, perf,
	// record) fails with the same structured MISSING_SECRET error instead of a
	// handler-specific crash. Providers must not re-check presence locally.
	if (provider.secrets?.some((secret) => secret.required === true)) {
		assertRequiredSecretsPresent(
			provider,
			_options?.env ?? ("env" in ctx ? ctx.env : { get: () => undefined }),
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

	const result: unknown = await execute();

	if (isStreamingOperation(provider, operationId)) {
		return result;
	}

	try {
		return await parseSchema(operation.output, result, `operations.${operationId}.output`);
	} catch (cause) {
		if (!(cause instanceof z.ZodError) && !isValidationError(cause)) {
			throw cause;
		}
		throw new ValidationError(`Operation handler output failed schema validation.`, {
			code: "OUTPUT_VALIDATION_FAILED",
			category: "output_validation",
			retryable: false,
			zodError: isValidationError(cause) ? cause.zodError : cause,
			...(cause instanceof Error ? { cause } : {}),
		});
	}
}
