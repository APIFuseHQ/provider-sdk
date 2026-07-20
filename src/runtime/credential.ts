import { CredentialModeError } from "../errors.js";
import type { AuthMode, CredentialContext } from "../types.js";

export interface CreateCredentialContextOptions {
	allowedKeys?: string[];
	mode?: AuthMode;
	scopes?: string[];
	values?: Record<string, string>;
}

function getAllowedKeys(
	allowedKeys: string[] | undefined,
	values: Record<string, string>,
): string[] {
	if (allowedKeys) {
		return allowedKeys;
	}

	return Object.keys(values);
}

function normalizeScopes(
	mode: AuthMode,
	values: Record<string, string>,
	scopes?: string[],
): string[] {
	if (mode !== "oauth2") {
		return [];
	}

	if (scopes) {
		return [...scopes];
	}

	const rawScopes = values.scope ?? values.scopes;
	if (!rawScopes) {
		return [];
	}

	return rawScopes
		.split(/[\s,]+/)
		.map((scope) => scope.trim())
		.filter((scope) => scope.length > 0);
}

export function createCredentialContext(
	options: CreateCredentialContextOptions = {},
): CredentialContext {
	const mode = options.mode ?? "none";
	const values = options.values ?? {};
	const allowedKeys = getAllowedKeys(options.allowedKeys, values);
	const allowedKeySet = new Set(allowedKeys);
	const normalizedScopes = normalizeScopes(mode, values, options.scopes);

	return {
		mode,
		get(key: string): string | undefined {
			if (!allowedKeySet.has(key)) {
				return undefined;
			}

			return values[key];
		},
		getAll(): Record<string, string> {
			const result: Record<string, string> = {};

			for (const key of allowedKeys) {
				const value = values[key];
				if (value !== undefined) {
					result[key] = value;
				}
			}

			return result;
		},
		getAccessToken(): string | undefined {
			if (mode !== "oauth2") {
				throw new CredentialModeError(
					"Access tokens are only available for oauth2 credential mode.",
				);
			}

			return values.access_token;
		},
		getScopes(): string[] {
			if (mode !== "oauth2") {
				throw new CredentialModeError(
					"OAuth scopes are only available for oauth2 credential mode.",
				);
			}

			return [...normalizedScopes];
		},
	};
}
