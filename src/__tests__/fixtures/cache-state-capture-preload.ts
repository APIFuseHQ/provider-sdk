import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import * as cacheModule from "../../runtime/cache.js";

const captureFile = process.env.APIFUSE_P6C_CAPTURE_FILE!;
if (process.env.APIFUSE_P6C_CAPTURE_KIND === "cache") {
	const originalCreate = cacheModule.createProviderCache;
	const originalBypass = cacheModule.createBypassProviderCache;
	function capture(original: typeof originalCreate): typeof originalCreate {
		return (...args: Parameters<typeof originalCreate>) => {
			const cache = original(...args);
			return new Proxy(cache, {
				get(target, key) {
					const value: unknown = Reflect.get(target, key);
					if (typeof value !== "function" || key === "key") return value;
					return (...methodArgs: unknown[]) => {
						const result: unknown = Reflect.apply(value, target, methodArgs);
						const record = () =>
							appendFileSync(
								captureFile,
								`${JSON.stringify({ provider: args[0].providerId, op: String(key), meta: target.responseMeta() ?? null })}\n`,
							);
						if (result instanceof Promise) {
							return result.then(
								(value: unknown) => {
									record();
									return value;
								},
								(error: unknown) => {
									record();
									throw error;
								},
							);
						}
						record();
						return result;
					};
				},
			});
		};
	}
	mock.module("../../runtime/cache.js", () => ({
		...cacheModule,
		createProviderCache: capture(originalCreate),
		createBypassProviderCache: capture(originalBypass),
	}));
} else {
	const original = Response.prototype.json;
	Response.prototype.json = async function () {
		const body = await this.clone().text();
		const parsed: unknown = await original.call(this);
		if (parsed && typeof parsed === "object" && "meta" in parsed) {
			const meta = parsed.meta;
			if (meta && typeof meta === "object" && "cache" in meta && meta.cache) {
				appendFileSync(
					captureFile,
					`${JSON.stringify({ body, cache: JSON.stringify(meta.cache) })}\n`,
				);
			}
		}
		return parsed;
	};
}
