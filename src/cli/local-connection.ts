import type { AuthMode, ProviderDefinition } from "../types.js";

/**
 * The connection the local CLIs stand in for the gateway with.
 *
 * At invocation time the gateway resolves the credential a provider needs and
 * attaches it to the request envelope as
 * `connection: { id, mode, secrets, metadata }`; `serve` then builds
 * `ctx.credential` from `connection.secrets` and nothing else. For
 * `auth.mode: "platform-managed"` the secrets are the platform-owned key the
 * caller never sees — which is why a probe reaches one only by going back
 * through the gateway (`ctx.gateway.execute(...)` in a health case's
 * `prepareInput`), and why nothing that runs outside the gateway had any way
 * to supply it.
 *
 * `apifuse record` hard-coded `credential: { mode: "none" }`, so
 * `ctx.credential.get(...)` returned `undefined` for every platform-managed
 * provider and the run died on that provider's own `MISSING_SECRET`. The same
 * hole made `submit-check --smoke` POST an envelope with no `connection` at
 * all. A large share of the fleet was unrecordable and unsmokeable, and it
 * read as "no live upstream success" rather than as a missing capability.
 *
 * This module is the local resolver for that connection. It does not invent a
 * second credential path: it produces the exact shape the gateway injects, so
 * the provider code under test takes the production branch.
 */
export interface LocalConnection {
	readonly id: string;
	readonly mode: AuthMode;
	readonly secrets: Record<string, string>;
	readonly metadata: Record<string, never>;
	/**
	 * Empty, exactly as the gateway leaves it when it injects a platform
	 * credential. `OperationConnectionSchema` requires the field, so omitting
	 * it would make every smoke envelope fail request validation before the
	 * provider ran.
	 */
	readonly externalRef: string;
}

/**
 * JSON object of `connection.secrets`, keyed exactly as the provider reads
 * them through `ctx.credential.get(...)`.
 *
 * A single JSON value rather than one variable per key on purpose:
 * platform-managed providers must not declare `credential.keys` (the SDK lint
 * rejects it), so the key names are known only to the provider's own source.
 * There is no derivation from an env name that would be right for every
 * provider, and guessing one would be a second, lossy contract next to the
 * gateway's.
 */
export const LOCAL_CONNECTION_SECRETS_ENV = "APIFUSE__LOCAL_CONNECTION__SECRETS";

/** Stable local connection id, mirroring the CLIs' other `local-*` scopes. */
export const LOCAL_CONNECTION_ID = "local-connection";

/** Auth modes whose providers read a credential the gateway supplies. */
export function providerRequiresConnection(provider: {
	readonly auth?: { readonly mode?: AuthMode } | undefined;
}): boolean {
	const mode = provider.auth?.mode;
	return mode !== undefined && mode !== "none";
}

export type CredentialOverrideParse =
	| { readonly ok: true; readonly secrets: Record<string, string> }
	| { readonly ok: false; readonly reason: string };

/**
 * Parses repeated `--credential key=value` arguments.
 *
 * Splits on the first `=` only: a base64 or URL-shaped secret routinely
 * contains more.
 */
export function parseCredentialOverrides(values: readonly string[]): CredentialOverrideParse {
	const secrets: Record<string, string> = {};
	for (const [index, value] of values.entries()) {
		// The offending argument is never echoed. `--credential =secret` and
		// `--credential secret` are both malformed *and* carry the credential, so
		// quoting the input to be helpful would print it to stderr — before any
		// redaction context exists, so no caller could scrub it.
		const separator = value.indexOf("=");
		if (separator <= 0) {
			return {
				ok: false,
				reason: `--credential #${index + 1} is not of the form key=value; its value is not echoed here because it may be the credential.`,
			};
		}
		const key = value.slice(0, separator).trim();
		if (key.length === 0) {
			return {
				ok: false,
				reason: `--credential #${index + 1} has an empty key; its value is not echoed here because it may be the credential.`,
			};
		}
		secrets[key] = value.slice(separator + 1);
	}
	return { ok: true, secrets };
}

/** Reads {@link LOCAL_CONNECTION_SECRETS_ENV} into a secrets map. */
export function parseEnvironmentSecrets(raw: string | undefined): CredentialOverrideParse {
	if (raw === undefined || raw.trim().length === 0) {
		return { ok: true, secrets: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			ok: false,
			reason: `${LOCAL_CONNECTION_SECRETS_ENV} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			ok: false,
			reason: `${LOCAL_CONNECTION_SECRETS_ENV} must be a JSON object of credential key to string value.`,
		};
	}
	const secrets: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value !== "string") {
			return {
				ok: false,
				reason: `${LOCAL_CONNECTION_SECRETS_ENV}.${key} must be a string (received ${typeof value}); the value is not echoed here.`,
			};
		}
		secrets[key] = value;
	}
	return { ok: true, secrets };
}

export interface ResolveLocalConnectionOptions {
	/** Repeated `--credential key=value` arguments, in order. */
	readonly overrides?: readonly string[];
	/** Environment to read {@link LOCAL_CONNECTION_SECRETS_ENV} from. */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

export type LocalConnectionResolution =
	| { readonly ok: true; readonly connection: LocalConnection | undefined }
	| { readonly ok: false; readonly reason: string };

/**
 * Resolves the connection to attach for one local invocation.
 *
 * Three outcomes, and the middle one is the point of the change:
 *
 * - the provider needs no credential (`auth.mode` absent or `"none"`) →
 *   no connection, exactly as before;
 * - the provider needs one and none is configured → `ok: false` with a
 *   message naming both ways to supply it. The caller surfaces that instead
 *   of letting the provider fail deep inside a handler on a `MISSING_SECRET`
 *   that reads like an upstream problem;
 * - the provider needs one and it is configured → the gateway's envelope
 *   shape.
 *
 * CLI overrides win over the environment so a one-off run does not need the
 * shell variable unset.
 */
export function resolveLocalConnection(
	provider: Pick<ProviderDefinition, "id"> & { auth?: { mode?: AuthMode } },
	options: ResolveLocalConnectionOptions = {},
): LocalConnectionResolution {
	const fromEnv = parseEnvironmentSecrets(
		(options.env ?? process.env)[LOCAL_CONNECTION_SECRETS_ENV],
	);
	if (!fromEnv.ok) return fromEnv;

	const fromArgs = parseCredentialOverrides(options.overrides ?? []);
	if (!fromArgs.ok) return fromArgs;

	const secrets = { ...fromEnv.secrets, ...fromArgs.secrets };
	const mode = provider.auth?.mode;

	if (!providerRequiresConnection(provider)) {
		if (Object.keys(secrets).length > 0) {
			return {
				ok: false,
				reason: `Provider "${provider.id}" declares auth.mode ${JSON.stringify(mode ?? "none")}, which takes no credential. Remove the supplied credential values.`,
			};
		}
		return { ok: true, connection: undefined };
	}

	if (Object.keys(secrets).length === 0) {
		return {
			ok: false,
			reason: missingLocalConnectionMessage(provider.id, mode ?? "none"),
		};
	}

	return {
		ok: true,
		connection: {
			id: LOCAL_CONNECTION_ID,
			// `mode` is narrowed by providerRequiresConnection above.
			mode: mode ?? "none",
			secrets,
			metadata: {},
			externalRef: "",
		},
	};
}

/** The message a caller prints when a needed credential is not configured. */
export function missingLocalConnectionMessage(providerId: string, mode: AuthMode): string {
	const platformManaged = mode === "platform-managed";
	return [
		`Provider "${providerId}" declares auth.mode "${mode}", so the gateway injects a credential on every invocation and this command has none.`,
		platformManaged
			? "The value is the platform-owned key an operator holds; it is not a provider secret and is not derivable from the checkout."
			: "Supply the same credential the gateway would resolve for a connection.",
		"Supply it with one of:",
		"  --credential <key>=<value>   (repeatable)",
		`  ${LOCAL_CONNECTION_SECRETS_ENV}='{"<key>":"<value>"}'`,
		"The keys are the ones the provider passes to ctx.credential.get(...).",
		"Pass --no-credential to run without one anyway (the provider will fail the way it does in production when the credential is unavailable).",
	].join("\n");
}
