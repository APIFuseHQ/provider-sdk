import { strictEqual } from "node:assert";
import { describe, expect, it } from "bun:test";

import type { DiagnosticRedactor } from "../runtime/diagnostic-redactor.js";
import {
	MAX_PROVIDER_ERROR_STACK_FRAMES,
	parseProviderErrorStackFrame,
	providerErrorStackFrames,
} from "../server/error-stack-frames.js";

const FRAME_SHAPE =
	/^(?:(?:async|new) )?[\w$.<>[\] #]* ?\((?:[\w.$-]+|native|node:[\w/.-]+):\d+:\d+\)$/;
const NODE_MODULE_FRAME_SHAPE =
	/^(?:(?:async|new) )?[\w$.<>[\] #]* ?\(node:[A-Za-z_][\w.-]*(?:\/[A-Za-z_][\w.-]*)*:\d+:\d+\)$/;

function errorWithStack(stack: unknown, name = "Error", message = "boom"): Error {
	const error = new Error(message);
	error.name = name;
	Object.defineProperty(error, "stack", { value: stack, configurable: true, writable: true });
	return error;
}

describe("parseProviderErrorStackFrame", () => {
	it.each([
		["    at inner (/srv/app/src/probe.ts:3:30)", "inner (probe.ts:3:30)"],
		["    at new Foo (/tmp/psdk/probe-stack.ts:1:39)", "new Foo (probe-stack.ts:1:39)"],
		["    at <anonymous> (/tmp/psdk/probe-stack.ts:2:53)", "<anonymous> (probe-stack.ts:2:53)"],
		["    at map (native:1:11)", "map (native:1:11)"],
		["    at /tmp/psdk/probe-stack.ts:3:7", "(probe-stack.ts:3:7)"],
		["    at async af (/tmp/psdk/probe-stack.ts:5:57)", "async af (probe-stack.ts:5:57)"],
		[
			"    at async <anonymous> (/tmp/psdk/probe-stack.ts:5:83)",
			"async <anonymous> (probe-stack.ts:5:83)",
		],
		["    at file:///home/deploy/app/dist/index.js:12:8", "(index.js:12:8)"],
		["    at run (file:///home/deploy/app/dist/index.js:12:8)", "run (index.js:12:8)"],
		["    at handler (C:\\Users\\deploy\\app\\dist\\index.js:12:8)", "handler (index.js:12:8)"],
		["    at C:\\Users\\deploy\\app\\dist\\index.js:12:8", "(index.js:12:8)"],
		["    at Object.<anonymous> (/srv/app/dist/index.js:1:1)", "Object.<anonymous> (index.js:1:1)"],
		[
			"    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
			"process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
		],
		[
			"    at node:internal/main/run_main_module:28:49",
			"(node:internal/main/run_main_module:28:49)",
		],
		["    at Foo.#secretMethod (/srv/app/dist/index.js:4:4)", "Foo.#secretMethod (index.js:4:4)"],
	])("re-emits %j as %j", (line, expected) => {
		const frame = parseProviderErrorStackFrame(line);
		expect(frame).toBe(expected);
		expect(frame).toMatch(FRAME_SHAPE);
	});

	it.each([
		"Error: boom",
		"    at eval (eval at <anonymous> (/srv/app/index.js:1:1), <anonymous>:1:1)",
		"    at new Function (<anonymous>)",
		"    at async Promise.all (index 0)",
		"    at inner (/srv/app/index.js)",
		"    at inner (/srv/app/index.js:1)",
		"    at inner (/srv/app/my file.js:1:1)",
		"    at inner (/srv/app/alice@example.test:1:1)",
		"    at inner (https://cdn.example.test/bundle.js?token=abc:1:1)",
		"    at inner (/srv/app/index.js:1:1) trailing",
		"    at inner /srv/app/index.js:1:1)",
		"at inner (/srv/app/index.js:1:1)",
		`    at ${"f".repeat(81)} (/srv/app/index.js:1:1)`,
		`    at inner (/srv/app/${"f".repeat(121)}.js:1:1)`,
		`    at inner (/srv/app/index.js:1:1)${" ".repeat(1100)}`,
		"    at `rm -rf /` (/srv/app/index.js:1:1)",
		"    at inner (/srv/app/index.js:99999999:1)",
	])("drops %j instead of passing it through", (line) => {
		expect(parseProviderErrorStackFrame(line)).toBeUndefined();
	});
});

describe("engine-internal locations", () => {
	it.each([
		["    at run (node:async_hooks:62:22)", "run (node:async_hooks:62:22)"],
		[
			"    at run (node:internal/source-map/source_map_cache:78:1)",
			"run (node:internal/source-map/source_map_cache:78:1)",
		],
		["    at map (native:1:11)", "map (native:1:11)"],
	])("keeps %j verbatim", (line, expected) => {
		expect(parseProviderErrorStackFrame(line)).toBe(expected);
	});

	// The `node:` branch is the only one that keeps a `/`. A forged stack must
	// not be able to smuggle a deployment path (or `..` traversal) through it:
	// such a location falls back to the basename rule like any other path.
	it.each([
		["    at fn (node:evil/../../etc/passwd:1:1)", "fn (passwd:1:1)"],
		["    at x (node:home/ubuntu/.ssh/id_ed25519:1:1)", "x (id_ed25519:1:1)"],
		["    at x (node:../../../srv/app/index.js:1:1)", "x (index.js:1:1)"],
		[`    at x (node:${"a/".repeat(40)}index.js:1:1)`, "x (index.js:1:1)"],
	])("reduces the non-module-id location %j to a basename", (line, expected) => {
		const frame = parseProviderErrorStackFrame(line);
		expect(frame).toBe(expected);
		expect(frame).not.toContain("/");
		expect(frame).not.toContain("..");
	});

	it("drops a node:-prefixed location whose basename leaves the charset", () => {
		expect(
			parseProviderErrorStackFrame("    at x (node:evil/../../srv/my file.js:1:1)"),
		).toBeUndefined();
	});
});

describe("providerErrorStackFrames", () => {
	it("returns basename frames from a real thrown error without directories", () => {
		let caught: unknown;
		try {
			[1].map(() => {
				throw new Error("boom");
			});
		} catch (error) {
			caught = error;
		}
		const frames = providerErrorStackFrames(caught);
		expect(frames).toBeDefined();
		expect(frames!.length).toBeGreaterThan(0);
		expect(frames!.length).toBeLessThanOrEqual(MAX_PROVIDER_ERROR_STACK_FRAMES);
		expect(frames![0]).toContain("error-stack-frames.test.ts:");
		for (const frame of frames!) {
			expect(frame).toMatch(FRAME_SHAPE);
			// An engine-internal module id is the only frame allowed to keep a
			// `/`, and its grammar admits no directory or traversal segment.
			if (frame.includes("node:")) {
				expect(frame).toMatch(NODE_MODULE_FRAME_SHAPE);
			} else {
				expect(frame).not.toContain("/");
			}
			expect(frame).not.toContain("\\");
			expect(frame).not.toContain("..");
			expect(frame.length).toBeLessThanOrEqual(200);
		}
	});

	it("caps the emitted frames", () => {
		const lines = Array.from({ length: 40 }, (_, i) => `    at fn${i} (/srv/app/f${i}.js:${i}:1)`);
		const frames = providerErrorStackFrames(errorWithStack(["Error: boom", ...lines].join("\n")));
		expect(frames).toEqual([
			"fn0 (f0.js:0:1)",
			"fn1 (f1.js:1:1)",
			"fn2 (f2.js:2:1)",
			"fn3 (f3.js:3:1)",
			"fn4 (f4.js:4:1)",
		]);
	});

	it("strips the name: message header so a message cannot inject frames", () => {
		const message = "boom\n    at evil (/etc/passwd:1:1)\n    at evil2 (/etc/shadow:2:2)";
		const stack = `Error: ${message}\n    at real (/srv/app/index.js:7:7)`;
		expect(providerErrorStackFrames(errorWithStack(stack, "Error", message))).toEqual([
			"real (index.js:7:7)",
		]);
	});

	it("fails closed when the header does not match the error", () => {
		const stack = "Renamed: other\n    at real (/srv/app/index.js:7:7)";
		expect(providerErrorStackFrames(errorWithStack(stack, "Error", "boom"))).toBeUndefined();
	});

	it.each([
		["replaced", "changed"],
		["shortened to a prefix", "boom"],
		["extended", "boom details and more"],
	])("fails closed when the message was %s after the stack was formatted", (_label, mutated) => {
		const error = new Error("boom details\n    at fake (/tmp/alice-example-test:1:1)");
		expect(typeof error.stack).toBe("string");
		error.message = mutated;
		expect(providerErrorStackFrames(error)).toBeUndefined();
	});

	it("fails closed when the header is not followed by a newline", () => {
		expect(
			providerErrorStackFrames(errorWithStack("Error: boom at real (/srv/app/index.js:7:7)")),
		).toBeUndefined();
		expect(
			providerErrorStackFrames(errorWithStack("Error: boom    at real (/srv/app/index.js:7:7)")),
		).toBeUndefined();
	});

	it("accepts a node:assert header with the error code and a multi-line message", () => {
		let caught: unknown;
		try {
			strictEqual(1, 2);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		if (!(caught instanceof Error)) throw new Error("node:assert did not throw an Error");
		expect(caught.stack).toMatch(/^AssertionError \[ERR_ASSERTION\]: /);
		const frames = providerErrorStackFrames(caught);
		expect(frames).toBeDefined();
		expect(frames![0]).toMatch(/\(error-stack-frames\.test\.ts:\d+:\d+\)$/);
	});

	it("accepts a message-first header as written by the Playwright adapter", () => {
		const message = [
			"page.goto: Timeout 30000ms exceeded.",
			"=========================== logs ===========================",
			'navigating to "https://example.test/", waiting until "load"',
			"============================================================",
		].join("\n");
		const stack = `${message}\n    at real (/srv/app/index.js:7:7)`;
		expect(providerErrorStackFrames(errorWithStack(stack, "TimeoutError", message))).toEqual([
			"real (index.js:7:7)",
		]);
	});

	it.each([
		"preamble\nError: boom\n    at real (/srv/app/index.js:7:7)",
		"at fake (/srv/app/fake.js:1:1): boom\n    at real (/srv/app/index.js:7:7)",
		`${"E".repeat(130)}: boom\n    at real (/srv/app/index.js:7:7)`,
	])("rejects a header whose prefix is not name-like: %j", (stack) => {
		expect(providerErrorStackFrames(errorWithStack(stack, "Error", "boom"))).toBeUndefined();
	});

	it("handles an empty name header", () => {
		const stack = "boom\n    at real (/srv/app/index.js:7:7)";
		expect(providerErrorStackFrames(errorWithStack(stack, "", "boom"))).toEqual([
			"real (index.js:7:7)",
		]);
	});

	it("handles an empty message header", () => {
		const stack = "Error\n    at real (/srv/app/index.js:7:7)";
		expect(providerErrorStackFrames(errorWithStack(stack, "Error", ""))).toEqual([
			"real (index.js:7:7)",
		]);
	});

	it.each([
		["non-object", 42],
		["null", null],
		["string stack", { stack: 7 }],
		["plain object with a stack string", { stack: "Error: boom\n    at evil (/etc/passwd:1:1)" }],
		["non-string stack", Object.assign(new Error("boom"), { stack: 7 })],
		["missing stack", { name: "Error", message: "boom" }],
		["header only", errorWithStack("Error: boom")],
		["no parseable frames", errorWithStack("Error: boom\n    at async Promise.all (index 0)")],
		["oversized junk", errorWithStack(`Error: boom\n${"x".repeat(1024 * 1024)}`)],
		[
			"frame beyond the scan window",
			errorWithStack(`Error: boom\n${" ".repeat(16 * 1024)}\n    at late (/srv/app/index.js:1:1)`),
		],
		[
			"frame beyond the line window",
			errorWithStack(`Error: boom\n${"\n".repeat(70)}    at late (/srv/app/index.js:1:1)`),
		],
	])("yields undefined for %s", (_label, error) => {
		expect(providerErrorStackFrames(error)).toBeUndefined();
	});

	it("reads the engine-installed stack of a subclass through whichever shape the runtime uses", () => {
		class ProviderCrash extends Error {
			constructor(message: string) {
				super(message);
				this.name = "ProviderCrash";
			}
		}
		const frames = providerErrorStackFrames(new ProviderCrash("boom\nwith a second line"));
		expect(frames).toBeDefined();
		expect(frames![0]).toMatch(
			/^(?:new ProviderCrash|<anonymous>) \(error-stack-frames\.test\.ts:\d+:\d+\)$/,
		);
	});

	it("never runs a provider-controlled stack getter", () => {
		let invoked = 0;
		const error = new Error("boom");
		Object.defineProperty(error, "stack", {
			get() {
				invoked += 1;
				throw new Error("getter must not run");
			},
			configurable: true,
		});
		expect(providerErrorStackFrames(error)).toBeUndefined();
		expect(invoked).toBe(0);
	});

	it("fails closed instead of throwing on a throwing message accessor", () => {
		const error = errorWithStack("Error: boom\n    at real (/srv/app/index.js:7:7)");
		Object.defineProperty(error, "message", {
			get() {
				throw new Error("no message for you");
			},
		});
		expect(providerErrorStackFrames(error)).toBeUndefined();
	});

	it("redacts each frame with the request redactor and fails closed", () => {
		const error = errorWithStack(
			"Error: boom\n    at hrfcokey1234 (/srv/app/hrfcokey1234.js:1:1)\n    at ok (/srv/app/ok.js:2:2)",
		);
		expect(
			providerErrorStackFrames(error, (text) => text.replaceAll("hrfcokey1234", "[REDACTED]")),
		).toEqual(["[REDACTED] ([REDACTED].js:1:1)", "ok (ok.js:2:2)"]);
		expect(
			providerErrorStackFrames(error, () => {
				throw new Error("redactor failed");
			}),
		).toEqual(["[REDACTION_FAILED]", "[REDACTION_FAILED]"]);
		// A redactor that returns a non-string is a broken observer: never fall back to the original.
		const returnsUndefined = ((text: string) =>
			text.length > 0 ? undefined : text) as DiagnosticRedactor;
		expect(providerErrorStackFrames(error, returnsUndefined)).toEqual([
			"[REDACTION_FAILED]",
			"[REDACTION_FAILED]",
		]);
	});
});
