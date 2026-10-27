/**
 * Session-state layer runtime (ADR-0008 D9 extended to upstream session state):
 * the provider declares what a state is (acquire, carry, validity, distribute)
 * and the SDK acquires, keeps, distributes, judges and renews it.
 *
 * One registry lives per server app and holds the pools; one binding per
 * operation context selects the declarations in scope for that operation. The
 * stealth and http clients call `binding.run` through a client adapter, so both
 * clients share one state machine and one pool per declaration and profile.
 *
 * Distribution follows the declared share, not a rate limit: `distribute.qps`
 * is the number of requests per second assigned to one state. A request takes
 * a state with room left in its share; when none has room, the request
 * acquires another state instead of waiting. Requests wait only for an
 * acquisition already in flight for the state they were assigned to.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { SDKError } from "../errors.js";
import type {
	CredentialContext,
	EnvContext,
	HttpClient,
	ProviderDefinition,
	ProviderSessionState,
	ResponseMatcher,
	SessionStateAcquireRequest,
	SessionStateCapture,
	SessionStateCarry,
	SessionStateClassification,
	SessionStateExpiry,
	SessionStateJudge,
	SessionStateResponseView,
	StealthClient,
} from "../types.js";
import { BoundedExpiringMap } from "./bounded-expiring-map.js";
import { registerDiagnosticValue } from "./diagnostic-env.js";
import { SESSION_STATE_DEFAULTS } from "./session-state-defaults.js";
import { parseSessionStateDurationMs } from "./session-state-duration.js";
import { cookieValuesFromHeaders } from "./stealth-cookies.js";

/** Client option key under which the server hands an operation's binding to ctx.stealth and ctx.http. */
export const SESSION_STATE_BINDING = Symbol("apifuse.sessionState.binding");
/** Stealth fetch option key: the egress a pinned state was acquired on. */
export const SESSION_STATE_PINNED_EGRESS = Symbol("apifuse.sessionState.pinnedEgress");
/** Non-enumerable stealth response key: the egress the response arrived on. */
export const SESSION_STATE_RESPONSE_EGRESS = Symbol("apifuse.sessionState.responseEgress");
/** Non-enumerable http response key: every `Set-Cookie` header, unjoined. */
export const SESSION_STATE_SET_COOKIES = Symbol("apifuse.sessionState.setCookies");

/** Telemetry events, counted per request on the stealth or http payload. */
export type SessionStateTelemetryEvent =
	| "acquired"
	| "reused"
	| "expired"
	| "invalidated"
	| "reacquired"
	| "waited";

export interface SessionStateCookieStore {
	readonly setCookies: readonly string[];
	readonly url: string;
}

/** What one send carries, merged across the declarations that apply. */
export interface SessionStateCarryPlan {
	readonly cookieStores: readonly SessionStateCookieStore[];
	readonly cookies: readonly (readonly [string, string])[];
	readonly headers: readonly (readonly [string, string])[];
	readonly query: readonly (readonly [string, string])[];
	readonly egress?: unknown;
}

export interface SessionStateExchange {
	readonly view: SessionStateResponseView;
	readonly setCookies: readonly string[];
	readonly egress?: unknown;
}

/** The client-specific half of one request; see stealth.ts and http.ts. */
export interface SessionStateClientAdapter<TResponse> {
	readonly client: "stealth" | "http";
	/** Clients with different fingerprints never share a state. */
	readonly profile: string;
	readonly url: URL;
	readonly method: string;
	readonly signal?: AbortSignal;
	callerHasCookie(): boolean;
	callerHasHeader(name: string): boolean;
	callerHasQuery(name: string): boolean;
	/** Sends the request once with the plan applied and never throws on an HTTP status. */
	send(plan: SessionStateCarryPlan, replay: number): Promise<TResponse>;
	exchange(response: TResponse): Promise<SessionStateExchange>;
	/** Issues a declared acquisition request on this client, outside the layer. */
	acquire(request: SessionStateAcquireRequest): Promise<SessionStateExchange>;
	/** Attaches the classification, or applies the caller's `throwOnHttpError` to an unclassified response. */
	finish(response: TResponse, classification: SessionStateClassification | undefined): TResponse;
}

export interface SessionStateBindingDeps {
	readonly connectionId?: string;
	readonly credential?: CredentialContext;
	readonly env: EnvContext;
	readonly signal?: AbortSignal;
	/** The operation's own clients, for acquisition handlers and cross-client acquisition requests. */
	readonly clients: () => { readonly http: HttpClient; readonly stealth: StealthClient };
	readonly record?: (client: "stealth" | "http", event: SessionStateTelemetryEvent) => void;
}

type Captured = {
	readonly values: Readonly<Record<string, string>>;
	readonly cookies?: SessionStateCookieStore;
	readonly expiresAt?: number;
};

/** A declaration as the runtime reads it. */
export type SessionStateRuntimeDeclaration = {
	readonly name: string;
	readonly declaration: ProviderSessionState;
	readonly hosts: ReadonlySet<string>;
	readonly operations?: ReadonlySet<string>;
	readonly scope: "provider" | "connection";
	readonly qps?: number;
	readonly maxConcurrent?: number;
	readonly pinned: boolean;
	readonly ttlMs?: number;
	readonly idleTtlMs?: number;
	readonly maxUses?: number;
	readonly reacquire: number;
	readonly replayMethods: ReadonlySet<string>;
	readonly carries: readonly SessionStateCarry[];
	readonly judge?: (view: SessionStateResponseView) => boolean;
};

const EMPTY_PLAN: SessionStateCarryPlan = { cookieStores: [], cookies: [], headers: [], query: [] };

/** Set while an acquisition request or handler runs, so its own requests bypass the layer. */
const acquisitionScope = new AsyncLocalStorage<true>();

// ---------------------------------------------------------------------------
// Durations, matchers and capture
// ---------------------------------------------------------------------------

const regexCache = new Map<string, RegExp>();

function regex(source: string): RegExp {
	let compiled = regexCache.get(source);
	if (!compiled) {
		compiled = new RegExp(source);
		regexCache.set(source, compiled);
	}
	return compiled;
}

/** Reads a dot path (`data.items.0.token`) from a parsed JSON value. */
export function readJsonPath(value: unknown, path: string): unknown {
	let current = value;
	for (const segment of path.split(".")) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function tryJson(view: SessionStateResponseView): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: view.json() };
	} catch {
		return { ok: false };
	}
}

function statusMatches(status: number, expected: NonNullable<ResponseMatcher["status"]>): boolean {
	if (typeof expected === "number") return status === expected;
	if (Array.isArray(expected)) return expected.includes(status);
	const range = expected as { readonly min: number; readonly max: number };
	return status >= range.min && status <= range.max;
}

/** Whether one declarative matcher holds for the response: every present field must hold. */
export function matchesResponse(matcher: ResponseMatcher, view: SessionStateResponseView): boolean {
	if (matcher.status !== undefined && !statusMatches(view.status, matcher.status)) return false;
	if (matcher.headers) {
		for (const [name, expected] of Object.entries(matcher.headers)) {
			const actual = view.headers[name.toLowerCase()];
			if (actual === undefined) return false;
			if (expected === true) continue;
			if (typeof expected === "string") {
				if (actual.toLowerCase() !== expected.toLowerCase()) return false;
			} else if (!regex(expected.pattern).test(actual)) {
				return false;
			}
		}
	}
	if (matcher.bodyIncludes && !matcher.bodyIncludes.some((needle) => view.body.includes(needle)))
		return false;
	if (matcher.bodyPattern !== undefined && !regex(matcher.bodyPattern).test(view.body))
		return false;
	if (matcher.json) {
		const parsed = tryJson(view);
		if (!parsed.ok) return false;
		for (const [path, expected] of Object.entries(matcher.json)) {
			const actual = readJsonPath(parsed.value, path);
			if (expected !== null && typeof expected === "object") {
				if (actual === undefined || !regex(expected.pattern).test(String(actual))) return false;
			} else if (actual !== expected) {
				return false;
			}
		}
	}
	return true;
}

function compileJudge(
	judge: SessionStateJudge | undefined,
): ((view: SessionStateResponseView) => boolean) | undefined {
	if (judge === undefined) return undefined;
	if (typeof judge === "function") return (view) => judge(view) === true;
	const matchers: readonly ResponseMatcher[] = Array.isArray(judge)
		? judge
		: [judge as ResponseMatcher];
	return (view) => matchers.some((matcher) => matchesResponse(matcher, view));
}

function cookieName(setCookie: string): string {
	const separator = setCookie.indexOf("=");
	return (separator < 0 ? "" : setCookie.slice(0, separator)).trim();
}

function primitiveString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	return undefined;
}

function expiryFromValue(
	raw: string | undefined,
	unit: "epoch-seconds" | "seconds-from-now" | "iso",
	now: number,
): number | undefined {
	if (raw === undefined) return undefined;
	if (unit === "iso") {
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	const seconds = Number(raw);
	if (!Number.isFinite(seconds)) return undefined;
	return unit === "epoch-seconds" ? seconds * 1_000 : now + seconds * 1_000;
}

function resolveExpiry(
	expiry: SessionStateExpiry | undefined,
	values: Readonly<Record<string, string>>,
	sources: {
		readonly view?: SessionStateResponseView;
		readonly credential?: CredentialContext;
	},
	now: number,
): number | undefined {
	if (expiry === undefined) return undefined;
	if (typeof expiry === "function") return expiry(values);
	if ("json" in expiry) {
		if (!sources.view) return undefined;
		const parsed = tryJson(sources.view);
		if (!parsed.ok) return undefined;
		return expiryFromValue(
			primitiveString(readJsonPath(parsed.value, expiry.json)),
			expiry.unit,
			now,
		);
	}
	if ("header" in expiry) {
		return expiryFromValue(sources.view?.headers[expiry.header.toLowerCase()], expiry.unit, now);
	}
	return expiryFromValue(sources.credential?.get(expiry.credential), expiry.unit, now);
}

function registerValues(values: Iterable<string>): void {
	for (const value of values) registerDiagnosticValue(value);
}

/** Captures every declared name from a response, or nothing. Captured values are registered as diagnostic values. */
function captureFromExchange(
	capture: SessionStateCapture,
	when: ResponseMatcher | undefined,
	exchange: SessionStateExchange,
	now: number,
): Captured | undefined {
	const { view } = exchange;
	if (when && !matchesResponse(when, view)) return undefined;
	const values: Record<string, string> = {};
	let cookies: SessionStateCookieStore | undefined;
	if (capture.cookies && capture.cookies.length > 0) {
		const wanted = new Set(capture.cookies);
		const found = new Set<string>();
		const setCookies: string[] = [];
		for (const setCookie of exchange.setCookies) {
			const name = cookieName(setCookie);
			if (!wanted.has(name)) continue;
			const value = cookieValuesFromHeaders(setCookie)[0];
			if (!value) continue;
			found.add(name);
			setCookies.push(setCookie);
		}
		if (found.size !== wanted.size) return undefined;
		cookies = { setCookies, url: view.url };
		registerValues(setCookies.flatMap((setCookie) => cookieValuesFromHeaders(setCookie)));
	}
	for (const [valueName, header] of Object.entries(capture.headers ?? {})) {
		const value = view.headers[header.toLowerCase()];
		if (!value) return undefined;
		values[valueName] = value;
	}
	const jsonPaths = Object.entries(capture.json ?? {});
	if (jsonPaths.length > 0) {
		const parsed = tryJson(view);
		if (!parsed.ok) return undefined;
		for (const [valueName, path] of jsonPaths) {
			const value = primitiveString(readJsonPath(parsed.value, path));
			if (!value) return undefined;
			values[valueName] = value;
		}
	}
	if (!cookies && Object.keys(values).length === 0) return undefined;
	registerValues(Object.values(values));
	const expiresAt = resolveExpiry(capture.expiresAt, values, { view }, now);
	return {
		values,
		...(cookies ? { cookies } : {}),
		...(expiresAt === undefined ? {} : { expiresAt }),
	};
}

function captureFromCredential(
	capture: Pick<SessionStateCapture, "credential" | "expiresAt">,
	credential: CredentialContext | undefined,
): Captured | undefined {
	if (!credential) return undefined;
	const values: Record<string, string> = {};
	for (const [valueName, key] of Object.entries(capture.credential ?? {})) {
		const value = credential.get(key);
		if (value) values[valueName] = value;
	}
	if (Object.keys(values).length === 0) return undefined;
	registerValues(Object.values(values));
	return { values };
}

/** Splits a `Set-Cookie` value that a fetch implementation joined with commas. */
export function splitJoinedSetCookie(value: string): string[] {
	const parts: string[] = [];
	let start = 0;
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] !== ",") continue;
		// A comma starts a new cookie only when a `name=` follows before any `;`.
		const rest = value.slice(index + 1);
		if (/^\s*[^=;,\s]+=/.test(rest)) {
			parts.push(value.slice(start, index).trim());
			start = index + 1;
		}
	}
	parts.push(value.slice(start).trim());
	return parts.filter((part) => part.length > 0);
}

/** Builds the judge view of a response whose body is already a string. */
export function createSessionStateResponseView(input: {
	readonly url: string;
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}): SessionStateResponseView {
	const headers = Object.fromEntries(
		Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value]),
	);
	let parsed: { value: unknown } | undefined;
	return {
		url: input.url,
		status: input.status,
		headers,
		body: input.body,
		json() {
			parsed ??= { value: JSON.parse(input.body) };
			return parsed.value;
		},
	};
}

function setCookiesFromHeaders(headers: Readonly<Record<string, string>>): string[] {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === "set-cookie") return splitJoinedSetCookie(value);
	}
	return [];
}

/** Reads what a provider acquisition handler returned: a view, a stealth response or an http response. */
async function exchangeFromHandlerResult(
	result: unknown,
	fallbackUrl: string,
): Promise<SessionStateExchange> {
	if (result === null || typeof result !== "object") {
		throw new SDKError("A session-state acquisition handler must return a response", {
			code: "SESSION_STATE_ACQUIRE_INVALID",
			fix: "Return the response of the acquisition request, for example `return ctx.stealth.fetch(url)`.",
		});
	}
	const record = result as Record<PropertyKey, unknown>;
	const status = typeof record.status === "number" ? record.status : 0;
	const headers =
		record.headers && typeof record.headers === "object"
			? (record.headers as Record<string, string>)
			: {};
	const body =
		typeof record.body === "string"
			? record.body
			: typeof record.text === "function"
				? String(await (record.text as () => Promise<unknown>)())
				: "";
	const url = typeof record.url === "string" ? record.url : fallbackUrl;
	const rawHeaders = Array.isArray(record.rawHeaders)
		? (record.rawHeaders as [string, string][])
		: undefined;
	const hiddenSetCookies = record[SESSION_STATE_SET_COOKIES];
	const setCookies = rawHeaders
		? rawHeaders.filter(([name]) => name.toLowerCase() === "set-cookie").map(([, value]) => value)
		: Array.isArray(hiddenSetCookies)
			? (hiddenSetCookies as string[])
			: setCookiesFromHeaders(headers);
	return {
		view: createSessionStateResponseView({ url, status, headers, body }),
		setCookies,
		...(record[SESSION_STATE_RESPONSE_EGRESS] === undefined
			? {}
			: { egress: record[SESSION_STATE_RESPONSE_EGRESS] }),
	};
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

type EntrySettlement = { readonly ok: true } | { readonly ok: false; readonly error?: unknown };

class StateEntry {
	status: "pending" | "ready" | "failed" | "retired" = "pending";
	values: Readonly<Record<string, string>> = {};
	cookies: SessionStateCookieStore | undefined;
	expiresAt: number | undefined;
	egress: unknown;
	issuedAt = 0;
	lastUsedAt: number;
	uses = 0;
	inflight = 0;
	tokens: number;
	tokensAt: number;
	readonly settled: Promise<EntrySettlement>;
	#settle!: (settlement: EntrySettlement) => void;

	constructor(now: number, capacity: number) {
		this.lastUsedAt = now;
		this.tokens = capacity;
		this.tokensAt = now;
		this.settled = new Promise((resolve) => {
			this.#settle = resolve;
		});
	}

	/** Read after an await: another request may have retired the state meanwhile. */
	isReady(): boolean {
		return this.status === "ready";
	}

	fill(captured: Captured, egress: unknown, now: number): void {
		this.values = captured.values;
		this.cookies = captured.cookies;
		this.expiresAt = captured.expiresAt;
		this.egress = egress;
		if (this.status === "pending") {
			this.issuedAt = now;
			this.status = "ready";
			this.#settle({ ok: true });
		}
	}

	fail(error?: unknown): void {
		if (this.status !== "pending") return;
		this.status = "failed";
		this.#settle(error === undefined ? { ok: false } : { ok: false, error });
	}
}

class StatePool {
	readonly #declaration: SessionStateRuntimeDeclaration;
	readonly #entries: StateEntry[] = [];

	constructor(declaration: SessionStateRuntimeDeclaration) {
		this.#declaration = declaration;
	}

	get size(): number {
		return this.#entries.length;
	}

	#capacity(): number {
		const { qps } = this.#declaration;
		return qps === undefined ? Number.POSITIVE_INFINITY : Math.max(1, qps);
	}

	#refill(entry: StateEntry, now: number): void {
		const { qps } = this.#declaration;
		if (qps === undefined) return;
		const elapsed = Math.max(0, now - entry.tokensAt);
		entry.tokens = Math.min(
			this.#capacity(),
			entry.tokens + (elapsed * qps) / SESSION_STATE_DEFAULTS.qpsWindowMs,
		);
		entry.tokensAt = now;
	}

	#expired(entry: StateEntry, now: number): boolean {
		if (entry.status !== "ready") return false;
		const { ttlMs, idleTtlMs, maxUses } = this.#declaration;
		if (ttlMs !== undefined && now >= entry.issuedAt + ttlMs) return true;
		if (idleTtlMs !== undefined && entry.inflight === 0 && now >= entry.lastUsedAt + idleTtlMs)
			return true;
		if (entry.expiresAt !== undefined && now >= entry.expiresAt) return true;
		return maxUses !== undefined && entry.uses >= maxUses;
	}

	#hasRoom(entry: StateEntry, now: number): boolean {
		if (entry.status !== "ready" && entry.status !== "pending") return false;
		this.#refill(entry, now);
		if (this.#declaration.qps !== undefined && entry.tokens < 1) return false;
		const { maxConcurrent, maxUses } = this.#declaration;
		if (maxUses !== undefined && entry.uses >= maxUses) return false;
		return maxConcurrent === undefined || entry.inflight < maxConcurrent;
	}

	/** Drops expired and settled-failed states; returns how many expired. */
	prune(now: number): number {
		let expired = 0;
		for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
			const entry = this.#entries[index] as StateEntry;
			if (entry.status === "failed" || entry.status === "retired") {
				this.#entries.splice(index, 1);
			} else if (this.#expired(entry, now)) {
				entry.status = "retired";
				this.#entries.splice(index, 1);
				expired += 1;
			}
		}
		return expired;
	}

	#claim(entry: StateEntry, now: number): void {
		if (this.#declaration.qps !== undefined) entry.tokens -= 1;
		entry.inflight += 1;
		entry.lastUsedAt = now;
	}

	/**
	 * First fit in acquisition order: the oldest state with room in its share
	 * takes the request, so states beyond the current demand go unused and
	 * retire on their own lifetime.
	 */
	assign(now: number): { readonly entry: StateEntry; readonly acquiring: boolean } {
		for (const entry of this.#entries) {
			if (!this.#hasRoom(entry, now)) continue;
			this.#claim(entry, now);
			return { entry, acquiring: false };
		}
		const entry = new StateEntry(now, this.#capacity());
		this.#entries.push(entry);
		this.#claim(entry, now);
		return { entry, acquiring: true };
	}

	/** Adds a state captured outside an assignment and claims it for the caller. */
	add(captured: Captured, egress: unknown, now: number): StateEntry {
		const entry = new StateEntry(now, this.#capacity());
		entry.fill(captured, egress, now);
		this.#entries.push(entry);
		this.#claim(entry, now);
		return entry;
	}

	retire(entry: StateEntry): void {
		entry.fail();
		entry.status = "retired";
		const index = this.#entries.indexOf(entry);
		if (index >= 0) this.#entries.splice(index, 1);
	}

	release(entry: StateEntry): void {
		entry.inflight = Math.max(0, entry.inflight - 1);
	}
}

// ---------------------------------------------------------------------------
// Registry and binding
// ---------------------------------------------------------------------------

function normalizeDeclaration(
	name: string,
	declaration: ProviderSessionState,
): SessionStateRuntimeDeclaration {
	const { validity, distribute } = declaration;
	const durationMs = (value: string | undefined) =>
		value === undefined ? undefined : parseSessionStateDurationMs(value);
	return {
		name,
		declaration,
		hosts: new Set(distribute.hosts.map((host) => host.toLowerCase())),
		...(distribute.operations === undefined ? {} : { operations: new Set(distribute.operations) }),
		scope:
			declaration.acquire.from === "credential" ? "connection" : (distribute.scope ?? "provider"),
		...(distribute.qps === undefined ? {} : { qps: distribute.qps }),
		...(distribute.maxConcurrent === undefined ? {} : { maxConcurrent: distribute.maxConcurrent }),
		pinned: distribute.egress === "pinned",
		...(durationMs(validity.ttl) === undefined ? {} : { ttlMs: durationMs(validity.ttl) }),
		...(durationMs(validity.idleTtl) === undefined
			? {}
			: { idleTtlMs: durationMs(validity.idleTtl) }),
		...(validity.maxUses === undefined ? {} : { maxUses: validity.maxUses }),
		reacquire:
			declaration.acquire.from === "credential"
				? 0
				: (validity.reacquire ?? SESSION_STATE_DEFAULTS.reacquire),
		replayMethods: new Set(
			(validity.replayMethods ?? SESSION_STATE_DEFAULTS.replayMethods).map((method) =>
				method.toUpperCase(),
			),
		),
		carries: Array.isArray(declaration.carry)
			? (declaration.carry as readonly SessionStateCarry[])
			: [declaration.carry as SessionStateCarry],
		...(validity.invalidWhen === undefined ? {} : { judge: compileJudge(validity.invalidWhen) }),
	};
}

function hostMatches(declaration: SessionStateRuntimeDeclaration, url: URL): boolean {
	return (
		declaration.hosts.has(url.hostname.toLowerCase()) ||
		declaration.hosts.has(url.host.toLowerCase())
	);
}

/** Process-lifetime pools of one server app. */
export class SessionStateRegistry {
	readonly #declarations: readonly SessionStateRuntimeDeclaration[];
	readonly #names: ReadonlySet<string>;
	readonly #providerPools = new Map<string, StatePool>();
	readonly #connectionPools = new Map<string, BoundedExpiringMap<string, StatePool>>();
	readonly #now: () => number;

	constructor(
		sessionState: NonNullable<ProviderDefinition["sessionState"]>,
		now: () => number = Date.now,
	) {
		this.#declarations = Object.entries(sessionState).map(([name, declaration]) =>
			normalizeDeclaration(name, declaration),
		);
		this.#names = new Set(this.#declarations.map((declaration) => declaration.name));
		this.#now = now;
	}

	now(): number {
		return this.#now();
	}

	hasName(name: string): boolean {
		return this.#names.has(name);
	}

	pool(
		declaration: SessionStateRuntimeDeclaration,
		profile: string,
		connectionId: string | undefined,
	): StatePool {
		const key = `${declaration.name}\u0000${profile}`;
		if (declaration.scope === "provider") {
			let pool = this.#providerPools.get(key);
			if (!pool) {
				pool = new StatePool(declaration);
				this.#providerPools.set(key, pool);
			}
			return pool;
		}
		let pools = this.#connectionPools.get(key);
		if (!pools) {
			pools = new BoundedExpiringMap<string, StatePool>(
				SESSION_STATE_DEFAULTS.maxConnectionPools,
				() => Number.POSITIVE_INFINITY,
			);
			this.#connectionPools.set(key, pools);
		}
		const now = this.#now();
		const connection = connectionId as string;
		let pool = pools.get(connection, now);
		if (!pool) {
			pool = new StatePool(declaration);
			pools.set(connection, pool, now);
		}
		return pool;
	}

	/** The declarations in force for one operation; undefined when none is. */
	bind(operationId: string, deps: SessionStateBindingDeps): SessionStateBinding | undefined {
		const inScope = this.#declarations.filter(
			(declaration) => !declaration.operations || declaration.operations.has(operationId),
		);
		return inScope.length === 0 ? undefined : new SessionStateBinding(this, inScope, deps);
	}
}

/** Creates the app's registry, or undefined for a provider without `sessionState`. */
export function createSessionStateRegistry(
	provider: Pick<ProviderDefinition, "sessionState">,
	options: { readonly now?: () => number } = {},
): SessionStateRegistry | undefined {
	const sessionState = provider.sessionState;
	if (!sessionState || Object.keys(sessionState).length === 0) return undefined;
	return new SessionStateRegistry(sessionState, options.now);
}

type Lease = {
	readonly declaration: SessionStateRuntimeDeclaration;
	readonly pool?: StatePool;
	/** The claimed state, ready or still being acquired by this request. */
	entry?: StateEntry;
	/** This request's own response is the acquisition (`from: "response"` with no state yet). */
	acquiring: boolean;
	/** `from: "credential"` values for this request. */
	credential?: Captured;
	carried: boolean;
	budget: number;
	/** Acquisition requests this call issued for the declaration. */
	requests: number;
	classification?: SessionStateClassification["outcome"];
};

function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function parseCookieHeader(header: string): [string, string][] {
	return header
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.includes("="))
		.map((part) => {
			const separator = part.indexOf("=");
			return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
		});
}

/** One operation context's view of the registry. */
export class SessionStateBinding {
	readonly #registry: SessionStateRegistry;
	readonly #declarations: readonly SessionStateRuntimeDeclaration[];
	readonly #deps: SessionStateBindingDeps;

	constructor(
		registry: SessionStateRegistry,
		declarations: readonly SessionStateRuntimeDeclaration[],
		deps: SessionStateBindingDeps,
	) {
		this.#registry = registry;
		this.#declarations = declarations;
		this.#deps = deps;
	}

	/**
	 * The declarations that apply to one request, in declaration order. Empty
	 * inside an acquisition, for `sessionState: false`, and for a host or
	 * connection outside every declaration.
	 */
	select(
		url: URL,
		option: string | readonly string[] | false | undefined,
	): readonly SessionStateRuntimeDeclaration[] {
		if (option === false || acquisitionScope.getStore()) return [];
		let names: ReadonlySet<string> | undefined;
		if (option !== undefined) {
			const list = typeof option === "string" ? [option] : option;
			for (const name of list) {
				if (!this.#registry.hasName(name)) {
					throw new SDKError(`Unknown sessionState declaration "${name}"`, {
						code: "SESSION_STATE_UNKNOWN",
						fix: "Pass the name of a declaration under defineProvider({ sessionState }), or false.",
					});
				}
			}
			names = new Set(list);
		}
		return this.#declarations.filter(
			(declaration) =>
				(!names || names.has(declaration.name)) &&
				hostMatches(declaration, url) &&
				(declaration.declaration.acquire.from === "credential" ||
					declaration.scope === "provider" ||
					this.#deps.connectionId !== undefined),
		);
	}

	#record(client: "stealth" | "http", event: SessionStateTelemetryEvent, count = 1): void {
		for (let index = 0; index < count; index += 1) {
			try {
				this.#deps.record?.(client, event);
			} catch {
				/* Telemetry never changes the request. */
			}
		}
	}

	/** Whether the caller already occupies every place this declaration would carry to. */
	#blocked<T>(
		declaration: SessionStateRuntimeDeclaration,
		adapter: SessionStateClientAdapter<T>,
	): boolean {
		return declaration.carries.every((carry) => {
			switch (carry.as) {
				case "cookies":
				case "cookie":
				case "cookie-header":
					return adapter.callerHasCookie();
				case "header":
					return adapter.callerHasHeader(carry.name);
				case "query":
					return adapter.callerHasQuery(carry.name);
			}
			return false;
		});
	}

	async #acquireByRequest<T>(
		declaration: SessionStateRuntimeDeclaration,
		adapter: SessionStateClientAdapter<T>,
	): Promise<SessionStateExchange> {
		const acquire = declaration.declaration.acquire;
		if (acquire.from !== "request") throw new Error("unreachable: not a request acquisition");
		const spec = acquire.request;
		return acquisitionScope.run(true, async () => {
			if (typeof spec === "function") {
				const { http, stealth } = this.#deps.clients();
				const result = await spec({
					http,
					stealth,
					...(this.#deps.credential ? { credential: this.#deps.credential } : {}),
					env: this.#deps.env,
					...(adapter.signal ? { signal: adapter.signal } : {}),
				});
				return exchangeFromHandlerResult(result, adapter.url.href);
			}
			const client = spec.client ?? adapter.client;
			if (client === adapter.client) return adapter.acquire(spec);
			const { http, stealth } = this.#deps.clients();
			const result =
				client === "http"
					? await http.request(spec.url, {
							method: spec.method ?? "GET",
							...(spec.headers ? { headers: { ...spec.headers } } : {}),
							...(spec.body === undefined ? {} : { body: spec.body }),
							throwOnHttpError: false,
						})
					: await stealth.fetch(spec.url, {
							...(spec.method ? { method: spec.method } : {}),
							...(spec.headers ? { headers: { ...spec.headers } } : {}),
							...(spec.body === undefined ? {} : { body: spec.body }),
							throwOnHttpError: false,
						});
			return exchangeFromHandlerResult(result, spec.url);
		});
	}

	/**
	 * Gives the lease a state: a ready one with room, a pending one this request
	 * waits for, or a new one. `from: "request"` acquires before returning;
	 * `from: "response"` leaves `acquiring` set so the send itself acquires.
	 */
	async #fill<T>(lease: Lease, adapter: SessionStateClientAdapter<T>): Promise<void> {
		const { declaration, pool } = lease;
		if (!pool) return;
		const acquire = declaration.declaration.acquire;
		const now = this.#registry.now();
		this.#record(adapter.client, "expired", pool.prune(now));
		const { entry, acquiring } = pool.assign(now);
		if (!acquiring) {
			// Counted at assignment, so concurrent waiters cannot overrun maxUses.
			entry.uses += 1;
			if (entry.status === "ready") {
				lease.entry = entry;
				this.#record(adapter.client, "reused");
				return;
			}
			this.#record(adapter.client, "waited");
			const settlement = await waitFor(entry.settled, adapter.signal).catch((error: unknown) => {
				entry.uses -= 1;
				pool.release(entry);
				throw error;
			});
			if (settlement.ok && entry.isReady()) {
				lease.entry = entry;
				return;
			}
			entry.uses -= 1;
			pool.release(entry);
			if (!settlement.ok && settlement.error !== undefined) throw settlement.error;
			// The acquisition this request waited for yielded nothing: go out without a
			// state, and for passive acquisition let this response try to yield one.
			if (acquire.from === "response") lease.acquiring = true;
			else lease.classification = "acquire_failed";
			return;
		}
		if (acquire.from === "response") {
			lease.entry = entry;
			lease.acquiring = true;
			return;
		}
		let exchange: SessionStateExchange;
		lease.requests += 1;
		try {
			exchange = await this.#acquireByRequest(declaration, adapter);
		} catch (error) {
			// Requests waiting for this acquisition receive the same error.
			entry.fail(error);
			pool.retire(entry);
			pool.release(entry);
			throw error;
		}
		if (acquire.from !== "request") return;
		const captured = captureFromExchange(
			acquire.capture,
			acquire.when,
			exchange,
			this.#registry.now(),
		);
		if (!captured) {
			pool.retire(entry);
			pool.release(entry);
			lease.classification = "acquire_failed";
			return;
		}
		entry.fill(captured, exchange.egress, this.#registry.now());
		entry.uses += 1;
		lease.entry = entry;
		this.#record(adapter.client, "acquired");
	}

	#plan<T>(leases: readonly Lease[], adapter: SessionStateClientAdapter<T>): SessionStateCarryPlan {
		const cookieStores: SessionStateCookieStore[] = [];
		const cookies: [string, string][] = [];
		const headers: [string, string][] = [];
		const query: [string, string][] = [];
		let egress: unknown;
		const callerCookie = adapter.callerHasCookie();
		const now = this.#registry.now();
		for (const lease of leases) {
			lease.carried = false;
			const source =
				lease.credential ??
				(lease.entry?.status === "ready" && !lease.acquiring
					? { values: lease.entry.values, cookies: lease.entry.cookies }
					: undefined);
			if (!source) continue;
			for (const carry of lease.declaration.carries) {
				if (carry.as === "cookies") {
					if (callerCookie || !source.cookies) continue;
					cookieStores.push(source.cookies);
					registerValues(
						source.cookies.setCookies.flatMap((setCookie) => cookieValuesFromHeaders(setCookie)),
					);
					lease.carried = true;
					continue;
				}
				const value = source.values[carry.value];
				if (value === undefined) continue;
				if (carry.as === "cookie" || carry.as === "cookie-header") {
					if (callerCookie) continue;
					const pairs: [string, string][] =
						carry.as === "cookie" ? [[carry.name, value]] : parseCookieHeader(value);
					for (const pair of pairs) {
						if (!cookies.some(([name]) => name === pair[0])) cookies.push(pair);
					}
				} else if (carry.as === "header") {
					const lower = carry.name.toLowerCase();
					if (adapter.callerHasHeader(carry.name)) continue;
					if (headers.some(([name]) => name.toLowerCase() === lower)) continue;
					headers.push([
						carry.name,
						carry.format === undefined ? value : carry.format.replace("{value}", value),
					]);
				} else {
					if (adapter.callerHasQuery(carry.name)) continue;
					if (query.some(([name]) => name === carry.name)) continue;
					query.push([carry.name, value]);
				}
				registerDiagnosticValue(value);
				lease.carried = true;
			}
			if (lease.carried && lease.entry) {
				lease.entry.lastUsedAt = now;
				if (lease.declaration.pinned && lease.entry.egress !== undefined && egress === undefined)
					egress = lease.entry.egress;
			}
		}
		return {
			cookieStores,
			cookies,
			headers,
			query,
			...(egress === undefined ? {} : { egress }),
		};
	}

	#releaseLease(lease: Lease): void {
		if (!lease.pool || !lease.entry) return;
		// A send that failed before its response settled the acquisition fails it, so
		// requests waiting on it go out on their own instead of hanging.
		lease.entry.fail();
		lease.pool.release(lease.entry);
		lease.entry = undefined;
	}

	/**
	 * Judges one response for one lease and decides the next step: nothing,
	 * a replay carrying a fresh state, or a classification.
	 */
	async #judge<T>(
		lease: Lease,
		exchange: SessionStateExchange,
		adapter: SessionStateClientAdapter<T>,
	): Promise<"done" | "replay"> {
		const { declaration, pool } = lease;
		const acquire = declaration.declaration.acquire;
		const now = this.#registry.now();
		if (acquire.from === "credential") {
			if (lease.carried && declaration.judge?.(exchange.view))
				lease.classification = "credential_invalid";
			return "done";
		}
		if (!pool) return "done";
		const participated = lease.carried || lease.acquiring;
		if (!participated) return "done";
		const invalid = declaration.judge?.(exchange.view) === true;
		const captured =
			acquire.from === "response"
				? captureFromExchange(acquire.capture, acquire.when, exchange, now)
				: undefined;

		let fresh: StateEntry | undefined;
		if (lease.acquiring) {
			lease.acquiring = false;
			if (captured) {
				if (lease.entry && lease.entry.status === "pending") {
					lease.entry.fill(captured, exchange.egress, now);
					fresh = lease.entry;
				} else {
					if (lease.entry) pool.release(lease.entry);
					fresh = pool.add(captured, exchange.egress, now);
					lease.entry = fresh;
				}
				this.#record(adapter.client, "acquired");
			} else if (lease.entry) {
				lease.entry.fail();
				pool.release(lease.entry);
				lease.entry = undefined;
			}
		} else if (lease.entry) {
			if (invalid) {
				pool.retire(lease.entry);
				pool.release(lease.entry);
				lease.entry = undefined;
				this.#record(adapter.client, "invalidated");
				if (captured) {
					fresh = pool.add(captured, exchange.egress, now);
					lease.entry = fresh;
					this.#record(adapter.client, "acquired");
				}
			} else if (captured) {
				// A served response that renews the value keeps the state's issue time and use count.
				lease.entry.values = captured.values;
				if (captured.cookies) lease.entry.cookies = captured.cookies;
				if (captured.expiresAt !== undefined) lease.entry.expiresAt = captured.expiresAt;
			}
		}
		if (!invalid) return "done";

		if (lease.budget <= 0) {
			lease.classification = "reacquire_exhausted";
			return "done";
		}
		if (acquire.from === "request") {
			lease.budget -= 1;
			this.#record(adapter.client, "reacquired");
			await this.#fill(lease, adapter);
			if (lease.classification || !lease.entry) {
				lease.classification ??= "acquire_failed";
				return "done";
			}
			if (!declaration.replayMethods.has(adapter.method)) {
				lease.classification = "replay_required";
				return "done";
			}
			return "replay";
		} else {
			if (!fresh) {
				lease.classification = "acquire_failed";
				return "done";
			}
			lease.budget -= 1;
			this.#record(adapter.client, "reacquired");
		}
		if (!fresh) {
			lease.classification = "acquire_failed";
			return "done";
		}
		if (!declaration.replayMethods.has(adapter.method)) {
			lease.classification = "replay_required";
			return "done";
		}
		fresh.uses += 1;
		return "replay";
	}

	/** Runs one request through the declarations that apply to it. */
	async run<T>(
		adapter: SessionStateClientAdapter<T>,
		declarations: readonly SessionStateRuntimeDeclaration[],
	): Promise<T> {
		const leases: Lease[] = [];
		let attempts = 0;
		try {
			for (const declaration of declarations) {
				if (this.#blocked(declaration, adapter)) continue;
				const acquire = declaration.declaration.acquire;
				if (acquire.from === "credential") {
					const credential = captureFromCredential(acquire.capture, this.#deps.credential);
					if (credential)
						leases.push({
							declaration,
							credential,
							acquiring: false,
							carried: false,
							budget: 0,
							requests: 0,
						});
					continue;
				}
				const lease: Lease = {
					declaration,
					pool: this.#registry.pool(declaration, adapter.profile, this.#deps.connectionId),
					acquiring: false,
					carried: false,
					budget: declaration.reacquire,
					requests: 0,
				};
				leases.push(lease);
				// A failed acquisition request leaves `acquire_failed` on the lease; the
				// in-scope request still goes out, without the state.
				await this.#fill(lease, adapter);
			}
			for (let replay = 0; ; replay += 1) {
				const plan = leases.length === 0 ? EMPTY_PLAN : this.#plan(leases, adapter);
				const response = await adapter.send(plan, replay);
				attempts += 1;
				const exchange = await adapter.exchange(response);
				let again = false;
				for (const lease of leases) {
					if (lease.classification) continue;
					if ((await this.#judge(lease, exchange, adapter)) === "replay") again = true;
				}
				const classified = leases.find((lease) => lease.classification);
				if (classified?.classification) {
					return adapter.finish(response, {
						name: classified.declaration.name,
						outcome: classified.classification,
						attempts: attempts + leases.reduce((sum, lease) => sum + lease.requests, 0),
						carried: classified.carried,
					});
				}
				if (!again) return adapter.finish(response, undefined);
			}
		} finally {
			for (const lease of leases) this.#releaseLease(lease);
		}
	}
}
