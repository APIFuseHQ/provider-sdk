import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { SDK_VERSION } from "./sdk-version.js";

/**
 * Internal runtime diagnostics route on the provider's primary listener, next
 * to `/health` and `/readyz`. It answers one JSON report that tells an idle
 * process that still burns CPU apart from a busy one without `exec`: process
 * CPU sampled over a short window, memory, the Node event-loop and
 * active-resource APIs, and on Linux the per-thread CPU and file-descriptor
 * picture from `/proc/self`.
 *
 * Read-only and secret-free. It shares the boundary of `/health` and `/readyz`:
 * the generated provider NetworkPolicy admits only the gateway on this port and
 * the gateway dials canonical operation paths only, so a tenant cannot reach
 * it; operators use `kubectl port-forward`.
 */
export const RUNTIME_DIAGNOSTICS_ROUTE = "/__apifuse/diagnostics/runtime";
export const RUNTIME_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;
/** Query parameter naming the sampling window; clamped, never rejected. */
export const RUNTIME_DIAGNOSTICS_WINDOW_QUERY = "windowMs";
export const DEFAULT_RUNTIME_DIAGNOSTICS_WINDOW_MS = 250;
export const MIN_RUNTIME_DIAGNOSTICS_WINDOW_MS = 50;
export const MAX_RUNTIME_DIAGNOSTICS_WINDOW_MS = 5_000;
/**
 * Linux USER_HZ. The unit of `utime`/`stime` in `/proc` stat files is an ABI
 * constant (100 Hz) independent of the kernel's CONFIG_HZ.
 */
export const PROCFS_CLOCK_TICKS_PER_SECOND = 100;
export const DEFAULT_PROCFS_SELF_ROOT = "/proc/self";

export interface RuntimeDiagnosticsCpuTotals {
	readonly userMicros: number;
	readonly systemMicros: number;
}

export interface RuntimeDiagnosticsCpu {
	/** `process.cpuUsage()` since boot and its average in cores over `uptimeSeconds`. */
	readonly lifetime: RuntimeDiagnosticsCpuTotals & { readonly averageCores: number };
	/** `process.cpuUsage()` delta over the sampling window, as cores (1 = one CPU fully busy). */
	readonly window: RuntimeDiagnosticsCpuTotals & {
		readonly userCores: number;
		readonly systemCores: number;
		readonly totalCores: number;
	};
}

export interface RuntimeDiagnosticsEventLoopUtilization {
	readonly idle: number;
	readonly active: number;
	readonly utilization: number;
}

export interface RuntimeDiagnosticsEventLoop {
	/**
	 * false when the runtime returned only zeros for the whole process lifetime.
	 * Bun 1.2 and 1.3 stub `performance.eventLoopUtilization`; read
	 * `cpu.window` and `procfs.threads` instead.
	 */
	readonly reported: boolean;
	readonly lifetime: RuntimeDiagnosticsEventLoopUtilization;
	readonly window: RuntimeDiagnosticsEventLoopUtilization;
}

export interface RuntimeDiagnosticsActiveResources {
	/**
	 * false when the runtime listed nothing, although at least the socket that
	 * answers this request is alive. Bun 1.2 and 1.3 stub
	 * `process.getActiveResourcesInfo`; read `procfs.fileDescriptors` instead.
	 */
	readonly reported: boolean;
	readonly total: number;
	readonly byType: Readonly<Record<string, number>>;
}

export interface RuntimeDiagnosticsMemory {
	readonly rss: number;
	readonly heapTotal: number;
	readonly heapUsed: number;
	readonly external: number;
	readonly arrayBuffers: number;
}

export interface RuntimeDiagnosticsThreadCpuTicks {
	readonly userTicks: number;
	readonly systemTicks: number;
}

export interface RuntimeDiagnosticsThreadContextSwitches {
	readonly voluntary: number;
	readonly nonvoluntary: number;
}

export interface RuntimeDiagnosticsThreadWindow extends RuntimeDiagnosticsThreadCpuTicks {
	/** CPU consumed by this thread over the window, in cores. */
	readonly cores: number;
	readonly contextSwitches: RuntimeDiagnosticsThreadContextSwitches;
}

export interface RuntimeDiagnosticsThread {
	readonly tid: number;
	/** Kernel thread name (`comm`, 15 bytes), e.g. `bun`, `HTTP Client`, `HeapHelper`. */
	readonly name: string;
	/** Scheduler state letter at the second sample (`R` running, `S` sleeping, ...). */
	readonly state: string;
	/** Kernel wait channel at the second sample (`0` while running); null when unreadable. */
	readonly waitChannel: string | null;
	readonly lifetime: RuntimeDiagnosticsThreadCpuTicks;
	/** null for a thread that appeared after the first sample. */
	readonly window: RuntimeDiagnosticsThreadWindow | null;
}

export type RuntimeDiagnosticsFdKind =
	| "socket"
	| "eventpoll"
	| "timerfd"
	| "eventfd"
	| "pipe"
	| "file"
	| "other";

export interface RuntimeDiagnosticsProcfs {
	readonly clockTicksPerSecond: number;
	/**
	 * Elapsed time between the two /proc/self scans. Slightly longer than
	 * `window.observedMs` because it encloses the scans themselves; thread
	 * `window.cores` is computed over this interval.
	 */
	readonly observedMs: number;
	readonly threads: {
		readonly total: number;
		readonly byName: Readonly<Record<string, number>>;
		/** Sorted by window cores descending, so the hottest thread is first. */
		readonly items: readonly RuntimeDiagnosticsThread[];
	};
	readonly fileDescriptors: {
		readonly total: number;
		readonly byKind: Readonly<Record<RuntimeDiagnosticsFdKind, number>>;
	};
}

export interface RuntimeDiagnosticsReport {
	readonly schemaVersion: typeof RUNTIME_DIAGNOSTICS_SCHEMA_VERSION;
	readonly provider: { readonly id: string; readonly version: string };
	readonly sdkVersion: string;
	readonly runtime: {
		readonly bunVersion: string | null;
		readonly nodeCompatVersion: string;
		readonly platform: string;
		readonly arch: string;
		readonly pid: number;
	};
	readonly sampledAt: string;
	readonly uptimeSeconds: number;
	readonly window: { readonly requestedMs: number; readonly observedMs: number };
	readonly cpu: RuntimeDiagnosticsCpu;
	readonly memory: RuntimeDiagnosticsMemory;
	readonly eventLoop: RuntimeDiagnosticsEventLoop;
	readonly activeResources: RuntimeDiagnosticsActiveResources;
	/** null off Linux or when `/proc/self` is unreadable. */
	readonly procfs: RuntimeDiagnosticsProcfs | null;
}

export interface RuntimeDiagnosticsClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

export interface CollectRuntimeDiagnosticsInput {
	readonly provider: { readonly id: string; readonly version: string };
	/** Sampling window; clamped to [MIN, MAX]. */
	readonly windowMs?: number;
	/** `/proc/self` substitute for tests. */
	readonly procfsRoot?: string;
	readonly clock?: RuntimeDiagnosticsClock;
}

const defaultClock: RuntimeDiagnosticsClock = {
	now: () => performance.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function normalizeRuntimeDiagnosticsWindowMs(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_RUNTIME_DIAGNOSTICS_WINDOW_MS;
	return Math.min(
		MAX_RUNTIME_DIAGNOSTICS_WINDOW_MS,
		Math.max(MIN_RUNTIME_DIAGNOSTICS_WINDOW_MS, Math.trunc(value)),
	);
}

/** Parses the `windowMs` query value; anything unparsable falls back to the default. */
export function resolveRuntimeDiagnosticsWindowMs(raw: string | undefined | null): number {
	if (raw === undefined || raw === null || raw.trim() === "") {
		return DEFAULT_RUNTIME_DIAGNOSTICS_WINDOW_MS;
	}
	const parsed = Number.parseInt(raw, 10);
	return normalizeRuntimeDiagnosticsWindowMs(Number.isNaN(parsed) ? undefined : parsed);
}

export async function collectRuntimeDiagnostics(
	input: CollectRuntimeDiagnosticsInput,
): Promise<RuntimeDiagnosticsReport> {
	const clock = input.clock ?? defaultClock;
	const procfsRoot = input.procfsRoot ?? DEFAULT_PROCFS_SELF_ROOT;
	const requestedMs = normalizeRuntimeDiagnosticsWindowMs(input.windowMs);

	// Two nested brackets. The procfs scans are synchronous work on the main
	// thread, so the process-level CPU bracket starts after the first scan and
	// closes before the second one: the scans' own CPU never lands inside it.
	// The thread bracket encloses the scans and divides their tick deltas by
	// its own elapsed time, so the scan cost is attributed over the interval it
	// actually spans instead of inflating a short window.
	const threadsStartedAt = clock.now();
	const threadsStart = sampleThreads(procfsRoot);
	const cpuStart = process.cpuUsage();
	const eventLoopStart = sampleEventLoopUtilization();
	const startedAt = clock.now();
	await clock.sleep(requestedMs);
	const observedMs = Math.max(0, clock.now() - startedAt);
	const cpuWindow = process.cpuUsage(cpuStart);
	const eventLoopEnd = sampleEventLoopUtilization();
	const threadsEnd = sampleThreads(procfsRoot);
	const threadsObservedMs = Math.max(0, clock.now() - threadsStartedAt);
	const fileDescriptors = sampleFileDescriptors(procfsRoot);

	const cpuLifetime = process.cpuUsage();
	const uptimeSeconds = process.uptime();
	const sampledAt = new Date().toISOString();
	const memory = process.memoryUsage();
	const activeResources = sampleActiveResources();

	return {
		schemaVersion: RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
		provider: { id: input.provider.id, version: input.provider.version },
		sdkVersion: SDK_VERSION,
		runtime: {
			bunVersion: process.versions.bun ?? null,
			nodeCompatVersion: process.versions.node,
			platform: process.platform,
			arch: process.arch,
			pid: process.pid,
		},
		sampledAt,
		uptimeSeconds,
		window: { requestedMs, observedMs },
		cpu: {
			lifetime: {
				userMicros: cpuLifetime.user,
				systemMicros: cpuLifetime.system,
				averageCores: coresFromMicros(cpuLifetime.user + cpuLifetime.system, uptimeSeconds * 1000),
			},
			window: {
				userMicros: cpuWindow.user,
				systemMicros: cpuWindow.system,
				userCores: coresFromMicros(cpuWindow.user, observedMs),
				systemCores: coresFromMicros(cpuWindow.system, observedMs),
				totalCores: coresFromMicros(cpuWindow.user + cpuWindow.system, observedMs),
			},
		},
		memory: {
			rss: memory.rss,
			heapTotal: memory.heapTotal,
			heapUsed: memory.heapUsed,
			external: memory.external,
			arrayBuffers: memory.arrayBuffers,
		},
		eventLoop: {
			reported: eventLoopEnd.idle + eventLoopEnd.active > 0,
			lifetime: eventLoopEnd,
			window: eventLoopUtilizationDelta(eventLoopEnd, eventLoopStart),
		},
		activeResources,
		procfs:
			threadsEnd === null || fileDescriptors === null
				? null
				: {
						clockTicksPerSecond: PROCFS_CLOCK_TICKS_PER_SECOND,
						observedMs: threadsObservedMs,
						threads: summarizeThreads(threadsStart, threadsEnd, threadsObservedMs),
						fileDescriptors,
					},
	};
}

function coresFromMicros(micros: number, elapsedMs: number): number {
	if (!(elapsedMs > 0)) return 0;
	return micros / 1000 / elapsedMs;
}

function sampleEventLoopUtilization(): RuntimeDiagnosticsEventLoopUtilization {
	const eventLoopUtilization: unknown = performance.eventLoopUtilization;
	if (typeof eventLoopUtilization !== "function") return { idle: 0, active: 0, utilization: 0 };
	try {
		const sample: unknown = (eventLoopUtilization as () => unknown).call(performance);
		return {
			idle: numberProperty(sample, "idle"),
			active: numberProperty(sample, "active"),
			utilization: numberProperty(sample, "utilization"),
		};
	} catch {
		return { idle: 0, active: 0, utilization: 0 };
	}
}

function eventLoopUtilizationDelta(
	end: RuntimeDiagnosticsEventLoopUtilization,
	start: RuntimeDiagnosticsEventLoopUtilization,
): RuntimeDiagnosticsEventLoopUtilization {
	const idle = Math.max(0, end.idle - start.idle);
	const active = Math.max(0, end.active - start.active);
	const total = idle + active;
	return { idle, active, utilization: total > 0 ? active / total : 0 };
}

function sampleActiveResources(): RuntimeDiagnosticsActiveResources {
	const getActiveResourcesInfo: unknown = process.getActiveResourcesInfo;
	let types: string[] = [];
	if (typeof getActiveResourcesInfo === "function") {
		try {
			const listed: unknown = (getActiveResourcesInfo as () => unknown).call(process);
			if (Array.isArray(listed)) {
				types = listed.filter((entry): entry is string => typeof entry === "string");
			}
		} catch {
			types = [];
		}
	}
	const byType: Record<string, number> = {};
	for (const type of types) byType[type] = (byType[type] ?? 0) + 1;
	return { reported: types.length > 0, total: types.length, byType };
}

function numberProperty(value: unknown, key: string): number {
	if (value === null || typeof value !== "object") return 0;
	const candidate: unknown = (value as Record<string, unknown>)[key];
	return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
}

interface ThreadSample {
	readonly tid: number;
	readonly name: string;
	readonly state: string;
	readonly userTicks: number;
	readonly systemTicks: number;
	readonly voluntary: number;
	readonly nonvoluntary: number;
	readonly waitChannel: string | null;
}

function sampleThreads(root: string): Map<number, ThreadSample> | null {
	let entries: string[];
	try {
		entries = readdirSync(join(root, "task"));
	} catch {
		return null;
	}
	const samples = new Map<number, ThreadSample>();
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const sample = sampleThread(join(root, "task", entry), Number.parseInt(entry, 10));
		if (sample) samples.set(sample.tid, sample);
	}
	return samples;
}

function sampleThread(taskDir: string, tid: number): ThreadSample | null {
	let stat: string;
	try {
		stat = readFileSync(join(taskDir, "stat"), "utf8");
	} catch {
		// The thread exited between the directory listing and this read.
		return null;
	}
	const open = stat.indexOf("(");
	const close = stat.lastIndexOf(")");
	if (open < 0 || close < open) return null;
	const fields = stat
		.slice(close + 2)
		.trimEnd()
		.split(" ");
	const userTicks = Number.parseInt(fields[11] ?? "", 10);
	const systemTicks = Number.parseInt(fields[12] ?? "", 10);
	if (!Number.isFinite(userTicks) || !Number.isFinite(systemTicks)) return null;
	const switches = readContextSwitches(join(taskDir, "status"));
	return {
		tid,
		name: stat.slice(open + 1, close),
		state: fields[0] ?? "?",
		userTicks,
		systemTicks,
		voluntary: switches.voluntary,
		nonvoluntary: switches.nonvoluntary,
		waitChannel: readWaitChannel(join(taskDir, "wchan")),
	};
}

function readContextSwitches(statusPath: string): RuntimeDiagnosticsThreadContextSwitches {
	let voluntary = 0;
	let nonvoluntary = 0;
	let status: string;
	try {
		status = readFileSync(statusPath, "utf8");
	} catch {
		return { voluntary, nonvoluntary };
	}
	for (const line of status.split("\n")) {
		const separator = line.indexOf(":");
		if (separator < 0) continue;
		const key = line.slice(0, separator);
		if (key !== "voluntary_ctxt_switches" && key !== "nonvoluntary_ctxt_switches") continue;
		const parsed = Number.parseInt(line.slice(separator + 1).trim(), 10);
		if (!Number.isFinite(parsed)) continue;
		if (key === "voluntary_ctxt_switches") voluntary = parsed;
		else nonvoluntary = parsed;
	}
	return { voluntary, nonvoluntary };
}

function readWaitChannel(wchanPath: string): string | null {
	try {
		const value = readFileSync(wchanPath, "utf8").trim();
		return value === "" ? null : value;
	} catch {
		return null;
	}
}

function summarizeThreads(
	start: Map<number, ThreadSample> | null,
	end: Map<number, ThreadSample>,
	observedMs: number,
): RuntimeDiagnosticsProcfs["threads"] {
	const byName: Record<string, number> = {};
	const items: RuntimeDiagnosticsThread[] = [];
	for (const sample of end.values()) {
		byName[sample.name] = (byName[sample.name] ?? 0) + 1;
		const baseline = start?.get(sample.tid);
		let window: RuntimeDiagnosticsThreadWindow | null = null;
		if (baseline) {
			const userTicks = Math.max(0, sample.userTicks - baseline.userTicks);
			const systemTicks = Math.max(0, sample.systemTicks - baseline.systemTicks);
			window = {
				userTicks,
				systemTicks,
				cores: coresFromTicks(userTicks + systemTicks, observedMs),
				contextSwitches: {
					voluntary: Math.max(0, sample.voluntary - baseline.voluntary),
					nonvoluntary: Math.max(0, sample.nonvoluntary - baseline.nonvoluntary),
				},
			};
		}
		items.push({
			tid: sample.tid,
			name: sample.name,
			state: sample.state,
			waitChannel: sample.waitChannel,
			lifetime: { userTicks: sample.userTicks, systemTicks: sample.systemTicks },
			window,
		});
	}
	items.sort(compareThreads);
	return { total: items.length, byName, items };
}

function coresFromTicks(ticks: number, elapsedMs: number): number {
	if (!(elapsedMs > 0)) return 0;
	return ((ticks / PROCFS_CLOCK_TICKS_PER_SECOND) * 1000) / elapsedMs;
}

function compareThreads(left: RuntimeDiagnosticsThread, right: RuntimeDiagnosticsThread): number {
	const leftCores = left.window?.cores ?? -1;
	const rightCores = right.window?.cores ?? -1;
	if (leftCores !== rightCores) return rightCores - leftCores;
	const leftLifetime = left.lifetime.userTicks + left.lifetime.systemTicks;
	const rightLifetime = right.lifetime.userTicks + right.lifetime.systemTicks;
	if (leftLifetime !== rightLifetime) return rightLifetime - leftLifetime;
	return left.tid - right.tid;
}

function sampleFileDescriptors(root: string): RuntimeDiagnosticsProcfs["fileDescriptors"] | null {
	let entries: string[];
	try {
		entries = readdirSync(join(root, "fd"));
	} catch {
		return null;
	}
	const byKind: Record<RuntimeDiagnosticsFdKind, number> = {
		socket: 0,
		eventpoll: 0,
		timerfd: 0,
		eventfd: 0,
		pipe: 0,
		file: 0,
		other: 0,
	};
	let total = 0;
	for (const entry of entries) {
		let target: string;
		try {
			target = readlinkSync(join(root, "fd", entry));
		} catch {
			// Closed between the listing and the readlink (the listing's own
			// directory handle always lands here).
			continue;
		}
		byKind[classifyFileDescriptor(target)] += 1;
		total += 1;
	}
	return { total, byKind };
}

function classifyFileDescriptor(target: string): RuntimeDiagnosticsFdKind {
	if (target.startsWith("socket:")) return "socket";
	if (target === "anon_inode:[eventpoll]") return "eventpoll";
	if (target === "anon_inode:[timerfd]") return "timerfd";
	if (target === "anon_inode:[eventfd]") return "eventfd";
	if (target.startsWith("pipe:")) return "pipe";
	if (target.startsWith("/")) return "file";
	return "other";
}
