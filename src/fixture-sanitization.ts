export const REDACTED_FIXTURE_VALUE = "[REDACTED]";

export function isSensitiveFixtureKey(key: string): boolean {
	return /authorization|token|api[-_]?key/i.test(key);
}

export function sanitizeFixture<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeFixture(item)) as T;
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	const entries = Object.entries(value).map(([key, entryValue]) => {
		if (isSensitiveFixtureKey(key)) {
			return [key, REDACTED_FIXTURE_VALUE] as const;
		}

		return [key, sanitizeFixture(entryValue)] as const;
	});

	return Object.fromEntries(entries) as T;
}

/** Removes userinfo, query values, and fragments from a URL used in diagnostics. */
export function sanitizeUrlForLogs(value: string): string {
	try {
		const parsed = new URL(value);
		const queryMarker = parsed.search ? `?${REDACTED_FIXTURE_VALUE}` : "";
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}${queryMarker}`;
	} catch {
		return value.split(/[?#]/, 1)[0] ?? "[invalid-url]";
	}
}

/** Returns query-free request provenance without retaining URL userinfo or origin credentials. */
export function requestPathForFixture(value: string): string {
	try {
		return new URL(value).pathname;
	} catch {
		return value.split(/[?#]/, 1)[0] ?? "/";
	}
}
