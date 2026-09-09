const { BrowserTelemetryCollector } = await import(process.argv[2]);
const jsc = process.versions.bun ? await import("bun:jsc") : undefined;
const collect = () => (jsc ? jsc.gcAndSweep() : globalThis.gc());
const heap = () => (jsc ? jsc.heapStats().heapSize : process.memoryUsage().heapUsed);
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
function populate(repeats) {
	const error = "0123456789".repeat(repeats);
	const spans = Array.from({ length: 24 }, () => ({
		name: "browser.page.goto",
		duration_ms: 1,
		status: "error",
		attributes: {},
		error,
	}));
	const payload = new BrowserTelemetryCollector({ redact: (value) => value }).toLogPayload({
		spans,
		byName: new Map(),
		count: () => 24,
		durationMs: () => 24,
	});
	spans.length = 0;
	return payload;
}
for (let i = 0; i < 4; i += 1) populate(1);
await tick();
collect();
const before = heap();
globalThis.browserLog = populate(1048576);
await tick();
collect();
await tick();
collect();
console.log(
	JSON.stringify({
		retainedHeapDelta: heap() - before,
		lengths: globalThis.browserLog.samples.map((sample) => sample.diagnostics.length),
	}),
);
