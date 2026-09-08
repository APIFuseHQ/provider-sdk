import { afterEach, describe, expect, it, jest } from "bun:test";
import { createServer, Socket } from "node:net";
import { createDiagnosticRedactor } from "../runtime/diagnostic-redactor.js";
import {
	createNativeNetworkClient,
	createNativeNetworkConnection,
} from "../runtime/native-network.js";
import {
	NativeTelemetryCollector,
	type NativeConnectTelemetryEvent,
	type NativeTelemetryDiagnostics,
} from "../runtime/native-telemetry.js";
import { isGatewayIngestible, RequestTelemetry } from "../runtime/request-telemetry.js";
import { createTraceContext } from "../runtime/trace.js";

const attempt: NativeConnectTelemetryEvent = {
	kind: "tcp",
	outcome: "ok",
	ms: 12,
	tunnelMs: 4,
	proxyUsed: true,
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	jest.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connectedSocket(): Promise<Socket> {
	const peers = new Set<Socket>();
	const server = createServer((socket) => {
		peers.add(socket);
		socket.on("error", () => undefined);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("TCP fixture did not bind");
	const socket = new Socket();
	await new Promise<void>((resolve, reject) => {
		socket.once("error", reject);
		socket.connect(address.port, "127.0.0.1", resolve);
	});
	cleanups.push(async () => {
		socket.destroy();
		for (const peer of peers) peer.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return socket;
}

describe("native telemetry collector", () => {
	it("detaches retained diagnostics from multi-megabyte vendor strings", async () => {
		const moduleUrl = new URL("../runtime/native-telemetry.ts", import.meta.url).href;
		const probe = Bun.spawn({
			cmd: [
				process.execPath,
				"--eval",
				`
				import { gcAndSweep, heapStats } from "bun:jsc";
				import { NativeTelemetryCollector } from ${JSON.stringify(moduleUrl)};
				const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
				function populate(repeats) {
					const collector = new NativeTelemetryCollector();
					for (let i = 0; i < 24; i++) {
						const text = String(i).padEnd(10, "X").repeat(repeats);
						const diagnostics = { host: text, errorMessage: text, systemCode: text, missingFields: [text] };
						collector.recordConnect({ kind: "tcp", outcome: "error", ms: 1, tunnelMs: 0, proxyUsed: false, errorCode: "other", diagnostics });
						collector.recordVendorSkip({ vendor: "smartproxy", reason: "allocation_failed", diagnostics });
					}
					return collector;
				}
				for (let i = 0; i < 4; i++) populate(1);
				await tick(); gcAndSweep();
				const before = heapStats().heapSize;
				globalThis.retained = populate(1048576);
				await tick(); gcAndSweep(); await tick(); gcAndSweep();
				console.log(JSON.stringify({ retainedHeapDelta: heapStats().heapSize - before, lengths: globalThis.retained.toLogPayload().attemptSamples.map((sample) => sample.diagnostics.host.length) }));
			`,
			],
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exit] = await Promise.all([
			new Response(probe.stdout).text(),
			new Response(probe.stderr).text(),
			probe.exited,
		]);
		expect(stderr).toBe("");
		expect(exit).toBe(0);
		const result = JSON.parse(stdout);
		expect(result.lengths).toEqual(Array(24).fill(300));
		expect(result.retainedHeapDelta).toBeLessThan(2 * 1024 * 1024);
	}, 20_000);

	it("omits an unused contributor from both surfaces", () => {
		const collector = new NativeTelemetryCollector();
		const ledger = new RequestTelemetry(createTraceContext());
		ledger.register(collector);
		expect(collector.toLogPayload()).toBeUndefined();
		expect(ledger.toLogPayload()).toBeUndefined();
		expect(ledger.toHeaderValue()).toBeUndefined();
	});

	it.each([
		[Number.MAX_SAFE_INTEGER - 1, 2],
		[Number.MAX_VALUE, Number.MAX_VALUE],
	])("saturates %s + %s without dropping native from log or header", (first, second) => {
		const collector = new NativeTelemetryCollector();
		const ledger = new RequestTelemetry(createTraceContext());
		ledger.register(collector);
		for (const [index, value] of [first, second, 1].entries()) {
			collector.recordConnect({ ...attempt, ms: value, tunnelMs: value });
			collector.recordBytes({ direction: "in", bytes: value });
			collector.recordBytes({ direction: "out", bytes: value });
			const total =
				index === 0 ? Math.min(first, Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
			const expected = {
				connectMs: total,
				tunnelMs: total,
				bytesIn: total,
				bytesOut: total,
			};
			expect(ledger.toLogPayload()?.native).toMatchObject(expected);
			const decoded = JSON.parse(Buffer.from(ledger.toHeaderValue()!, "base64url").toString());
			expect(decoded.native).toMatchObject(expected);
			expect(decoded.native).toEqual(collector.toHeaderPayload(collector.toLogPayload()!));
		}
	});

	it.each([
		[Number.NaN, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
		[Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
		[Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
		[Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
		[-10, 0, 12],
		[0, 0, 12],
		[6.9, 6, 18],
	])("clamps source value %s to %s for total %s in log and header", (input, clamped, total) => {
		const collector = new NativeTelemetryCollector();
		const ledger = new RequestTelemetry(createTraceContext());
		ledger.register(collector);
		for (const value of [6, input, 6]) {
			collector.recordConnect({ ...attempt, ms: value, tunnelMs: value });
			collector.recordBytes({ direction: "in", bytes: value });
			collector.recordBytes({ direction: "out", bytes: value });
		}
		const expected = {
			attempts: 3,
			connectMs: total,
			tunnelMs: total,
			bytesIn: total,
			bytesOut: total,
			attemptSamples: [
				{ n: 1, ...attempt, ms: 6, tunnelMs: 6 },
				{ n: 2, ...attempt, ms: clamped, tunnelMs: clamped },
				{ n: 3, ...attempt, ms: 6, tunnelMs: 6 },
			],
		};
		expect(ledger.toLogPayload()?.native).toMatchObject(expected);
		const decoded = JSON.parse(Buffer.from(ledger.toHeaderValue()!, "base64url").toString());
		expect(decoded.native).toMatchObject(expected);
	});

	it("aggregates beyond both sample caps and returns independent snapshots", () => {
		const collector = new NativeTelemetryCollector();
		for (let index = 0; index < 30; index++) {
			collector.recordConnect({ ...attempt, diagnostics: { host: "target.invalid" } });
			collector.recordVendorSkip({
				vendor: "smartproxy",
				reason: "credentials_absent",
				diagnostics: { missingFields: ["key"] },
			});
			collector.recordBytes({ direction: "in", bytes: 2 });
			collector.recordBytes({ direction: "out", bytes: 3 });
		}
		const log = collector.toLogPayload()!;
		expect(log).toMatchObject({
			attempts: 30,
			connectMs: 360,
			tunnelMs: 120,
			vendorSkips: 30,
			vendorSkipReasons: [{ reason: "credentials_absent", count: 30 }],
			bytesIn: 60,
			bytesOut: 90,
			attemptSamplesDropped: 6,
			vendorSkipSamplesDropped: 6,
		});
		expect(log.attemptSamples).toHaveLength(24);
		expect(log.vendorSkipSamples).toHaveLength(24);
		log.attemptSamples![0]!.diagnostics!.host = "changed";
		log.vendorSkipSamples![0]!.diagnostics!.missingFields = ["changed"];
		expect(collector.toLogPayload()?.attemptSamples?.[0]?.diagnostics?.host).toBe("target.invalid");
		expect(collector.toLogPayload()?.vendorSkipSamples?.[0]?.diagnostics?.missingFields).toEqual([
			"key",
		]);
		const header = collector.toHeaderPayload(log);
		expect(isGatewayIngestible(header)).toBe(true);
		expect(header.attemptSamplesDropped).toBe(6);
	});

	it("redacts every retained text field before bounding, keeping numeric and closed fields intact", () => {
		const sentinel = "P5cSecret123";
		expect(sentinel).toHaveLength(12);
		const registry = createDiagnosticRedactor([sentinel]);
		const seen: string[] = [];
		const collector = new NativeTelemetryCollector({
			redact: (text) => {
				seen.push(text);
				return registry.redact(text);
			},
		});
		const text = "a".repeat(294) + sentinel + "z".repeat(1000);
		const fields: NativeTelemetryDiagnostics = {
			host: text,
			serverName: text,
			protocol: text,
			sessionId: text,
			expiresAt: text,
			errorName: text,
			errorMessage: text,
			causeName: text,
			causeMessage: text,
			systemCode: text,
			missingFields: [text],
			port: 1234,
			status: 407,
			socksReplyCode: 2,
			sticky: true,
		};
		collector.recordConnect({
			...attempt,
			outcome: "error",
			errorCode: "native_connection_failed",
			diagnostics: fields,
		});
		collector.recordVendorSkip({
			vendor: "smartproxy",
			reason: "allocation_failed",
			diagnostics: fields,
		});
		const log = collector.toLogPayload()!;
		const header = collector.toHeaderPayload(log);
		expect(seen).toHaveLength(33);
		expect(seen.every((value) => value === text)).toBe(true);
		expect(log.attemptSamples?.[0]?.diagnostics?.errorMessage).toBe("a".repeat(294) + "[REDAC");
		expect(log.attemptSamples?.[0]?.diagnostics).toMatchObject({
			port: 1234,
			status: 407,
			socksReplyCode: 2,
			sticky: true,
		});
		expect(JSON.stringify(log)).not.toContain(sentinel);
		expect(JSON.stringify(header)).not.toContain("diagnostics");
		expect(JSON.stringify(header)).not.toContain("target");
		expect(header.lastErrorCode as unknown).toBe("native_connection_failed");
		expect(isGatewayIngestible(header)).toBe(true);
	});

	it("fails closed when redaction throws and preserves UTF-16 code units at the bound", () => {
		const failed = new NativeTelemetryCollector({
			redact: () => {
				throw new Error("redactor failed");
			},
		});
		failed.recordConnect({ ...attempt, diagnostics: { host: "P5cSecret123" } });
		expect(failed.toLogPayload()?.attemptSamples?.[0]?.diagnostics?.host).toBe(
			"[REDACTION_FAILED]",
		);
		expect(JSON.stringify(failed.toLogPayload())).not.toContain("P5cSecret123");
		const collector = new NativeTelemetryCollector();
		collector.recordConnect({
			...attempt,
			diagnostics: { host: "a".repeat(299) + "\ud83d\ude00" },
		});
		expect(collector.toLogPayload()?.attemptSamples?.[0]?.diagnostics?.host).toBe(
			"a".repeat(299) + "\ud83d",
		);
	});

	it("projects a real log payload into the v1 header without diagnostic text", () => {
		const collector = new NativeTelemetryCollector();
		collector.recordConnect({ ...attempt, diagnostics: { host: "target.invalid", port: 443 } });
		const ledger = new RequestTelemetry(createTraceContext());
		ledger.register(collector);
		const log = collector.toLogPayload()!;
		const decoded = JSON.parse(Buffer.from(ledger.toHeaderValue()!, "base64url").toString());
		expect(decoded.v).toBe(1);
		expect(decoded.native).toEqual(collector.toHeaderPayload(log));
		expect(decoded.native.attemptSamples).toEqual([{ n: 1, ...attempt }]);
	});

	it("counts preflight and catch/rethrow failures once, with three calls producing three samples", async () => {
		const collector = new NativeTelemetryCollector();
		const client = createNativeNetworkClient({
			nativeTelemetry: collector,
			proxyPolicy: { mode: "disabled" },
			egress: {},
		});
		for (let index = 0; index < 3; index++)
			await expect(client.connectTcp({ host: "example.com", port: 443 })).rejects.toMatchObject({
				code: "native_egress_not_declared",
			});
		expect(collector.toLogPayload()?.attempts).toBe(3);
		expect(collector.toLogPayload()?.attemptSamples?.map((sample) => sample.n)).toEqual([1, 2, 3]);
	});

	it("contains recorder failures without changing transport errors", async () => {
		const collector = new NativeTelemetryCollector();
		collector.recordConnect = () => {
			throw new Error("observer failure");
		};
		const client = createNativeNetworkClient({ nativeTelemetry: collector, egress: {} });
		await expect(client.connectTcp({ host: "example.com", port: 443 })).rejects.toMatchObject({
			code: "native_egress_not_declared",
		});
	});

	it.each([
		"acknowledged",
		"error",
		"missing",
		"pending",
	] as const)("records actual drain %s and hard expiry once", async (mode) => {
		const socket = await connectedSocket();
		const collector = new NativeTelemetryCollector({
			redact: (text) => text.replaceAll("P5cSecret123", "[REDACTED]"),
		});
		const now = Date.parse("2026-09-08T00:00:00Z");
		jest.useFakeTimers({ now });
		const connection = createNativeNetworkConnection(
			socket,
			{
				url: "http://fixture.invalid:8080",
				vendor: "nodemaven",
				sticky: true,
				expiresAt: new Date(now + 10000).toISOString(),
			},
			{
				nativeTelemetry: collector,
				proxyPolicy: { mode: "required", session: { drainLeadSeconds: 3 } },
				warn: () => undefined,
			},
		);
		if (mode !== "missing")
			connection.onExpiring?.(() => {
				if (mode === "error") throw new Error("drain P5cSecret123");
				if (mode === "pending") return new Promise<void>(() => undefined);
			});
		jest.advanceTimersByTime(7000);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(collector.toLogPayload()).toMatchObject({
			drain: 1,
			drainAcknowledged: mode === "acknowledged" ? 1 : 0,
			drainErrors: mode === "error" ? 1 : 0,
			drainMissingHandler: mode === "missing" ? 1 : 0,
			expiry: 0,
		});
		expect(JSON.stringify(collector.toLogPayload())).not.toContain("P5cSecret123");
		jest.advanceTimersByTime(3000);
		await expect(connection.read()).rejects.toMatchObject({ code: "native_proxy_expired" });
		await expect(connection.read()).rejects.toMatchObject({ code: "native_proxy_expired" });
		expect(collector.toLogPayload()).toMatchObject({
			drain: 1,
			expiry: 1,
			lastErrorCode: "native_proxy_expired",
		});
	});

	it("counts idle expiry once across repeated reads and clears timers on early close", async () => {
		const socket = await connectedSocket();
		const collector = new NativeTelemetryCollector();
		jest.useFakeTimers();
		const connection = createNativeNetworkConnection(
			socket,
			undefined,
			{ nativeTelemetry: collector },
			1000,
		);
		jest.advanceTimersByTime(1000);
		await expect(connection.read()).rejects.toMatchObject({
			code: "native_connection_idle_timeout",
		});
		await expect(connection.read()).rejects.toMatchObject({
			code: "native_connection_idle_timeout",
		});
		expect(collector.toLogPayload()).toMatchObject({
			idle: 1,
			expiry: 0,
			lastErrorCode: "native_connection_idle_timeout",
		});
	});

	it.each([
		"resolve",
		"reject",
	] as const)("ignores drain %s after the connection lifecycle ends", async (outcome) => {
		const socket = await connectedSocket();
		const collector = new NativeTelemetryCollector();
		const now = Date.parse("2026-09-08T00:00:00Z");
		jest.useFakeTimers({ now });
		let finish!: () => void;
		const pending = new Promise<void>((resolve, reject) => {
			finish = outcome === "resolve" ? resolve : () => reject(new Error("late drain"));
		});
		const connection = createNativeNetworkConnection(
			socket,
			{
				url: "http://fixture.invalid:8080",
				vendor: "nodemaven",
				sticky: true,
				expiresAt: new Date(now + 10000).toISOString(),
			},
			{
				nativeTelemetry: collector,
				proxyPolicy: { mode: "required", session: { drainLeadSeconds: 3 } },
			},
		);
		connection.onExpiring?.(() => pending);
		jest.advanceTimersByTime(7000);
		await Promise.resolve();
		jest.advanceTimersByTime(3000);
		await Promise.resolve();
		await Promise.resolve();
		finish();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(collector.toLogPayload()).toMatchObject({
			drain: 1,
			expiry: 1,
			drainAcknowledged: 0,
			drainErrors: 0,
		});
	});
});
