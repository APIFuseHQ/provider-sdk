// Fresh-process GC probe: each reverted sliced diagnostic would retain 10 MiB.
const { HttpTelemetryCollector } = await import(process.argv[2]);
const jsc = process.versions.bun ? await import("bun:jsc") : undefined;
const collect = () => (jsc ? jsc.gcAndSweep() : globalThis.gc());
const heapSize = () => (jsc ? jsc.heapStats().heapSize : process.memoryUsage().heapUsed);
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
function populate(repeats) {
	const collector = new HttpTelemetryCollector({ redact: (text) => text });
	const request = collector.startRequest({});
	for (let index = 0; index < 24; index++) {
		const text = String(index).padEnd(10, "x").repeat(repeats);
		request.recordAttempt({
			ms: 1,
			proxyUsed: false,
			e: "other",
			diagnostics: {
				name: text,
				message: text,
				cause: { name: text, message: text },
			},
		});
	}
	request.finish(24);
	return collector;
}
for (let index = 0; index < 4; index++) populate(1);
await tick();
collect();
const before = heapSize();
globalThis.retainedHttpCollector = populate(1_048_576);
await tick();
collect();
await tick();
collect();
const retainedHeapDelta = heapSize() - before;
const log = globalThis.retainedHttpCollector.toLogPayload();
console.log(
	JSON.stringify({
		retainedHeapDelta,
		lengths: log.attemptSamples.flatMap(({ diagnostics: d }) => [
			d.name.length,
			d.message.length,
			d.cause.name.length,
			d.cause.message.length,
		]),
	}),
);
