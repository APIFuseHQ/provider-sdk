import type { EnvContext } from "../types";

export function createEnvContext(allowedKeys?: string[]): EnvContext {
	return {
		get(key: string): string | undefined {
			if (allowedKeys && !allowedKeys.includes(key)) {
				return undefined;
			}

			return process.env[key];
		},
	};
}
