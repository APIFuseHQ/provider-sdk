// Records the headers real Google Chrome sends on each hop of a redirected
// navigation, form submission and script fetch, and writes
// chrome-redirect-hop-capture.json. Everything stays on 127.0.0.1: a
// node:http2 listener (self-signed) for HTTP/2 and a node:net listener that
// reads the raw HTTP/1.1 bytes.
//
//   xvfb-run -a node scripts/capture-chrome-redirect-hops.ts [/usr/bin/google-chrome]
//
// Node runs this file directly (type stripping), so the HTTP/2 listener is
// Node's own and its `rawHeaders` keep the HEADERS frame order. Playwright gets
// no locale, userAgent or extraHTTPHeaders option, so no header is installed
// through DevTools and Accept-Language comes from //net.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const chromePath = process.argv[2] ?? "/usr/bin/google-chrome";
const outFile = path.join(import.meta.dirname, "..", "chrome-redirect-hop-capture.json");

type Recorded = {
	method: string;
	path: string;
	order: string[];
	values: Record<string, string>;
	lines?: string[];
	requestLine?: string;
};

const PAGE = `<!doctype html><title>redirect hops</title>
<a id="nav" href="/start">go</a>
<form id="form-302" method="post" action="/submit?status=302"><input name="q" value="probe"><button>302</button></form>
<form id="form-303" method="post" action="/submit?status=303"><input name="q" value="probe"><button>303</button></form>
<form id="form-307" method="post" action="/submit?status=307"><input name="q" value="probe"><button>307</button></form>`;

type Reply = { status: number; headers: Record<string, string>; body: string };

function route(method: string, target: string): Reply {
	const url = new URL(target, "http://local");
	const status = Number(url.searchParams.get("status") ?? "302");
	const html = (body: string): Reply => ({
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
		body,
	});
	switch (url.pathname) {
		case "/page":
			return {
				...html(PAGE),
				headers: {
					"content-type": "text/html; charset=utf-8",
					"set-cookie": "probe_sid=abc123; Path=/",
				},
			};
		case "/start":
			return { status: 302, headers: { location: "/done" }, body: "" };
		case "/submit":
			return { status, headers: { location: "/done" }, body: "" };
		case "/done":
			return html(`<title>done</title>${method}`);
		case "/api/start":
			return { status: 302, headers: { location: "/api/done" }, body: "" };
		case "/api/submit":
			return { status, headers: { location: "/api/done" }, body: "" };
		case "/api/done":
			return {
				status: 200,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ method }),
			};
		default:
			return { status: 404, headers: {}, body: "" };
	}
}

function selfSignedCertificate(): { key: Buffer; cert: Buffer } {
	const dir = mkdtempSync(path.join(tmpdir(), "chrome-redirect-capture-"));
	try {
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-subj",
				"/CN=127.0.0.1",
				"-addext",
				"subjectAltName=IP:127.0.0.1",
				"-keyout",
				path.join(dir, "key.pem"),
				"-out",
				path.join(dir, "cert.pem"),
			],
			{ stdio: "ignore" },
		);
		return {
			key: readFileSync(path.join(dir, "key.pem")),
			cert: readFileSync(path.join(dir, "cert.pem")),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function startHttp2(recorded: Recorded[]): Promise<http2.Http2SecureServer> {
	const server = http2.createSecureServer({ ...selfSignedCertificate(), allowHTTP1: false });
	server.on("stream", (stream, headers, _flags, rawHeaders) => {
		const order: string[] = [];
		const values: Record<string, string> = {};
		for (let index = 0; index < rawHeaders.length; index += 2) {
			const name = String(rawHeaders[index]);
			order.push(name);
			values[name] = String(rawHeaders[index + 1]);
		}
		const method = String(headers[":method"]);
		const target = String(headers[":path"]);
		stream.on("data", () => {});
		stream.on("end", () => {
			recorded.push({ method, path: target, order, values });
			const reply = route(method, target);
			stream.respond({ ":status": reply.status, ...reply.headers });
			stream.end(reply.body);
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function startHttp1(recorded: Recorded[]): Promise<net.Server> {
	const server = net.createServer((socket) => {
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
			while (true) {
				const end = buffer.indexOf("\r\n\r\n");
				if (end < 0) return;
				const lines = buffer.subarray(0, end).toString("latin1").split("\r\n");
				const requestLine = lines.shift() ?? "";
				const lengthLine = lines.find((line) => /^content-length:/i.test(line));
				const length = lengthLine ? Number(lengthLine.slice(lengthLine.indexOf(":") + 1)) : 0;
				if (buffer.length < end + 4 + length) return;
				buffer = buffer.subarray(end + 4 + length);
				const [method = "", target = ""] = requestLine.split(" ");
				const order = lines.map((line) => line.slice(0, line.indexOf(":")));
				const values = Object.fromEntries(
					lines.map((line) => [
						line.slice(0, line.indexOf(":")),
						line.slice(line.indexOf(":") + 1).trim(),
					]),
				);
				recorded.push({ method, path: target, order, values, lines, requestLine });
				const reply = route(method, target);
				const body = Buffer.from(reply.body);
				const head = [
					`HTTP/1.1 ${reply.status} X`,
					...Object.entries(reply.headers).map(([name, value]) => `${name}: ${value}`),
					`content-length: ${body.length}`,
					"connection: keep-alive",
				].join("\r\n");
				socket.write(Buffer.concat([Buffer.from(`${head}\r\n\r\n`), body]));
			}
		});
		socket.on("error", () => {});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

type Scenario = {
	name: string;
	run: (page: import("playwright").Page) => Promise<unknown>;
	done: string;
};

const scenarios: Scenario[] = [
	{
		name: "navigation_302",
		run: (page) => Promise.all([page.waitForURL(/\/done$/), page.click("#nav")]),
		done: "/done",
	},
	...[302, 303, 307].map(
		(status): Scenario => ({
			name: `form_post_${status}`,
			run: (page) =>
				Promise.all([page.waitForURL(/\/done$/), page.click(`#form-${status} button`)]),
			done: "/done",
		}),
	),
	{
		name: "fetch_get_302",
		run: (page) => page.evaluate(() => fetch("/api/start").then((response) => response.text())),
		done: "/api/done",
	},
	...[302, 303, 307].map(
		(status): Scenario => ({
			name: `fetch_post_json_${status}`,
			run: (page) =>
				page.evaluate(
					(code) =>
						fetch(`/api/submit?status=${code}`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: '{"probe":true}',
						}).then((response) => response.text()),
					status,
				),
			done: "/api/done",
		}),
	),
];

const browser = await chromium.launch({ executablePath: chromePath, headless: false });
const capture: Record<string, unknown> = {};
try {
	for (const transport of ["h2", "h1"] as const) {
		const recorded: Recorded[] = [];
		const server = transport === "h2" ? await startHttp2(recorded) : await startHttp1(recorded);
		const { port } = server.address() as net.AddressInfo;
		const base = `${transport === "h2" ? "https" : "http"}://127.0.0.1:${port}`;
		for (const scenario of scenarios) {
			const context = await browser.newContext({ ignoreHTTPSErrors: true });
			const page = await context.newPage();
			await page.goto(`${base}/page`);
			recorded.length = 0;
			await scenario.run(page);
			await page.waitForTimeout(300);
			const hops = recorded.filter(
				(request) => request.path !== "/favicon.ico" && request.path !== "/page",
			);
			if (hops.at(-1)?.path !== scenario.done) {
				throw new Error(`${transport} ${scenario.name}: chain ended at ${hops.at(-1)?.path}`);
			}
			capture[`${scenario.name}_${transport}`] = { http: transport, hops };
			await context.close();
		}
		server.close();
	}
	writeFileSync(
		outFile,
		`${JSON.stringify(
			{
				provenance: {
					browser: `Google Chrome ${browser.version()} (${process.platform} ${process.arch}, headed under Xvfb)`,
					driver:
						"Playwright launching the system Chrome with no locale, userAgent or extraHTTPHeaders option, so no header is installed through DevTools; Accept-Language comes from //net",
					action:
						'a same-origin page that set probe_sid=abc123: a link click (navigation), a click on a <form method="post"> submit button (application/x-www-form-urlencoded, one field), and a page fetch() (GET, and POST with Content-Type: application/json); every first request is answered with the named redirect status to a same-origin target',
					h2: "HEADERS frame order from node:http2 rawHeaders on 127.0.0.1 (self-signed certificate)",
					h1: "raw request bytes read by a node:net listener on 127.0.0.1 over http://",
					script: "scripts/capture-chrome-redirect-hops.ts",
					captured: new Date().toISOString().slice(0, 10),
				},
				...capture,
			},
			null,
			"\t",
		)}\n`,
	);
	console.log(`wrote ${outFile}`);
} finally {
	await browser.close();
}
