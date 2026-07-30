import type {
	HttpStreamResponse,
	ProviderContext,
	RequestOptions,
	SseMessage,
	StealthSession,
	StealthRedirectRunResult,
} from "../types.js";
import { readableBytes, readableLines, readableTextChunks } from "../stream.js";
import {
	parseHttpRequestInvocation,
	isSensitiveKey,
	redactSensitiveError,
	redactSensitiveText,
	redactUrlQueryParams,
	requestOptionsFromHttpInvocation,
	serializeRequestUrl,
	type SerializedRequestUrl,
} from "./request-options.js";
import {
	type CreateTraceContextOptions,
	createTraceContext,
	getTraceRecorder,
	type TraceContext,
} from "./trace.js";

export interface InstrumentationOptions extends CreateTraceContextOptions {}

export type InstrumentedProviderContext<T extends ProviderContext> = Omit<T, "trace"> & {
	trace: TraceContext;
};

type InstrumentedNamespace = "http" | "stealth" | "browser" | "session" | "state";

const BROWSER_PAGE_METHODS = new Set(["goto", "fill", "click", "type", "waitForSelector"]);
const DIAGNOSTIC_BASE_URL = "http://apifuse-instrumentation.invalid";

type RequestDiagnostics = {
	diagnosticUrlDegraded?: boolean;
	requestId?: string;
	serializedUrl?: SerializedRequestUrl;
	sensitiveParamNames: readonly string[];
	sensitiveValues: readonly string[];
	traceUrl?: string;
};

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

function getErrorStatus(error: unknown): number | undefined {
	if (
		typeof error === "object" &&
		error !== null &&
		"status" in error &&
		typeof error.status === "number"
	) {
		return error.status;
	}

	return undefined;
}

function getResponseDuration(result: unknown): number | undefined {
	if (
		typeof result === "object" &&
		result !== null &&
		"meta" in result &&
		typeof result.meta === "object" &&
		result.meta !== null &&
		"duration" in result.meta &&
		typeof result.meta.duration === "number"
	) {
		return result.meta.duration;
	}

	return undefined;
}

function getResponseStatus(namespace: InstrumentedNamespace, result: unknown): number | undefined {
	if (
		typeof result === "object" &&
		result !== null &&
		"status" in result &&
		typeof result.status === "number"
	) {
		return result.status;
	}

	if (namespace === "http") {
		return 200;
	}

	return undefined;
}

function getUrl(
	namespace: InstrumentedNamespace,
	args: unknown[],
	result?: unknown,
): string | undefined {
	if (typeof args[0] === "string") {
		return args[0];
	}

	if (
		namespace === "browser" &&
		typeof result === "object" &&
		result !== null &&
		"url" in result &&
		typeof result.url === "string"
	) {
		return result.url;
	}

	return undefined;
}

function requestOptionsForInvocation(
	namespace: InstrumentedNamespace,
	methodName: string,
	args: readonly unknown[],
): RequestOptions | undefined {
	if (namespace === "http") {
		const invocation = parseHttpRequestInvocation(methodName, [...args]);
		return invocation ? requestOptionsFromHttpInvocation(invocation) : undefined;
	}
	if (namespace !== "stealth" || methodName !== "fetch" || typeof args[0] !== "string") {
		return undefined;
	}
	const options = args[1];
	return options !== null && typeof options === "object" && !Array.isArray(options)
		? (options as RequestOptions)
		: undefined;
}

function fallbackSensitiveValues(options?: RequestOptions): readonly string[] {
	const sensitiveParams = options?.sensitiveParams;
	if (!sensitiveParams || typeof sensitiveParams !== "object") return [];
	return Object.values(sensitiveParams).map(String);
}

function stripDiagnosticBase(url: string): string {
	return url.startsWith(DIAGNOSTIC_BASE_URL) ? url.slice(DIAGNOSTIC_BASE_URL.length) || "/" : url;
}

function serializeDiagnosticUrl(
	url: string,
	options?: RequestOptions,
): { degraded: boolean; serializedUrl: SerializedRequestUrl } {
	try {
		return {
			degraded: false,
			serializedUrl: serializeRequestUrl(url, options?.params, options?.sensitiveParams),
		};
	} catch {
		try {
			const absoluteUrl = new URL(url, DIAGNOSTIC_BASE_URL).toString();
			const serialized = serializeRequestUrl(
				absoluteUrl,
				options?.params,
				options?.sensitiveParams,
			);
			return {
				degraded: false,
				serializedUrl: {
					requestUrl: stripDiagnosticBase(serialized.requestUrl),
					redactedUrl: stripDiagnosticBase(serialized.redactedUrl),
					sensitiveValues: serialized.sensitiveValues,
				},
			};
		} catch {
			const sensitiveParamNames = Object.keys(options?.sensitiveParams ?? {});
			const structural = redactUrlQueryParams(url, sensitiveParamNames);
			return {
				degraded: true,
				serializedUrl: {
					requestUrl: url,
					redactedUrl: structural.redactedUrl,
					sensitiveValues: [
						...new Set([...fallbackSensitiveValues(options), ...structural.sensitiveValues]),
					],
				},
			};
		}
	}
}

function snapshotRequestDiagnostics(
	namespace: InstrumentedNamespace,
	methodName: string,
	args: readonly unknown[],
): RequestDiagnostics {
	const options = requestOptionsForInvocation(namespace, methodName, args);
	const url = typeof args[0] === "string" ? args[0] : undefined;
	const hasSensitiveParams = Boolean(
		options?.sensitiveParams && Object.keys(options.sensitiveParams).length > 0,
	);
	const sensitiveParamNames = Object.keys(options?.sensitiveParams ?? {});
	const diagnosticUrl =
		hasSensitiveParams && url ? serializeDiagnosticUrl(url, options) : undefined;
	const traceUrl =
		hasSensitiveParams && url
			? serializeDiagnosticUrl(url, { sensitiveParams: options?.sensitiveParams }).serializedUrl
					.redactedUrl
			: undefined;
	return {
		...(diagnosticUrl?.degraded ? { diagnosticUrlDegraded: true } : {}),
		...(hasSensitiveParams ? { requestId: crypto.randomUUID() } : {}),
		serializedUrl: diagnosticUrl?.serializedUrl,
		sensitiveParamNames,
		sensitiveValues:
			diagnosticUrl?.serializedUrl.sensitiveValues ?? fallbackSensitiveValues(options),
		traceUrl,
	};
}

function sanitizeRequestError(error: unknown, diagnostics: RequestDiagnostics): unknown {
	return redactSensitiveError(
		error,
		diagnostics.sensitiveValues,
		diagnostics.serializedUrl?.requestUrl,
		diagnostics.serializedUrl?.redactedUrl,
	);
}

function isHttpStreamResponse(value: unknown): value is HttpStreamResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"body" in value &&
		value.body instanceof ReadableStream
	);
}

function instrumentHttpStreamConsumption(
	value: HttpStreamResponse,
	recorder: NonNullable<ReturnType<typeof getTraceRecorder>>,
	args: unknown[],
	diagnostics: RequestDiagnostics,
): HttpStreamResponse {
	const source = value.body;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const body = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					reader ??= source.getReader();
					const chunk = await reader.read();
					if (chunk.done) {
						controller.close();
						return;
					}
					controller.enqueue(chunk.value);
				} catch (error) {
					const sanitizedError = sanitizeRequestError(error, diagnostics);
					try {
						await recorder.runSpan(
							"http.stream.consume",
							() => {
								throw sanitizedError;
							},
							{
								onError: (spanError) =>
									buildSpanAttributes("http", "stream", args, undefined, spanError, diagnostics),
							},
						);
					} catch (recordedError) {
						controller.error(recordedError);
					}
				}
			},
			async cancel(reason) {
				try {
					await (reader ? reader.cancel(reason) : source.cancel(reason));
				} catch (error) {
					throw sanitizeRequestError(error, diagnostics);
				}
			},
		},
		{ highWaterMark: 0 },
	);

	const instrumented = {
		...value,
		body,
		bytes: () => readableBytes(body),
		textChunks: () => readableTextChunks(body),
		lines: () => readableLines(body),
	} satisfies HttpStreamResponse;
	try {
		Object.assign(value, instrumented);
		return value;
	} catch {
		return instrumented;
	}
}

function isAsyncIterable<T = unknown>(value: unknown): value is AsyncIterable<T> {
	return (
		typeof value === "object" &&
		value !== null &&
		Symbol.asyncIterator in value &&
		typeof value[Symbol.asyncIterator] === "function"
	);
}

function instrumentHttpSseConsumption(
	value: AsyncIterable<SseMessage>,
	recorder: NonNullable<ReturnType<typeof getTraceRecorder>>,
	args: unknown[],
	diagnostics: RequestDiagnostics,
): AsyncIterable<SseMessage> {
	const source = value;
	return {
		async *[Symbol.asyncIterator]() {
			try {
				for await (const event of source) yield event;
			} catch (error) {
				const sanitizedError = sanitizeRequestError(error, diagnostics);
				return await recorder.runSpan(
					"http.sse.consume",
					() => {
						throw sanitizedError;
					},
					{
						onError: (spanError) =>
							buildSpanAttributes("http", "sse", args, undefined, spanError, diagnostics),
					},
				);
			}
		},
	};
}

function getMethod(
	namespace: InstrumentedNamespace,
	methodName: string,
	args: unknown[],
): string | undefined {
	if (namespace === "http") {
		// Preserve the original instrumentation contract: generic entry points are
		// reported as REQUEST/STREAM/SSE, independent of transport options.
		return methodName.toUpperCase();
	}

	if (namespace === "stealth") {
		const options = typeof args[1] === "object" && args[1] !== null ? args[1] : undefined;
		if (options && "method" in options && typeof options.method === "string") {
			return options.method.toUpperCase();
		}

		return "GET";
	}

	return undefined;
}

function buildSpanAttributes(
	namespace: InstrumentedNamespace,
	methodName: string,
	args: unknown[],
	result?: unknown,
	error?: unknown,
	diagnostics: RequestDiagnostics = { sensitiveParamNames: [], sensitiveValues: [] },
): Record<string, string | number | boolean> {
	const attributes: Record<string, string | number | boolean> = {};
	const rawUrl = getUrl(namespace, args, result);
	const structuralUrl = diagnostics.traceUrl ?? rawUrl;
	const url = structuralUrl
		? redactSensitiveText(
				structuralUrl,
				diagnostics.sensitiveValues,
				diagnostics.serializedUrl?.requestUrl,
				diagnostics.serializedUrl?.redactedUrl,
			)
		: undefined;
	const method = getMethod(namespace, methodName, args);
	const status = error ? getErrorStatus(error) : getResponseStatus(namespace, result);
	const duration = error ? undefined : getResponseDuration(result);

	if (url) {
		attributes.url = url;
	}
	if (diagnostics.requestId) attributes.request_id = diagnostics.requestId;
	if (diagnostics.diagnosticUrlDegraded) attributes.redaction_degraded = true;

	if (method) {
		attributes.method = method;
	}

	if (status !== undefined && (namespace === "http" || namespace === "stealth")) {
		attributes.status = status;
	}

	if (duration !== undefined) {
		attributes.duration_ms = duration;
	}

	if (namespace === "session" || namespace === "state") {
		attributes.operation = methodName;
		const key = typeof args[0] === "string" ? args[0] : undefined;
		if (key) {
			attributes.key = key;
		}
	}

	return attributes;
}

function isStealthRedirectRunResult(value: unknown): value is StealthRedirectRunResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"reason" in value &&
		typeof value.reason === "string" &&
		"hops" in value &&
		Array.isArray(value.hops) &&
		"final" in value &&
		typeof value.final === "object" &&
		value.final !== null
	);
}

function buildStealthRedirectAttributes(
	args: unknown[],
	result: unknown,
	error: unknown,
	diagnostics: RequestDiagnostics,
): Record<string, string | number | boolean> {
	const attributes = buildSpanAttributes("stealth", "fetch", args, undefined, error, diagnostics);
	if (!isStealthRedirectRunResult(result)) return attributes;

	attributes.redirect_reason = result.reason;
	attributes.redirect_hop_count = result.hops.length;
	attributes.status = result.final.status;
	if (result.hops.length > 0) {
		const sensitiveValues = new Set(diagnostics.sensitiveValues);
		const path = result.hops
			.map((hop) => {
				const hopUrl = hop.nextUrl ?? hop.url;
				const responseSensitiveParamNames = [...queryParamNames(hopUrl)].filter(isSensitiveKey);
				const structural = redactUrlQueryParams(hopUrl, [
					...new Set([...diagnostics.sensitiveParamNames, ...responseSensitiveParamNames]),
				]);
				for (const value of structural.sensitiveValues) sensitiveValues.add(value);
				const safeUrl = redactSensitiveText(structural.redactedUrl, [...sensitiveValues]);
				return `${hop.method} ${hop.status} ${safeUrl}`;
			})
			.join(" -> ");
		attributes.redirect_path = redactSensitiveText(
			path,
			[...sensitiveValues],
			diagnostics.serializedUrl?.requestUrl,
			diagnostics.serializedUrl?.redactedUrl,
		);
	}
	return attributes;
}

function queryParamNames(url: string): Set<string> {
	const queryStart = url.indexOf("?");
	if (queryStart === -1) return new Set();
	const fragmentStart = url.indexOf("#", queryStart);
	const query = url.slice(queryStart + 1, fragmentStart === -1 ? undefined : fragmentStart);
	return new Set(new URLSearchParams(query).keys());
}

function getBrowserPageAttributes(
	methodName: string,
	args: unknown[],
	elapsedMs?: number,
	error?: unknown,
): Record<string, string | number | boolean> {
	const attributes: Record<string, string | number | boolean> = {};

	if (methodName === "goto") {
		const url = typeof args[0] === "string" ? args[0] : undefined;
		if (url) {
			attributes.url = url;
		}
		if (error === undefined) {
			attributes.navigation_ms = elapsedMs ?? 0;
		}
		return attributes;
	}

	const selector = typeof args[0] === "string" ? args[0] : undefined;
	if (selector) {
		attributes.selector = selector;
	}

	if (error === undefined) {
		const key = methodName === "waitForSelector" ? "wait_ms" : "action_ms";
		attributes[key] = elapsedMs ?? 0;
	}

	return attributes;
}

function wrapPage<T extends object>(page: T, trace: TraceContext): T {
	if (page === null || page === undefined) {
		return page;
	}

	const recorder = getTraceRecorder(trace);
	if (!recorder) {
		return page;
	}

	const wrappedMethods = new Map<PropertyKey, unknown>();

	return new Proxy(page, {
		get(pageTarget, property, receiver) {
			const value = Reflect.get(pageTarget, property, receiver);

			if (
				typeof value !== "function" ||
				property === "constructor" ||
				!BROWSER_PAGE_METHODS.has(String(property))
			) {
				return value;
			}

			if (wrappedMethods.has(property)) {
				return wrappedMethods.get(property);
			}

			const methodName = String(property);
			const wrapped = (...args: unknown[]) => {
				let elapsedMs = 0;

				return recorder.runSpan(
					`browser.page.${methodName}`,
					async () => {
						const startedAt = Date.now();
						const result = await Reflect.apply(value, pageTarget, args);
						elapsedMs = Date.now() - startedAt;
						return result;
					},
					{
						onSuccess: () => getBrowserPageAttributes(methodName, args, elapsedMs),
						onError: (error) => getBrowserPageAttributes(methodName, args, undefined, error),
					},
				);
			};

			wrappedMethods.set(property, wrapped);
			return wrapped;
		},
	});
}

function wrapStealthRedirects(
	redirects: StealthSession["redirects"],
	trace: TraceContext,
): StealthSession["redirects"] {
	const recorder = getTraceRecorder(trace);
	if (!recorder) return redirects;

	return {
		run(...args: Parameters<StealthSession["redirects"]["run"]>) {
			const diagnosticArgs = [args[0].url, args[0]];
			const diagnostics = snapshotRequestDiagnostics("stealth", "fetch", diagnosticArgs);
			let result: ReturnType<StealthSession["redirects"]["run"]>;
			try {
				result = redirects.run(...args);
			} catch (error) {
				const sanitizedError = sanitizeRequestError(error, diagnostics);
				recorder
					.runSpan(
						"stealth.redirects.run",
						() => {
							throw sanitizedError;
						},
						{
							onError: (spanError) =>
								buildStealthRedirectAttributes(diagnosticArgs, undefined, spanError, diagnostics),
						},
					)
					.catch(() => undefined);
				throw sanitizedError;
			}

			const sanitizedResult = Promise.resolve(result).catch((error: unknown) => {
				throw sanitizeRequestError(error, diagnostics);
			});
			return recorder.runSpan("stealth.redirects.run", () => sanitizedResult, {
				onSuccess: (spanResult) =>
					buildStealthRedirectAttributes(diagnosticArgs, spanResult, undefined, diagnostics),
				onError: (error) =>
					buildStealthRedirectAttributes(diagnosticArgs, undefined, error, diagnostics),
			});
		},
	};
}

function wrapStealthSession(session: StealthSession, trace: TraceContext): StealthSession {
	const wrappedSession = wrapNamespace("stealth", session, trace);
	const redirects = wrapStealthRedirects(session.redirects, trace);
	return new Proxy(wrappedSession, {
		get(target, property, receiver) {
			return property === "redirects" ? redirects : Reflect.get(target, property, receiver);
		},
	});
}

function wrapNamespace<T extends object>(
	namespace: InstrumentedNamespace,
	target: T,
	trace: TraceContext,
	shouldInstrument?: (methodName: string, args: unknown[]) => boolean,
): T {
	const recorder = getTraceRecorder(trace);
	if (!recorder) {
		return target;
	}

	const wrappedMethods = new Map<PropertyKey, unknown>();

	return new Proxy(target, {
		get(namespaceTarget, property, receiver) {
			const value = Reflect.get(namespaceTarget, property, receiver);

			if (typeof value !== "function" || property === "constructor") {
				return value;
			}

			if (namespace === "browser" && property === "newPage") {
				if (wrappedMethods.has(property)) {
					return wrappedMethods.get(property);
				}

				const wrapped = (...args: unknown[]) => {
					let allocateMs = 0;

					return recorder.runSpan(
						"browser.newPage",
						async () => {
							const startedAt = Date.now();
							const page = await Reflect.apply(value, namespaceTarget, args);
							allocateMs = Date.now() - startedAt;
							return wrapPage(page, trace);
						},
						{
							onSuccess: (result) => {
								const attributes: Record<string, string | number | boolean> = {
									allocate_ms: allocateMs,
								};

								if (
									result &&
									typeof result === "object" &&
									"pageId" in result &&
									typeof (result as { pageId?: unknown }).pageId === "string"
								) {
									attributes.page_id = (result as { pageId: string }).pageId;
								}

								if (
									namespaceTarget &&
									typeof namespaceTarget === "object" &&
									"engine" in namespaceTarget &&
									typeof (namespaceTarget as { engine?: unknown }).engine === "string"
								) {
									attributes.engine = (namespaceTarget as { engine: string }).engine;
								}

								return attributes;
							},
							onError: (error) => getBrowserPageAttributes("newPage", args, undefined, error),
						},
					);
				};

				wrappedMethods.set(property, wrapped);
				return wrapped;
			}

			if (wrappedMethods.has(property)) {
				return wrappedMethods.get(property);
			}

			const methodName = String(property);
			if (namespace === "browser") {
				const wrapped = (...args: unknown[]) => {
					let elapsedMs = 0;

					return recorder.runSpan(
						`browser.${methodName}`,
						async () => {
							const startedAt = Date.now();
							const result = await Reflect.apply(value, namespaceTarget, args);
							elapsedMs = Date.now() - startedAt;
							return result;
						},
						{
							onSuccess: () => getBrowserPageAttributes(methodName, args, elapsedMs),
							onError: (error) => getBrowserPageAttributes(methodName, args, undefined, error),
						},
					);
				};

				wrappedMethods.set(property, wrapped);
				return wrapped;
			}

			const wrapped = (...args: unknown[]) => {
				if (shouldInstrument && !shouldInstrument(methodName, args)) {
					return Reflect.apply(value, namespaceTarget, args);
				}
				const requestDiagnostics = snapshotRequestDiagnostics(namespace, methodName, args);
				// Invoke first and decide by the RETURN VALUE. `runSpan` always
				// returns a Promise, so unconditionally span-wrapping every member
				// silently rewrote synchronous contracts: `ctx.state.namespace()`
				// (a sync factory) came back as a Promise, and every method call on
				// it threw a raw TypeError — surfaced in production as catchtable's
				// deterministic CONFIRM_STATE_UNAVAILABLE on 2026-07-27 (and the
				// 2026-07-22 reserve internal_error loop before it). Sync members
				// keep their sync contract; only genuinely async operations are
				// recorded as spans.
				let result: unknown;
				try {
					result = Reflect.apply(value, namespaceTarget, args);
				} catch (error) {
					const sanitizedError = sanitizeRequestError(error, requestDiagnostics);
					// A promise-returning implementation may still throw
					// SYNCHRONOUSLY during pre-flight validation. Preserve the
					// synchronous throw contract, but keep recording the failure
					// span (the pre-fidelity wrapper captured these).
					recorder
						.runSpan(
							`${namespace}.${methodName}`,
							() => {
								throw sanitizedError;
							},
							{
								onError: (spanError) =>
									buildSpanAttributes(
										namespace,
										methodName,
										args,
										undefined,
										spanError,
										requestDiagnostics,
									),
							},
						)
						.catch(() => undefined);
					throw sanitizedError;
				}
				if (!isThenable(result)) {
					// The state namespace factory returns the object whose METHODS
					// are the operations worth tracing — instrument that object so
					// `state.get`/`state.compareAndSet`/… spans exist (they never
					// could before: the factory's return value was destroyed).
					if (
						namespace === "state" &&
						methodName === "namespace" &&
						typeof result === "object" &&
						result !== null
					) {
						return wrapNamespace(namespace, result, trace);
					}
					if (
						namespace === "stealth" &&
						methodName === "createSession" &&
						typeof result === "object" &&
						result !== null
					) {
						return wrapStealthSession(result as StealthSession, trace);
					}
					return result;
				}
				const sanitizedResult = Promise.resolve(result).catch((error: unknown) => {
					throw sanitizeRequestError(error, requestDiagnostics);
				});
				const tracedResult = recorder.runSpan(`${namespace}.${methodName}`, () => sanitizedResult, {
					onSuccess: (spanResult) =>
						buildSpanAttributes(
							namespace,
							methodName,
							args,
							spanResult,
							undefined,
							requestDiagnostics,
						),
					onError: (error) =>
						buildSpanAttributes(namespace, methodName, args, undefined, error, requestDiagnostics),
				});
				return namespace === "http" && methodName === "stream"
					? tracedResult.then((spanResult) =>
							isHttpStreamResponse(spanResult)
								? instrumentHttpStreamConsumption(spanResult, recorder, args, requestDiagnostics)
								: spanResult,
						)
					: namespace === "http" && methodName === "sse"
						? tracedResult.then((spanResult) =>
								isAsyncIterable<SseMessage>(spanResult)
									? instrumentHttpSseConsumption(spanResult, recorder, args, requestDiagnostics)
									: spanResult,
							)
						: tracedResult;
			};

			wrappedMethods.set(property, wrapped);
			return wrapped;
		},
	});
}

function hasTraceOverrides(options: InstrumentationOptions): boolean {
	return options.maxSpans !== undefined || options.onSpan !== undefined;
}

export function wrapWithInstrumentation<T extends ProviderContext>(
	ctx: T,
	options: InstrumentationOptions = {},
): InstrumentedProviderContext<T> {
	const trace =
		getTraceRecorder(ctx.trace) && !hasTraceOverrides(options)
			? (ctx.trace as TraceContext)
			: createTraceContext(options);
	const wrappedTargets = new Map<InstrumentedNamespace, unknown>();

	return new Proxy(ctx, {
		get(target, property, receiver) {
			if (property === "trace") {
				return trace;
			}

			if (
				property === "http" ||
				property === "stealth" ||
				property === "browser" ||
				property === "session" ||
				property === "state"
			) {
				const namespace = property;
				if (wrappedTargets.has(namespace)) {
					return wrappedTargets.get(namespace);
				}

				const value = Reflect.get(target, property, receiver);
				if (!value || typeof value !== "object") {
					return value;
				}

				const wrapped = wrapNamespace(namespace, value, trace);
				wrappedTargets.set(namespace, wrapped);
				return wrapped;
			}

			return Reflect.get(target, property, receiver);
		},
	}) as unknown as InstrumentedProviderContext<T>;
}
