import { isProviderError, type ProviderErrorObservability } from "../errors.js";

const PROVIDER_OBSERVABILITY_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const PROVIDER_OBSERVABILITY_FINGERPRINT_PATTERN = /^[A-Fa-f0-9]{12}$/;
const MAX_PROVIDER_OBSERVABILITY_MESSAGE_LENGTH = 10_000_000;

/**
 * Extracts only own data properties from branded provider errors. In
 * particular, descriptor reads reject options/observability accessors without
 * invoking provider-controlled getters.
 */
export function safeProviderErrorObservability(
	error: unknown,
): ProviderErrorObservability | undefined {
	if (!isProviderError(error)) return undefined;
	let candidate: unknown;
	let reason: unknown;
	let fingerprint: unknown;
	let messageLength: unknown;
	try {
		const optionsDescriptor = Object.getOwnPropertyDescriptor(error, "options");
		if (optionsDescriptor === undefined || !Object.hasOwn(optionsDescriptor, "value")) {
			return undefined;
		}
		const options = optionsDescriptor.value;
		if (options === null || typeof options !== "object" || Array.isArray(options)) {
			return undefined;
		}
		const observabilityDescriptor = Object.getOwnPropertyDescriptor(options, "observability");
		if (observabilityDescriptor === undefined || !Object.hasOwn(observabilityDescriptor, "value")) {
			return undefined;
		}
		candidate = observabilityDescriptor.value;
		if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
			return undefined;
		}
		const ownValue = (key: keyof ProviderErrorObservability): unknown => {
			const descriptor = Object.getOwnPropertyDescriptor(candidate as object, key);
			return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
		};
		reason = ownValue("reason");
		fingerprint = ownValue("fingerprint");
		messageLength = ownValue("messageLength");
	} catch {
		return undefined;
	}
	const safe: ProviderErrorObservability = {
		...(typeof reason === "string" && PROVIDER_OBSERVABILITY_TOKEN_PATTERN.test(reason)
			? { reason }
			: {}),
		...(typeof fingerprint === "string" &&
		PROVIDER_OBSERVABILITY_FINGERPRINT_PATTERN.test(fingerprint)
			? { fingerprint }
			: {}),
		...(typeof messageLength === "number" &&
		Number.isInteger(messageLength) &&
		messageLength >= 0 &&
		messageLength <= MAX_PROVIDER_OBSERVABILITY_MESSAGE_LENGTH
			? { messageLength }
			: {}),
	};

	return Object.keys(safe).length > 0 ? safe : undefined;
}
