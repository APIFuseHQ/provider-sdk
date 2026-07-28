import { z } from "zod";

import { statefulSignedHeaders } from "../stateful-signing.js";
import { StatefulControlPlaneError, type StatefulControlPlaneOperation } from "./errors.js";
import { parseSessionKey, type SessionKey } from "./session-key.js";
import type {
	AcquireSessionOwnerInput,
	AcquireSessionOwnerResult,
	ReleaseSessionOwnerInput,
	RenewSessionOwnerInput,
	SessionOwnerRecord,
	SessionOwnerRegistry,
	StatefulProviderSessionKey,
} from "./stateful-provider-session-runtime.js";

type FetchTransport = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type SessionOwnerScope = {
	readonly serviceAccountId: string;
	readonly providerId: string;
	readonly connectionId?: string;
};

export type HttpSessionOwnerRegistryOptions = {
	readonly baseUrl: string;
	readonly secret: string;
	readonly scope?: SessionOwnerScope;
	readonly fetch?: FetchTransport;
	readonly clock?: () => Date;
	readonly requestTimeoutMs?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A mutating registry request failed after it may have reached the control plane. Callers must
 * resolve the session owner and reconcile instead of blindly retrying the mutation.
 */
export class AmbiguousRegistryOperationError extends StatefulControlPlaneError {
	readonly ambiguous = true;

	constructor(input: {
		readonly operation: Exclude<StatefulControlPlaneOperation, "resolve">;
		readonly message: string;
		readonly cause: unknown;
	}) {
		super({
			code: "STATEFUL_CONTROL_PLANE_OPERATION_AMBIGUOUS",
			message: input.message,
			operation: input.operation,
			cause: input.cause,
		});
		this.name = "AmbiguousRegistryOperationError";
	}
}

const SessionKeySchema = z
	.string()
	.min(1)
	.transform((value, context): SessionKey => {
		try {
			parseSessionKey(value);
			return value as SessionKey;
		} catch (error) {
			context.addIssue({
				code: "custom",
				message: error instanceof Error ? error.message : "Invalid canonical session key.",
			});
			return z.NEVER;
		}
	});

const OwnerRecordSchema = z.object({
	sessionKey: SessionKeySchema,
	ownerPodId: z.string().min(1),
	ownerEndpoint: z.string().min(1),
	generation: z.number().int().positive(),
	leaseExpiresAt: z.string().refine(isTimestamp),
	status: z.enum(["acquiring", "connected", "draining", "expired"]),
	lastUsedAt: z.string().refine(isTimestamp),
});

const AcquireResultSchema = z.object({
	record: OwnerRecordSchema,
	acquired: z.boolean(),
});

const ResolveResponseSchema = z.union([
	OwnerRecordSchema,
	z.object({ record: OwnerRecordSchema }).transform((value) => value.record),
	z.object({ data: OwnerRecordSchema }).transform((value) => value.data),
]);

const AcquireResponseSchema = z.union([
	AcquireResultSchema,
	z.object({ data: AcquireResultSchema }).transform((value) => value.data),
]);

const RenewResponseSchema = z.union([
	OwnerRecordSchema.nullable(),
	z.object({ record: OwnerRecordSchema.nullable() }).transform((value) => value.record),
	z.object({ data: OwnerRecordSchema.nullable() }).transform((value) => value.data),
]);

const ReleaseResponseSchema = z.union([
	z.boolean(),
	z.object({ released: z.boolean() }).transform((value) => value.released),
	z.object({ data: z.boolean() }).transform((value) => value.data),
]);

export type HttpSessionOwnerRecord = Omit<SessionOwnerRecord, "sessionKey"> & {
	readonly sessionKey: SessionKey;
};

export type HttpAcquireSessionOwnerResult = Omit<AcquireSessionOwnerResult, "record"> & {
	readonly record: HttpSessionOwnerRecord;
};

export class HttpSessionOwnerRegistry implements SessionOwnerRegistry {
	readonly #baseUrl: string;
	readonly #secret: string;
	readonly #scope?: SessionOwnerScope;
	readonly #fetch: FetchTransport;
	readonly #clock: () => Date;
	readonly #requestTimeoutMs: number;

	constructor(options: HttpSessionOwnerRegistryOptions) {
		if (options.baseUrl.trim().length === 0) {
			throw new Error("Stateful control-plane baseUrl is required.");
		}
		if (options.secret.trim().length === 0) {
			throw new Error("Stateful control-plane secret is required.");
		}
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#secret = options.secret;
		this.#scope = options.scope;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#clock = options.clock ?? (() => new Date());
		this.#requestTimeoutMs = positiveInteger(
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			"requestTimeoutMs",
		);
	}

	async resolve(
		sessionKey: StatefulProviderSessionKey,
		now?: Date,
		signal?: AbortSignal,
	): Promise<HttpSessionOwnerRecord | null> {
		const response = await this.#post(
			"resolve",
			{
				...this.#scope,
				sessionKey,
				...(now ? { now: now.toISOString() } : {}),
			},
			signal,
		);
		if (response.status === 404) return null;
		return this.#parse(response, "resolve", ResolveResponseSchema);
	}

	async acquire(
		input: AcquireSessionOwnerInput,
		signal?: AbortSignal,
	): Promise<HttpAcquireSessionOwnerResult> {
		const response = await this.#post(
			"acquire",
			{
				...this.#scope,
				...input,
				...(input.now ? { now: input.now.toISOString() } : {}),
			},
			signal,
		);
		return this.#parse(response, "acquire", AcquireResponseSchema);
	}

	async renew(
		input: RenewSessionOwnerInput,
		signal?: AbortSignal,
	): Promise<HttpSessionOwnerRecord | null> {
		const response = await this.#post(
			"renew",
			{
				...this.#scope,
				...input,
				...(input.now ? { now: input.now.toISOString() } : {}),
			},
			signal,
		);
		return this.#parse(response, "renew", RenewResponseSchema);
	}

	async release(input: ReleaseSessionOwnerInput, signal?: AbortSignal): Promise<boolean> {
		const response = await this.#post(
			"release",
			{
				...this.#scope,
				...input,
			},
			signal,
		);
		return this.#parse(response, "release", ReleaseResponseSchema);
	}

	async #post(
		operation: StatefulControlPlaneOperation,
		body: unknown,
		callerSignal?: AbortSignal,
	): Promise<Response> {
		const rawBody = JSON.stringify(body);
		const timestamp = this.#clock().toISOString();
		const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
		const signal = AbortSignal.any(callerSignal ? [callerSignal, timeoutSignal] : [timeoutSignal]);
		try {
			return await this.#fetch(`${this.#baseUrl}/v1/stateful/sessions/owners/${operation}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...statefulSignedHeaders({
						secret: this.#secret,
						timestamp,
						rawBody,
					}),
				},
				body: rawBody,
				signal,
			});
		} catch (cause) {
			const timedOut = timeoutSignal.aborted && !callerSignal?.aborted;
			if (operation !== "resolve") {
				throw new AmbiguousRegistryOperationError({
					operation,
					message: timedOut
						? `Stateful control-plane ${operation} timed out after ${this.#requestTimeoutMs}ms; resolve the session owner and reconcile before retrying.`
						: `Stateful control-plane ${operation} request failed after it may have committed; resolve the session owner and reconcile before retrying.`,
					cause,
				});
			}
			throw new StatefulControlPlaneError({
				code: "STATEFUL_CONTROL_PLANE_REQUEST_FAILED",
				message: timedOut
					? `Stateful control-plane resolve timed out after ${this.#requestTimeoutMs}ms; retry resolve or check control-plane availability.`
					: "Stateful control-plane resolve request failed.",
				operation,
				cause,
			});
		}
	}

	async #parse<T>(
		response: Response,
		operation: StatefulControlPlaneOperation,
		schema: z.ZodType<T>,
	): Promise<T> {
		if (!response.ok) {
			throw new StatefulControlPlaneError({
				code: "STATEFUL_CONTROL_PLANE_HTTP_ERROR",
				message: `Stateful control-plane ${operation} returned status ${response.status}.`,
				operation,
				status: response.status,
			});
		}
		const rawBody = await response.text();
		let body: unknown;
		try {
			body = JSON.parse(rawBody);
		} catch (cause) {
			throw invalidResponse(operation, response.status, cause);
		}
		const parsed = schema.safeParse(body);
		if (!parsed.success) {
			throw invalidResponse(operation, response.status, parsed.error);
		}
		return parsed.data;
	}
}

function invalidResponse(
	operation: StatefulControlPlaneOperation,
	status: number,
	cause: unknown,
): StatefulControlPlaneError {
	return new StatefulControlPlaneError({
		code: "STATEFUL_CONTROL_PLANE_INVALID_RESPONSE",
		message: `Stateful control-plane ${operation} returned an invalid response.`,
		operation,
		status,
		cause,
	});
}

function isTimestamp(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`Stateful control-plane ${name} must be a positive integer.`);
	}
	return value;
}
