import { describe, expect, it } from "bun:test";
import { sanitizeDiagnosticText } from "../../fixture-sanitization.js";
import { sanitizeSpanForOutput } from "../../trace-sanitization.js";
import {
	createDiagnosticRedactor,
	REDACTION_FAILED,
	redactDiagnosticText,
} from "../diagnostic-redactor.js";
import { createTraceContext, getTraceRecorder, type Span } from "../trace.js";

describe("trace diagnostic redaction", () => {
	it("normalizes initial and result attributes before recording and notifying onSpan", async () => {
		const secret = "hrfcokey1234";
		const observed: Span[] = [];
		const trace = createTraceContext({
			redact: (text) => text.replaceAll(secret, "[REDACTED]"),
			onSpan: (span) => observed.push(structuredClone(span)),
		});
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("trace recorder missing");
		await recorder.runSpan("provider.success", () => secret, {
			attributes: {
				url: `https://vendor.test/${secret}/items`,
				list: [secret, "safe"],
				object: { toString: () => `value:${secret}` },
				count: 7,
				ok: true,
				missing: null,
			},
			onSuccess: (value) => ({ result: value }),
		});
		expect(trace.getSpans()[0]?.attributes).toEqual({
			url: "https://vendor.test/[REDACTED]/items",
			list: "[REDACTED],safe",
			object: "value:[REDACTED]",
			count: 7,
			ok: true,
			result: "[REDACTED]",
			duration_ms: expect.any(Number),
		});
		expect(observed).toEqual(trace.getSpans());
		expect(JSON.stringify(observed)).not.toContain(secret);
	});

	it.each([
		false,
		true,
	])("redacts errors and error attributes; throwing redactor=%s", async (throws) => {
		const secret = "hrfcokey1234";
		const observed: Span[] = [];
		const trace = createTraceContext({
			redact: (text) => {
				if (throws) throw new Error(`redactor failed with ${secret}`);
				return text.replaceAll(secret, "[REDACTED]");
			},
			onSpan: (span) => observed.push(structuredClone(span)),
		});
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("trace recorder missing");
		const operationError = new Error(`upstream ${secret} rejected`);
		await expect(
			recorder.runSpan(
				"provider.failure",
				() => {
					throw operationError;
				},
				{
					attributes: { url: `https://vendor.test/${secret}` },
					onError: (error) => ({ diagnostic: String(error) }),
				},
			),
		).rejects.toBe(operationError);
		const span = trace.getSpans()[0];
		expect(span?.error).toBe(throws ? "[REDACTION_FAILED]" : "upstream [REDACTED] rejected");
		if (throws) {
			expect(span?.attributes).toEqual({
				"[REDACTED#1]": REDACTION_FAILED,
				"[REDACTED#2]": REDACTION_FAILED,
				"[REDACTED#3]": REDACTION_FAILED,
			});
		} else {
			expect(span?.attributes.url).toBe("https://vendor.test/[REDACTED]");
			expect(span?.attributes.diagnostic).toBe("Error: upstream [REDACTED] rejected");
		}
		expect(JSON.stringify(trace.getSpans())).not.toContain(secret);
		expect(observed).toEqual(trace.getSpans());
	});

	it("redacts the generated duration attribute key", async () => {
		const registry = createDiagnosticRedactor(["duration_ms"]);
		const trace = createTraceContext({ redact: registry.redact });
		await trace.span("provider.duration", async () => undefined);
		expect(trace.getSpans()[0]?.attributes).toEqual({ "[REDACTED#1]": "[REDACTED]" });
	});

	it("redacts primitive secrets while preserving benign number and boolean types", async () => {
		const registry = createDiagnosticRedactor([
			"1234",
			"200",
			"true",
			"12345678",
			"9007199254740993",
		]);
		const trace = createTraceContext({ redact: registry.redact });
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("trace recorder missing");
		await recorder.runSpan("provider.primitives", () => undefined, {
			attributes: {
				secretNumber: 1234,
				duration_ms: 1234,
				status: 200,
				retryable: true,
				longNumber: 12345678,
				shortBigint: 1234n,
				secretBoolean: true,
				secretBigint: 9007199254740993n,
				benignNumber: 42,
				benignBoolean: false,
				benignBigint: 77n,
			},
		});
		expect(trace.getSpans()[0]?.attributes).toEqual({
			secretNumber: 1234,
			secretBoolean: true,
			status: 200,
			retryable: true,
			longNumber: "[REDACTED]",
			shortBigint: "1234",
			secretBigint: "[REDACTED]",
			benignNumber: 42,
			benignBoolean: false,
			benignBigint: "77",
			duration_ms: 1234,
		});
		const attributes = trace.getSpans()[0]!.attributes;
		expect(typeof attributes.duration_ms).toBe("number");
		expect(typeof attributes.status).toBe("number");
		expect(typeof attributes.retryable).toBe("boolean");
		const output = sanitizeSpanForOutput(trace.getSpans()[0]!, undefined, registry.redact);
		expect(output.attributes.duration_ms).toBe(1234);
		expect(output.attributes.status).toBe(200);
		expect(output.attributes.retryable).toBe(true);
		const transformed = sanitizeSpanForOutput(
			{
				id: "primitive-span",
				name: "safe",
				startedAt: 0,
				endedAt: 1,
				duration_ms: 1,
				status: "ok",
				attributes: { numeric: 12345678 },
			},
			undefined,
			(text) => (text === "12345678" ? `\u0000${"x".repeat(400)}` : text),
		);
		expect(transformed.attributes.numeric).toBe(`\\u0000${"x".repeat(294)}… [truncated]`);
	});

	it("replaces matched keys and names before bounds and suppresses values behind changed keys", async () => {
		const secret = "orchardkey12";
		const privateValue = "unregistered-private-value";
		expect(secret).toHaveLength(12);
		expect(sanitizeDiagnosticText(secret)).toBe(secret);
		const registry = createDiagnosticRedactor([secret]);
		const observed: Span[] = [];
		const trace = createTraceContext({
			redact: registry.redact,
			onSpan: (span) => observed.push(structuredClone(span)),
		});
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("trace recorder missing");
		await recorder.runSpan(secret, () => undefined, {
			attributes: { [`prefix-${secret}-password`]: privateValue },
		});
		expect(trace.getSpans()[0]).toMatchObject({
			name: "[REDACTED]",
			attributes: { "[REDACTED#1]": "[REDACTED]" },
		});
		expect(observed).toEqual(trace.getSpans());
		expect(JSON.stringify(observed)).not.toContain(secret);
		expect(JSON.stringify(observed)).not.toContain(privateValue);

		const straddled = `${"x".repeat(290)}${secret}`;
		const output = sanitizeSpanForOutput(
			{
				id: "span-id",
				name: straddled,
				startedAt: 0,
				endedAt: 1,
				duration_ms: 1,
				status: "ok",
				attributes: { [straddled]: privateValue },
			},
			undefined,
			registry.redact,
		);
		expect(output.name).toBe(`${"x".repeat(290)}[REDACTED]`);
		expect(output.attributes).toEqual({ "[REDACTED#1]": "[REDACTED]" });
		expect(JSON.stringify(output)).not.toContain(secret);
		expect(JSON.stringify(output)).not.toContain(privateValue);
	});

	it.each([
		"undefined",
		"boxed",
		"object",
		"identity",
		"second",
		"late",
	] as const)("fails closed for a %s registry callback before recording or onSpan", async (mode) => {
		const secret = "willowforest";
		const registry = createDiagnosticRedactor([secret]);
		const knownGood = registry.redact;
		let calls = 0;
		const invalid = { redact: (text: string) => text };
		Object.defineProperty(invalid, "redact", {
			value: (text: string) => {
				calls += 1;
				if (mode === "undefined") return undefined;
				if (mode === "boxed") return new String(text);
				if (mode === "object") return { text };
				if (mode === "identity") return text;
				if (mode === "second" && calls === 2) throw new Error(secret);
				return knownGood(text);
			},
		});
		registry.redact = invalid.redact;
		const observed: Span[] = [];
		const trace = createTraceContext({
			redact: (text) => redactDiagnosticText(text, registry.redact),
			onSpan: (span) => observed.push(structuredClone(span)),
		});
		if (mode === "late")
			registry.redact = () => {
				throw new Error(secret);
			};
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("trace recorder missing");
		await recorder.runSpan("safe", () => undefined, {
			attributes: { diagnostic: secret },
		});
		const serialized = JSON.stringify(trace.getSpans());
		expect(serialized).not.toContain(secret);
		expect(serialized).toContain(REDACTION_FAILED);
		expect(observed).toEqual(trace.getSpans());
	});
});

it("rechecks pending names and attributes after late credential registration before onSpan", async () => {
	const registry = createDiagnosticRedactor();
	const observed: unknown[] = [];
	const trace = createTraceContext({
		redact: registry.redact,
		onSpan: (span) => observed.push(span),
	});
	await getTraceRecorder(trace)!.runSpan(
		"request:orchardgrove",
		() => {
			registry.add(["orchardgrove"]);
		},
		{ attributes: { message: "vendor orchardgrove" } },
	);
	expect(trace.getSpans()[0].name).toBe("request:[REDACTED]");
	expect(trace.getSpans()[0].attributes.message).toBe("vendor [REDACTED]");
	expect(observed).toEqual(trace.getSpans());
});

it("preserves two redacted keys across initial/result attributes, JSON and OTLP", async () => {
	const { spansToOTLP } = await import("../otlp.js");
	const registry = createDiagnosticRedactor(["orchardgrove", "meadowwillow"]);
	const trace = createTraceContext({ redact: registry.redact });
	await getTraceRecorder(trace)!.runSpan("orchardgrove", () => {}, {
		attributes: { orchardgrove: "private first" },
		onSuccess: () => ({ meadowwillow: "private second" }),
	});
	const span = trace.getSpans()[0];
	expect(span.attributes).toEqual({
		"[REDACTED#1]": "[REDACTED]",
		"[REDACTED#2]": "[REDACTED]",
		duration_ms: expect.any(Number),
	});
	const json = sanitizeSpanForOutput(span, undefined, registry.redact);
	expect(JSON.parse(JSON.stringify(json)).attributes).toEqual(span.attributes);
	const otlp = spansToOTLP([json]);
	expect(otlp.resourceSpans[0].scopeSpans[0].spans[0].attributes).toHaveLength(3);
	expect(otlp.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("[REDACTED]");
});
