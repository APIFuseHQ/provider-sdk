import { type DiagnosticRedactor, redactDiagnosticText } from "../runtime/diagnostic-redactor.js";

/**
 * Bounded, whitelist-shaped stack frames for masked (>=500) provider failures.
 *
 * `sanitizeDiagnosticText` is a blacklist scrubber for free text: a V8/Bun
 * frame such as `at inner (/srv/app/probe.ts:3:30)` comes out as
 * `at inner ([REDACTED])`, and even a bare `serve-implementation.ts:2039:12`
 * trips the opaque-token heuristics. Stack frames therefore never go through
 * it. Instead each frame is parsed against a strict grammar and re-emitted
 * from its parts only: an optional `async`/`new` marker, the function name
 * (identifier characters only), the file *basename* (never a filesystem
 * directory, URL, or drive letter) and the numeric line:column. The sole
 * exception is an engine-internal location (`native`, or a `node:` module id
 * of identifier-shaped segments), which is kept verbatim because it names no
 * deployment path. Frames that do not fit the grammar (eval frames, frames
 * without a location, oversized lines) are dropped rather than passed
 * through.
 */
export const MAX_PROVIDER_ERROR_STACK_FRAMES = 5;
const MAX_STACK_SCAN_CHARS = 16 * 1024;
const MAX_STACK_SCAN_LINES = 64;
const MAX_STACK_LINE_CHARS = 1024;

const FRAME_LINE = /^\s+at\s+(\S.*)$/;
const FRAME_MODIFIER = /^(async|new)\s+(.*)$/;
const FRAME_FUNCTION_NAME = /^[\w$.<>[\] #]{1,80}$/;
const FRAME_LOCATION = /^(.*):(\d{1,7}):(\d{1,7})$/;
const MAX_NODE_MODULE_ID_CHARS = 128;
// Engine-internal module ids only: `node:` plus `/`-separated identifier-shaped
// segments (`node:async_hooks`, `node:internal/process/task_queues`). Every
// segment must start with a letter or `_`, so `..` traversal and dotfile
// segments cannot ride through this branch.
const FRAME_NODE_MODULE = /^node:[A-Za-z_][\w.-]{0,40}(?:\/[A-Za-z_][\w.-]{0,40}){0,7}$/;
const FRAME_BASENAME = /^[\w.$-]{1,120}$/;
// A basename of dots only (`.`, `..`, `...`) names no file.
const FRAME_BASENAME_HAS_NAME = /[^.]/;

function parseFunctionName(raw: string): { modifier?: string; name?: string } | undefined {
	let rest = raw.trim();
	let modifier: string | undefined;
	const modified = FRAME_MODIFIER.exec(rest);
	if (modified) {
		modifier = modified[1];
		rest = modified[2].trim();
	}
	if (rest.length === 0) return { modifier };
	if (!FRAME_FUNCTION_NAME.test(rest)) return undefined;
	return { modifier, name: rest };
}

function parseLocation(raw: string): string | undefined {
	if (/[\s()]/.test(raw)) return undefined;
	const located = FRAME_LOCATION.exec(raw);
	if (!located) return undefined;
	const [, path, line, column] = located;
	let file: string;
	if (
		path === "native" ||
		(path.length <= MAX_NODE_MODULE_ID_CHARS && FRAME_NODE_MODULE.test(path))
	) {
		// Not filesystem paths: engine-internal module ids carry no deployment
		// information. This is the one branch that keeps a `/`, and the grammar
		// above bounds it to identifier segments.
		file = path;
	} else {
		const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
		const basename = separator >= 0 ? path.slice(separator + 1) : path;
		if (!FRAME_BASENAME.test(basename)) return undefined;
		// `.` and `..` pass the basename character class but name no file: they
		// are the traversal tokens the grammar exists to exclude, so a path such
		// as `/srv/app/..:1:1` must not be emitted as `..:1:1`.
		if (!FRAME_BASENAME_HAS_NAME.test(basename)) return undefined;
		file = basename;
	}
	return `${file}:${line}:${column}`;
}

/** Parses one `at ...` line into `[async |new ][fn ](basename:line:col)`, or undefined. */
export function parseProviderErrorStackFrame(line: string): string | undefined {
	if (line.length > MAX_STACK_LINE_CHARS) return undefined;
	const frame = FRAME_LINE.exec(line);
	if (!frame) return undefined;
	const rest = frame[1].trimEnd();

	let functionPart: string;
	let locationPart: string;
	if (rest.endsWith(")")) {
		const open = rest.lastIndexOf("(");
		if (open < 0) return undefined;
		functionPart = rest.slice(0, open);
		locationPart = rest.slice(open + 1, -1);
	} else {
		// A frame with no parenthesized location still carries its `async`/`new`
		// modifier inline (`at async file:///app/index.mjs:12:3`, emitted by V8
		// for an anonymous async frame such as a module's top-level await).
		// Split it off here: `parseLocation` rejects anything containing
		// whitespace, so leaving it attached dropped the whole frame.
		const modified = FRAME_MODIFIER.exec(rest);
		functionPart = modified ? modified[1] : "";
		locationPart = modified ? modified[2].trim() : rest;
	}
	// Eval frames nest parentheses inside the function part; never pass them through.
	if (/[()]/.test(functionPart)) return undefined;

	const location = parseLocation(locationPart);
	if (!location) return undefined;
	const fn = parseFunctionName(functionPart);
	if (!fn) return undefined;

	const prefix = [fn.modifier, fn.name].filter((part) => part !== undefined).join(" ");
	return prefix.length > 0 ? `${prefix} (${location})` : `(${location})`;
}

// V8 (Node >= 21) installs `stack` as a shared native accessor pair on every
// Error instance; JSC (Bun) installs a data property. Capture the engine's own
// accessor once so a provider-defined accessor (a different function object) is
// still rejected while the engine's is trusted. The engine accessor itself can
// call a process-global `Error.prepareStackTrace` hook, a process-wide trust
// boundary this module cannot narrow: a provider that installs one already
// reshapes `stack` for every consumer, and the whitelist grammar below still
// bounds what the resulting text can carry.
const NATIVE_STACK_GETTER = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;

function readOwnStackString(error: unknown): string | undefined {
	// Only engine-captured stacks: a thrown plain object is provider-authored text.
	if (!(error instanceof Error)) return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "stack");
		if (descriptor === undefined) return undefined;
		let stack: unknown;
		if (Object.hasOwn(descriptor, "value")) {
			stack = descriptor.value;
		} else if (
			typeof NATIVE_STACK_GETTER === "function" &&
			descriptor.get === NATIVE_STACK_GETTER
		) {
			stack = Reflect.apply(NATIVE_STACK_GETTER, error, []);
		} else {
			// A provider-defined accessor must never run inside the logger.
			return undefined;
		}
		return typeof stack === "string" ? stack : undefined;
	} catch {
		return undefined;
	}
}

// Header shapes ahead of the frame block: `Name: message` (V8/JSC),
// `Name [CODE]: message` (node:assert), `Name` (empty message), or the bare
// message (Playwright rewrites `stack` as message-first). The message itself
// is matched verbatim, so anything before it must be a short name-like prefix.
const HEADER_NAME_PREFIX = /^(?:[\w$][\w$ .[\]-]{0,119}: )?$/;
const HEADER_NAME_ONLY = /^[\w$][\w$ .[\]-]{0,119}$/;

/**
 * The frame block that follows the header, or undefined when the header does
 * not embed the current `message` followed by a newline. Fail closed there: if
 * `message` was mutated after the stack was formatted, the original message
 * lines are still in the string and could be parsed as forged frames. (A
 * mutation that truncates exactly at one of the message's own newlines is
 * indistinguishable from the string alone; the whitelist grammar and the
 * redactor still bound what such a line can carry.)
 */
function frameBlock(stack: string, error: object): string | undefined {
	let message: unknown;
	try {
		message = (error as { message?: unknown }).message;
	} catch {
		return undefined;
	}
	if (typeof message !== "string") return undefined;
	if (message.length === 0) {
		const newline = stack.indexOf("\n");
		if (newline < 0 || !HEADER_NAME_ONLY.test(stack.slice(0, newline))) return undefined;
		return stack.slice(newline + 1);
	}
	const at = stack.indexOf(`${message}\n`);
	if (at < 0 || !HEADER_NAME_PREFIX.test(stack.slice(0, at))) return undefined;
	return stack.slice(at + message.length + 1);
}

/**
 * Up to {@link MAX_PROVIDER_ERROR_STACK_FRAMES} whitelist-shaped frames from
 * `error.stack`, or undefined when nothing parses. For an engine-formatted
 * stack the header (which embeds the current `message`) is located and
 * stripped first, so a provider-controlled *message* containing newlines
 * cannot inject frame-shaped text (no header match, no frames). A provider
 * that overwrites `stack` or `name` outright can still put grammar-shaped
 * frames in the record: the field is a diagnostic hint, not an attested
 * location, and the whitelist plus the redactor bound what it can carry.
 * Each emitted frame still passes
 * through the request redactor so a registered secret that happens to appear
 * in a function or file name is masked (fail-closed to `[REDACTION_FAILED]`).
 */
export function providerErrorStackFrames(
	error: unknown,
	redact?: DiagnosticRedactor,
): string[] | undefined {
	const stack = readOwnStackString(error);
	if (stack === undefined) return undefined;

	const body = frameBlock(stack, error as object);
	if (body === undefined) return undefined;

	const frames: string[] = [];
	const lines = body.slice(0, MAX_STACK_SCAN_CHARS).split("\n", MAX_STACK_SCAN_LINES);
	for (const line of lines) {
		if (frames.length >= MAX_PROVIDER_ERROR_STACK_FRAMES) break;
		const frame = parseProviderErrorStackFrame(line);
		if (frame !== undefined) frames.push(redactDiagnosticText(frame, redact));
	}
	return frames.length > 0 ? frames : undefined;
}
