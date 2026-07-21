import type { ProviderContext } from "../types.js";
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

function getMethod(
	namespace: InstrumentedNamespace,
	methodName: string,
	args: unknown[],
): string | undefined {
	if (namespace === "http") {
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
): Record<string, string | number | boolean> {
	const attributes: Record<string, string | number | boolean> = {};
	const url = getUrl(namespace, args, result);
	const method = getMethod(namespace, methodName, args);
	const status = error ? getErrorStatus(error) : getResponseStatus(namespace, result);
	const duration = error ? undefined : getResponseDuration(result);

	if (url) {
		attributes.url = url;
	}

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

function wrapNamespace<T extends object>(
	namespace: InstrumentedNamespace,
	target: T,
	trace: TraceContext,
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

			const wrapped = (...args: unknown[]) =>
				recorder.runSpan(
					`${namespace}.${methodName}`,
					() => Reflect.apply(value, namespaceTarget, args),
					{
						onSuccess: (result) => buildSpanAttributes(namespace, methodName, args, result),
						onError: (error) => buildSpanAttributes(namespace, methodName, args, undefined, error),
					},
				);

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
