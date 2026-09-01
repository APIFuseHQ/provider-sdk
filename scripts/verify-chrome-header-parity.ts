import chromeGroundTruth from "../chrome-ground-truth-capture.json";
import chromeExtendedCapture from "../chrome-extended-capture.json";
import h1CasingCapture from "../h1-casing-capture.json";
import { createStealthClient } from "../src/runtime/stealth.js";
import type { StealthFetchOptions } from "../src/types.js";
import net from "node:net";

const endpoint = "https://tls.peet.ws/api/all";

const probes: Array<{
	name: string;
	expected: string[];
	options?: StealthFetchOptions;
}> = [
	{
		name: "navigation",
		expected: chromeGroundTruth.document_navigation_cold.order,
	},
	{
		name: "xhr",
		expected: chromeGroundTruth.fetch_xhr.order,
		options: {
			stealth: { requestClass: "xhr" },
			headers: { Referer: "https://tls.peet.ws/" },
		},
	},
	{
		name: "post",
		expected: chromeGroundTruth.fetch_post_json.order,
		options: {
			method: "POST",
			body: '{"probe":true}',
			headers: {
				"Content-Type": "application/json",
				Origin: "https://tls.peet.ws",
				Referer: "https://tls.peet.ws/",
			},
		},
	},
	{
		name: "xhr-extra-headers-cookie",
		expected: chromeExtendedCapture.xhr_extra_headers.order,
		options: {
			stealth: { requestClass: "xhr" },
			headers: {
				"Cache-Control": "no-cache",
				"If-None-Match": '"etag-value"',
				Pragma: "no-cache",
				"X-Requested-With": "XMLHttpRequest",
				Referer: "https://tls.peet.ws/api/all",
				Cookie: "probe_sid=abc123",
			},
		},
	},
	{
		name: "navigation-cookie",
		expected: chromeExtendedCapture.navigation_with_cookie.order,
		options: { headers: { Cookie: "probe_sid=abc123" } },
	},
	{
		name: "post-form-cookie",
		expected: chromeExtendedCapture.post_form_urlencoded.order,
		options: {
			method: "POST",
			body: "a=1",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: "https://tls.peet.ws",
				Referer: "https://tls.peet.ws/api/all",
				Cookie: "probe_sid=abc123",
			},
		},
	},
	{
		name: "xhr-range",
		expected: chromeExtendedCapture.xhr_range.order,
		options: {
			stealth: { requestClass: "xhr" },
			headers: {
				Referer: "https://tls.peet.ws/api/all",
				Cookie: "probe_sid=abc123",
				Range: "bytes=0-1023",
			},
		},
	},
];

function observedHeaderOrder(payload: unknown): string[] {
	if (!payload || typeof payload !== "object") return [];
	const http2 = (payload as { http2?: unknown }).http2;
	if (!http2 || typeof http2 !== "object") return [];
	const frames = (http2 as { sent_frames?: unknown }).sent_frames;
	if (!Array.isArray(frames)) return [];
	const headersFrame = frames.find(
		(frame) =>
			frame &&
			typeof frame === "object" &&
			String((frame as { frame_type?: unknown }).frame_type).toLowerCase() === "headers",
	);
	const headers = (headersFrame as { headers?: unknown } | undefined)?.headers;
	if (!Array.isArray(headers)) return [];
	return headers.flatMap((header) => {
		if (typeof header === "string") {
			if (header.startsWith(":")) return [header.slice(0, header.indexOf(":", 1))];
			return [header.slice(0, header.indexOf(":"))];
		}
		if (header && typeof header === "object") {
			const name = (header as { name?: unknown }).name;
			return typeof name === "string" ? [name.toLowerCase()] : [];
		}
		return [];
	});
}

let failed = false;
for (const probe of probes) {
	const client = createStealthClient(endpoint, {
		stealth: { browser: "chrome", os: "macos" },
	});
	try {
		const payload = await client.fetch(endpoint, probe.options).then((response) => response.json());
		const observed = observedHeaderOrder(payload);
		const matches = JSON.stringify(observed) === JSON.stringify(probe.expected);
		failed ||= !matches;
		console.log(
			JSON.stringify({ class: probe.name, matches, expected: probe.expected, observed }, null, 2),
		);
	} finally {
		client.close?.();
	}
}

const h1Server = net.createServer((socket) => {
	let buffered = "";
	let handled = false;
	socket.on("data", (chunk) => {
		if (handled) return;
		buffered += chunk.toString("latin1");
		if (!buffered.includes("\r\n\r\n")) return;
		handled = true;
		const lines = buffered.slice(0, buffered.indexOf("\r\n\r\n")).split("\r\n");
		const names = lines.slice(1).map((line) => line.slice(0, line.indexOf(":")));
		console.log(
			JSON.stringify(
				{
					class: "h1-xhr",
					matches: JSON.stringify(names) === JSON.stringify(h1CasingCapture.chrome_xhr.names),
					expected: h1CasingCapture.chrome_xhr.names,
					observed: names,
				},
				null,
			),
		);
		failed ||= JSON.stringify(names) !== JSON.stringify(h1CasingCapture.chrome_xhr.names);
		socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
	});
});
await new Promise<void>((resolve) => h1Server.listen(0, "127.0.0.1", resolve));
const h1Address = h1Server.address();
if (!h1Address || typeof h1Address === "string") throw new Error("h1 verifier listener did not start");
const h1Client = createStealthClient(`http://127.0.0.1:${h1Address.port}`);
try {
	await h1Client.fetch("/xhr", {
		stealth: { requestClass: "xhr" },
		headers: {
			"Cache-Control": "no-cache",
			"X-Requested-With": "XMLHttpRequest",
			Referer: `http://127.0.0.1:${h1Address.port}/`,
			Cookie: "probe_sid=abc123",
		},
	});
} finally {
	h1Client.close?.();
	h1Server.close();
}

if (failed) process.exitCode = 1;
