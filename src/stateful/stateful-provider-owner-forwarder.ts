import { z } from "zod";
import {
	type OperationConnection,
	OperationErrorResponseSchema,
	OperationSuccessResponseSchema,
} from "../server/index.js";
import type { ProviderServerStatefulForwardEnvelope } from "../server/serve.js";
import { signStatefulRequestBody, statefulSignedHeaders } from "../stateful-signing.js";
import type { SessionKey } from "./session-key.js";
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
		return parseForwardedResponse(response);
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
			connection: metadata.connection,
			headers: sanitizeForwardedHeaders(metadata.headers),
			...(metadata.trace ? { trace: metadata.trace } : {}),
		},
	};
}

function forwardedMetadata(request: StatefulOperationRequest): {
	readonly connection: OperationConnection;
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
	const connection = OperationConnectionSchema.parse(operationRequest?.connection);
	return {
		connection,
		...(operationRequest?.headers ? { headers: operationRequest.headers } : {}),
		...(operationRequest?.trace ? { trace: operationRequest.trace } : {}),
	};
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

async function parseForwardedResponse(response: Response): Promise<StatefulOperationResult> {
	const body = await response.json().catch(() => undefined);
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

const OperationConnectionSchema = z.object({
	id: z.string(),
	mode: z.enum(["oauth2", "credentials", "platform-managed", "none"]),
	secrets: z.record(z.string(), z.string()),
	scopes: z.array(z.string()).optional(),
	metadata: z.record(z.string(), z.unknown()),
	externalRef: z.string(),
});
