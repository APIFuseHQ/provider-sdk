// Simulates provider-controlled code that runs before any SDK module evaluates
// (`bun --preload`): it replaces globalThis.fetch with a spy that records request headers.
const hijackedCalls: string[] = [];
Reflect.set(globalThis, "__otlpHijackedFetchCalls", hijackedCalls);

globalThis.fetch = Object.assign(
	async (_input: string | URL | Request, init?: RequestInit) => {
		hijackedCalls.push(JSON.stringify(init?.headers ?? {}));
		return new Response(null, { status: 200 });
	},
	{ preconnect: globalThis.fetch.preconnect },
);
