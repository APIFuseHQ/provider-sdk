import {
	isProviderError,
	isSessionExpiredError,
	isValidationError,
	ProviderError,
	type ProviderErrorObservability,
	type ProviderErrorOptions,
	SessionExpiredError,
	ValidationError,
} from "../errors.js";
import { z } from "zod";
import { parseSchema } from "../schema.js";
import type { ProviderDefinition } from "../types.js";
import { assertRequiredSecretsPresent } from "./secrets.js";

export function isStreamingOperation(provider: ProviderDefinition, operationId: string): boolean {
	const kind = provider.operations[operationId]?.transport?.kind ?? "json";
	return kind !== "json";
}

function preservedSessionExpiredOptions(error: unknown): ProviderErrorOptions {
	if (!isProviderError(error)) return { retryable: true };
	const optionsDescriptor = Object.getOwnPropertyDescriptor(error, "options");
	if (
		optionsDescriptor === undefined ||
		!Object.hasOwn(optionsDescriptor, "value") ||
		optionsDescriptor.value === null ||
		typeof optionsDescriptor.value !== "object" ||
		Array.isArray(optionsDescriptor.value)
	) {
		return { retryable: true };
	}
	const options = optionsDescriptor.value as object;
	const ownValue = (key: string): unknown => {
		const descriptor = Object.getOwnPropertyDescriptor(options, key);
		return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
	};
	const observabilityCandidate = ownValue("observability");
	if (
		observabilityCandidate === null ||
		typeof observabilityCandidate !== "object" ||
		Array.isArray(observabilityCandidate)
	) {
		return { retryable: true };
	}
	const observabilityObject = observabilityCandidate as object;
	const observabilityValue = (key: keyof ProviderErrorObservability): unknown => {
		const descriptor = Object.getOwnPropertyDescriptor(observabilityObject, key);
		return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
	};
	const reason = observabilityValue("reason");
	const fingerprint = observabilityValue("fingerprint");
	const messageLength = observabilityValue("messageLength");
	const observability: ProviderErrorObservability = {
		...(typeof reason === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(reason) ? { reason } : {}),
		...(typeof fingerprint === "string" && /^[A-Fa-f0-9]{12}$/.test(fingerprint)
			? { fingerprint }
			: {}),
		...(typeof messageLength === "number" &&
		Number.isInteger(messageLength) &&
		messageLength >= 0 &&
		messageLength <= 10_000_000
			? { messageLength }
			: {}),
	};
	return Object.keys(observability).length > 0
		? { observability, retryable: true }
		: { retryable: true };
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
	_options?: { skipAuth?: boolean },
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
		assertRequiredSecretsPresent(provider, "env" in ctx ? ctx.env : { get: () => undefined });
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
		// Use the branded guard, not `instanceof`: a handler loaded through a
		// duplicate/published SDK module can throw a correctly branded
		// SessionExpiredError whose constructor identity differs from this
		// executor's, which `instanceof` would miss — dropping the retryable
		// upgrade and stranding an operation that opted into auth refresh.
		if (isSessionExpiredError(error) && operation.retryOnAuthRefresh) {
			// Preserve provider-authored safe metadata while forcing the retry signal.
			// `cause` intentionally remains dropped, matching the pre-existing
			// reconstruction semantics.
			throw new SessionExpiredError(error.message, preservedSessionExpiredOptions(error));
		}
		throw error;
	}

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
