import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	collectRuntimeDiagnostics,
	DEFAULT_RUNTIME_DIAGNOSTICS_WINDOW_MS,
	MAX_RUNTIME_DIAGNOSTICS_WINDOW_MS,
	MIN_RUNTIME_DIAGNOSTICS_WINDOW_MS,
	normalizeRuntimeDiagnosticsWindowMs,
	PROCFS_CLOCK_TICKS_PER_SECOND,
	resolveRuntimeDiagnosticsWindowMs,
	RUNTIME_DIAGNOSTICS_ROUTE,
	type RuntimeDiagnosticsClock,
	type RuntimeDiagnosticsReport,
} from "../server/runtime-diagnostics.js";
import { createServerApp } from "../server/serve.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

interface FixtureThread {
	readonly tid: number;
	readonly name: string;
	readonly state?: string;
	readonly userTicks: number;
	readonly systemTicks: number;
	readonly voluntary?: number;
	readonly nonvoluntary?: number;
	readonly waitChannel?: string;
}

const fixtureRoots: string[] = [];

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createProcfsFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "apifuse-runtime-diagnostics-"));
	fixtureRoots.push(root);
	mkdirSync(join(root, "task"));
	mkdirSync(join(root, "fd"));
	return root;
}

function writeThread(root: string, thread: FixtureThread): void {
	const taskDir = join(root, "task", String(thread.tid));
	mkdirSync(taskDir, { recursive: true });
	const state = thread.state ?? "S";
	// Field layout of /proc/<pid>/task/<tid>/stat: pid (comm) state ppid pgrp
	// session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime ...
	writeFileSync(
		join(taskDir, "stat"),
		`${thread.tid} (${thread.name}) ${state} 1 1 1 0 -1 4194560 100 0 0 0 ${thread.userTicks} ${thread.systemTicks} 0 0 20 0 11 0 12345 0 0\n`,
	);
	writeFileSync(
		join(taskDir, "status"),
		`Name:\t${thread.name}\nvoluntary_ctxt_switches:\t${thread.voluntary ?? 0}\nnonvoluntary_ctxt_switches:\t${thread.nonvoluntary ?? 0}\n`,
	);
	writeFileSync(join(taskDir, "wchan"), thread.waitChannel ?? "0");
}

function writeFileDescriptors(root: string, targets: readonly string[]): void {
	for (const [index, target] of targets.entries()) {
		symlinkSync(target, join(root, "fd", String(index)));
	}
}

function scriptedClock(
	nowValues: readonly number[],
	onSleep: (ms: number) => void = () => {},
): RuntimeDiagnosticsClock & { readonly sleeps: number[] } {
	const remaining = [...nowValues];
	const sleeps: number[] = [];
	return {
		sleeps,
		now: () => {
			const next = remaining.shift();
			if (next === undefined) throw new Error("scripted clock exhausted");
			return next;
		},
		sleep: async (ms) => {
			sleeps.push(ms);
			onSleep(ms);
		},
	};
}

const provider = { id: "diagnostics-provider", version: "3.1.4" };

describe("runtime diagnostics window", () => {
	it("defaults, parses and clamps the windowMs query", () => {
		expect(resolveRuntimeDiagnosticsWindowMs(undefined)).toBe(
			DEFAULT_RUNTIME_DIAGNOSTICS_WINDOW_MS,
		);
		expect(resolveRuntimeDiagnosticsWindowMs(null)).toBe(DEFAULT_RUNTIME_DIAGNOSTICS_WINDOW_MS);
		expect(resolveRuntimeDiagnosticsWindowMs("")).toBe(DEFAULT_RUNTIME_DIAGNOSTICS_WINDOW_MS);
		expect(resolveRuntimeDiagnosticsWindowMs("abc")).toBe(DEFAULT_RUNTIME_DIAGNOSTICS_WINDOW_MS);
		expect(resolveRuntimeDiagnosticsWindowMs("1000")).toBe(1000);
		expect(resolveRuntimeDiagnosticsWindowMs("1000.9")).toBe(1000);
		expect(resolveRuntimeDiagnosticsWindowMs("1")).toBe(MIN_RUNTIME_DIAGNOSTICS_WINDOW_MS);
		expect(resolveRuntimeDiagnosticsWindowMs("-5")).toBe(MIN_RUNTIME_DIAGNOSTICS_WINDOW_MS);
		expect(resolveRuntimeDiagnosticsWindowMs("999999")).toBe(MAX_RUNTIME_DIAGNOSTICS_WINDOW_MS);
	});

	it("normalizes programmatic windows the same way", () => {
		expect(normalizeRuntimeDiagnosticsWindowMs(undefined)).toBe(
			DEFAULT_RUNTIME_DIAGNOSTICS_WINDOW_MS,
		);
		expect(normalizeRuntimeDiagnosticsWindowMs(Number.NaN)).toBe(
			DEFAULT_RUNTIME_DIAGNOSTICS_WINDOW_MS,
		);
		expect(normalizeRuntimeDiagnosticsWindowMs(Number.POSITIVE_INFINITY)).toBe(
			DEFAULT_RUNTIME_DIAGNOSTICS_WINDOW_MS,
		);
		expect(normalizeRuntimeDiagnosticsWindowMs(0)).toBe(MIN_RUNTIME_DIAGNOSTICS_WINDOW_MS);
		expect(normalizeRuntimeDiagnosticsWindowMs(300.7)).toBe(300);
		expect(normalizeRuntimeDiagnosticsWindowMs(1e9)).toBe(MAX_RUNTIME_DIAGNOSTICS_WINDOW_MS);
	});
});

describe("collectRuntimeDiagnostics", () => {
	it("attributes window CPU to threads from two procfs samples and ranks the hottest first", async () => {
		const root = createProcfsFixture();
		writeThread(root, { tid: 1, name: "bun", userTicks: 100, systemTicks: 20, voluntary: 10 });
		writeThread(root, {
			tid: 2,
			name: "HTTP Client",
			userTicks: 5,
			systemTicks: 5,
			waitChannel: "ep_poll",
		});
		writeThread(root, { tid: 3, name: "HeapHelper", userTicks: 0, systemTicks: 0 });
		writeFileDescriptors(root, [
			"socket:[1]",
			"socket:[2]",
			"anon_inode:[eventpoll]",
			"anon_inode:[timerfd]",
			"anon_inode:[eventfd]",
			"pipe:[3]",
			"/dev/null",
			"anon_inode:[io_uring]",
		]);
		const clock = scriptedClock([0, 1000], () => {
			// The main thread burns 40 ticks user + 10 ticks system (0.5 cores over
			// one second) and switches context 30 times; the network thread
			// moves 2 ticks; the helper stays idle.
			writeThread(root, {
				tid: 1,
				name: "bun",
				state: "R",
				userTicks: 140,
				systemTicks: 30,
				voluntary: 40,
				nonvoluntary: 3,
			});
			writeThread(root, {
				tid: 2,
				name: "HTTP Client",
				userTicks: 6,
				systemTicks: 6,
				waitChannel: "ep_poll",
			});
		});

		const report = await collectRuntimeDiagnostics({
			provider,
			windowMs: 1000,
			procfsRoot: root,
			clock,
		});

		expect(clock.sleeps).toEqual([1000]);
		expect(report.schemaVersion).toBe(1);
		expect(report.provider).toEqual(provider);
		expect(report.window).toEqual({ requestedMs: 1000, observedMs: 1000 });
		expect(report.procfs).not.toBeNull();
		const procfs = report.procfs;
		if (!procfs) throw new Error("expected procfs");
		expect(procfs.clockTicksPerSecond).toBe(PROCFS_CLOCK_TICKS_PER_SECOND);
		expect(procfs.threads.total).toBe(3);
		expect(procfs.threads.byName).toEqual({ bun: 1, "HTTP Client": 1, HeapHelper: 1 });
		expect(procfs.threads.items.map((thread) => thread.tid)).toEqual([1, 2, 3]);
		expect(procfs.threads.items[0]).toEqual({
			tid: 1,
			name: "bun",
			state: "R",
			waitChannel: "0",
			lifetime: { userTicks: 140, systemTicks: 30 },
			window: {
				userTicks: 40,
				systemTicks: 10,
				cores: 0.5,
				contextSwitches: { voluntary: 30, nonvoluntary: 3 },
			},
		});
		expect(procfs.threads.items[1]).toMatchObject({
			tid: 2,
			name: "HTTP Client",
			state: "S",
			waitChannel: "ep_poll",
			window: { userTicks: 1, systemTicks: 1, cores: 0.02 },
		});
		expect(procfs.threads.items[2]?.window).toEqual({
			userTicks: 0,
			systemTicks: 0,
			cores: 0,
			contextSwitches: { voluntary: 0, nonvoluntary: 0 },
		});
		expect(procfs.fileDescriptors).toEqual({
			total: 8,
			byKind: { socket: 2, eventpoll: 1, timerfd: 1, eventfd: 1, pipe: 1, file: 1, other: 1 },
		});
	});

	it("drops threads that exited and reports a null window for threads born inside the window", async () => {
		const root = createProcfsFixture();
		writeThread(root, { tid: 1, name: "bun", userTicks: 1, systemTicks: 1 });
		writeThread(root, { tid: 2, name: "JITWorker", userTicks: 9, systemTicks: 9 });
		const clock = scriptedClock([0, 500], () => {
			rmSync(join(root, "task", "2"), { recursive: true, force: true });
			writeThread(root, { tid: 3, name: "HTTP Client", userTicks: 7, systemTicks: 0 });
		});

		const report = await collectRuntimeDiagnostics({
			provider,
			windowMs: 500,
			procfsRoot: root,
			clock,
		});

		const procfs = report.procfs;
		if (!procfs) throw new Error("expected procfs");
		expect(procfs.threads.items.map((thread) => [thread.tid, thread.window])).toEqual([
			[
				1,
				{
					userTicks: 0,
					systemTicks: 0,
					cores: 0,
					contextSwitches: { voluntary: 0, nonvoluntary: 0 },
				},
			],
			[3, null],
		]);
		expect(procfs.fileDescriptors).toEqual({
			total: 0,
			byKind: { socket: 0, eventpoll: 0, timerfd: 0, eventfd: 0, pipe: 0, file: 0, other: 0 },
		});
	});

	it("skips malformed task entries instead of failing the report", async () => {
		const root = createProcfsFixture();
		writeThread(root, { tid: 1, name: "bun", userTicks: 1, systemTicks: 1 });
		mkdirSync(join(root, "task", "not-a-tid"));
		mkdirSync(join(root, "task", "7"));
		writeFileSync(join(root, "task", "7", "stat"), "garbage without parentheses\n");
		const clock = scriptedClock([0, 250]);

		const report = await collectRuntimeDiagnostics({
			provider,
			windowMs: 250,
			procfsRoot: root,
			clock,
		});

		expect(report.procfs?.threads.items.map((thread) => thread.tid)).toEqual([1]);
	});

	it("reports procfs as null when /proc/self is unreadable and still samples process CPU", async () => {
		const root = createProcfsFixture();
		const clock = scriptedClock([0, 250]);

		const report = await collectRuntimeDiagnostics({
			provider,
			windowMs: 250,
			procfsRoot: join(root, "missing"),
			clock,
		});

		expect(report.procfs).toBeNull();
		expect(report.sdkVersion).not.toBe("unknown");
		expect(report.runtime.pid).toBe(process.pid);
		expect(report.runtime.nodeCompatVersion).toBe(process.versions.node);
		expect(report.uptimeSeconds).toBeGreaterThan(0);
		expect(report.cpu.lifetime.averageCores).toBeGreaterThanOrEqual(0);
		expect(report.cpu.window.totalCores).toBeGreaterThanOrEqual(0);
		expect(report.cpu.window.totalCores).toBe(
			(report.cpu.window.userMicros + report.cpu.window.systemMicros) / 1000 / 250,
		);
		expect(report.memory.rss).toBeGreaterThan(0);
		expect(report.eventLoop.window.utilization).toBeGreaterThanOrEqual(0);
		expect(report.eventLoop.window.utilization).toBeLessThanOrEqual(1);
		expect(report.activeResources.total).toBe(
			Object.values(report.activeResources.byType).reduce((sum, count) => sum + count, 0),
		);
	});

	it("never divides by a zero-length window", async () => {
		const root = createProcfsFixture();
		writeThread(root, { tid: 1, name: "bun", userTicks: 1, systemTicks: 1 });
		const clock = scriptedClock([10, 10]);

		const report = await collectRuntimeDiagnostics({
			provider,
			windowMs: 50,
			procfsRoot: root,
			clock,
		});

		expect(report.window.observedMs).toBe(0);
		expect(report.cpu.window.totalCores).toBe(0);
		expect(report.procfs?.threads.items[0]?.window?.cores).toBe(0);
	});

	it.skipIf(process.platform !== "linux")(
		"reads the live /proc/self picture on Linux",
		async () => {
			const report = await collectRuntimeDiagnostics({ provider, windowMs: 50 });

			const procfs = report.procfs;
			if (!procfs) throw new Error("expected procfs on linux");
			expect(procfs.threads.total).toBeGreaterThanOrEqual(1);
			expect(procfs.threads.items.some((thread) => thread.tid === process.pid)).toBe(true);
			expect(procfs.fileDescriptors.total).toBeGreaterThanOrEqual(1);
			expect(report.window.observedMs).toBeGreaterThanOrEqual(40);
		},
	);
});

describe(`GET ${RUNTIME_DIAGNOSTICS_ROUTE}`, () => {
	it("serves the report on the primary app without authentication and without caching", async () => {
		const app = createServerApp(
			createProviderDefinitionDouble({ id: "diag-provider", version: "2.0.0" }),
		);

		const response = await app.request(`${RUNTIME_DIAGNOSTICS_ROUTE}?windowMs=50`);

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = (await response.json()) as RuntimeDiagnosticsReport;
		expect(body.schemaVersion).toBe(1);
		expect(body.provider).toEqual({ id: "diag-provider", version: "2.0.0" });
		expect(body.window.requestedMs).toBe(50);
		expect(body.window.observedMs).toBeGreaterThanOrEqual(40);
		expect(typeof body.cpu.window.totalCores).toBe("number");
	});

	it("clamps an out-of-range window instead of rejecting it", async () => {
		const app = createServerApp(createProviderDefinitionDouble({ id: "diag-provider" }));

		const response = await app.request(`${RUNTIME_DIAGNOSTICS_ROUTE}?windowMs=1`);

		expect(response.status).toBe(200);
		const body = (await response.json()) as RuntimeDiagnosticsReport;
		expect(body.window.requestedMs).toBe(MIN_RUNTIME_DIAGNOSTICS_WINDOW_MS);
	});

	it("is a GET-only route", async () => {
		const app = createServerApp(createProviderDefinitionDouble({ id: "diag-provider" }));

		const response = await app.request(RUNTIME_DIAGNOSTICS_ROUTE, { method: "POST" });

		expect(response.status).toBe(404);
	});
});
