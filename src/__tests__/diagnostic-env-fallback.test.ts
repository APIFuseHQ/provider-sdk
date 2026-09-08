import { expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
// A subprocess is required: fallback exhaustion intentionally lasts until process restart.
async function probe(source: string) {
	const proc = Bun.spawn([process.execPath, "-e", source], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
	return JSON.parse(stdout);
}
const imports = `
import { createDiagnosticRedactor, compileProcessDiagnosticSensitiveValues, withDiagnosticFallbackScope } from './src/runtime/diagnostic-redactor.ts';
import { readDiagnosticEnv, withDiagnosticEnv } from './src/runtime/diagnostic-env.ts';
import { createServerApp } from './src/server/serve.ts';
import { createProviderDefinitionDouble } from './src/__tests__/test-utils.ts';
import { z } from 'zod';
`;

it.each([
	"startup",
	"CLI",
	"detached",
])("registers rotated outside-context credentials before a later request echoes them: %s", async (path) => {
	expect(
		await probe(`${imports}
const name = 'P4_OUTSIDE_ROTATE';
process.env[name] = 'initialvalue';
let cached;
const events = [];
const provider = createProviderDefinitionDouble({ env: true, secrets: [{ name }], operations: { inspect: { riskClass: 'read', input: z.object({}), output: z.object({}), handler: async () => { throw new Error('echo ' + cached); } } } });
const app = createServerApp(provider, { logger: event => events.push(event) });
process.env[name] = 'outsideorchard';
if (${JSON.stringify(path)} === 'CLI') {
 const { createProviderContext } = await import('./bin/apifuse-dev.ts');
 cached = createProviderContext(provider).ctx.env.get(name);
} else if (${JSON.stringify(path)} === 'detached') {
 cached = await new Promise(resolve => setTimeout(() => resolve(readDiagnosticEnv(name)), 0));
} else cached = readDiagnosticEnv(name);
const response = await app.request('/v1/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'r', input: {} }) });
await response.text();
console.log(JSON.stringify({ cached, status: response.status, message: events.find(e => e.event === 'provider_request_failed').message }));
`),
	).toEqual({ cached: "outsideorchard", status: 500, message: "echo [REDACTED]" });
});

it("refreshes existing scopes and independent checkers with raw, trimmed, encoded and URL/auth fallback values", async () => {
	expect(
		await probe(`${imports}
const handle = compileProcessDiagnosticSensitiveValues([]);
const a = createDiagnosticRedactor([], handle), b = createDiagnosticRedactor([], handle);
a.redact('outsideorchard');
readDiagnosticEnv('P4_RAW', { P4_RAW: ' outsideorchard ' });
readDiagnosticEnv('APIFUSE__CDP_POOL__URL', { APIFUSE__CDP_POOL__URL: 'ws://userorchard:passwordgrove@localhost/pathgrove' });
readDiagnosticEnv('OTEL_EXPORTER_OTLP_HEADERS', { OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20authorchard' });
const values = [' outsideorchard ', 'outsideorchard', btoa('outsideorchard'), 'userorchard', 'passwordgrove', 'pathgrove', 'authorchard'];
const primary = values.map(value => a.redact(value));
b.redact = text => text;
console.log(JSON.stringify({ primary, checker: values.map(value => b.redact(value)) }));
`),
	).toEqual({ primary: Array(7).fill("[REDACTED]"), checker: Array(7).fill("[REDACTION_FAILED]") });
});

it("keeps overlapping request-local reads out of other requests and the fallback", async () => {
	expect(
		await probe(`${imports}
const handle = compileProcessDiagnosticSensitiveValues([]);
const a = createDiagnosticRedactor([], handle), b = createDiagnosticRedactor([], handle);
let release;
const ready = new Promise(resolve => release = resolve);
const first = withDiagnosticEnv((_name, value) => a.add([value]), async () => {
 readDiagnosticEnv('P4_A', { P4_A: 'Asecretorchard' });
 await ready;
 return a.redact('Asecretorchard Bsecretmeadow');
});
const second = withDiagnosticEnv((_name, value) => b.add([value]), async () => {
 readDiagnosticEnv('P4_B', { P4_B: 'Bsecretmeadow' });
 await Promise.resolve();
 release();
 return b.redact('Asecretorchard Bsecretmeadow');
});
console.log(JSON.stringify([await first, await second, createDiagnosticRedactor([], handle).redact('Asecretorchard Bsecretmeadow')]));
`),
	).toEqual([
		"[REDACTED] Bsecretmeadow",
		"Asecretorchard [REDACTED]",
		"Asecretorchard Bsecretmeadow",
	]);
});

it("binds each app inventory to its fallback lifetime across overlapping, nested and completed scopes", async () => {
	expect(
		await probe(`${imports}
const make = () => createDiagnosticRedactor([], compileProcessDiagnosticSensitiveValues([]));
readDiagnosticEnv('P4_PARENT', { P4_PARENT: 'parentorchard' });
const parent = make();
let release;
const ready = new Promise(resolve => release = resolve);
const first = withDiagnosticFallbackScope(async () => {
 const app = make();
 app.redact('scopeorchard'); // Populate a cache before the late read.
 await ready;
 readDiagnosticEnv('P4_A', { P4_A: 'scopeorchard' });
 const checked = make();
 checked.redact = text => text;
 const nested = withDiagnosticFallbackScope(() => {
  readDiagnosticEnv('P4_NESTED', { P4_NESTED: 'nestedorchard' });
  return make();
 });
 return { app, checked, nested };
});
const second = withDiagnosticFallbackScope(async () => {
 readDiagnosticEnv('OTEL_EXPORTER_OTLP_HEADERS', { OTEL_EXPORTER_OTLP_HEADERS: 'X-Extra=1' });
 await Promise.resolve();
 release();
 return make();
});
const [{ app, checked, nested }, sibling] = await Promise.all([first, second]);
const sample = 'parentorchard scopeorchard nestedorchard connection-1 af_con_1';
console.log(JSON.stringify({ parent: parent.redact(sample), app: app.redact(sample), nested: nested.redact(sample), sibling: sibling.redact(sample), checked: checked.redact('scopeorchard'), later: make().redact(sample) }));
`),
	).toEqual({
		parent: "[REDACTED] scopeorchard nestedorchard connection-1 af_con_1",
		app: "parentorchard [REDACTED] nestedorchard connection-1 af_con_1",
		nested: "parentorchard scopeorchard [REDACTED] connection-1 af_con_1",
		sibling: "parentorchard scopeorchard nestedorchard connection-1 af_con_1",
		checked: "[REDACTION_FAILED]",
		later: "[REDACTED] scopeorchard nestedorchard connection-1 af_con_1",
	});
});

it("keeps exhaustion and its warning within the owning fallback lifetime", async () => {
	expect(
		await probe(`${imports}
const make = () => createDiagnosticRedactor([], compileProcessDiagnosticSensitiveValues([]));
const warnings = [];
console.warn = line => warnings.push(line);
const parent = make();
const exhausted = withDiagnosticFallbackScope(() => {
 const app = make();
 readDiagnosticEnv('P4_LIMIT', { P4_LIMIT: 'x'.repeat(65537) });
 readDiagnosticEnv('P4_LIMIT', { P4_LIMIT: 'y'.repeat(65537) });
 return app;
});
readDiagnosticEnv('P4_PARENT', { P4_PARENT: 'parentorchard' });
const sibling = withDiagnosticFallbackScope(() => {
 readDiagnosticEnv('P4_SIBLING', { P4_SIBLING: 'siblingorchard' });
 return make();
});
console.log(JSON.stringify({ parent: parent.redact('parentorchard'), exhausted: exhausted.redact('ordinary message'), sibling: sibling.redact('siblingorchard'), later: make().redact('ordinary message'), warnings }));
`),
	).toEqual({
		parent: "[REDACTED]",
		exhausted: "[REDACTION_FAILED]",
		sibling: "[REDACTED]",
		later: "ordinary message",
		warnings: [
			"[apifuse] diagnostic redaction failed closed; reason=static_registry_limit; limit=1024_entries/65536_bytes",
		],
	});
});

it.each([
	"entries",
	"bytes",
	"oversized",
])("bounds fallback %s and fails closed process-wide with one warning", async (bound) => {
	expect(
		await probe(`${imports}
const warnings = [];
console.warn = line => warnings.push(line);
const handle = compileProcessDiagnosticSensitiveValues(['staticgroves']);
const a = createDiagnosticRedactor([], handle);
if (${JSON.stringify(bound)} === 'entries') {
 for (let i = 0; i < 1024; i++) readDiagnosticEnv('P4_LIMIT', { P4_LIMIT: 'entry-' + i });
} else readDiagnosticEnv('P4_LIMIT', { P4_LIMIT: 'x'.repeat(${bound === "oversized" ? 65537 : 65536}) });
const before = a.redact('ordinary message');
readDiagnosticEnv('P4_LIMIT', { P4_LIMIT: 'overflowgrove' });
for (let i = 0; i < 2000; i++) readDiagnosticEnv('P4_LIMIT', { P4_LIMIT: 'discarded-' + i });
const b = createDiagnosticRedactor([], compileProcessDiagnosticSensitiveValues([]));
console.log(JSON.stringify({ before, after: a.redact('overflowgrove'), later: b.redact('ordinary message'), retainedOverflow: b.has('overflowgrove'), warnings }));
`),
	).toEqual({
		before: bound === "oversized" ? "[REDACTION_FAILED]" : "ordinary message",
		after: "[REDACTION_FAILED]",
		later: "[REDACTION_FAILED]",
		retainedOverflow: false,
		warnings: [
			"[apifuse] diagnostic redaction failed closed; reason=static_registry_limit; limit=1024_entries/65536_bytes",
		],
	});
});

it("registers a rotated env read in the actual perf tool without a request scope", async () => {
	const directory = await mkdtemp(join(tmpdir(), "p4-env-perf-"));
	try {
		await writeFile(
			join(directory, "index.ts"),
			`
import { z } from ${JSON.stringify(join(root, "node_modules/zod/index.js"))};
import { createProviderDefinitionDouble } from ${JSON.stringify(join(root, "src/__tests__/test-utils.ts"))};
process.env.P4_PERF_ROTATE = 'initialvalue';
export default createProviderDefinitionDouble({ env: true, secrets: [{ name: 'P4_PERF_ROTATE' }], operations: { inspect: { riskClass: 'read', input: z.object({}), output: z.object({}), handler: async ctx => {
 process.env.P4_PERF_ROTATE = 'perfoutsidegrove';
 const cached = ctx.env.get('P4_PERF_ROTATE');
 await ctx.trace.span('vendor ' + cached, async () => {});
 return {};
} } } });
`,
		);
		expect(
			await probe(`${imports}
const { main } = await import('./bin/apifuse-perf.ts');
process.argv = [process.execPath, 'apifuse-perf', ${JSON.stringify(directory)}, '--operation', 'inspect', '--runs', '1', '--warmup', '0', '--export', ${JSON.stringify(join(directory, "export.json"))}];
const log = console.log;
console.log = () => {};
await main();
console.log = log;
const output = await Bun.file(${JSON.stringify(join(directory, "export.json"))}).text();
console.log(JSON.stringify({ registered: createDiagnosticRedactor([], compileProcessDiagnosticSensitiveValues([])).has('perfoutsidegrove'), leaks: output.includes('perfoutsidegrove'), redacted: output.includes('[REDACTED]') }));
`),
		).toEqual({ registered: true, leaks: false, redacted: true });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

// Derived from review4's detached probe: the timer must be BORN inside A.
it.each([
	"response",
	"error",
	"live",
])("routes a request-born timer by its actual lifetime: %s", async (mode) => {
	expect(
		await probe(`${imports}
import { getTraceRecorder } from './src/runtime/trace.ts';
const mode = ${JSON.stringify(mode)};
const name = 'P4_REQUEST_TIMER';
process.env[name] = 'initialvalue';
const entered = Promise.withResolvers();
const read = Promise.withResolvers();
const events = [];
let aTrace, cached, finished = false, readAfterFinish;
const provider = createProviderDefinitionDouble({ env: true, secrets: [{ name }], operations: { inspect: { riskClass: 'read', input: z.object({ which: z.string() }), output: z.object({}), handler: async (ctx, input) => {
 if (input.which === 'A') {
  aTrace = ctx.trace;
  process.env[name] = 'requestorchard';
  const local = ctx.env.get(name);
  await getTraceRecorder(ctx.trace).runSpan('local', () => {}, { attributes: { message: local } });
  setTimeout(async () => {
   await entered.promise;
   readAfterFinish = finished;
   cached = ctx.env.get(name);
   await getTraceRecorder(aTrace).runSpan('timer-read', () => {}, { attributes: { message: cached } });
   read.resolve();
  }, 0);
  if (mode === 'live') await read.promise;
  if (mode === 'error') throw new Error('A ' + local);
  return {};
 }
 process.env[name] = 'detachedorchard';
 entered.resolve();
 await read.promise;
 throw new Error('B requestorchard ' + cached);
} } } });
// Exercise CI repair's app binding after its configuration scope has returned.
const { app, fallback } = withDiagnosticFallbackScope(() => ({
 app: createServerApp(provider, { logger: event => events.push(event) }),
 fallback: createDiagnosticRedactor([], compileProcessDiagnosticSensitiveValues([])),
}));
const post = which => app.request('/v1/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: which, input: { which } }) });
const first = post('A');
if (mode !== 'live') { await first; finished = true; }
const second = post('B');
await (await second).text();
await (await first).text();
console.log(JSON.stringify({
 readAfterFinish,
 local: aTrace.getSpans().find(span => span.name === 'local').attributes.message,
 timer: aTrace.getSpans().find(span => span.name === 'timer-read').attributes.message,
 message: events.find(event => event.requestId === 'B' && event.event === 'provider_request_failed').message,
 fallbackLocal: fallback.has('requestorchard'),
 fallbackDetached: fallback.has('detachedorchard'),
 parentDetached: createDiagnosticRedactor([], compileProcessDiagnosticSensitiveValues([])).has('detachedorchard'),
}));
`),
	).toEqual({
		readAfterFinish: mode !== "live",
		local: "[REDACTED]",
		timer: "[REDACTED]",
		message: mode === "live" ? "B requestorchard detachedorchard" : "B requestorchard [REDACTED]",
		fallbackLocal: false,
		fallbackDetached: mode !== "live",
		parentDetached: false,
	});
});

it("refuses trivially short registrations in static, fallback and request inventories", async () => {
	expect(
		await probe(`${imports}
const values = ['1', 'ab', 'api', 'apis'];
for (const value of values) readDiagnosticEnv('P4_FLOOR', { P4_FLOOR: value });
const request = createDiagnosticRedactor(values);
const fallback = createDiagnosticRedactor([], compileProcessDiagnosticSensitiveValues([]));
const staticRegistry = createDiagnosticRedactor([], compileProcessDiagnosticSensitiveValues(values));
const text = 'connection-1 af_con_1 ab api apis apisuffix';
console.log(JSON.stringify([request, fallback, staticRegistry].map(registry => ({ has: values.map(value => registry.has(value)), text: registry.redact(text) }))));
`),
	).toEqual(
		Array(3).fill({
			has: [false, false, false, true],
			text: "connection-1 af_con_1 ab api [REDACTED] apisuffix",
		}),
	);
});

// Exact contract values from review4's cap probe, plus bigint provenance and actual OTLP output.
it("preserves structured attributes at recording and export after fallback exhaustion", async () => {
	expect(
		await probe(`${imports}
import { createTraceContext, getTraceRecorder } from './src/runtime/trace.ts';
import { sanitizeSpanForOutput, sanitizeTraceAttributes } from './src/trace-sanitization.ts';
import { swapOTLPTransportForTests } from './src/runtime/otlp.ts';
const warnings = [];
console.warn = line => warnings.push(line);
const registry = createDiagnosticRedactor([], compileProcessDiagnosticSensitiveValues([]));
for (const value of ['12345678', '9007199254740993', 'privatekeygrove']) readDiagnosticEnv('P4_CAP', { P4_CAP: value });
for (let i = 3; i < 1024; i++) readDiagnosticEnv('P4_CAP', { P4_CAP: 'entrygrove-' + i });
readDiagnosticEnv('P4_CAP', { P4_CAP: 'overflowgrove' });
const attributes = { duration_ms: 1234, status: 200, retryable: true, outcome: 'success', code: 'upstream_error', errorClass: 'upstream', phase: 'cleanup', cacheStatus: 'hit', identitySource: 'declared', taxonomy: 'v1', taxonomyVersion: 'v1', message: 'ordinary message', longNumber: 987654321, shortBigint: 1234n, longBigint: 987654321n, matchedNumber: 12345678, matchedBigint: 9007199254740993n, privatekeygrove: 'private value' };
const observed = [], exports = [];
swapOTLPTransportForTests(Object.assign(async (_url, init) => { exports.push(JSON.parse(init.body)); return new Response(); }, { preconnect: fetch.preconnect }));
const trace = createTraceContext({ redact: registry.redact, onSpan: span => observed.push(span), exportOptions: { endpoint: 'http://collector.test' }, resourceAttributes: { code: 'upstream_error', message: 'resource text' }, sanitizeSpanForExport: span => sanitizeSpanForOutput(span, undefined, registry.redact) });
await getTraceRecorder(trace).runSpan('contract', () => {}, { attributes });
await new Promise(resolve => setImmediate(resolve));
const span = trace.getSpans()[0];
const output = sanitizeSpanForOutput(span, undefined, registry.redact);
const app = createServerApp(createProviderDefinitionDouble({ operations: { inspect: { riskClass: 'read', input: z.object({}), output: z.unknown(), handler: async () => new Response('raw provider bytes', { status: 503, statusText: 'custom provider phrase' }) } } }), { logger: () => {} });
const raw = await app.request('/v1/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'cap', input: {} }) });
const wire = exports[0].resourceSpans[0];
console.log(JSON.stringify({ recorded: span.attributes, notified: observed[0].attributes, output: output.attributes, direct: sanitizeTraceAttributes(attributes, registry.redact), wire: Object.fromEntries(wire.scopeSpans[0].spans[0].attributes.map(({key,value}) => [key, value])), resource: wire.resource.attributes, warnings: warnings.length, raw: { status: raw.status, statusText: raw.statusText, body: await raw.text() } }));
`),
	).toEqual(
		(() => {
			const expected = {
				duration_ms: 1234,
				status: 200,
				retryable: true,
				outcome: "success",
				code: "upstream_error",
				errorClass: "upstream",
				phase: "cleanup",
				cacheStatus: "hit",
				identitySource: "declared",
				taxonomy: "v1",
				taxonomyVersion: "v1",
				message: "[REDACTION_FAILED]",
				longNumber: 987654321,
				shortBigint: "1234",
				longBigint: "987654321",
				matchedNumber: "[REDACTED]",
				matchedBigint: "[REDACTED]",
				"[REDACTED#1]": "[REDACTED]",
			};
			return {
				recorded: expected,
				notified: expected,
				output: expected,
				direct: expected,
				wire: Object.fromEntries(
					Object.entries(expected).map(([key, value]) => [
						key,
						typeof value === "number"
							? { doubleValue: value }
							: typeof value === "boolean"
								? { boolValue: value }
								: { stringValue: value },
					]),
				),
				resource: [
					{ key: "code", value: { stringValue: "upstream_error" } },
					{ key: "message", value: { stringValue: "[REDACTION_FAILED]" } },
				],
				warnings: 1,
				raw: { status: 503, statusText: "Service Unavailable", body: "raw provider bytes" },
			};
		})(),
	);
});
