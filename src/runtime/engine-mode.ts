import {
	createInProcessProviderEngine,
	PROVIDER_ENGINE_MODE_ENV,
	type ProviderEngine,
	type ProviderEngineMode,
} from "../engine.js";
import { ProviderError, ValidationError } from "../errors.js";

/**
 * Engine attachment selection. Internal on purpose: ADR-0011 removes the
 * in-process lane, so every symbol exported here would become a breaking removal
 * later. The server surfaces the outcome on the `provider_engine_mode` boot
 * event instead.
 */

const KNOWN_PROVIDER_ENGINE_MODES = ["in-process", "remote"] as const;

/** Mode used when neither `engineMode` nor `APIFUSE__ENGINE__MODE` names one. */
export const DEFAULT_PROVIDER_ENGINE_MODE = "in-process" satisfies ProviderEngineMode;

/** Remote engine client endpoint; engine-owned, so never declarable as a provider secret. */
export const REMOTE_ENGINE_CLIENT_URL_ENV = "APIFUSE__ENGINE__URL";
/** Remote engine client credential; registered with the diagnostic redactor by sensitive-values. */
export const REMOTE_ENGINE_CLIENT_API_KEY_ENV = "APIFUSE__ENGINE__API_KEY";

/** Engine env names that only mean something in remote mode. */
const REMOTE_ONLY_ENGINE_ENV_NAMES = [
	REMOTE_ENGINE_CLIENT_URL_ENV,
	REMOTE_ENGINE_CLIENT_API_KEY_ENV,
] as const;

/** Where the resolved mode came from, in precedence order. */
export type ProviderEngineModeSource = "engine" | "env" | "option" | "default";

/**
 * Non-fatal conditions worth reporting at boot:
 * - `invalid_env_value`: `APIFUSE__ENGINE__MODE` held an unrecognized value.
 * - `env_overrode_option`: the manifest and the host code disagreed; the manifest won.
 * - `engine_object_overrode_requested_mode`: an explicit engine object cannot honour the requested mode.
 * - `engine_env_ignored`: remote-only engine env is projected but the mode is not
 *   remote (not reported for a host-supplied engine, which may consume it itself).
 */
export type ProviderEngineModeWarning =
	| "invalid_env_value"
	| "env_overrode_option"
	| "engine_object_overrode_requested_mode"
	| "engine_env_ignored";

export interface ProviderEngineModeResolution {
	readonly mode: ProviderEngineMode | "custom";
	readonly source: ProviderEngineModeSource;
	/** True for every non-remote attachment, whose removal is scheduled by ADR-0011. */
	readonly deprecated: boolean;
	readonly warnings: readonly ProviderEngineModeWarning[];
}

export interface ProviderEngineModeResolutionInput {
	/** Explicit `engineMode` option passed by the host process. */
	readonly option?: ProviderEngineMode;
	/** Explicit engine object passed by the host; used as given when present. */
	readonly engine?: Pick<ProviderEngine, "kind">;
	/** Environment to read the engine env from; defaults to `process.env`. */
	readonly environment?: Readonly<Record<string, string | undefined>>;
}

function isKnownMode(value: string): value is (typeof KNOWN_PROVIDER_ENGINE_MODES)[number] {
	return (KNOWN_PROVIDER_ENGINE_MODES as readonly string[]).includes(value);
}

function normalize(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * Resolve the engine attachment mode once at boot.
 *
 * Precedence: an explicit `engine` object, then `APIFUSE__ENGINE__MODE`, then the
 * `engineMode` option, then the default. The manifest outranks the option so
 * provider code cannot silently downgrade what the deployment asked for; every
 * disagreement is reported in `warnings` with a truthful `source` rather than
 * being dropped.
 *
 * Deployment-authored input is never fatal (an unrecognized env value is warned
 * about and ignored). A malformed `engineMode` option is a fault in the calling
 * code, which no manifest can reach, so it throws.
 */
export function resolveProviderEngineMode(
	input: ProviderEngineModeResolutionInput = {},
): ProviderEngineModeResolution {
	const environment = input.environment ?? process.env;
	const warnings: ProviderEngineModeWarning[] = [];

	// Read directly: this is a mode name, not a credential, so it must not be
	// registered with the diagnostic redactor the way readDiagnosticEnv is.
	const rawEnv = normalize(environment[PROVIDER_ENGINE_MODE_ENV]);
	let envMode: ProviderEngineMode | undefined;
	if (rawEnv !== undefined) {
		if (isKnownMode(rawEnv)) envMode = rawEnv;
		else warnings.push("invalid_env_value");
	}

	const optionMode = normalize(input.option);
	if (input.option !== undefined && (optionMode === undefined || !isKnownMode(optionMode))) {
		throw new ValidationError(
			`Invalid engineMode option "${String(input.option)}"; expected ${KNOWN_PROVIDER_ENGINE_MODES.join(" or ")}`,
			{ fix: 'Pass engineMode: "in-process" | "remote", or omit it to use the default.' },
		);
	}
	if (optionMode !== undefined && envMode !== undefined && optionMode !== envMode) {
		warnings.push("env_overrode_option");
	}

	const requested = envMode ?? optionMode;
	const requestedSource: ProviderEngineModeSource | undefined =
		envMode !== undefined ? "env" : optionMode !== undefined ? "option" : undefined;

	// Normalized like every other mode input: an un-normalized host `kind` would
	// reach the boot event and /readyz verbatim and mis-score the fleet audit.
	const engineKind =
		input.engine === undefined ? undefined : (normalize(input.engine.kind) ?? "custom");
	if (engineKind !== undefined) {
		if (requested !== undefined && engineKind !== requested) {
			warnings.push("engine_object_overrode_requested_mode");
		}
		return finalize(engineKind, "engine", environment, warnings);
	}

	return finalize(
		requested ?? DEFAULT_PROVIDER_ENGINE_MODE,
		requestedSource ?? "default",
		environment,
		warnings,
	);
}

function finalize(
	mode: ProviderEngineMode | "custom",
	source: ProviderEngineModeSource,
	environment: Readonly<Record<string, string | undefined>>,
	warnings: ProviderEngineModeWarning[],
): ProviderEngineModeResolution {
	// Presence of the remote engine env never selects a mode (the manifest
	// generator projects it fleet-wide before the SDK can use it), but staying
	// silent about it would hide a half-applied cutover. Skipped for a host-supplied
	// engine: that object may be a remote client that consumes the env itself, so
	// claiming the env is unused would be a false report.
	if (
		mode !== "remote" &&
		source !== "engine" &&
		REMOTE_ONLY_ENGINE_ENV_NAMES.some((name) => normalize(environment[name]) !== undefined)
	) {
		warnings.push("engine_env_ignored");
	}
	// Fail-closed for the ADR-0011 audit: everything that is not the remote lane
	// still attaches capabilities inside the pod process and is scheduled for
	// removal, including an opaque host engine that declares no kind.
	return { mode, source, deprecated: mode !== "remote", warnings };
}

const UNAVAILABLE_ENGINES = new WeakSet<ProviderEngine>();

/** True when the engine cannot attach, so readiness must report the process as unready. */
export function isUnavailableProviderEngine(engine: ProviderEngine): boolean {
	return UNAVAILABLE_ENGINES.has(engine);
}

/**
 * Engine that refuses every attachment with `reason`.
 *
 * Requesting a mode this release cannot serve must not crash the process: the SDK
 * answers a structured error per request and reports the process unready, the same
 * trade-off `provider_secrets_missing` already makes at boot. Non-retryable, so a
 * caller-side retry loop cannot turn a configuration fault into load.
 */
export function createUnavailableProviderEngine(
	kind: ProviderEngineMode,
	reason: { message: string; code: string; fix: string },
): ProviderEngine {
	const engine: ProviderEngine = {
		kind,
		attach: () => {
			throw new ProviderError(reason.message, {
				code: reason.code,
				retryable: false,
				fix: reason.fix,
			});
		},
	};
	UNAVAILABLE_ENGINES.add(engine);
	return engine;
}

/**
 * Engine for a resolved mode. `remote` has no client in this release, so it
 * resolves to an engine that fails every request instead of falling back to
 * in-process (ADR-0011 Pitfall 2: in-process is never a fallback).
 */
export function createEngineForMode(mode: ProviderEngineMode | "custom"): ProviderEngine {
	// Default-deny on the mode name, not just on "remote": the mode union is open
	// so a later lane can be named, and falling through to in-process for an
	// unserved lane is the silent downgrade ADR-0011 Pitfall 2 forbids.
	if (mode === DEFAULT_PROVIDER_ENGINE_MODE) return createInProcessProviderEngine();
	return createUnavailableProviderEngine(mode, {
		message: `Provider engine mode "${mode}" was requested but this @apifuse/provider-sdk release only serves the ${DEFAULT_PROVIDER_ENGINE_MODE} engine`,
		code: "PROVIDER_ENGINE_MODE_UNSUPPORTED",
		fix: `Unset ${PROVIDER_ENGINE_MODE_ENV} (or the engineMode option), or upgrade to a release that serves this mode.`,
	});
}

/**
 * Fail fast for the CLIs (`apifuse dev`, `apifuse record`). They are developer
 * tools, not pods: an unusable mode should stop the command rather than start a
 * server that refuses every request.
 */
export function assertProcessEngineModeSupported(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): ProviderEngineModeResolution {
	const resolution = resolveProviderEngineMode({ environment });
	if (resolution.mode !== DEFAULT_PROVIDER_ENGINE_MODE) {
		throw new ProviderError(
			`Provider engine mode "${resolution.mode}" was requested but this @apifuse/provider-sdk release only serves the ${DEFAULT_PROVIDER_ENGINE_MODE} engine`,
			{
				code: "PROVIDER_ENGINE_MODE_UNSUPPORTED",
				retryable: false,
				details: { mode: resolution.mode, source: resolution.source },
				fix: `Unset ${PROVIDER_ENGINE_MODE_ENV}, or upgrade to a release that serves this mode.`,
			},
		);
	}
	return resolution;
}
