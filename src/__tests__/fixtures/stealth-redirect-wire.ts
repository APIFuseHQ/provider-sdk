// Runs the real stealth transport (wreq-js, no module mock) against two local
// servers and prints what each one received. stealth-redirect-wire.test.ts
// spawns this file so the wreq-js mock in other test files cannot reach it.
import net from "node:net";
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

// HTTP/1.1 header order as written on the wire: Bun.serve does not keep it, so
// this listener reads the raw request bytes.
type RawReceived = { path: string; method: string; names: string[] };
const rawReceived: RawReceived[] = [];
const raw = net.createServer((socket) => {
	let buffer = Buffer.alloc(0);
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
		while (true) {
			const end = buffer.indexOf("\r\n\r\n");
			if (end < 0) return;
			const lines = buffer.subarray(0, end).toString("latin1").split("\r\n");
			const [method = "", target = ""] = (lines.shift() ?? "").split(" ");
			const names = lines.map((line) => line.slice(0, line.indexOf(":")));
			const lengthLine = lines.find((line) => /^content-length:/i.test(line));
			const length = lengthLine ? Number(lengthLine.slice(lengthLine.indexOf(":") + 1)) : 0;
			if (buffer.length < end + 4 + length) return;
			buffer = buffer.subarray(end + 4 + length);
			const url = new URL(target, "http://raw");
			rawReceived.push({ path: url.pathname, method, names });
			const status = url.pathname === "/done" ? 200 : Number(url.searchParams.get("status"));
			socket.write(
				status === 200
					? "HTTP/1.1 200 OK\r\ncontent-length: 4\r\n\r\ndone"
					: `HTTP/1.1 ${status} Redirect\r\nlocation: /done\r\ncontent-length: 0\r\n\r\n`,
			);
		}
	});
	socket.on("error", () => {});
});
await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
const rawOrigin = `http://127.0.0.1:${(raw.address() as net.AddressInfo).port}`;

const rawResults: Record<string, RawReceived[]> = {};
async function rawScenario(name: string, run: () => Promise<unknown>) {
	rawReceived.length = 0;
	await run();
	rawResults[name] = [...rawReceived];
}

const browserHeaders = { Referer: `${rawOrigin}/page`, Cookie: "probe_sid=abc123" };
await rawScenario("navigation302", () =>
	createStealthClient(rawOrigin).fetch("/start?status=302", { headers: browserHeaders }),
);
for (const status of [302, 303, 307]) {
	await rawScenario(`formPost${status}`, () =>
		createStealthClient(rawOrigin).fetch(`/submit?status=${status}`, {
			method: "POST",
			body: "q=probe",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: rawOrigin,
				...browserHeaders,
			},
			stealth: { requestClass: "form-post" },
		}),
	);
}
await rawScenario("redirectsRunNavigation302", () =>
	createStealthClient(rawOrigin)
		.createSession()
		.redirects.run({ url: "/start?status=302", headers: browserHeaders }),
);
raw.close();

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
console.log(JSON.stringify({ ...results, raw: rawResults }));
