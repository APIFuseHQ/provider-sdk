import { readFileSync } from "node:fs";

/** Published @apifuse/provider-sdk version, read from the package manifest; "unknown" when unreadable. */
export function resolveSdkVersion(): string {
	try {
		const packageJsonUrl = new URL("../../package.json", import.meta.url);
		const parsed: unknown = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
		if (
			parsed &&
			typeof parsed === "object" &&
			"version" in parsed &&
			typeof (parsed as { version: unknown }).version === "string"
		) {
			return (parsed as { version: string }).version;
		}
	} catch {
		// fall through to unknown
	}
	return "unknown";
}

export const SDK_VERSION = resolveSdkVersion();
