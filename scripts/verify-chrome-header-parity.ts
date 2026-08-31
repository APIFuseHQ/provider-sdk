import chromeGroundTruth from "../chrome-ground-truth-capture.json";
import { createStealthClient } from "../src/runtime/stealth.js";
import type { StealthFetchOptions } from "../src/types.js";

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
		options: { headers: { Referer: "https://tls.peet.ws/" } },
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

if (failed) process.exitCode = 1;
