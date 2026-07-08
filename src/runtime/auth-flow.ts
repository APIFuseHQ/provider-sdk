import { ContextAccessError } from "../errors";
import { createAuthFlowHelpers } from "../auth";
import type {
	ContextScratchpad,
	EnvContext,
	FlowContext,
	HttpClient,
	NativeContext,
	StealthClient,
	SttContext,
} from "../types";
import { createUnsupportedNativeNetworkClient } from "./native-network";
import { createUnsupportedSttClient } from "./stt";

function normalizeAllowedKeys(allowedKeys: string[]): Set<string> {
	return new Set(allowedKeys.filter((key) => key.trim().length > 0));
}

function assertAllowedKey(allowedKeys: Set<string>, key: string): void {
	if (!allowedKeys.has(key)) {
		throw new ContextAccessError(
			`Context key "${key}" is not declared in context.keys.`,
		);
	}
}

export function createScratchpad(
	allowedKeys: string[],
	initial: Record<string, unknown> = {},
): ContextScratchpad {
	const normalizedAllowedKeys = normalizeAllowedKeys(allowedKeys);
	const values = new Map<string, unknown>();

	for (const [key, value] of Object.entries(initial)) {
		assertAllowedKey(normalizedAllowedKeys, key);
		values.set(key, value);
	}

	return {
		get(key: string): unknown {
			assertAllowedKey(normalizedAllowedKeys, key);
			return values.get(key);
		},
		set(key: string, value: unknown): void {
			assertAllowedKey(normalizedAllowedKeys, key);
			values.set(key, value);
		},
		toJSON(): Record<string, unknown> {
			return Object.fromEntries(values.entries());
		},
	};
}

export function createFlowContext(options: {
	http: HttpClient;
	stealth: StealthClient;
	env: EnvContext;
	tenantId: string;
	providerId: string;
	connectionId?: string;
	externalRef?: string;
	allowedKeys: string[];
	initialContext?: Record<string, unknown>;
	native?: NativeContext;
	stt?: SttContext;
}): FlowContext {
	return {
		connectionId: options.connectionId,
		externalRef: options.externalRef,
		tenantId: options.tenantId,
		providerId: options.providerId,
		http: options.http,
		native: options.native ?? {
			network: createUnsupportedNativeNetworkClient(),
		},
		stealth: options.stealth,
		env: options.env,
		context: createScratchpad(options.allowedKeys, options.initialContext),
		stt: options.stt ?? createUnsupportedSttClient(),
		auth: createAuthFlowHelpers(),
	};
}
