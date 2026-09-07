import type { ProviderDefinition } from "../types.js";
import {
	collectDiagnosticSensitiveValues,
	SELF_TEST_SENSITIVE_SOURCE_KINDS,
} from "./sensitive-values.js";

export const SELF_TEST_REDACTED_PLACEHOLDER = "[REDACTED]";

/** Maximum length of any string echoed in a self-test response. */
export const SELF_TEST_MAX_TEXT_LENGTH = 300;

/** Values shorter than this are too generic to be treated as secrets. */
const MIN_SENSITIVE_VALUE_LENGTH = 4;

const HEADER_SHAPED_SECRETS: readonly RegExp[] = [
	/(authorization\s*[:=]\s*)[^\s;,]+/gi,
	/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
	/((?:set-)?cookie\s*[:=]\s*)[^;\n]+/gi,
];

/**
 * Collects every secret-shaped value known to the self-test runtime so probe
 * results can be scrubbed before they leave the pod: master secrets, declared
 * provider env secrets, health-probe credential env values, and request-supplied
 * credential inputs.
 */
export function collectSelfTestSensitiveValues(
	provider: ProviderDefinition,
	options: {
		env?: Readonly<Record<string, string | undefined>>;
		credentialInputs?: Readonly<Record<string, string>>;
	} = {},
): string[] {
	return collectDiagnosticSensitiveValues(provider, {
		...options,
		sourceKinds: SELF_TEST_SENSITIVE_SOURCE_KINDS,
		minimumLength: MIN_SENSITIVE_VALUE_LENGTH,
		includeResolvedEnvVariants: false,
	});
}

/**
 * Scrubs known secret values and header-shaped credentials from a string and
 * caps its length. Every string embedded in a SelfTestResponse MUST pass
 * through this before serialization.
 */
export function redactSelfTestText(
	text: string,
	sensitiveValues: readonly string[],
	maxLength: number = SELF_TEST_MAX_TEXT_LENGTH,
): string {
	let redacted = text;
	for (const value of sensitiveValues) {
		if (value.length < MIN_SENSITIVE_VALUE_LENGTH) continue;
		redacted = redacted.replaceAll(value, SELF_TEST_REDACTED_PLACEHOLDER);
	}
	for (const pattern of HEADER_SHAPED_SECRETS) {
		redacted = redacted.replace(
			pattern,
			(_match, prefix: string) => `${prefix}${SELF_TEST_REDACTED_PLACEHOLDER}`,
		);
	}
	if (redacted.length > maxLength) {
		redacted = `${redacted.slice(0, maxLength)}… [truncated]`;
	}
	return redacted;
}
