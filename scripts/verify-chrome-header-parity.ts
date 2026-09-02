import net from "node:net";
import alPlacementCapture from "../al-placement-capture.json";
import chromeAcceptOverride from "../chrome-accept-override.json";
import chromeExtendedCapture from "../chrome-extended-capture.json";
import chromeGroundTruth from "../chrome-ground-truth-capture.json";
import chromeValueTransform from "../chrome-value-transform.json";
import h1CasingCapture from "../h1-casing-capture.json";
import { createStealthClient } from "../src/runtime/stealth.js";
import type { StealthFetchOptions } from "../src/types.js";

const endpoint = "https://tls.peet.ws/api/all";
const acceptOverride = chromeAcceptOverride.accept_json;
const pseudoHeaders = chromeGroundTruth.fetch_xhr.order.slice(0, 4);

/**
 * The ground-truth, extended and h1 captures were taken through Playwright's
 * `locale` option, which installs Accept-Language via DevTools next to
 * User-Agent. Real Chrome only receives it from //net
 * (URLRequestHttpJob::AddExtraHeaders): after Accept-Encoding, before Cookie.
 * al-placement-capture.json B/C hold the no-DevTools captures directly.
 */
function realChromeOrder(harnessOrder: readonly string[]): string[] {
	const acceptLanguage = harnessOrder.find((name) => name.toLowerCase() === "accept-language");
	if (acceptLanguage === undefined) throw new Error("Harness capture lacks Accept-Language");
	const order = harnessOrder.filter((name) => name !== acceptLanguage);
	const acceptEncoding = order.findIndex((name) => name.toLowerCase() === "accept-encoding");
	if (acceptEncoding < 0) throw new Error("Harness capture lacks Accept-Encoding");
	order.splice(acceptEncoding + 1, 0, acceptLanguage);
	return order;
}

function callerHeaders(names: readonly string[]): Record<string, string> {
	return Object.fromEntries(names.map((name) => [name, "1"]));
}

const probes: Array<{
	name: string;
	expected: string[];
	expectedValues?: Record<string, string>;
	clientAcceptLanguage?: string;
	options?: StealthFetchOptions;
}> = [
	{
		name: "navigation",
		expected: realChromeOrder(chromeGroundTruth.document_navigation_cold.order),
	},
	{
		name: "xhr",
		expected: [...pseudoHeaders, ...alPlacementCapture.B_nolocale_none.order],
		options: {
			stealth: { requestClass: "xhr" },
			headers: { Referer: "https://tls.peet.ws/" },
		},
	},
	{
		name: "post",
		expected: realChromeOrder(chromeGroundTruth.fetch_post_json.order),
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
		name: "xhr-hashmap-three-caller",
		expected: [...pseudoHeaders, ...alPlacementCapture.B_nolocale_three.order],
		options: {
			stealth: { requestClass: "xhr" },
			headers: {
				...callerHeaders(alPlacementCapture.B_nolocale_three.caller),
				Referer: "https://tls.peet.ws/api/all",
			},
		},
	},
	{
		name: "xhr-hashmap-five-caller",
		expected: [...pseudoHeaders, ...alPlacementCapture.B_nolocale_five.order],
		options: {
			stealth: { requestClass: "xhr" },
			headers: {
				...callerHeaders(alPlacementCapture.B_nolocale_five.caller),
				Referer: "https://tls.peet.ws/api/all",
			},
		},
	},
	{
		name: "xhr-accept-lang-flag",
		expected: [...pseudoHeaders, ...alPlacementCapture.C_acceptlang_three.order],
		expectedValues: { "accept-language": alPlacementCapture.C_acceptlang_three.acceptLanguage },
		clientAcceptLanguage: alPlacementCapture.C_acceptlang_three.acceptLanguage,
		options: {
			stealth: { requestClass: "xhr" },
			headers: {
				...callerHeaders(alPlacementCapture.C_acceptlang_three.caller),
				Referer: "https://tls.peet.ws/api/all",
			},
		},
	},
	{
		name: "navigation-cookie",
		expected: realChromeOrder(chromeExtendedCapture.navigation_with_cookie.order),
		options: { headers: { Cookie: "probe_sid=abc123" } },
	},
	{
		name: "post-form-cookie",
		expected: realChromeOrder(chromeExtendedCapture.post_form_urlencoded.order),
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
		expected: realChromeOrder(chromeExtendedCapture.xhr_range.order),
		options: {
			stealth: { requestClass: "xhr" },
			headers: {
				Referer: "https://tls.peet.ws/api/all",
				Cookie: "probe_sid=abc123",
				Range: "bytes=0-1023",
			},
		},
	},
	{
		name: "xhr-accept-override",
		expected: [
			...pseudoHeaders,
			...realChromeOrder(Object.keys(chromeValueTransform.accept_padded.observed)),
		],
		expectedValues: { [acceptOverride.header.toLowerCase()]: acceptOverride.observed },
		options: {
			stealth: { requestClass: "xhr" },
			headers: {
				Referer: chromeValueTransform.accept_padded.observed.referer,
				[acceptOverride.header]: acceptOverride.requested,
			},
		},
	},
	{
		// Caller Accept-Language rides in the Fetch map; //net appends no second one.
		// The harness capture is also the real-Chrome order here because the DevTools
		// locale override skips a key the page already set.
		name: "xhr-caller-accept-language",
		expected: [
			...pseudoHeaders,
			...Object.keys(chromeValueTransform.accept_language_override.observed),
		],
		expectedValues: {
			"accept-language": chromeValueTransform.accept_language_override.observed["accept-language"],
		},
		options: {
			stealth: { requestClass: "xhr" },
			headers: {
				Referer: chromeValueTransform.accept_language_override.observed.referer,
				...chromeValueTransform.accept_language_override.sent,
			},
		},
	},
];

function observedHeaders(payload: unknown): Array<[string, string]> {
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
	return headers.flatMap((header): Array<[string, string]> => {
		if (typeof header === "string") {
			const separator = header.indexOf(":", header.startsWith(":") ? 1 : 0);
			if (separator < 0) return [];
			return [[header.slice(0, separator).toLowerCase(), header.slice(separator + 1).trimStart()]];
		}
		if (header && typeof header === "object") {
			const name = (header as { name?: unknown }).name;
			const value = (header as { value?: unknown }).value;
			return typeof name === "string"
				? [[name.toLowerCase(), typeof value === "string" ? value : ""]]
				: [];
		}
		return [];
	});
}

let failed = false;
for (const probe of probes) {
	const client = createStealthClient(endpoint, {
		stealth: {
			browser: "chrome",
			os: "macos",
			...(probe.clientAcceptLanguage ? { acceptLanguage: probe.clientAcceptLanguage } : {}),
		},
	});
	try {
		const payload = await client.fetch(endpoint, probe.options).then((response) => response.json());
		const observedHeadersList = observedHeaders(payload);
		const observed = observedHeadersList.map(([name]) => name);
		const observedValues = Object.fromEntries(
			Object.keys(probe.expectedValues ?? {}).map((name) => [
				name,
				observedHeadersList.find(([observedName]) => observedName === name)?.[1],
			]),
		);
		const matches =
			JSON.stringify(observed) === JSON.stringify(probe.expected) &&
			JSON.stringify(observedValues) === JSON.stringify(probe.expectedValues ?? {});
		failed ||= !matches;
		console.log(
			JSON.stringify(
				{
					class: probe.name,
					matches,
					expected: probe.expected,
					observed,
					...(probe.expectedValues ? { expectedValues: probe.expectedValues, observedValues } : {}),
				},
				null,
				2,
			),
		);
	} finally {
		client.close?.();
	}
}

const h1Expected = realChromeOrder(h1CasingCapture.chrome_xhr.names);
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
					matches: JSON.stringify(names) === JSON.stringify(h1Expected),
					expected: h1Expected,
					observed: names,
				},
				null,
			),
		);
		failed ||= JSON.stringify(names) !== JSON.stringify(h1Expected);
		socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
	});
});
await new Promise<void>((resolve) => h1Server.listen(0, "127.0.0.1", resolve));
const h1Address = h1Server.address();
if (!h1Address || typeof h1Address === "string")
	throw new Error("h1 verifier listener did not start");
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
