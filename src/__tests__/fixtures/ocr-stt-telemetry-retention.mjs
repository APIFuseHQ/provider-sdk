// Fresh-process P3 GC probe: a sliced caller string would retain 10 MiB per sample.
const module = await import(process.argv[2]);
const Collector =
	module[process.argv[3] === "ocr" ? "OcrTelemetryCollector" : "SttTelemetryCollector"];
const jsc = await import("bun:jsc");
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
function populate(repeats) {
	const collector = new Collector({ redact: (text) => text });
	for (let i = 0; i < 24; i++) {
		const text = String(i).padEnd(10, "-").repeat(repeats);
		collector.record({
			backend: "custom",
			engine: "custom",
			ms: 1,
			model: text,
			diagnostics: text,
		});
	}
	return collector;
}
for (let i = 0; i < 4; i++) populate(1);
await tick();
jsc.gcAndSweep();
const before = jsc.heapStats().heapSize;
globalThis.retainedCapabilityCollector = populate(1_048_576);
await tick();
jsc.gcAndSweep();
await tick();
jsc.gcAndSweep();
const retainedHeapDelta = jsc.heapStats().heapSize - before;
const log = globalThis.retainedCapabilityCollector.toLogPayload();
console.log(
	JSON.stringify({
		retainedHeapDelta,
		lengths: [log.model.length, ...log.diagnostics.map((s) => s.length)],
	}),
);
