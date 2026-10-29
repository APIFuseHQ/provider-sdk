import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createServer, Socket } from "node:net";
import { z } from "zod";

import { defineErrors } from "../define-errors.js";
import {
	ProviderError,
	type ProviderErrorOptions,
	ProviderSecretError,
	TransportError,
	ValidationError,
} from "../errors.js";
import { HandleError } from "../handle.js";
import {
	type ErrorObservabilityDetails,
	PLATFORM_FAULT_CATEGORIES,
	PROVIDER_FAILURE_CATEGORIES,
	PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
} from "../observability.js";
import { executeOperation } from "../runtime/executor.js";
import {
	createNativeNetworkClient,
	createNativeNetworkConnection,
	NativeProxyExpiredError,
} from "../runtime/native-network.js";
import {
	createProxyPoolExhaustedError,
	PROXY_POOL_EXHAUSTED_CODE,
	PROXY_POOL_EXHAUSTED_MESSAGE,
} from "../runtime/proxy-errors.js";
import { SMARTPROXY_PASSWORD_ENV, SMARTPROXY_USERNAME_ENV } from "../runtime/proxy-smartproxy.js";
import { CLIENT_CANCELLED_STATUS } from "../server/client-cancelled.js";
import {
	createServerApp,
	ERROR_OBSERVABILITY_HEADER,
	type ProviderServerLogEvent,
} from "../server/serve.js";
import {
	buildSessionKey,
	buildStatefulOperationRequest,
	createStatefulOwnerFenceValidator,
	HttpStatefulOwnerForwarder,
	InMemorySessionOwnerRegistry,
	type SessionKey,
	type StatefulOperationExecutor,
	StatefulProviderRuntimeExecutor,
	statefulForwardingContextFromProviderRequest,
	withStatefulLocalProviderContext,
} from "../stateful/index.js";
import type { OperationDefinition, ProviderContext, ProviderDefinition } from "../types.js";
import {
	GATEWAY_ACCEPTED_ORIGIN_HEADERS,
	GATEWAY_REJECTED_ORIGIN_HEADERS,
} from "./fixtures/gateway-error-observability-origin.js";
import { event } from "../stream.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

// A platform fault (an error outcome APIFuse reports as its own, origin
// `platform`) comes only from what the SDK observed itself: an error object it
// issued as one, the served request's own signal, or a throw it cannot read and
// masks. Nothing provider code sets on an error, not a category option, a public
// class, a code string or a look-alike, produces one. This file serves both
// kinds through real servers and reads the `X-ApiFuse-Error-Observability`
// header, the body, the status and the failure log they produce.
//
// The assembly: provider apps built by createServerApp, the SDK's transports
// (ctx.http, the native network client, a native connection with a sticky
// proxy) doing the failing work, and for the stateful path a real owner pod
// (signed forwarding, the SDK's owner-fence validator, executeOperation) and a
// real source pod (StatefulProviderRuntimeExecutor with the SDK's
// HttpStatefulOwnerForwarder), each on its own local listener and called by a
// real HTTP client. The header values are checked against the ones the
// Gateway's origin pair test reads (fixtures/gateway-error-observability-origin).

const PROVIDER_ID = "platform-fault-origin";
const FORWARDING_SECRET = "platform-fault-origin-secret";
const DEADLINE_CODE = "STATEFUL_FORWARDING_DEADLINE_EXPIRED";
const DECLARED_CODE = "DECLARED_FAILURE";
const UNDECLARED_CODE = "UNDECLARED_FAILURE";

// The served header as the origin-tagged contract: a category is accepted only
// together with the origin whose set it belongs to.
const ObservabilityFields = {
	taxonomyVersion: z.literal(PROVIDER_OBSERVABILITY_TAXONOMY_VERSION),
	retryable: z.boolean(),
	upstreamStatus: z.number().optional(),
};
const ServedObservabilitySchema: z.ZodType<ErrorObservabilityDetails> = z.union([
	z.object({
		origin: z.literal("platform"),
		category: z.enum(PLATFORM_FAULT_CATEGORIES),
		...ObservabilityFields,
	}),
	z.object({
		origin: z.literal("provider"),
		category: z.enum(PROVIDER_FAILURE_CATEGORIES),
		...ObservabilityFields,
		providerObservability: z
			.object({
				reason: z.string().optional(),
				fingerprint: z.string().optional(),
				messageLength: z.number().optional(),
			})
			.optional(),
	}),
]);

const ServedBodySchema = z.object({
	error: z
		.object({
			code: z.string(),
			message: z.string(),
			requestId: z.string().optional(),
			retryable: z.boolean(),
			source: z.string(),
			details: z.unknown().optional(),
		})
		.passthrough(),
});

type Served = {
	readonly status: number;
	readonly header: string;
	readonly observability: ErrorObservabilityDetails;
	readonly body: z.infer<typeof ServedBodySchema>;
};

async function readServed(response: Response): Promise<Served> {
	const header = response.headers.get(ERROR_OBSERVABILITY_HEADER);
	if (header === null) throw new Error(`${ERROR_OBSERVABILITY_HEADER} is missing`);
	return {
		status: response.status,
		header,
		observability: ServedObservabilitySchema.parse(JSON.parse(header)),
		body: ServedBodySchema.parse(await response.json()),
	};
}

function outcome(served: Served | undefined) {
	return {
		status: served?.status,
		origin: served?.observability.origin,
		category: served?.observability.category,
		retryable: served?.observability.retryable,
		code: served?.body.error.code,
		source: served?.body.error.source,
	};
}

function failureLog(events: readonly ProviderServerLogEvent[], requestId: string) {
	const failed = events.find(
		(event) => event.event === "provider_request_failed" && event.requestId === requestId,
	);
	if (failed?.event !== "provider_request_failed") {
		throw new Error(`no provider_request_failed for ${requestId}`);
	}
	return failed;
}

// The upstream: /hold never answers.
const upstream = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(): Promise<Response> {
		return new Promise<Response>(() => {});
	},
});
const upstreamOrigin = `http://127.0.0.1:${upstream.port}`;

// A local TCP peer for the native connection whose sticky proxy expires.
const tcpPeer = createServer((socket) => {
	socket.on("error", () => undefined);
});
await new Promise<void>((resolve) => tcpPeer.listen(0, "127.0.0.1", resolve));
const tcpPeerAddress = tcpPeer.address();
if (tcpPeerAddress === null || typeof tcpPeerAddress === "string") {
	throw new Error("tcp peer has no port");
}
const tcpPeerPort = tcpPeerAddress.port;

async function connectedSocket(): Promise<Socket> {
	const socket = new Socket();
	await new Promise<void>((resolve, reject) => {
		socket.once("error", reject);
		socket.connect({ host: "127.0.0.1", port: tcpPeerPort }, () => resolve());
	});
	return socket;
}

const CategoryInput = z.object({ category: z.unknown(), declared: z.boolean() });

const output = z.object({ ok: z.boolean() });

function operation(
	handler: (ctx: ProviderContext, input: unknown) => Promise<{ ok: boolean }>,
	extra: Partial<OperationDefinition> = {},
): OperationDefinition {
	return {
		riskClass: "read",
		input: z.object({}).passthrough(),
		output,
		upstream: { baseUrl: upstreamOrigin },
		handler,
		...extra,
	};
}

// A code declared under a platform word. This SDK's types and defineErrors
// reject one, but an SDK copy whose defineErrors still took every category
// (the release before this one) made such declarations, and serve recognizes
// a factory-made error from another copy by the cross-copy declaration brand.
// The error is built the way that copy built it; serve reads the platform
// word as no value, like the category option.
const DECLARED_PLATFORM_WORD_CODE = "DECLARED_PLATFORM_WORD";

function thrownUnderPlatformWordDeclaration(): ProviderError {
	const description = "A provider failure declared under a platform word.";
	const error = new ProviderError(description, { code: DECLARED_PLATFORM_WORD_CODE });
	Object.defineProperty(error, Symbol.for("@apifuse/provider-sdk/error-declaration@1"), {
		value: {
			code: DECLARED_PLATFORM_WORD_CODE,
			status: 502,
			category: "internal_error",
			retryable: false,
			description,
		},
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return error;
}

// The serve request whose ctx.http call aborts the inbound request first.
let inboundToAbort: AbortController | undefined;

const provider: ProviderDefinition = createProviderDefinitionDouble({
	id: PROVIDER_ID,
	http: {},
	operations: {
		succeeds: operation(async () => ({ ok: true })),
		// The provider's `category` option carries a value outside the
		// provider-failure words: a platform word through a cast or from
		// JavaScript, or not a string at all. Read from JSON, as a JavaScript
		// provider would hand it over.
		"category-option": operation(
			async (_ctx, input) => {
				const { category, declared } = CategoryInput.parse(input);
				const options: ProviderErrorOptions = JSON.parse(
					JSON.stringify({
						code: declared ? DECLARED_CODE : UNDECLARED_CODE,
						category,
						retryable: false,
					}),
				);
				throw new ProviderError("The provider failed.", options);
			},
			{
				input: CategoryInput,
				errorCodes: [
					{
						code: DECLARED_CODE,
						status: 502,
						retryable: false,
						description: "A declared provider failure.",
					},
				],
			},
		),
		"declared-platform-category": operation(async () => {
			throw thrownUnderPlatformWordDeclaration();
		}),
		// Public classes and SDK codes, constructed by the provider.
		"provider-handle-error": operation(async () => {
			throw new HandleError("HANDLE_STORAGE_UNAVAILABLE", "Handle storage is down.");
		}),
		"provider-native-proxy-expired": operation(async () => {
			throw new NativeProxyExpiredError(new Date().toISOString());
		}),
		"provider-missing-secret": operation(async () => {
			throw new ProviderSecretError("The provider's own key is missing.", {
				code: "MISSING_SECRET",
				category: "credential_unavailable",
				retryable: false,
			});
		}),
		"provider-deadline-code": operation(async () => {
			throw new ProviderError("The provider gave up.", { code: DEADLINE_CODE });
		}),
		"provider-client-cancelled-code": operation(async () => {
			throw new ProviderError("The provider stopped.", { code: "client_cancelled" });
		}),
		"provider-proxy-pool-exhausted": operation(async () => {
			throw new TransportError(PROXY_POOL_EXHAUSTED_MESSAGE, { code: PROXY_POOL_EXHAUSTED_CODE });
		}),
		"provider-output-validation-code": operation(async () => {
			throw new ValidationError("Operation handler output failed schema validation.", {
				code: "OUTPUT_VALIDATION_FAILED",
			});
		}),
		"provider-upstream-http": operation(async () => {
			throw new ProviderError("upstream failed", {
				code: "UPSTREAM_FAILED",
				category: "upstream_http",
				retryable: false,
			});
		}),
		"provider-credential-unavailable": operation(async () => {
			throw new ProviderError("credential missing", {
				code: "CREDENTIAL_MISSING",
				category: "credential_unavailable",
				retryable: false,
			});
		}),
		// Platform faults.
		"sdk-proxy-pool-exhausted": operation(async () => {
			// What ctx.stealth throws once the vendor edge refused every session
			// the attempt budget allowed.
			throw createProxyPoolExhaustedError();
		}),
		"invalid-output": operation(async () => JSON.parse('{"ok":"not a boolean"}')),
		"plain-error": operation(async () => {
			throw new Error("boom");
		}),
		"caller-leaves": operation(async (ctx) => {
			inboundToAbort?.abort();
			await ctx.http.get("/hold", { retry: false });
			return { ok: true };
		}),
		// A stream the caller stops reading after its first event; the SDK
		// terminalizes it as its own client_cancelled.
		"caller-stops-reading": {
			riskClass: "read",
			input: z.object({}).passthrough(),
			output,
			transport: { kind: "sse", events: { delta: z.object({ value: z.string() }) } },
			async *handler() {
				yield event("delta", { value: "first" });
				await new Promise<void>(() => undefined);
			},
		},
		"native-proxy-invalid": operation(async () => {
			// A native client whose gateway synthesizer allocates an endpoint
			// URL the client cannot tunnel through.
			const client = createNativeNetworkClient({
				proxyPolicy: { mode: "required", providers: ["nodemaven"] },
				credentials: () => ({ kind: "present", values: {} }),
				gatewaySynthesizers: [
					() => ({ url: "socks5://127.0.0.1:0", vendor: "nodemaven", sticky: false }),
				],
			});
			await client.connectTcp({ host: "127.0.0.1", port: tcpPeerPort });
			return { ok: true };
		}),
		"native-proxy-expired": operation(async () => {
			const connection = createNativeNetworkConnection(
				await connectedSocket(),
				{
					url: "http://sticky.invalid:8080",
					vendor: "nodemaven",
					sticky: true,
					expiresAt: new Date(Date.now() + 30).toISOString(),
				},
				{
					proxyPolicy: { mode: "required", session: { drainLeadSeconds: 0 } },
					warn: () => undefined,
				},
			);
			await Bun.sleep(120);
			await connection.read();
			return { ok: true };
		}),
	},
});

// Required proxy egress with no vendor credentials: the SDK's proxy
// resolution fails before any request goes out.
const proxyRequiredProvider = createProviderDefinitionDouble({
	id: "platform-fault-proxy-required",
	http: {},
	native: { network: { tcp: [{ host: "127.0.0.1", ports: [9], tls: "disabled" }] } },
	proxy: { mode: "required", providers: ["smartproxy"] },
	operations: {
		http: operation(async (ctx) => {
			await ctx.http.get("/");
			return { ok: true };
		}),
		native: operation(async (ctx) => {
			await ctx.native.network.connectTcp({ host: "127.0.0.1", port: 9 });
			return { ok: true };
		}),
	},
});

const SECRET_ENV = "APIFUSE__PROVIDER__PLATFORM_FAULT_SECRET__UPSTREAM_KEY";
const secretProvider = createProviderDefinitionDouble({
	id: "platform-fault-secret",
	secrets: [{ name: SECRET_ENV, required: true, description: "Upstream key" }],
	operations: { succeeds: operation(async () => ({ ok: true })) },
});

const events: ProviderServerLogEvent[] = [];
const app = createServerApp(provider, { logger: (event) => events.push(event) });

async function call(
	operationId: string,
	requestId: string,
	input: Record<string, unknown> = {},
	signal?: AbortSignal,
): Promise<Served> {
	const response = await app.request(`/v1/${operationId}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId, input }),
		...(signal ? { signal } : {}),
	});
	return readServed(response);
}

const SMARTPROXY_ENV_NAMES = [SMARTPROXY_USERNAME_ENV, SMARTPROXY_PASSWORD_ENV] as const;
const originalSmartproxyEnv = SMARTPROXY_ENV_NAMES.map(
	(name) => [name, process.env[name]] as const,
);
const originalSecret = process.env[SECRET_ENV];

afterEach(() => {
	inboundToAbort = undefined;
	for (const [name, value] of originalSmartproxyEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	if (originalSecret === undefined) delete process.env[SECRET_ENV];
	else process.env[SECRET_ENV] = originalSecret;
});

// The words a provider cannot report: every platform fault category that is
// not also a provider failure.
const PLATFORM_ONLY_WORDS = PLATFORM_FAULT_CATEGORIES.filter(
	(word) => !(PROVIDER_FAILURE_CATEGORIES as readonly string[]).includes(word),
);

describe("a provider's category option outside the provider-failure words", () => {
	for (const category of [...PLATFORM_ONLY_WORDS, "not_a_category", 7, true]) {
		it(`reads ${JSON.stringify(category)} as no value and signals it`, async () => {
			const requestId = `category-${String(category)}`;
			const served = await call("category-option", requestId, { category, declared: true });

			// Classified as if the provider had set none: the declared 502 of an
			// unregistered code derives provider_error.
			expect(outcome(served)).toEqual({
				status: 502,
				origin: "provider",
				category: "provider_error",
				retryable: false,
				code: DECLARED_CODE,
				source: "apifuse",
			});
			expect(failureLog(events, requestId)).toMatchObject({
				status: 502,
				code: DECLARED_CODE,
				errorCategory: "provider_error",
				errorOrigin: "provider",
				signal: "unknown_provider_error_category",
			});
		});
	}

	it("keeps the unregistered code signal when that applies too", async () => {
		const served = await call("category-option", "category-undeclared", {
			category: "internal_error",
			declared: false,
		});

		expect(outcome(served)).toEqual({
			status: 500,
			origin: "provider",
			category: "provider_error",
			retryable: false,
			code: UNDECLARED_CODE,
			source: "apifuse",
		});
		expect(failureLog(events, "category-undeclared")).toMatchObject({
			errorOrigin: "provider",
			signal: "unregistered_provider_error_code",
		});
	});

	it("never produces a header the Gateway rejects as a provider reporting a platform word", async () => {
		for (const category of ["internal_error", "dependency_unavailable"]) {
			const served = await call("category-option", `category-gateway-${category}`, {
				category,
				declared: true,
			});
			for (const rejected of Object.values(GATEWAY_REJECTED_ORIGIN_HEADERS)) {
				expect(JSON.parse(served.header)).not.toEqual(JSON.parse(rejected));
			}
		}
	});
});

describe("a declaration's category outside the provider-failure words", () => {
	it("rejects a platform word in this SDK's defineErrors at definition", () => {
		expect(() =>
			defineErrors({
				DECLARED_PLATFORM_WORD: {
					status: 502,
					category:
						"internal_error" as never /* test-invalid: the type rejects a platform word; the runtime check is under test */,
					description: "A provider failure declared under a platform word.",
				},
			}),
		).toThrow(/declares the platform-fault category internal_error/);
	});

	it("reads a platform word another SDK copy declared as no value and signals it", async () => {
		const requestId = "category-declared-platform-word";
		const served = await call("declared-platform-category", requestId);

		// Classified as if the declaration named no category: the declared 502
		// of an unregistered code derives provider_error.
		expect(outcome(served)).toEqual({
			status: 502,
			origin: "provider",
			category: "provider_error",
			retryable: false,
			code: DECLARED_PLATFORM_WORD_CODE,
			source: "apifuse",
		});
		expect(failureLog(events, requestId)).toMatchObject({
			status: 502,
			code: DECLARED_PLATFORM_WORD_CODE,
			errorCategory: "provider_error",
			errorOrigin: "provider",
			signal: "unknown_provider_error_category",
		});
	});
});

describe("public classes and SDK codes a provider constructs itself", () => {
	it("serves a HandleError with a runtime handle code as the provider's failure", async () => {
		const served = await call("provider-handle-error", "provider-handle");
		expect(outcome(served)).toEqual({
			status: 500,
			origin: "provider",
			category: "provider_error",
			retryable: false,
			code: "HANDLE_STORAGE_UNAVAILABLE",
			source: "apifuse",
		});
	});

	it("serves a NativeProxyExpiredError as the provider's transport failure, not the proxy pool's", async () => {
		const served = await call("provider-native-proxy-expired", "provider-native-proxy-expired");
		expect(outcome(served)).toEqual({
			status: 502,
			origin: "provider",
			category: "upstream_http",
			retryable: true,
			code: "native_proxy_expired",
			source: "upstream_failure",
		});
	});

	it("serves a provider-thrown MISSING_SECRET as the provider's credential_unavailable", async () => {
		const served = await call("provider-missing-secret", "provider-missing-secret");
		expect(outcome(served)).toEqual({
			status: 400,
			origin: "provider",
			category: "credential_unavailable",
			retryable: false,
			code: "MISSING_SECRET",
			source: "apifuse",
		});
	});

	it("serves STATEFUL_FORWARDING_DEADLINE_EXPIRED thrown by the provider as its own failure", async () => {
		const served = await call("provider-deadline-code", "provider-deadline-code");
		expect(outcome(served)).toEqual({
			status: 500,
			origin: "provider",
			category: "provider_error",
			retryable: false,
			code: DEADLINE_CODE,
			source: "apifuse",
		});
	});

	it("serves a ProviderError the provider built with the code client_cancelled as its own failure", async () => {
		const served = await call("provider-client-cancelled-code", "provider-client-cancelled-code");
		expect(outcome(served)).toEqual({
			status: 500,
			origin: "provider",
			category: "provider_error",
			retryable: false,
			code: "client_cancelled",
			source: "apifuse",
		});
		expect(failureLog(events, "provider-client-cancelled-code")).toMatchObject({
			errorOrigin: "provider",
			signal: "unregistered_provider_error_code",
		});
	});

	it("serves a TransportError with PROXY_POOL_EXHAUSTED thrown by the provider as an upstream failure", async () => {
		const served = await call("provider-proxy-pool-exhausted", "provider-proxy-pool-exhausted");
		expect(outcome(served)).toEqual({
			status: 502,
			origin: "provider",
			category: "upstream_http",
			retryable: true,
			code: PROXY_POOL_EXHAUSTED_CODE,
			source: "upstream_failure",
		});
		// The SDK's own exhausted pool, from the factory ctx.stealth throws.
		const sdk = await call("sdk-proxy-pool-exhausted", "sdk-proxy-pool-exhausted");
		expect(outcome(sdk)).toEqual({
			status: 502,
			origin: "platform",
			category: "proxy_pool",
			retryable: true,
			code: PROXY_POOL_EXHAUSTED_CODE,
			source: "apifuse",
		});
	});

	it("pins a ValidationError carrying OUTPUT_VALIDATION_FAILED to the provider's 400 input_validation", async () => {
		const served = await call("provider-output-validation-code", "provider-output-lookalike");
		expect(outcome(served)).toEqual({
			status: 400,
			origin: "provider",
			category: "input_validation",
			retryable: false,
			code: "OUTPUT_VALIDATION_FAILED",
			source: "client",
		});
		// The SDK's own output check, on the same app.
		const sdk = await call("invalid-output", "sdk-output-validation");
		expect(outcome(sdk)).toEqual({
			status: 500,
			origin: "platform",
			category: "output_validation",
			retryable: false,
			code: "OUTPUT_VALIDATION_FAILED",
			source: "apifuse",
		});
	});
});

describe("platform faults the SDK observed itself", () => {
	it("serves a throw it cannot read as the platform's masked internal_error", async () => {
		const served = await call("plain-error", "plain-error");
		expect(outcome(served)).toEqual({
			status: 500,
			origin: "platform",
			category: "internal_error",
			retryable: false,
			code: "internal_error",
			source: "apifuse",
		});
		expect(failureLog(events, "plain-error")).toMatchObject({
			errorCategory: "internal_error",
			errorOrigin: "platform",
		});
		expect(failureLog(events, "plain-error")).not.toHaveProperty("signal");
	});

	it("serves ctx.http's cancellation after the caller left as the platform's client_cancelled", async () => {
		inboundToAbort = new AbortController();
		const served = await call("caller-leaves", "caller-leaves", {}, inboundToAbort.signal);
		expect(outcome(served)).toEqual({
			status: CLIENT_CANCELLED_STATUS,
			origin: "platform",
			category: "client_cancelled",
			retryable: false,
			code: "transport_cancelled",
			source: "client",
		});
	});

	it("terminalizes a stream the caller stops reading as the platform's client_cancelled", async () => {
		const requestId = "caller-stops-reading";
		const response = await app.request("/v1/caller-stops-reading", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId, input: {} }),
		});
		const reader = response.body?.getReader();
		expect((await reader?.read())?.done).toBe(false);
		await reader?.cancel("consumer stopped");

		// The SDK issues the cancellation with its fault record and no
		// declaration: the log reads the platform fault, and no deprecated
		// per-throw option or unregistered code is reported for it.
		const log = failureLog(events, requestId);
		expect(log).toMatchObject({
			status: CLIENT_CANCELLED_STATUS,
			code: "client_cancelled",
			errorCategory: "client_cancelled",
			errorOrigin: "platform",
			retryable: false,
		});
		expect(log).not.toHaveProperty("signal");
		expect(
			events.filter(
				(entry) =>
					entry.event === "provider_error_options_deprecated" && entry.code === "client_cancelled",
			),
		).toEqual([]);
	});

	it("serves the native client's unusable proxy endpoint as the proxy pool's fault", async () => {
		const served = await call("native-proxy-invalid", "native-proxy-invalid");
		expect(outcome(served)).toEqual({
			status: 502,
			origin: "platform",
			category: "proxy_pool",
			retryable: true,
			code: "native_proxy_invalid",
			source: "apifuse",
		});
	});

	it("serves a native connection closed at its sticky proxy's expiry as the proxy pool's fault", async () => {
		const served = await call("native-proxy-expired", "native-proxy-expired");
		expect(outcome(served)).toEqual({
			status: 502,
			origin: "platform",
			category: "proxy_pool",
			retryable: true,
			code: "native_proxy_expired",
			source: "apifuse",
		});
	});

	it("serves required proxy egress without credentials as the proxy pool's fault on ctx.http and ctx.native", async () => {
		for (const name of SMARTPROXY_ENV_NAMES) delete process.env[name];
		const proxyApp = createServerApp(proxyRequiredProvider, { logger: () => undefined });
		const served: Record<string, Served> = {};
		for (const transport of ["http", "native"] as const) {
			served[transport] = await readServed(
				await proxyApp.request(`/v1/${transport}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ requestId: `proxy-required-${transport}`, input: {} }),
				}),
			);
		}
		// ctx.http wraps the resolver's failure in its transport error.
		expect(outcome(served.http)).toEqual({
			status: 502,
			origin: "platform",
			category: "proxy_pool",
			retryable: true,
			code: "transport_network_error",
			source: "apifuse",
		});
		// ctx.native throws the resolver's failure itself: served masked.
		expect(outcome(served.native)).toEqual({
			status: 500,
			origin: "platform",
			category: "proxy_pool",
			retryable: true,
			code: "internal_error",
			source: "apifuse",
		});
		expect(JSON.parse(served.native?.header ?? "null")).toEqual(
			JSON.parse(GATEWAY_ACCEPTED_ORIGIN_HEADERS["runtime: PROXY_REQUIRED code"]),
		);
	});

	it("serves the required-secret gate as the platform's credential_unavailable", async () => {
		delete process.env[SECRET_ENV];
		const secretApp = createServerApp(secretProvider, { logger: () => undefined });
		const served = await readServed(
			await secretApp.request("/v1/succeeds", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "secret-gate", input: {} }),
			}),
		);
		expect(outcome(served)).toEqual({
			status: 400,
			origin: "platform",
			category: "credential_unavailable",
			retryable: false,
			code: "MISSING_SECRET",
			source: "apifuse",
		});
		expect(JSON.parse(served.header)).toEqual(
			JSON.parse(
				GATEWAY_ACCEPTED_ORIGIN_HEADERS['provider sets credential_unavailable, origin "platform"'],
			),
		);
	});
});

describe("the header the Gateway's origin pair test reads", () => {
	it("is what the SDK writes for the same failures", async () => {
		const served = {
			"runtime: plain Error thrown": await call("plain-error", "gateway-plain-error"),
			"runtime: output fails its schema": await call("invalid-output", "gateway-invalid-output"),
			"provider sets upstream_http": await call("provider-upstream-http", "gateway-upstream-http"),
			'provider sets credential_unavailable, origin "provider"': await call(
				"provider-credential-unavailable",
				"gateway-credential-unavailable",
			),
		};
		for (const [name, response] of Object.entries(served)) {
			const expected = Object.entries(GATEWAY_ACCEPTED_ORIGIN_HEADERS).find(
				([fixture]) => fixture === name,
			)?.[1];
			expect({ name, header: JSON.parse(response.header) }).toEqual({
				name,
				header: JSON.parse(expected ?? "null"),
			});
		}
	});
});

// Stateful forwarding: the source pod relays the owner pod's answer.

type Recorded = Map<string, Served>;

function errorRequestId(body: unknown): string {
	const parsed = z.object({ error: z.object({ requestId: z.string() }) }).safeParse(body);
	return parsed.success ? parsed.data.error.requestId : "";
}

// Serves `fetchApp` on a real listener and records the error response it built
// for each request id.
function recordingListener(fetchApp: (request: Request) => Response | Promise<Response>) {
	const served: Recorded = new Map();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request): Promise<Response> {
			const response = await fetchApp(request);
			if (response.status >= 400) {
				const copy = response.clone();
				const body: unknown = await copy.clone().json();
				served.set(errorRequestId(body), await readServed(copy));
			}
			return response;
		},
	});
	return { server, served, endpoint: `http://127.0.0.1:${server.port}` };
}

const ownerEvents: ProviderServerLogEvent[] = [];
const ownerRegistry = new InMemorySessionOwnerRegistry();
const ownerApp = createServerApp(provider, {
	logger: (event) => ownerEvents.push(event),
	statefulForwarding: {
		secret: FORWARDING_SECRET,
		validateOwnerFence: createStatefulOwnerFenceValidator(ownerRegistry),
	},
	internalOperationExecutor: ({ provider: servedProvider, operationId, ctx, request }) =>
		executeOperation(servedProvider, operationId, ctx, request.input),
});
const ownerPod = recordingListener((request) => ownerApp.fetch(request));

// An owner pod on an SDK released before the origin tag, or one answering with
// a header this pod cannot read: each forwarded request id names its answer.
const DEADLINE_BODY = (requestId: string) =>
	JSON.stringify({
		error: {
			code: DEADLINE_CODE,
			message: "Stateful forwarding deadline expired.",
			requestId,
			retryable: false,
			source: "apifuse",
		},
	});
const OLD_OWNER_ANSWERS: Record<string, { status: number; header?: string }> = {
	// The shape an owner writes before the origin tag.
	"old-owner-deadline": {
		status: 504,
		header: `{"category":"stateful_forwarding_deadline","taxonomyVersion":"2026-10-23","retryable":false}`,
	},
	// The same deadline from an owner whose taxonomy still called it timeout.
	"old-owner-timeout-word": {
		status: 504,
		header: `{"category":"timeout","taxonomyVersion":"2026-08-07","retryable":false}`,
	},
	// An owner from before the header.
	"old-owner-no-header": { status: 504 },
	// A tagged answer: the provider on the owner pod threw the deadline code.
	"tagged-provider-deadline-code": {
		status: 500,
		header: `{"category":"provider_error","origin":"provider","retryable":false,"taxonomyVersion":"2026-10-23"}`,
	},
	"unreadable-header": { status: 504, header: "not json" },
};
const EnvelopeRequestId = z.object({ requestId: z.string() });
const oldOwner = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request): Promise<Response> {
		const { requestId } = EnvelopeRequestId.parse(await request.json());
		const answer = OLD_OWNER_ANSWERS[requestId];
		if (!answer) return new Response("unknown request", { status: 404 });
		return new Response(DEADLINE_BODY(requestId), {
			status: answer.status,
			headers: {
				"content-type": "application/json",
				...(answer.header ? { [ERROR_OBSERVABILITY_HEADER]: answer.header } : {}),
			},
		});
	},
});

const liveSession = buildSessionKey({
	providerId: PROVIDER_ID,
	serviceAccountId: "account-1",
	connectionId: "connection-live",
});
const oldOwnerSession = buildSessionKey({
	providerId: PROVIDER_ID,
	serviceAccountId: "account-1",
	connectionId: "connection-old-owner",
});
await ownerRegistry.acquire({
	sessionKey: liveSession,
	ownerPodId: "pod-owner",
	ownerEndpoint: ownerPod.endpoint,
	leaseDurationMs: 60_000,
});
const oldOwnerRegistry = new InMemorySessionOwnerRegistry();
await oldOwnerRegistry.acquire({
	sessionKey: oldOwnerSession,
	ownerPodId: "pod-old-owner",
	ownerEndpoint: `http://127.0.0.1:${oldOwner.port}`,
	leaseDurationMs: 60_000,
});

const sourceNeverOwns: StatefulOperationExecutor = {
	async executeLocal() {
		throw new Error("The source pod never owns the session in this assembly.");
	},
};

function sourceRoute(
	registry: InMemorySessionOwnerRegistry,
	clock?: () => Date,
): StatefulProviderRuntimeExecutor {
	return new StatefulProviderRuntimeExecutor({
		currentPod: { podId: "pod-source", endpoint: "http://127.0.0.1:1" },
		registry,
		forwarder: new HttpStatefulOwnerForwarder({
			currentPodId: "pod-source",
			secret: FORWARDING_SECRET,
		}),
		executor: sourceNeverOwns,
		leaseDurationMs: 60_000,
		...(clock ? { clock } : {}),
	});
}

const SOURCE_CLOCK_LAG_MS = 60_000;
const sourceRoutes = new Map<
	string,
	{ executor: StatefulProviderRuntimeExecutor; session: SessionKey }
>([
	["live", { executor: sourceRoute(ownerRegistry), session: liveSession }],
	// A source pod whose clock runs a minute behind the owner's: a deadline
	// that has passed on the owner is still ahead here, so its own timer never
	// fires and only the owner's answer can say the deadline expired.
	[
		"lagging",
		{
			executor: sourceRoute(ownerRegistry, () => new Date(Date.now() - SOURCE_CLOCK_LAG_MS)),
			session: liveSession,
		},
	],
	["old-owner", { executor: sourceRoute(oldOwnerRegistry), session: oldOwnerSession }],
]);

const sourceEvents: ProviderServerLogEvent[] = [];
const sourceApp = createServerApp(provider, {
	logger: (event) => sourceEvents.push(event),
	operationExecutor: async ({ ctx, request, operationId }) => {
		const headers = request.headers ?? {};
		const route = sourceRoutes.get(headers["x-test-route"] ?? "");
		if (!route) throw new Error("unknown source route");
		const result = await route.executor.invoke(
			buildStatefulOperationRequest({
				requestId: request.requestId,
				sessionKey: route.session,
				providerId: PROVIDER_ID,
				operationId,
				connectionId: "connection-1",
				serviceAccountId: "account-1",
				input: request.input,
				...(headers["x-test-deadline-at"] ? { deadlineAt: headers["x-test-deadline-at"] } : {}),
				runtimeContext: withStatefulLocalProviderContext(
					ctx,
					statefulForwardingContextFromProviderRequest(request),
				),
			}),
		);
		return result.output;
	},
});
const sourcePod = recordingListener((request) => sourceApp.fetch(request));

afterAll(() => {
	sourcePod.server.stop(true);
	ownerPod.server.stop(true);
	oldOwner.stop(true);
	upstream.stop(true);
	tcpPeer.close();
});

async function callSource(
	operationId: string,
	requestId: string,
	route: string,
	deadlineAt: string,
): Promise<number> {
	const response = await fetch(`${sourcePod.endpoint}/v1/${operationId}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			requestId,
			input: {},
			headers: { "x-test-route": route, "x-test-deadline-at": deadlineAt },
		}),
	});
	await response.arrayBuffer();
	return response.status;
}

function futureDeadline(): string {
	return new Date(Date.now() + 30_000).toISOString();
}

function pastDeadline(): string {
	return new Date(Date.now() - 1_000).toISOString();
}

const SOURCE_DEADLINE = {
	status: 504,
	origin: "platform",
	category: "stateful_forwarding_deadline",
	retryable: false,
	code: DEADLINE_CODE,
	source: "apifuse",
} as const;

function maskedForwardingFailure(served: Served | undefined) {
	return {
		...outcome(served),
		details: served?.body.error.details,
	};
}

const SOURCE_RELAYED_FAILURE = {
	status: 500,
	origin: "platform",
	category: "internal_error",
	retryable: false,
	code: "internal_error",
	source: "apifuse",
	details: {
		retryable: false,
		category: "internal_error",
		errorClass: "StatefulOwnerForwardingError",
	},
} as const;

describe("the source pod relaying the owner pod's answer", () => {
	it("serves the owner's own deadline, reported as a platform fault, as the forwarding deadline", async () => {
		const status = await callSource("succeeds", "owner-deadline", "lagging", pastDeadline());
		expect(status).toBe(504);
		expect(outcome(ownerPod.served.get("owner-deadline"))).toEqual(SOURCE_DEADLINE);
		expect(outcome(sourcePod.served.get("owner-deadline"))).toEqual(SOURCE_DEADLINE);
		expect(failureLog(sourceEvents, "owner-deadline")).toMatchObject({
			status: 504,
			code: DEADLINE_CODE,
			errorClass: "StatefulRoutingDeadlineError",
			errorOrigin: "platform",
		});
	});

	it("does not turn the deadline code a provider threw on the owner pod into the forwarding deadline", async () => {
		const status = await callSource(
			"provider-deadline-code",
			"owner-provider-deadline-code",
			"live",
			futureDeadline(),
		);
		expect(status).toBe(500);
		expect(outcome(ownerPod.served.get("owner-provider-deadline-code"))).toEqual({
			status: 500,
			origin: "provider",
			category: "provider_error",
			retryable: false,
			code: DEADLINE_CODE,
			source: "apifuse",
		});
		expect(maskedForwardingFailure(sourcePod.served.get("owner-provider-deadline-code"))).toEqual(
			SOURCE_RELAYED_FAILURE,
		);
	});

	it("reads the body's code only for an owner that writes no origin", async () => {
		const answered: Record<string, unknown> = {};
		for (const requestId of Object.keys(OLD_OWNER_ANSWERS)) {
			await callSource("succeeds", requestId, "old-owner", futureDeadline());
			answered[requestId] = maskedForwardingFailure(sourcePod.served.get(requestId));
		}
		const deadline = { ...SOURCE_DEADLINE, details: undefined };
		expect(answered).toEqual({
			"old-owner-deadline": deadline,
			"old-owner-timeout-word": deadline,
			"old-owner-no-header": deadline,
			"tagged-provider-deadline-code": SOURCE_RELAYED_FAILURE,
			"unreadable-header": SOURCE_RELAYED_FAILURE,
		});
	});
});
