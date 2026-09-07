import { createInternalTestProviderEngine } from "../../internal/in-process-engine.js";
import {
	createServerApp as createProductionServerApp,
	createServerAppAsync as createProductionServerAppAsync,
	serve as serveProduction,
} from "../../server/serve.js";

export * from "../../server/serve.js";

export const createServerApp: typeof createProductionServerApp = ((provider, options = {}) =>
	createProductionServerApp(provider, {
		...options,
		engine: options.engine ?? createInternalTestProviderEngine(),
	})) as typeof createProductionServerApp;

export const createServerAppAsync: typeof createProductionServerAppAsync = (async (
	provider,
	options = {},
) =>
	createProductionServerAppAsync(provider, {
		...options,
		engine: options.engine ?? createInternalTestProviderEngine(),
	})) as typeof createProductionServerAppAsync;

export const serve: typeof serveProduction = (async (provider, options = {}) =>
	serveProduction(provider, {
		...options,
		engine: options.engine ?? createInternalTestProviderEngine(),
	})) as typeof serveProduction;
