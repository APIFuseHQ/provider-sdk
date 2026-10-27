/**
 * Declaration-time checks for `defineProvider({ sessionState })`. Every rule is
 * a structural invariant the runtime relies on, so a declaration that passes
 * here never needs a runtime fallback: bounded validity, carried values that
 * the capture actually produces, hosts the provider declared, and credential
 * state that is never re-acquired in-process.
 */
import { ValidationError } from "./errors.js";
import { parseSessionStateDurationMs } from "./runtime/session-state-duration.js";
import { isStealthOwnedHeaderName } from "./runtime/stealth-owned-headers.js";
import type { CredentialDeclaration, ProviderSessionState } from "./types.js";

const DECLARATION_FIELDS = new Set(["acquire", "carry", "validity", "distribute"]);
const ACQUIRE_FIELDS: Record<string, ReadonlySet<string>> = {
	response: new Set(["from", "capture", "when"]),
	request: new Set(["from", "request", "capture", "when"]),
	credential: new Set(["from", "capture"]),
};
const CAPTURE_FIELDS = new Set(["cookies", "headers", "json", "credential", "expiresAt"]);
const CREDENTIAL_CAPTURE_FIELDS = new Set(["credential", "expiresAt"]);
const ACQUIRE_REQUEST_FIELDS = new Set(["url", "method", "headers", "body", "client"]);
const CARRY_FIELDS: Record<string, ReadonlySet<string>> = {
	cookies: new Set(["as"]),
	cookie: new Set(["as", "name", "value"]),
	"cookie-header": new Set(["as", "value"]),
	header: new Set(["as", "name", "value", "format"]),
	query: new Set(["as", "name", "value"]),
};
const VALIDITY_FIELDS = new Set([
	"ttl",
	"idleTtl",
	"maxUses",
	"invalidWhen",
	"reacquire",
	"replayMethods",
]);
const DISTRIBUTE_FIELDS = new Set([
	"hosts",
	"operations",
	"scope",
	"qps",
	"maxConcurrent",
	"egress",
]);
const MATCHER_FIELDS = new Set(["status", "headers", "bodyIncludes", "bodyPattern", "json"]);
const EXPIRY_UNITS = new Set(["epoch-seconds", "seconds-from-now", "iso"]);
const CREDENTIAL_EXPIRY_UNITS = new Set(["epoch-seconds", "iso"]);
const HTTP_METHODS = new Set(["HEAD", "GET", "POST", "PUT", "DELETE", "OPTIONS", "TRACE", "PATCH"]);

type Fail = (path: string, problem: string, fix?: string) => never;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failer(providerId: string): Fail {
	return (path, problem, fix) => {
		throw new ValidationError(`Provider "${providerId}" has invalid ${path}: ${problem}`, {
			fix: fix ?? `Correct ${path}; see ProviderSessionState in the SDK types.`,
		});
	};
}

function onlyFields(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	path: string,
	fail: Fail,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			fail(
				path,
				`unknown field "${key}"`,
				`Remove ${path}.${key}; allowed fields are ${[...allowed].join(", ")}.`,
			);
		}
	}
}

function nonEmptyString(value: unknown, path: string, fail: Fail): string {
	if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string");
	return value as string;
}

function stringList(value: unknown, path: string, fail: Fail): string[] {
	if (!Array.isArray(value) || value.length === 0)
		fail(path, "must be a non-empty array of strings");
	const list = (value as unknown[]).map((item, index) =>
		nonEmptyString(item, `${path}[${index}]`, fail),
	);
	if (new Set(list).size !== list.length) fail(path, "must not repeat an entry");
	return list;
}

function stringRecord(value: unknown, path: string, fail: Fail): Record<string, string> {
	if (!isRecord(value) || Object.keys(value).length === 0)
		fail(path, "must be a non-empty object of strings");
	const record = value as Record<string, unknown>;
	for (const [key, item] of Object.entries(record)) nonEmptyString(item, `${path}.${key}`, fail);
	return record as Record<string, string>;
}

function compiles(source: unknown, path: string, fail: Fail): void {
	if (typeof source !== "string") fail(path, "must be a regular-expression source string");
	try {
		new RegExp(source as string);
	} catch {
		fail(path, "is not a valid regular expression");
	}
}

function positiveInteger(value: unknown, path: string, fail: Fail): void {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
		fail(path, "must be a positive integer");
}

function duration(value: unknown, path: string, fail: Fail): void {
	if (typeof value !== "string" || parseSessionStateDurationMs(value) === undefined)
		fail(path, 'must be a positive duration such as "20m" or "PT20M"');
}

function validateStatus(value: unknown, path: string, fail: Fail): void {
	const isStatus = (status: unknown) =>
		typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599;
	if (isStatus(value)) return;
	if (Array.isArray(value) && value.length > 0 && value.every(isStatus)) return;
	if (isRecord(value)) {
		onlyFields(value, new Set(["min", "max"]), path, fail);
		if (
			isStatus(value.min) &&
			isStatus(value.max) &&
			(value.min as number) <= (value.max as number)
		)
			return;
	}
	fail(path, "must be an HTTP status, a non-empty list of statuses, or { min, max }");
}

function validateMatcher(value: unknown, path: string, fail: Fail): void {
	if (!isRecord(value) || Object.keys(value).length === 0)
		fail(path, "must be a matcher object with at least one field");
	const matcher = value as Record<string, unknown>;
	onlyFields(matcher, MATCHER_FIELDS, path, fail);
	if (matcher.status !== undefined) validateStatus(matcher.status, `${path}.status`, fail);
	if (matcher.headers !== undefined) {
		if (!isRecord(matcher.headers) || Object.keys(matcher.headers).length === 0)
			fail(`${path}.headers`, "must be a non-empty object");
		for (const [name, expected] of Object.entries(matcher.headers as Record<string, unknown>)) {
			const fieldPath = `${path}.headers.${name}`;
			if (expected === true || typeof expected === "string") continue;
			if (isRecord(expected)) {
				onlyFields(expected, new Set(["pattern"]), fieldPath, fail);
				compiles(expected.pattern, `${fieldPath}.pattern`, fail);
				continue;
			}
			fail(fieldPath, "must be a string, { pattern } or true");
		}
	}
	if (matcher.bodyIncludes !== undefined)
		stringList(matcher.bodyIncludes, `${path}.bodyIncludes`, fail);
	if (matcher.bodyPattern !== undefined) compiles(matcher.bodyPattern, `${path}.bodyPattern`, fail);
	if (matcher.json !== undefined) {
		if (!isRecord(matcher.json) || Object.keys(matcher.json).length === 0)
			fail(`${path}.json`, "must be a non-empty object");
		for (const [jsonPath, expected] of Object.entries(matcher.json as Record<string, unknown>)) {
			const fieldPath = `${path}.json.${jsonPath}`;
			if (
				expected === null ||
				typeof expected === "string" ||
				typeof expected === "boolean" ||
				(typeof expected === "number" && Number.isFinite(expected))
			)
				continue;
			if (isRecord(expected)) {
				onlyFields(expected, new Set(["pattern"]), fieldPath, fail);
				compiles(expected.pattern, `${fieldPath}.pattern`, fail);
				continue;
			}
			fail(fieldPath, "must be a string, number, boolean, null or { pattern }");
		}
	}
}

function validateExpiry(value: unknown, path: string, credentialOnly: boolean, fail: Fail): void {
	if (typeof value === "function") return;
	if (!isRecord(value)) fail(path, "must be a function or { json | header | credential, unit }");
	const expiry = value as Record<string, unknown>;
	const sources = ["json", "header", "credential"].filter((key) => expiry[key] !== undefined);
	if (sources.length !== 1) fail(path, "must name exactly one of json, header or credential");
	const source = sources[0] as string;
	if (credentialOnly && source !== "credential")
		fail(path, "must read the credential when the state comes from the credential");
	onlyFields(expiry, new Set([source, "unit"]), path, fail);
	nonEmptyString(expiry[source], `${path}.${source}`, fail);
	const units = source === "credential" ? CREDENTIAL_EXPIRY_UNITS : EXPIRY_UNITS;
	if (typeof expiry.unit !== "string" || !units.has(expiry.unit))
		fail(`${path}.unit`, `must be one of ${[...units].join(", ")}`);
}

/** Returns the value names the capture produces. */
function validateCapture(
	value: unknown,
	path: string,
	from: string,
	fail: Fail,
): { values: Set<string>; cookies: boolean; expiresAt: boolean } {
	if (!isRecord(value)) fail(path, "must be an object");
	const capture = value as Record<string, unknown>;
	onlyFields(
		capture,
		from === "credential" ? CREDENTIAL_CAPTURE_FIELDS : CAPTURE_FIELDS,
		path,
		fail,
	);
	const values = new Set<string>();
	let cookies = false;
	if (from === "credential") {
		if (capture.credential === undefined)
			fail(path, "must declare credential keys when the state comes from the credential");
		for (const name of Object.keys(stringRecord(capture.credential, `${path}.credential`, fail)))
			values.add(name);
	} else {
		if (capture.credential !== undefined)
			fail(`${path}.credential`, 'is only valid with acquire.from "credential"');
		if (capture.cookies !== undefined) {
			stringList(capture.cookies, `${path}.cookies`, fail);
			cookies = true;
		}
		for (const key of ["headers", "json"] as const) {
			if (capture[key] === undefined) continue;
			for (const name of Object.keys(stringRecord(capture[key], `${path}.${key}`, fail))) {
				if (values.has(name)) fail(`${path}.${key}.${name}`, "repeats a captured value name");
				values.add(name);
			}
		}
		if (!cookies && values.size === 0)
			fail(path, "must capture at least one of cookies, headers or json");
	}
	if (capture.expiresAt !== undefined)
		validateExpiry(capture.expiresAt, `${path}.expiresAt`, from === "credential", fail);
	return { values, cookies, expiresAt: capture.expiresAt !== undefined };
}

function validateAcquire(
	value: unknown,
	path: string,
	fail: Fail,
): { from: string; values: Set<string>; cookies: boolean; expiresAt: boolean } {
	if (!isRecord(value)) fail(path, "must be an object");
	const acquire = value as Record<string, unknown>;
	const from = acquire.from;
	if (typeof from !== "string" || !(from in ACQUIRE_FIELDS))
		fail(`${path}.from`, 'must be "response", "request" or "credential"');
	onlyFields(acquire, ACQUIRE_FIELDS[from as string] as ReadonlySet<string>, path, fail);
	if (from === "request") {
		const request = acquire.request;
		if (typeof request !== "function") {
			if (!isRecord(request)) fail(`${path}.request`, "must be a request object or a function");
			const spec = request as Record<string, unknown>;
			onlyFields(spec, ACQUIRE_REQUEST_FIELDS, `${path}.request`, fail);
			nonEmptyString(spec.url, `${path}.request.url`, fail);
			if (
				spec.method !== undefined &&
				(typeof spec.method !== "string" || !HTTP_METHODS.has(spec.method.toUpperCase()))
			)
				fail(`${path}.request.method`, "must be an HTTP method");
			if (spec.headers !== undefined) stringRecord(spec.headers, `${path}.request.headers`, fail);
			if (spec.body !== undefined && typeof spec.body !== "string")
				fail(`${path}.request.body`, "must be a string");
			if (spec.client !== undefined && spec.client !== "stealth" && spec.client !== "http")
				fail(`${path}.request.client`, 'must be "stealth" or "http"');
		}
	}
	if (acquire.when !== undefined) validateMatcher(acquire.when, `${path}.when`, fail);
	return {
		from: from as string,
		...validateCapture(acquire.capture, `${path}.capture`, from as string, fail),
	};
}

function validateCarry(
	value: unknown,
	path: string,
	captured: { values: Set<string>; cookies: boolean },
	fail: Fail,
): void {
	const items = Array.isArray(value) ? value : [value];
	if (items.length === 0) fail(path, "must carry at least one value");
	items.forEach((item, index) => {
		const itemPath = Array.isArray(value) ? `${path}[${index}]` : path;
		if (!isRecord(item)) fail(itemPath, "must be an object");
		const carry = item as Record<string, unknown>;
		const as = carry.as;
		if (typeof as !== "string" || !(as in CARRY_FIELDS))
			fail(`${itemPath}.as`, 'must be "cookies", "cookie", "cookie-header", "header" or "query"');
		onlyFields(carry, CARRY_FIELDS[as as string] as ReadonlySet<string>, itemPath, fail);
		if (as === "cookies") {
			if (!captured.cookies)
				fail(
					itemPath,
					'{ as: "cookies" } needs capture.cookies',
					"Declare the cookie names in capture.cookies.",
				);
			return;
		}
		const name =
			as === "cookie-header" ? undefined : nonEmptyString(carry.name, `${itemPath}.name`, fail);
		const valueName = nonEmptyString(carry.value, `${itemPath}.value`, fail);
		if (!captured.values.has(valueName))
			fail(
				`${itemPath}.value`,
				`"${valueName}" is not a value the capture produces`,
				`Use one of ${[...captured.values].map((item) => `"${item}"`).join(", ") || "the captured value names"}.`,
			);
		if (as === "header" && name !== undefined) {
			if (isStealthOwnedHeaderName(name.toLowerCase()) || name.toLowerCase() === "cookie")
				fail(`${itemPath}.name`, `"${name}" is a header the SDK owns or carries itself`);
			if (
				carry.format !== undefined &&
				(typeof carry.format !== "string" || !carry.format.includes("{value}"))
			)
				fail(`${itemPath}.format`, 'must be a string containing "{value}"');
		}
	});
}

function validateValidity(
	value: unknown,
	path: string,
	captured: { from: string; expiresAt: boolean },
	fail: Fail,
): void {
	if (!isRecord(value)) fail(path, "must be an object");
	const validity = value as Record<string, unknown>;
	onlyFields(validity, VALIDITY_FIELDS, path, fail);
	if (validity.ttl !== undefined) duration(validity.ttl, `${path}.ttl`, fail);
	if (validity.idleTtl !== undefined) duration(validity.idleTtl, `${path}.idleTtl`, fail);
	if (validity.maxUses !== undefined) positiveInteger(validity.maxUses, `${path}.maxUses`, fail);
	if (validity.invalidWhen !== undefined && typeof validity.invalidWhen !== "function") {
		if (Array.isArray(validity.invalidWhen)) {
			if (validity.invalidWhen.length === 0) fail(`${path}.invalidWhen`, "must not be empty");
			for (const [index, matcher] of validity.invalidWhen.entries())
				validateMatcher(matcher, `${path}.invalidWhen[${index}]`, fail);
		} else {
			validateMatcher(validity.invalidWhen, `${path}.invalidWhen`, fail);
		}
	}
	if (validity.reacquire !== undefined) {
		if (
			typeof validity.reacquire !== "number" ||
			!Number.isInteger(validity.reacquire) ||
			validity.reacquire < 0
		)
			fail(`${path}.reacquire`, "must be a non-negative integer");
		if (captured.from === "credential" && validity.reacquire !== 0)
			fail(
				`${path}.reacquire`,
				"must be 0 or omitted when the state comes from the credential",
				"A credential is renewed by the gateway's auth.flow.refresh, never in-process.",
			);
	}
	if (validity.replayMethods !== undefined) {
		const methods = stringList(validity.replayMethods, `${path}.replayMethods`, fail);
		for (const method of methods)
			if (!HTTP_METHODS.has(method.toUpperCase()))
				fail(`${path}.replayMethods`, `"${method}" is not an HTTP method`);
	}
	if (
		validity.ttl === undefined &&
		validity.idleTtl === undefined &&
		validity.maxUses === undefined &&
		validity.invalidWhen === undefined &&
		!captured.expiresAt
	)
		fail(
			path,
			"must bound the state with ttl, idleTtl, maxUses, invalidWhen or capture.expiresAt",
			"Declare at least one of them so a state is never kept forever.",
		);
}

function validateDistribute(
	value: unknown,
	path: string,
	from: string,
	allowedHosts: readonly string[] | undefined,
	fail: Fail,
): void {
	if (!isRecord(value)) fail(path, "must be an object");
	const distribute = value as Record<string, unknown>;
	onlyFields(distribute, DISTRIBUTE_FIELDS, path, fail);
	const hosts = stringList(distribute.hosts, `${path}.hosts`, fail);
	if (allowedHosts) {
		const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
		for (const host of hosts)
			if (!allowed.has(host.toLowerCase()))
				fail(
					`${path}.hosts`,
					`"${host}" is not in allowedHosts`,
					`Add "${host}" to allowedHosts or remove it here.`,
				);
	}
	if (distribute.operations !== undefined)
		stringList(distribute.operations, `${path}.operations`, fail);
	if (
		distribute.scope !== undefined &&
		distribute.scope !== "provider" &&
		distribute.scope !== "connection"
	)
		fail(`${path}.scope`, 'must be "provider" or "connection"');
	if (from === "credential" && distribute.scope === "provider")
		fail(
			`${path}.scope`,
			'must be "connection" (or omitted) when the state comes from the credential',
		);
	if (
		distribute.qps !== undefined &&
		(typeof distribute.qps !== "number" || !Number.isFinite(distribute.qps) || distribute.qps <= 0)
	)
		fail(`${path}.qps`, "must be a positive number");
	if (distribute.maxConcurrent !== undefined)
		positiveInteger(distribute.maxConcurrent, `${path}.maxConcurrent`, fail);
	if (
		distribute.egress !== undefined &&
		distribute.egress !== "independent" &&
		distribute.egress !== "pinned"
	)
		fail(`${path}.egress`, 'must be "independent" or "pinned"');
}

/** Shape checks that need only the declaration (`defineProvider`). */
export function validateProviderSessionState(config: {
	readonly id: string;
	readonly sessionState?: unknown;
	readonly allowedHosts?: readonly string[];
	readonly credential?: CredentialDeclaration;
}): void {
	if (config.sessionState === undefined) return;
	const fail = failer(config.id);
	if (!isRecord(config.sessionState) || Object.keys(config.sessionState).length === 0)
		fail("sessionState", "must be a non-empty object of named declarations");
	for (const [name, declaration] of Object.entries(
		config.sessionState as Record<string, unknown>,
	)) {
		const path = `sessionState.${name}`;
		if (name.trim() === "") fail("sessionState", "declaration names must be non-empty");
		if (!isRecord(declaration)) fail(path, "must be an object");
		const record = declaration as Record<string, unknown>;
		onlyFields(record, DECLARATION_FIELDS, path, fail);
		for (const field of DECLARATION_FIELDS)
			if (record[field] === undefined) fail(`${path}.${field}`, "is required");
		const captured = validateAcquire(record.acquire, `${path}.acquire`, fail);
		if (captured.from === "credential") {
			if (!config.credential)
				fail(`${path}.acquire`, 'needs a credential declaration for acquire.from "credential"');
			const keys = new Set(config.credential?.keys ?? []);
			const capture = (record.acquire as { capture: { credential: Record<string, string> } })
				.capture;
			for (const key of Object.values(capture.credential))
				if (!keys.has(key))
					fail(`${path}.acquire.capture.credential`, `"${key}" is not in credential.keys`);
		}
		validateCarry(record.carry, `${path}.carry`, captured, fail);
		validateValidity(record.validity, `${path}.validity`, captured, fail);
		validateDistribute(
			record.distribute,
			`${path}.distribute`,
			captured.from,
			config.allowedHosts,
			fail,
		);
	}
}

/**
 * `distribute.operations` names operations that exist only once `buildProvider`
 * receives the operation map, like `proxy.operations`.
 */
export function validateSessionStateOperationScope(
	providerId: string,
	sessionState: Readonly<Record<string, ProviderSessionState>> | undefined,
	operations: Record<string, unknown>,
): void {
	if (!sessionState) return;
	const fail = failer(providerId);
	for (const [name, declaration] of Object.entries(sessionState)) {
		for (const operationId of declaration.distribute.operations ?? []) {
			if (!Object.hasOwn(operations, operationId))
				fail(
					`sessionState.${name}.distribute.operations`,
					`"${operationId}" is not a declared operation`,
					`Use one of ${Object.keys(operations)
						.map((id) => `"${id}"`)
						.join(", ")}.`,
				);
		}
	}
}
