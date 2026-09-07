import { expect, it } from "bun:test";

it.each([
	false,
	true,
])("counts 2+3 dropped spans with one value-free warning; throwing sink=%s", async (throws) => {
	// A fresh process pins the production warning lifetime without a public reset hook.
	const proc = Bun.spawn(
		[
			process.execPath,
			"-e",
			`
import { createDiagnosticRedactor } from './src/runtime/diagnostic-redactor.ts';
import { createTraceContext, getDroppedOTLPSpanCount } from './src/runtime/trace.ts';
import { swapOTLPTransportForTests } from './src/runtime/otlp.ts';
const warnings = [];
let exports = 0;
let warningAttempts = 0;
console.warn = (...args) => { warningAttempts++; if (${throws}) throw new Error('warning sink failed'); warnings.push(args); };
swapOTLPTransportForTests(Object.assign(async () => { exports++; return new Response(); }, { preconnect: fetch.preconnect }));
const options = { traceId: 'abcdef12' + '0'.repeat(24), redact: createDiagnosticRedactor(['abcdef12']).redact, exportOptions: { endpoint: 'http://collector.test' } };
const first = createTraceContext(options);
await first.span('first', async () => {});
await first.span('second', async () => {});
await new Promise(resolve => setImmediate(resolve));
const afterFirst = structuredClone(warnings);
const second = createTraceContext(options);
for (let i = 0; i < 3; i++) await second.span('sensitive span orchard', async () => {});
await new Promise(resolve => setImmediate(resolve));
console.log(JSON.stringify({ afterFirst, afterSecond: warnings, exports, warningAttempts, total: getDroppedOTLPSpanCount('unverifiable_trace_id'), other: getDroppedOTLPSpanCount('future_reason') }));
`,
		],
		{ cwd: new URL("../../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	const warning = "[apifuse] OTLP export skipped; reason=unverifiable_trace_id; dropped_spans=2";
	expect(JSON.parse(stdout)).toEqual({
		afterFirst: throws ? [] : [[warning]],
		afterSecond: throws ? [] : [[warning]],
		exports: 0,
		warningAttempts: 1,
		total: 5,
		other: 0,
	});
});
