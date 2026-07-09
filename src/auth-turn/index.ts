import type { AuthTurn } from "../types";

export type { AuthTurn };

/**
 * Major version of the AuthTurn envelope contract.
 *
 * The envelope is additive-only within a major. Adding a turn kind is never an
 * envelope version event (the wire keeps `kind` open); a major bump happens
 * only on an envelope-shape break, which is expected to be a ~never,
 * gateway-first coordinated event.
 */
export const AUTH_TURN_ENVELOPE_MAJOR = 1;

/**
 * Package-root-relative path of the static schema artifact shipped in the npm
 * tarball. Tooling that needs the raw JSON document (for example codegen)
 * should read this file off the resolved on-disk package directory.
 */
export const AUTH_TURN_SCHEMA_ARTIFACT_PATH = "dist/auth-turn/auth-turn.v1.schema.json";

/**
 * JSON Schema (draft 2020-12) for the AuthTurn envelope, version 1.
 *
 * This is the exact codification of the runtime validation the SDK applies to
 * ceremony outputs (see `validateCeremonyOutput` in `src/ceremonies`), which
 * compiles this same document. `kind` is an OPEN string on the wire: the known
 * kinds in {@link TURN_KINDS} are tooling metadata, never a wire constraint.
 *
 * The committed artifact at `src/auth-turn/auth-turn.v1.schema.json` (shipped
 * to `dist/auth-turn/auth-turn.v1.schema.json`) must stay byte-equivalent to
 * this constant; a contract test enforces the equality.
 */
export const AUTH_TURN_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://apifuse.com/contracts/auth-turn/v1",
	title: "APIFuse AuthTurn envelope v1",
	description:
		"Protocol message exchanged during auth.flow ceremonies. kind is an open string; known kinds are tooling metadata, not a wire constraint.",
	type: "object",
	additionalProperties: false,
	required: ["kind", "turnId"],
	properties: {
		kind: {
			type: "string",
			minLength: 1,
			description:
				"Open turn kind. Known kinds are listed in the TURN_KINDS registry; unknown kinds remain valid on the wire.",
		},
		turnId: {
			type: "string",
			minLength: 1,
			description: "Provider-scoped identifier of this turn.",
		},
		expiresAt: {
			type: "string",
			minLength: 1,
			description: "Turn expiry timestamp as an ISO 8601 / RFC 3339 string.",
		},
		data: {
			type: "object",
			additionalProperties: true,
			description: "Kind-specific payload. Terminal kinds carry the payloads described in $defs.",
		},
		expectedInput: {
			type: "object",
			additionalProperties: true,
			description: "JSON Schema describing the input expected next.",
		},
		hint: {
			type: "string",
			description:
				"Deprecated but load-bearing human-readable hint materialized from provider locale catalogs.",
		},
		hintKey: {
			type: "string",
			description: "Provider locale catalog key for the turn hint.",
		},
		timing: {
			type: "object",
			additionalProperties: false,
			description: "Client pacing guidance for poll-style turns.",
			properties: {
				suggestedPollIntervalMs: { type: "number", minimum: 1 },
				maxWaitMs: { type: "number", minimum: 1 },
			},
		},
	},
	$defs: {
		completeTurnData: {
			title: 'Terminal payload for kind "complete"',
			description:
				"data payload of a complete turn. The gateway extracts data.credential for persistence; complete turns are never echoed to browsers.",
			type: "object",
			additionalProperties: true,
			required: ["credential"],
			properties: {
				credential: { type: "object", additionalProperties: true },
				metadata: { type: "object", additionalProperties: true },
			},
		},
		abortTurnData: {
			title: 'Terminal payload for kind "abort"',
			description:
				"data payload of an abort turn. code, when present, is the machine-readable abort reason.",
			type: "object",
			additionalProperties: true,
			properties: {
				code: { type: "string" },
			},
		},
	},
} as const;

export type TurnKindRendering = "custom" | "schema" | "terminal";

export interface AuthTurnKindDescriptor {
	/** Turn kind string as emitted on the wire. */
	readonly kind: string;
	/**
	 * How clients present the turn: "custom" (dedicated renderer), "schema"
	 * (generic expectedInput-driven rendering), or "terminal" (never rendered;
	 * consumed by the gateway).
	 */
	readonly rendering: TurnKindRendering;
	/** JSON pointer into AUTH_TURN_SCHEMA for the kind's data payload contract. */
	readonly payloadSchema?: string;
	/** Envelope major in which the kind was first registered. */
	readonly since: number;
}

/**
 * Registry of the turn kinds the SDK is known to emit today.
 *
 * This is tooling metadata (renderer routing, fixtures, codegen) — it is NOT a
 * wire constraint. Providers may emit kinds outside this list and they remain
 * valid against {@link AUTH_TURN_SCHEMA}. Every kind registered here must ship
 * a golden fixture at `src/auth-turn/fixtures/valid/<kind>.json`; a contract
 * test enforces the coverage.
 */
export const TURN_KINDS = [
	{
		kind: "abort",
		rendering: "terminal",
		payloadSchema: "#/$defs/abortTurnData",
		since: 1,
	},
	{ kind: "challenge", rendering: "custom", since: 1 },
	{
		kind: "complete",
		rendering: "terminal",
		payloadSchema: "#/$defs/completeTurnData",
		since: 1,
	},
	{ kind: "form", rendering: "custom", since: 1 },
	{ kind: "message", rendering: "custom", since: 1 },
	{ kind: "multi_choice", rendering: "custom", since: 1 },
	{ kind: "pending", rendering: "schema", since: 1 },
	{ kind: "poll", rendering: "custom", since: 1 },
	{ kind: "redirect", rendering: "custom", since: 1 },
	{ kind: "retry", rendering: "custom", since: 1 },
] as const satisfies readonly AuthTurnKindDescriptor[];

/** Turn kinds the SDK is known to emit. Tooling metadata, not a wire constraint. */
export type KnownAuthTurnKind = (typeof TURN_KINDS)[number]["kind"];

/** Known kinds presented through a dedicated client renderer. */
export type CustomRenderedTurnKind = Extract<
	(typeof TURN_KINDS)[number],
	{ rendering: "custom" }
>["kind"];

/** Known kinds consumed by the gateway instead of being rendered. */
export type TerminalTurnKind = Extract<
	(typeof TURN_KINDS)[number],
	{ rendering: "terminal" }
>["kind"];
