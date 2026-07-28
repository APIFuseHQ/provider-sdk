import { createHash, randomUUID } from "node:crypto";

const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const REDACTED_VALUE = "[REDACTED]";
const SECRET_KEY_PATTERN = /(?:token|password|secret|credential|cookie|authorization|device|uuid)/i;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ProviderEventSubject = {
	kind: "message" | "chat" | "member" | "session" | "auth" | "provider" | string;
	id: string;
};

export type ProviderEventSession = {
	sessionKey: string;
	generation: number;
};

export interface ProviderEvent<TPayload = Record<string, unknown>> {
	eventId: string;
	providerId: string;
	connectionId: string;
	serviceAccountId: string;
	eventType: string;
	subject: ProviderEventSubject;
	occurredAt: string;
	observedAt: string;
	payload: TPayload;
	session: ProviderEventSession;
	providerCursor?: string;
	dedupeKey?: string;
	rawRef?: string;
}

export type ProviderEventIdFactory = () => string;
export type ProviderEventClock = () => Date;

export type BuildProviderEventInput<
	TPayload extends Record<string, unknown> = Record<string, unknown>,
> = Omit<ProviderEvent<TPayload>, "eventId" | "observedAt"> & {
	eventId?: string;
	observedAt?: string;
	clock?: ProviderEventClock;
	idFactory?: ProviderEventIdFactory;
	maxPayloadBytes?: number;
	shouldRedactPayload?: boolean;
};

export type ProviderEventListOptions = {
	providerId?: string;
	connectionId?: string;
	eventType?: string;
	subjectKind?: string;
	subjectId?: string;
	afterObservedAt?: string;
	limit?: number;
};

export type ProviderEventAppendResult = {
	event: ProviderEvent;
	appended: boolean;
};

export interface ProviderEventLog {
	append(event: ProviderEvent): Promise<ProviderEventAppendResult>;
	get(eventId: string): Promise<ProviderEvent | null>;
	list(options?: ProviderEventListOptions): Promise<ProviderEvent[]>;
}

export type ProviderEventEmitterDefaults = {
	providerId: string;
	connectionId: string;
	serviceAccountId: string;
	session: ProviderEventSession;
	clock?: ProviderEventClock;
	idFactory?: ProviderEventIdFactory;
	maxPayloadBytes?: number;
	shouldRedactPayload?: boolean;
};

export type ProviderEventEmitterInput<
	TPayload extends Record<string, unknown> = Record<string, unknown>,
> = Omit<
	BuildProviderEventInput<TPayload>,
	"providerId" | "connectionId" | "serviceAccountId" | "session"
> & {
	providerId?: string;
	connectionId?: string;
	serviceAccountId?: string;
	session?: ProviderEventSession;
};

export class ProviderEventValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderEventValidationError";
	}
}

export function buildProviderEvent<
	TPayload extends Record<string, unknown> = Record<string, unknown>,
>(input: BuildProviderEventInput<TPayload>): ProviderEvent<TPayload> {
	validatePayload(input.payload, input.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES);
	const observedAt = input.observedAt ?? input.clock?.().toISOString() ?? new Date().toISOString();
	const payload =
		input.shouldRedactPayload === false ? input.payload : redactProviderEventPayload(input.payload);

	const event: ProviderEvent<TPayload> = {
		eventId: input.eventId ?? buildEventId({ ...input, observedAt }),
		providerId: input.providerId,
		connectionId: input.connectionId,
		serviceAccountId: input.serviceAccountId,
		eventType: input.eventType,
		subject: input.subject,
		occurredAt: input.occurredAt,
		observedAt,
		payload,
		session: input.session,
		...(input.providerCursor ? { providerCursor: input.providerCursor } : {}),
		...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
		...(input.rawRef ? { rawRef: input.rawRef } : {}),
	};

	validateProviderEvent(event, input.maxPayloadBytes);
	return event;
}

export function redactProviderEventPayload<TPayload>(payload: TPayload): TPayload {
	const cloned = structuredClone(payload);
	redactValueInPlace(cloned);
	return cloned;
}

export function isStaleProviderEvent(event: ProviderEvent, currentGeneration: number): boolean {
	return event.session.generation < currentGeneration;
}

export class InMemoryProviderEventLog implements ProviderEventLog {
	readonly #events: ProviderEvent[] = [];
	readonly #eventIds = new Set<string>();
	readonly #dedupeKeys = new Set<string>();

	async append(event: ProviderEvent): Promise<ProviderEventAppendResult> {
		validateProviderEvent(event);

		if (this.#eventIds.has(event.eventId)) {
			return { event, appended: false };
		}

		const dedupeTuple = event.dedupeKey ? buildDedupeTuple(event) : undefined;
		if (dedupeTuple && this.#dedupeKeys.has(dedupeTuple)) {
			return { event, appended: false };
		}

		this.#events.push(event);
		this.#eventIds.add(event.eventId);
		if (dedupeTuple) this.#dedupeKeys.add(dedupeTuple);

		return { event, appended: true };
	}

	async get(eventId: string): Promise<ProviderEvent | null> {
		validateRequiredString("eventId", eventId);
		return this.#events.find((event) => event.eventId === eventId) ?? null;
	}

	async list(options: ProviderEventListOptions = {}): Promise<ProviderEvent[]> {
		validateListOptions(options);
		let events = this.#events;

		if (options.providerId) {
			events = events.filter((event) => event.providerId === options.providerId);
		}
		if (options.connectionId) {
			events = events.filter((event) => event.connectionId === options.connectionId);
		}
		if (options.eventType) {
			events = events.filter((event) => event.eventType === options.eventType);
		}
		if (options.subjectKind) {
			events = events.filter((event) => event.subject.kind === options.subjectKind);
		}
		if (options.subjectId) {
			events = events.filter((event) => event.subject.id === options.subjectId);
		}
		if (options.afterObservedAt) {
			const afterMs = Date.parse(options.afterObservedAt);
			events = events.filter((event) => Date.parse(event.observedAt) > afterMs);
		}

		return typeof options.limit === "number" ? events.slice(0, options.limit) : [...events];
	}
}

export class ProviderEventEmitter {
	readonly #log: ProviderEventLog;
	readonly #defaults: ProviderEventEmitterDefaults;

	constructor(log: ProviderEventLog, defaults: ProviderEventEmitterDefaults) {
		validateRequiredString("providerId", defaults.providerId);
		validateRequiredString("connectionId", defaults.connectionId);
		validateRequiredString("serviceAccountId", defaults.serviceAccountId);
		validateSession(defaults.session);
		this.#log = log;
		this.#defaults = defaults;
	}

	emit<TPayload extends Record<string, unknown> = Record<string, unknown>>(
		input: ProviderEventEmitterInput<TPayload>,
	): Promise<ProviderEventAppendResult> {
		const event = buildProviderEvent({
			...input,
			providerId: input.providerId ?? this.#defaults.providerId,
			connectionId: input.connectionId ?? this.#defaults.connectionId,
			serviceAccountId: input.serviceAccountId ?? this.#defaults.serviceAccountId,
			session: input.session ?? this.#defaults.session,
			clock: input.clock ?? this.#defaults.clock,
			idFactory: input.idFactory ?? this.#defaults.idFactory,
			maxPayloadBytes: input.maxPayloadBytes ?? this.#defaults.maxPayloadBytes,
			shouldRedactPayload: input.shouldRedactPayload ?? this.#defaults.shouldRedactPayload,
		});
		return this.#log.append(event);
	}
}

function buildEventId<TPayload extends Record<string, unknown>>(
	input: Omit<BuildProviderEventInput<TPayload>, "eventId"> & {
		observedAt: string;
	},
): string {
	if (input.dedupeKey) {
		return deterministicProviderEventId([
			input.providerId,
			input.connectionId,
			input.eventType,
			input.dedupeKey,
		]);
	}

	return (
		input.idFactory?.() ??
		deterministicProviderEventId([
			input.providerId,
			input.connectionId,
			input.eventType,
			input.subject.kind,
			input.subject.id,
			input.observedAt,
		])
	);
}

function deterministicProviderEventId(parts: readonly string[]): string {
	return `pevt_${createHash("sha256").update(parts.join("\u001f")).digest("hex")}`;
}

function validateProviderEvent(
	event: ProviderEvent,
	maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
): void {
	validateRequiredString("eventId", event.eventId);
	validateRequiredString("providerId", event.providerId);
	validateRequiredString("connectionId", event.connectionId);
	validateRequiredString("serviceAccountId", event.serviceAccountId);
	validateRequiredString("eventType", event.eventType);
	validateRequiredString("subject.kind", event.subject?.kind);
	validateRequiredString("subject.id", event.subject?.id);
	validateRequiredString("occurredAt", event.occurredAt);
	validateRequiredString("observedAt", event.observedAt);
	validateTimestamp("occurredAt", event.occurredAt);
	validateTimestamp("observedAt", event.observedAt);
	validateSession(event.session);
	if (event.providerCursor !== undefined) {
		validateRequiredString("providerCursor", event.providerCursor);
	}
	if (event.dedupeKey !== undefined) {
		validateRequiredString("dedupeKey", event.dedupeKey);
	}
	if (event.rawRef !== undefined) {
		validateRequiredString("rawRef", event.rawRef);
	}
	validatePayload(event.payload, maxPayloadBytes);
}

function validateSession(session: ProviderEventSession): void {
	validateRequiredString("session.sessionKey", session?.sessionKey);
	if (!Number.isInteger(session?.generation) || session.generation < 0) {
		throw new ProviderEventValidationError(
			"ProviderEvent session.generation must be a non-negative integer.",
		);
	}
}

function validateRequiredString(name: string, value: unknown): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ProviderEventValidationError(`ProviderEvent ${name} must be a non-empty string.`);
	}
}

function validateTimestamp(name: string, value: string): void {
	if (!Number.isFinite(Date.parse(value))) {
		throw new ProviderEventValidationError(
			`ProviderEvent ${name} must be a parseable ISO timestamp string.`,
		);
	}
}

function validatePayload(payload: unknown, maxPayloadBytes: number): void {
	if (
		typeof maxPayloadBytes !== "number" ||
		!Number.isFinite(maxPayloadBytes) ||
		maxPayloadBytes <= 0
	) {
		throw new ProviderEventValidationError(
			"ProviderEvent maxPayloadBytes must be a positive finite number.",
		);
	}

	if (!isPlainRecord(payload)) {
		throw new ProviderEventValidationError(
			"ProviderEvent payload must be a JSON-serializable object.",
		);
	}

	assertJsonValue(payload, "payload");
	const encoded = JSON.stringify(payload);
	if (encoded === undefined) {
		throw new ProviderEventValidationError("ProviderEvent payload must be JSON-serializable.");
	}
	const payloadBytes = Buffer.byteLength(encoded, "utf8");
	if (payloadBytes > maxPayloadBytes) {
		throw new ProviderEventValidationError(
			`ProviderEvent payload exceeds max size of ${maxPayloadBytes} bytes.`,
		);
	}
}

function assertJsonValue(
	value: unknown,
	path: string,
	seen = new WeakSet<object>(),
): asserts value is JsonValue {
	if (value === null) return;
	if (typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return;
		throw new ProviderEventValidationError(
			`ProviderEvent ${path} must not contain non-finite numbers.`,
		);
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			throw new ProviderEventValidationError(
				`ProviderEvent ${path} must not contain circular references.`,
			);
		}
		seen.add(value);
		for (const [index, entry] of value.entries()) {
			assertJsonValue(entry, `${path}[${index}]`, seen);
		}
		seen.delete(value);
		return;
	}
	if (isPlainRecord(value)) {
		if (seen.has(value)) {
			throw new ProviderEventValidationError(
				`ProviderEvent ${path} must not contain circular references.`,
			);
		}
		seen.add(value);
		for (const [key, entry] of Object.entries(value)) {
			assertJsonValue(entry, `${path}.${key}`, seen);
		}
		seen.delete(value);
		return;
	}
	throw new ProviderEventValidationError(`ProviderEvent ${path} must be JSON-serializable.`);
}

function redactValueInPlace(value: unknown): void {
	if (Array.isArray(value)) {
		for (const entry of value) redactValueInPlace(entry);
		return;
	}
	if (!isPlainRecord(value)) return;

	for (const [key, entry] of Object.entries(value)) {
		if (SECRET_KEY_PATTERN.test(key)) value[key] = REDACTED_VALUE;
		else redactValueInPlace(entry);
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function buildDedupeTuple(event: ProviderEvent): string {
	return [event.serviceAccountId, event.providerId, event.connectionId, event.dedupeKey].join(
		"\u001f",
	);
}

function validateListOptions(options: ProviderEventListOptions): void {
	if (options.afterObservedAt) {
		validateTimestamp("afterObservedAt", options.afterObservedAt);
	}
	if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0)) {
		throw new ProviderEventValidationError("ProviderEvent list limit must be a positive integer.");
	}
}

export function randomProviderEventId(): string {
	return `pevt_${randomUUID().replaceAll("-", "")}`;
}
