// Runs the real stealth transport (wreq-js, no module mock) against two local
// servers and prints what each one received. stealth-redirect-wire.test.ts
// spawns this file so the wreq-js mock in other test files cannot reach it.
import { createStealthClient } from "../../runtime/stealth.js";

type Received = { path: string; method: string; headers: Record<string, string> };

function recordingServer(routes: (url: URL) => Response) {
	const received: Received[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request): Response {
			const url = new URL(request.url);
			received.push({
				path: url.pathname,
				method: request.method,
				headers: Object.fromEntries(request.headers),
			});
			return routes(url);
		},
	});
	return { server, received };
}

const other = recordingServer(() => new Response("other"));
// Same host, other port: same site (an IP address is its own site), other origin.
const sameSite = `http://127.0.0.1:${other.server.port}`;
// Other host name for the same listener: other site.
const crossSite = `http://localhost:${other.server.port}`;
const first = recordingServer((url) => {
	const target = url.searchParams.get("to");
	if (target) return new Response(null, { status: 302, headers: { location: target } });
	return new Response("first");
});
const origin = `http://127.0.0.1:${first.server.port}`;
const credentials = { Authorization: "Bearer caller-token", Cookie: "sid=caller-session" };

async function scenario(name: string, run: () => Promise<unknown>) {
	first.received.length = 0;
	other.received.length = 0;
	let error: { name?: string; code?: string } | undefined;
	try {
		await run();
	} catch (caught) {
		const value = caught as { name?: string; code?: string };
		error = { name: value.name, code: value.code };
	}
	return [
		name,
		{ first: [...first.received], other: [...other.received], ...(error ? { error } : {}) },
	] as const;
}

const client = () => createStealthClient(origin);
const results = Object.fromEntries([
	await scenario("crossSite", () =>
		client().fetch(`/login?to=${encodeURIComponent(`${crossSite}/steal`)}`, {
			headers: { ...credentials, "X-Trace": "kept" },
		}),
	),
	await scenario("sameSite", () =>
		client().fetch(`/login?to=${encodeURIComponent(`${sameSite}/next`)}`, {
			headers: credentials,
		}),
	),
	await scenario("postToGet", () =>
		client().fetch(`/login?to=${encodeURIComponent(`${origin}/done`)}`, {
			method: "POST",
			body: "user=a",
			headers: { ...credentials, "Content-Type": "application/x-www-form-urlencoded" },
		}),
	),
	await scenario("policy", () =>
		client().fetch(`/login?to=${encodeURIComponent(`${crossSite}/steal`)}`, {
			headers: credentials,
			redirectPolicy: { mode: "same-origin", maxHops: 5 },
		}),
	),
	await scenario("redirectsRun", () =>
		client()
			.createSession()
			.redirects.run({
				url: `/login?to=${encodeURIComponent(`${crossSite}/steal`)}`,
				headers: credentials,
			}),
	),
]);

first.server.stop(true);
other.server.stop(true);
console.log(JSON.stringify(results));
