export function resolvedStringVariants(value: string | undefined): string[] {
	if (value === undefined) return [];
	return [...new Set([value, value.trim()])].filter((candidate) => candidate.length > 0);
}

function decodedComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function urlCredentialComponents(
	value: string,
	options: { includePathAndQuery: boolean },
): string[] {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return [];
	}
	const username = decodedComponent(url.username);
	const password = decodedComponent(url.password);
	const components = [username, password, username && password ? `${username}:${password}` : ""];
	if (options.includePathAndQuery) {
		for (const segment of url.pathname.split("/")) {
			if (segment) components.push(decodedComponent(segment));
		}
		for (const [key, entryValue] of url.searchParams) {
			if (key) components.push(key);
			if (entryValue) {
				components.push(entryValue, `${key}=${entryValue}`);
			}
		}
	}
	return [...new Set(components.flatMap((component) => resolvedStringVariants(component)))];
}

export function otlpHeaderCredentialValues(value: string): string[] {
	const variants = resolvedStringVariants(value);
	for (const member of value.split(",")) {
		const separator = member.indexOf("=");
		if (separator <= 0) continue;
		const headerValue = decodedComponent(member.slice(separator + 1).trim());
		variants.push(...resolvedStringVariants(headerValue));
		const headerName = decodedComponent(member.slice(0, separator).trim()).toLowerCase();
		if (headerName === "authorization" || headerName === "proxy-authorization") {
			// A transport may echo just the credential without its HTTP auth scheme.
			const credential = /^(?:Bearer|Basic)\s+(.+)$/i.exec(headerValue)?.[1];
			if (credential) variants.push(...resolvedStringVariants(credential));
		}
	}
	return [...new Set(variants)];
}
