import { createRequire } from "node:module";
import Ajv from "ajv";

const require = createRequire(import.meta.url);

type Re2WasmModule = typeof import("re2-wasm");

let re2WasmModule: Re2WasmModule | undefined;

/**
 * re2-wasm instantiates its WASM binary at load time (~27 MiB of resident
 * memory) and this module is exported from the SDK index every provider pod
 * boots with. Pattern prevalidation is only exercised by ceremony input
 * schemas that declare `pattern`, so the module load is deferred to first use
 * and memoized. A synchronous require keeps prevalidate() synchronous.
 */
function loadRe2WasmModule(): Re2WasmModule {
	re2WasmModule ??= require("re2-wasm") as Re2WasmModule;
	return re2WasmModule;
}

export interface PrevalidateResult {
	valid: boolean;
	errors?: Array<{ path: string; message: string }>;
}

type JsonSchema = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 500;

function now(): number {
	return Date.now();
}

function cloneWithoutPatterns(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => cloneWithoutPatterns(entry));
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	const cloned: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key === "pattern") {
			continue;
		}
		cloned[key] = cloneWithoutPatterns(entry);
	}
	return cloned;
}

function buildAjv(): Ajv {
	return new Ajv({ allErrors: true, strict: true, strictSchema: true });
}

function createTimeoutGuard(timeoutMs: number): () => void {
	const startedAt = now();

	return () => {
		if (now() - startedAt > timeoutMs) {
			throw new Error("prevalidation_timeout");
		}
	};
}

function formatInstancePath(path: string): string {
	return path.length > 0 ? path : "$";
}

function appendPath(basePath: string, segment: string): string {
	if (segment.startsWith("[")) {
		return `${basePath}${segment}`;
	}

	return basePath === "$" ? `${basePath}.${segment}` : `${basePath}.${segment}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectPatternErrors(
	schema: unknown,
	data: unknown,
	path: string,
	guard: () => void,
	errors: Array<{ path: string; message: string }>,
): void {
	guard();

	if (!isRecord(schema)) {
		return;
	}

	if (typeof schema.pattern === "string" && typeof data === "string") {
		try {
			const { RE2 } = loadRe2WasmModule();
			const regex = new RE2(schema.pattern, "u");
			if (!regex.test(data)) {
				errors.push({
					path,
					message: `must match pattern ${schema.pattern}`,
				});
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Invalid RE2 pattern";
			errors.push({ path, message });
		}
	}

	if (schema.$ref !== undefined) {
		return;
	}

	if (Array.isArray(schema.allOf)) {
		for (const entry of schema.allOf) {
			collectPatternErrors(entry, data, path, guard, errors);
		}
	}

	if (Array.isArray(schema.anyOf)) {
		for (const entry of schema.anyOf) {
			collectPatternErrors(entry, data, path, guard, errors);
		}
	}

	if (Array.isArray(schema.oneOf)) {
		for (const entry of schema.oneOf) {
			collectPatternErrors(entry, data, path, guard, errors);
		}
	}

	if (isRecord(schema.not)) {
		collectPatternErrors(schema.not, data, path, guard, errors);
	}

	if (isRecord(schema.if)) {
		collectPatternErrors(schema.if, data, path, guard, errors);
	}

	if (isRecord(schema.then)) {
		collectPatternErrors(schema.then, data, path, guard, errors);
	}

	if (isRecord(schema.else)) {
		collectPatternErrors(schema.else, data, path, guard, errors);
	}

	if (Array.isArray(data) && schema.items !== undefined) {
		for (const [index, item] of data.entries()) {
			collectPatternErrors(
				schema.items,
				item,
				appendPath(path, `[${index}]`),
				guard,
				errors,
			);
		}
	}

	if (!isRecord(data)) {
		return;
	}

	if (isRecord(schema.properties)) {
		for (const [key, childSchema] of Object.entries(schema.properties)) {
			if (key in data) {
				collectPatternErrors(
					childSchema,
					data[key],
					appendPath(path, key),
					guard,
					errors,
				);
			}
		}
	}

	if (isRecord(schema.patternProperties)) {
		for (const [pattern, childSchema] of Object.entries(
			schema.patternProperties,
		)) {
			const { RE2 } = loadRe2WasmModule();
			const keyPattern = new RE2(pattern, "u");
			for (const [key, value] of Object.entries(data)) {
				guard();
				if (keyPattern.test(key)) {
					collectPatternErrors(
						childSchema,
						value,
						appendPath(path, key),
						guard,
						errors,
					);
				}
			}
		}
	}

	if (schema.additionalProperties && isRecord(schema.additionalProperties)) {
		const declaredKeys = isRecord(schema.properties)
			? new Set(Object.keys(schema.properties))
			: new Set<string>();

		for (const [key, value] of Object.entries(data)) {
			if (!declaredKeys.has(key)) {
				collectPatternErrors(
					schema.additionalProperties,
					value,
					appendPath(path, key),
					guard,
					errors,
				);
			}
		}
	}
}

export function prevalidate(
	schema: JsonSchema,
	data: unknown,
	options: { timeoutMs?: number } = {},
): PrevalidateResult {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const guard = createTimeoutGuard(timeoutMs);

	try {
		guard();
		const ajv = buildAjv();
		const strippedSchema = cloneWithoutPatterns(schema);
		if (!strippedSchema || typeof strippedSchema !== "object") {
			return {
				valid: false,
				errors: [{ path: "$", message: "Invalid schema" }],
			};
		}
		const validate = ajv.compile(strippedSchema);
		const schemaValid = validate(data);
		const errors =
			validate.errors?.map((error) => ({
				path: formatInstancePath(error.instancePath),
				message: error.message ?? "Invalid value",
			})) ?? [];

		collectPatternErrors(schema, data, "$", guard, errors);

		if (!schemaValid || errors.length > 0) {
			return { valid: false, errors };
		}

		return { valid: true };
	} catch (error) {
		if (error instanceof Error && error.message === "prevalidation_timeout") {
			return {
				valid: false,
				errors: [
					{
						path: "$",
						message: `Prevalidation timed out after ${timeoutMs}ms`,
					},
				],
			};
		}

		const message =
			error instanceof Error ? error.message : "Prevalidation failed";
		return { valid: false, errors: [{ path: "$", message }] };
	}
}
