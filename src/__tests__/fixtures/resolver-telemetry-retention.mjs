// Run in a fresh process: allocator noise from other tests must not hide retention.
// Pass the source module on Bun or the built module on Node (--expose-gc).
import { readFileSync, unlinkSync } from "node:fs";
import { writeHeapSnapshot } from "node:v8";
import { strictEqual } from "node:assert";

const { ResolverTelemetryCollector } = await import(process.argv[2]);
const jsc = process.versions.bun ? await import("bun:jsc") : undefined;
const collect = () => (jsc ? jsc.gcAndSweep() : globalThis.gc());
const heapSize = () => (jsc ? jsc.heapStats().heapSize : process.memoryUsage().heapUsed);
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
const event = { vendor: "capsolver", phase: "create_task", outcome: "error", ms: 1 };
const includeDiagnostics = process.argv.includes("--diagnostics");
const realVendor = process.argv.includes("--vendor");
let vendorCollector;
if (realVendor) {
	const { createResolverClient } = await import(new URL("./resolver.js", process.argv[2]));
	const { createCapsolverResolverVendorAdapter } = await import(
		new URL("./resolver-vendors/capsolver.js", process.argv[2])
	);
	vendorCollector = async (repeats) => {
		const collector = new ResolverTelemetryCollector();
		const adapter = createCapsolverResolverVendorAdapter({
			apiKey: "fake-key",
			allowedHosts: ["example.com"],
			fetchImpl: async () =>
				Response.json({
					errorId: 1,
					errorCode: "ERROR_ZERO_BALANCE",
					errorDescription: "0123456789".repeat(repeats),
				}),
		});
		await createResolverClient({ kinds: ["turnstile"], adapters: [adapter], telemetry: collector })
			.solve({ kind: "turnstile", siteKey: "k", pageUrl: "https://example.com/challenge" })
			.catch(() => undefined);
		return collector;
	};
}

// The same probe checks the UTF-16 round-trip on both engines.
for (const value of ["\ud800X\udc00", `${"x".repeat(299)}😀`, `${"x".repeat(298)}😀`]) {
	const collector = new ResolverTelemetryCollector();
	collector.recordVendorAttempt({
		...event,
		vendorErrorDescription: value,
		vendorErrorCode: value,
	});
	strictEqual(collector.toLogPayload().lastVendorErrorDescription, value.slice(0, 300));
	strictEqual(collector.toLogPayload().attemptSamples[0].c, value.slice(0, 300));
}

function populate(collector, repeats) {
	collector.recordVendorAttempt({
		...event,
		vendorErrorDescription: "description".padEnd(10, "D").repeat(repeats),
	});
	for (let index = 0; index < 24; index++) {
		collector.recordVendorAttempt({
			...event,
			vendorErrorCode: String(index).padEnd(10, "C").repeat(repeats),
		});
	}
}

// Keep the description outside the 24 code samples, without consuming a slot.
function populatedCollector(repeats) {
	const collector = new ResolverTelemetryCollector();
	for (let index = 0; index < 24; index++) {
		const value = String(index).padEnd(10, "C").repeat(repeats);
		collector.recordVendorAttempt({
			...event,
			vendorErrorCode: value,
			...(includeDiagnostics
				? {
						diagnostics: {
							cause: { name: value, message: value },
							upstreamHost: value,
							missingFields: [value],
							phase: value,
							round: 1,
							attemptIndex: index + 1,
						},
					}
				: {}),
		});
	}
	collector.recordVendorAttempt({
		...event,
		vendorErrorDescription: "0123456789".repeat(repeats),
	});
	return collector;
}

for (let index = 0; index < 4; index++) populate(new ResolverTelemetryCollector(), 1);
// Warm the actual adapter and Response implementation before measuring it.
if (vendorCollector) for (let index = 0; index < 4; index++) await vendorCollector(1);
await tick();
collect();
const before = heapSize();
globalThis.retainedResolverCollector = vendorCollector
	? await vendorCollector(1_048_576)
	: populatedCollector(1_048_576);
await tick();
collect();
await tick();
collect();
const retainedHeapDelta = heapSize() - before;
const log = globalThis.retainedResolverCollector.toLogPayload();
const result = {
	runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
	inputBytes: (realVendor ? 1 : 25) * 10 * 1_048_576,
	retainedHeapDelta,
	descriptionLength: log.lastVendorErrorDescription.length,
	codeLengths: log.attemptSamples.map((sample) => sample.c.length),
	includeDiagnostics,
	realVendor,
};

if (process.argv.includes("--heap-edges")) {
	// The reviewer's heap-edges.mjs traversal, extended to both runtime formats.
	let snapshot;
	if (jsc) snapshot = JSON.parse(Bun.generateHeapSnapshot("v8"));
	else {
		const path = writeHeapSnapshot();
		snapshot = JSON.parse(readFileSync(path, "utf8"));
		unlinkSync(path);
	}
	const {
		node_fields: nf,
		edge_fields: ef,
		node_types: nt,
		edge_types: et,
	} = snapshot.snapshot.meta;
	const nodes = [];
	const incoming = new Map();
	let edge = 0;
	for (let offset = 0; offset < snapshot.nodes.length; offset += nf.length) {
		const id = offset / nf.length;
		nodes[id] = {
			id,
			type: nt[0][snapshot.nodes[offset + nf.indexOf("type")]],
			name: snapshot.strings[snapshot.nodes[offset + nf.indexOf("name")]].slice(0, 80),
			size: snapshot.nodes[offset + nf.indexOf("self_size")],
		};
		const count = snapshot.nodes[offset + nf.indexOf("edge_count")];
		for (let index = 0; index < count; index++, edge += ef.length) {
			const target = snapshot.edges[edge + ef.indexOf("to_node")] / nf.length;
			const type = et[0][snapshot.edges[edge + ef.indexOf("type")]];
			const nameIndex = snapshot.edges[edge + ef.indexOf("name_or_index")];
			const name = ["element", "hidden"].includes(type)
				? String(nameIndex)
				: snapshot.strings[nameIndex];
			const parents = incoming.get(target) ?? [];
			parents.push({ from: id, type, name });
			incoming.set(target, parents);
		}
	}
	const parents = (id, depth) =>
		depth === 0
			? []
			: (incoming.get(id) ?? []).map((edge) => ({
					...edge,
					node: nodes[edge.from],
					parents: parents(edge.from, depth - 1),
				}));
	result.largeNodes = nodes
		.filter((node) => node.size >= 1_048_576)
		.map((node) => ({
			...node,
			parents: parents(node.id, 3),
		}));
}
console.log(JSON.stringify(result));
