import { ProviderError } from "../errors.js";
import {
	PROVIDER_CAPABILITY_KEYS,
	type ProviderCapabilityKey,
	type ProviderEngine,
	type ProviderEngineAttachmentInput,
} from "../engine.js";
import type { ProviderContext, ProviderDefinition } from "../types.js";

const CAPABILITY_KEY_SET = new Set<string>(PROVIDER_CAPABILITY_KEYS);

function declaresCapability(
	provider: ProviderDefinition,
	capability: ProviderCapabilityKey,
): boolean {
	return Object.hasOwn(provider, capability) && provider[capability] !== undefined;
}

function attachmentError(
	provider: ProviderDefinition,
	capability: ProviderCapabilityKey,
): ProviderError {
	return new ProviderError(
		`Provider engine could not attach declared capability "${capability}" for provider "${provider.id}"`,
		{
			code: "PROVIDER_ENGINE_ATTACHMENT_FAILED",
			details: { providerId: provider.id, capability },
			fix: `Configure the engine binding for "${capability}" before starting the provider.`,
		},
	);
}

function undeclaredCapabilityError(
	provider: ProviderDefinition,
	capability: ProviderCapabilityKey,
): ProviderError {
	return new ProviderError(
		`Provider "${provider.id}" accessed undeclared capability "${capability}"; add the "${capability}" declaration`,
		{
			code: "PROVIDER_CAPABILITY_UNDECLARED",
			details: { providerId: provider.id, capability },
			fix: `Add ${capability}: {} to the provider declaration, or remove the access.`,
		},
	);
}

function attachInProcess<TDeclaration extends object>(
	input: ProviderEngineAttachmentInput,
): ProviderContext<TDeclaration> {
	const { provider, bindings } = input;
	if (provider.runtimeTarget === "vanilla" && declaresCapability(provider, "native")) {
		throw new ProviderError(
			`Provider "${provider.id}" cannot attach capability "native" to runtime target "vanilla"; native requires an engine-resident runtime`,
			{
				code: "PROVIDER_RUNTIME_CAPABILITY_CONFLICT",
				details: { providerId: provider.id, capability: "native", runtimeTarget: "vanilla" },
			},
		);
	}

	const context: Record<PropertyKey, unknown> = { trace: bindings.trace };
	if (bindings.request !== undefined) context.request = bindings.request;
	for (const capability of PROVIDER_CAPABILITY_KEYS) {
		if (!declaresCapability(provider, capability)) continue;
		const binding = bindings[capability];
		if (binding === undefined || binding === null) throw attachmentError(provider, capability);
		context[capability] = binding;
	}

	return new Proxy(context, {
		get(target, property, receiver) {
			if (
				typeof property === "string" &&
				CAPABILITY_KEY_SET.has(property) &&
				!declaresCapability(provider, property as ProviderCapabilityKey)
			) {
				throw undeclaredCapabilityError(provider, property as ProviderCapabilityKey);
			}
			return Reflect.get(target, property, receiver);
		},
		has(target, property) {
			if (typeof property === "string" && CAPABILITY_KEY_SET.has(property)) {
				return declaresCapability(provider, property as ProviderCapabilityKey);
			}
			return Reflect.has(target, property);
		},
	}) as ProviderContext<TDeclaration>;
}

/** Repository-internal seam for SDK tests. Never export this from a package entry point. */
export function createInternalTestProviderEngine(): ProviderEngine {
	return { attach: attachInProcess };
}
