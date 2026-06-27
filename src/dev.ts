import { serve } from "./server/serve";
import type { ProviderDefinition } from "./types";

export interface DevServerOptions {
	port?: number;
	sessionDbPath?: string;
}

export function createDevServer(
	provider: ProviderDefinition,
	options?: DevServerOptions,
): { start: () => void } {
	const port = options?.port ?? 3900;

	return {
		start: () => {
			void serve(provider, { port });
			console.log(
				`[apifuse dev] ${provider.id}@${provider.version} running at http://localhost:${port}`,
			);
			console.log(
				`[apifuse dev] Operations: ${Object.keys(provider.operations).join(", ")}`,
			);
			console.log(`[apifuse dev] Health: http://localhost:${port}/health`);
		},
	};
}

export function startDevServer(
	provider: ProviderDefinition,
	options?: DevServerOptions,
): void {
	createDevServer(provider, options).start();
}
