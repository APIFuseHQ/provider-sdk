import { z } from "zod";

import { statefulSignedHeaders } from "../stateful-signing.js";
import { StatefulControlPlaneError, type StatefulControlPlaneOperation } from "./errors.js";
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
};

const OwnerRecordSchema = z.object({
	sessionKey: z.string().min(1),
	ownerPodId: z.string().min(1),
	ownerEndpoint: z.string().min(1),
	generation: z.number().int().nonnegative(),
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

export class HttpSessionOwnerRegistry implements SessionOwnerRegistry {
	readonly #baseUrl: string;
	readonly #secret: string;
	readonly #scope?: SessionOwnerScope;
	readonly #fetch: FetchTransport;
	readonly #clock: () => Date;

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
	}

	async resolve(
		sessionKey: StatefulProviderSessionKey,
		now?: Date,
	): Promise<SessionOwnerRecord | null> {
		const response = await this.#post("resolve", {
			...this.#scope,
			sessionKey,
			...(now ? { now: now.toISOString() } : {}),
		});
		if (response.status === 404) return null;
		return this.#parse(response, "resolve", ResolveResponseSchema);
	}

	async acquire(input: AcquireSessionOwnerInput): Promise<AcquireSessionOwnerResult> {
		const response = await this.#post("acquire", {
			...this.#scope,
			...input,
			...(input.now ? { now: input.now.toISOString() } : {}),
		});
		return this.#parse(response, "acquire", AcquireResponseSchema);
	}

	async renew(input: RenewSessionOwnerInput): Promise<SessionOwnerRecord | null> {
		const response = await this.#post("renew", {
			...this.#scope,
			...input,
			...(input.now ? { now: input.now.toISOString() } : {}),
		});
		return this.#parse(response, "renew", RenewResponseSchema);
	}

	async release(input: ReleaseSessionOwnerInput): Promise<boolean> {
		const response = await this.#post("release", {
			...this.#scope,
			...input,
		});
		return this.#parse(response, "release", ReleaseResponseSchema);
	}

	async #post(operation: StatefulControlPlaneOperation, body: unknown): Promise<Response> {
		const rawBody = JSON.stringify(body);
		const timestamp = this.#clock().toISOString();
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
			});
		} catch (cause) {
			throw new StatefulControlPlaneError({
				code: "STATEFUL_CONTROL_PLANE_REQUEST_FAILED",
				message: `Stateful control-plane ${operation} request failed.`,
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
