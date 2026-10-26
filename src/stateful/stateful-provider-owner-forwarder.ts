import { z } from "zod";
import {
	type OperationConnection,
	OperationErrorResponseSchema,
	OperationSuccessResponseSchema,
} from "../server/index.js";
import type { ProviderServerStatefulForwardEnvelope } from "../server/serve.js";
import { signStatefulRequestBody, statefulSignedHeaders } from "../stateful-signing.js";
import type { SessionKey } from "./session-key.js";
import type { StatefulForwardingRuntimeContext } from "./stateful-provider-runtime-context.js";
import type {
	StatefulOperationRequest,
	StatefulOperationResult,
	StatefulOwnerForwarder,
} from "./stateful-provider-session-routing.js";
import { forwardingContextFromStatefulRuntimeContext } from "./stateful-provider-session-routing.js";
import type {
	SessionOwnerRecord,
	SessionOwnerRegistry,
} from "./stateful-provider-session-runtime.js";

export const STATEFUL_INTERNAL_OPERATIONS_ROUTE = "/__apifuse/stateful/operations";
export const STATEFUL_FORWARDING_SIGNATURE_HEADER = "x-apifuse-stateful-signature";
export const STATEFUL_FORWARDING_TIMESTAMP_HEADER = "x-apifuse-stateful-timestamp";
export const STATEFUL_FORWARDING_NONCE_HEADER = "x-apifuse-stateful-nonce";
export const STATEFUL_FORWARDING_SOURCE_POD_HEADER = "x-apifuse-stateful-source-pod";

export interface StatefulOwnerForwarderOptions {
	readonly currentPodId: string;
	readonly secret: string;
	readonly fetch?: FetchTransport;
	readonly clock?: () => Date;
}

type FetchTransport = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

const MAX_FORWARDED_HEADERS = 32;
const MAX_FORWARDED_HEADER_BYTES = 8 * 1024;
// Inbound compatibility boundary for rolling deploys: older owner pods omit
// top-level retryable. Emitted responses remain strict via
// OperationErrorResponseSchema.
const ForwardedOperationErrorResponseSchema = OperationErrorResponseSchema.extend({
	error: OperationErrorResponseSchema.shape.error.extend({
		retryable: z.boolean().optional().default(false),
	}),
});
const SENSITIVE_HEADER_NAMES = new Set([
	"authorization",
	"cookie",
	"set-cookie",
	STATEFUL_FORWARDING_SIGNATURE_HEADER,
	STATEFUL_FORWARDING_TIMESTAMP_HEADER,
	STATEFUL_FORWARDING_NONCE_HEADER,
	STATEFUL_FORWARDING_SOURCE_POD_HEADER,
]);

/** Builds the standard fail-closed owner-currentness check for serve(). */
export function createStatefulOwnerFenceValidator(registry: SessionOwnerRegistry) {
	return async (
		fence: Pick<ProviderServerStatefulForwardEnvelope, "sessionKey" | "ownerPodId" | "generation">,
		signal: AbortSignal,
	): Promise<boolean> => {
		const current = await registry.resolve(fence.sessionKey as SessionKey, undefined, signal);
		return (
			current !== null &&
			current.sessionKey === fence.sessionKey &&
			current.ownerPodId === fence.ownerPodId &&
			current.generation === fence.generation
		);
	};
}

export class StatefulOwnerForwardingError extends Error {
	readonly code: string;
	readonly status?: number;

	constructor(input: {
		readonly code: string;
		readonly message: string;
		readonly status?: number;
		readonly cause?: unknown;
	}) {
		super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
		this.name = "StatefulOwnerForwardingError";
		this.code = input.code;
		this.status = input.status;
	}
}

export class HttpStatefulOwnerForwarder implements StatefulOwnerForwarder {
	readonly #currentPodId: string;
	readonly #secret: string;
	readonly #fetch: FetchTransport;
	readonly #clock: () => Date;

	constructor(options: StatefulOwnerForwarderOptions) {
		if (options.secret.trim().length === 0) {
			throw new Error("Stateful owner forwarding secret is required.");
		}
		this.#currentPodId = options.currentPodId;
		this.#secret = options.secret;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#clock = options.clock ?? (() => new Date());
	}

	async forward(
		owner: SessionOwnerRecord,
		request: StatefulOperationRequest,
		signal: AbortSignal,
	): Promise<StatefulOperationResult> {
		assertNoRequestScopedFiles(request.input);
		const forwardedAt = this.#clock().toISOString();
		const envelope = buildForwardingEnvelope({
			owner,
			request,
			sourcePodId: this.#currentPodId,
			forwardedAt,
		});
		const rawBody = JSON.stringify(envelope);
		let response: Response;
		try {
			const target = new URL(
				`${owner.ownerEndpoint.replace(/\/+$/, "")}${STATEFUL_INTERNAL_OPERATIONS_ROUTE}`,
			);
			response = await this.#fetch(target, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...statefulSignedHeaders({
						secret: this.#secret,
						timestamp: forwardedAt,
						rawBody,
						method: "POST",
						path: STATEFUL_INTERNAL_OPERATIONS_ROUTE,
					}),
					[STATEFUL_FORWARDING_SOURCE_POD_HEADER]: this.#currentPodId,
				},
				body: rawBody,
				signal,
			});
		} catch (cause) {
			throw new StatefulOwnerForwardingError({
				code: "STATEFUL_FORWARDING_REQUEST_FAILED",
				message: "Stateful owner forwarding request failed before a response was received.",
				cause,
			});
		}
		return parseForwardedResponse(response, signal);
	}
}

export function signStatefulForwardingBody(input: {
	readonly secret: string;
	readonly timestamp: string;
	readonly rawBody: string;
	readonly method: string;
	readonly path: string;
	readonly nonce: string;
}): string {
	return signStatefulRequestBody(input);
}

function assertNoRequestScopedFiles(input: unknown): void {
	if (!containsRequestScopedFile(input)) return;
	throw new StatefulOwnerForwardingError({
		code: "STATEFUL_FILE_FORWARDING_UNSUPPORTED",
		message:
			"Request-scoped files cannot be forwarded to a remote stateful owner. Use staged upload once available so the forwarding envelope carries only durable file_ref values, or route the request to the owner-local provider process.",
	});
}

function containsRequestScopedFile(value: unknown): boolean {
	if (isRequestScopedFileRef(value)) return true;
	if (Array.isArray(value)) return value.some((item) => containsRequestScopedFile(item));
	if (!value || typeof value !== "object") return false;
	return Object.values(value).some((item) => containsRequestScopedFile(item));
}

function isRequestScopedFileRef(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = Object.fromEntries(Object.entries(value));
	return record.type === "request_file" && typeof record.id === "string";
}

function buildForwardingEnvelope(input: {
	readonly owner: SessionOwnerRecord;
	readonly request: StatefulOperationRequest;
	readonly sourcePodId: string;
	readonly forwardedAt: string;
}): ProviderServerStatefulForwardEnvelope {
	const metadata = forwardedMetadata(input.request);
	return {
		requestId: input.request.requestId,
		providerId: input.request.providerId,
		operationId: input.request.operationId,
		sessionKey: input.request.sessionKey,
		connectionId: input.request.connectionId,
		serviceAccountId: input.request.serviceAccountId,
		...(input.request.idempotencyKey ? { idempotencyKey: input.request.idempotencyKey } : {}),
		...(input.request.deadlineAt !== undefined ? { deadlineAt: input.request.deadlineAt } : {}),
		sourcePodId: input.sourcePodId,
		forwardedAt: input.forwardedAt,
		ownerPodId: input.owner.ownerPodId,
		generation: input.owner.generation,
		operationRequest: {
			requestId: input.request.requestId,
			input: input.request.input as Record<string, unknown>,
			...(metadata.connection !== undefined ? { connection: metadata.connection } : {}),
			...(metadata.tenantId ? { tenantId: metadata.tenantId } : {}),
			headers: sanitizeForwardedHeaders(metadata.headers),
			...(metadata.trace ? { trace: metadata.trace } : {}),
		},
	};
}

function forwardedMetadata(request: StatefulOperationRequest): {
	readonly connection?: OperationConnection;
	readonly tenantId?: string;
	readonly headers?: Record<string, string>;
	readonly trace?: Record<string, string>;
} {
	const forwardingContext = forwardingContextFromStatefulRuntimeContext(request.runtimeContext);
	if (!forwardingContext) {
		throw new StatefulOwnerForwardingError({
			code: "STATEFUL_FORWARDING_CONTEXT_MISSING",
			message: "Stateful operation forwarding requires request context metadata.",
		});
	}
	const operationRequest = forwardingContext.operationRequest;
	if (!isForwardedOperationRequest(operationRequest)) {
		throw new StatefulOwnerForwardingError({
			code: "STATEFUL_FORWARDING_CONTEXT_MISSING",
			message:
				"Stateful operation forwarding requires the request context's operationRequest; only its connection may be absent.",
		});
	}
	const connection = forwardedConnection(operationRequest.connection);
	const tenantId = forwardedTenantId(operationRequest.tenantId);
	return {
		...(connection !== undefined ? { connection } : {}),
		...(tenantId !== undefined ? { tenantId } : {}),
		...(operationRequest.headers ? { headers: operationRequest.headers } : {}),
		...(operationRequest.trace ? { trace: operationRequest.trace } : {}),
	};
}

/**
 * `forwarding.operationRequest` is optional in the consumer-facing type, so a
 * type-valid `{ forwarding: {} }` reaches here. It is the request context
 * itself, not one optional field of it: forwarding without it would send the
 * operation stripped of its connection, tenant scope, headers and trace. Only
 * the `connection` inside it may be absent (a connectionless operation), so
 * a missing or non-object `operationRequest` fails at the source like a
 * missing forwarding context.
 */
function isForwardedOperationRequest(
	value: StatefulForwardingRuntimeContext["operationRequest"] | null,
): value is NonNullable<StatefulForwardingRuntimeContext["operationRequest"]> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The connection is optional on both sides of the hop, exactly like the owner's
 * received `operationRequest.connection`: an operation declared with
 * `auth.mode: "none"` reaches the source pod without one, and the owner must
 * execute it without one. Absent stays absent; the envelope never carries a
 * synthesized placeholder. A placeholder would key the owner's proxy affinity
 * by its id or `externalRef` (an empty `externalRef` keys it under `""`, which
 * is not an affinity scope), while an absent connection gets the fallback a
 * direct call without a connection gets: the provider id, or the provider and
 * operation ids under operation affinity. A connection that is present is
 * forwarded exactly as before.
 */
function forwardedConnection(value: unknown): OperationConnection | undefined {
	if (value === undefined) return undefined;
	return OperationConnectionSchema.parse(value);
}

/**
 * The runtime context is consumer-supplied and typed `unknown`, and only its
 * `requestId` is guarded on read. A malformed principal scope must fail at the
 * source with a forwarding error — the owner would otherwise reject the whole
 * forwarded operation, and dropping it silently would downgrade a per-principal
 * policy to the shared scope. `""` is not a principal (same rule as ids on the
 * ingress envelope), so it is absent rather than invalid.
 */
function forwardedTenantId(value: unknown): string | undefined {
	if (value === undefined || value === "") return undefined;
	if (typeof value !== "string") {
		throw new StatefulOwnerForwardingError({
			code: "STATEFUL_FORWARDING_CONTEXT_INVALID",
			message: "Stateful operation forwarding requires a string tenantId when it is present.",
		});
	}
	return value;
}

function sanitizeForwardedHeaders(
	headers: Record<string, string> | undefined,
): Record<string, string> {
	if (!headers) return {};
	const forwarded: Record<string, string> = {};
	let totalBytes = 0;
	for (const [name, value] of Object.entries(headers)) {
		const normalized = name.toLowerCase();
		if (SENSITIVE_HEADER_NAMES.has(normalized)) continue;
		const nextBytes = Buffer.byteLength(name) + Buffer.byteLength(value);
		if (
			Object.keys(forwarded).length >= MAX_FORWARDED_HEADERS ||
			totalBytes + nextBytes > MAX_FORWARDED_HEADER_BYTES
		) {
			break;
		}
		forwarded[name] = value;
		totalBytes += nextBytes;
	}
	return forwarded;
}

async function parseForwardedResponse(
	response: Response,
	signal: AbortSignal,
): Promise<StatefulOperationResult> {
	const body = await readForwardedResponseBody(response, signal);
	const success = OperationSuccessResponseSchema.safeParse(body);
	if (response.ok && success.success) {
		return { output: success.data.data };
	}

	const error = ForwardedOperationErrorResponseSchema.safeParse(body);
	if (error.success) {
		throw new StatefulOwnerForwardingError({
			code: error.data.error.code,
			message: error.data.error.message,
			status: response.status,
		});
	}

	throw new StatefulOwnerForwardingError({
		code: "STATEFUL_FORWARDING_BAD_RESPONSE",
		message: `Stateful owner returned an invalid response with status ${response.status}.`,
		status: response.status,
	});
}

/**
 * The forwarding signal can abort after the owner's response headers arrived
 * and before its body was read, for example when the owner answers at the
 * same instant the source's deadline timer fires. The body read then fails
 * and the response cannot be parsed, but the owner did not answer badly: the
 * forwarding request was cancelled. It fails like a request the signal
 * aborted before the response, `STATEFUL_FORWARDING_REQUEST_FAILED` with the
 * signal's reason as its cause, so a deadline that cancelled it is still
 * recognized as the deadline. A body that cannot be read or parsed while the
 * signal is live stays a bad response.
 */
async function readForwardedResponseBody(
	response: Response,
	signal: AbortSignal,
): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		if (!signal.aborted) return undefined;
		throw new StatefulOwnerForwardingError({
			code: "STATEFUL_FORWARDING_REQUEST_FAILED",
			message: "Stateful owner forwarding request was cancelled before the response was read.",
			status: response.status,
			cause: signal.reason,
		});
	}
}

const OperationConnectionSchema = z.object({
	id: z.string(),
	mode: z.enum(["oauth2", "credentials", "platform-managed", "none"]),
	secrets: z.record(z.string(), z.string()),
	scopes: z.array(z.string()).optional(),
	metadata: z.record(z.string(), z.unknown()),
	externalRef: z.string(),
});
