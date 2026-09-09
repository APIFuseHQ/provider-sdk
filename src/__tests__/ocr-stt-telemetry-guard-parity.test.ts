import { expect, it } from "bun:test";
import { startHttpTelemetry } from "../runtime/http-telemetry-guard.js";
import { bindOcrTelemetry } from "../runtime/ocr-telemetry.js";
import { bindSttTelemetry } from "../runtime/stt-telemetry.js";

const image = { kind: "base64", data: "cHJvYmU=" } as const;
type Mode =
	| "throw"
	| "reject"
	| "never"
	| "species"
	| "frozen"
	| "thenable"
	| "garbage-number"
	| "garbage-object";

function hostile(mode: Mode): unknown {
	if (mode === "throw") throw new Error("observer threw");
	if (mode === "reject") return Promise.reject(new Error("observer rejected"));
	if (mode === "never") return new Promise(() => {});
	if (mode === "species") {
		class HostilePromise extends Promise<never> {
			static get [Symbol.species](): PromiseConstructor {
				throw new Error("species getter ran");
			}
		}
		return HostilePromise.reject(new Error("species rejection"));
	}
	if (mode === "frozen") return Object.freeze(Promise.reject(new Error("frozen rejection")));
	if (mode === "thenable")
		return {
			// biome-ignore lint/suspicious/noThenProperty: hostile public observer return.
			then: () => {
				throw new Error("thenable must not be invoked");
			},
		};
	return mode === "garbage-number" ? 42 : { ordinary: true };
}

async function httpMarkers(mode: Mode): Promise<number> {
	let markers = 0;
	const request = startHttpTelemetry(
		{
			markTelemetryFailed: () => {
				markers++;
			},
			startRequest: () => ({
				recordAttempt: () => hostile(mode),
				finish: () => {},
				toTenantRetryPayload: () => undefined,
			}),
		},
		undefined,
	);
	request.recordAttempt({ ms: 1, proxyUsed: false });
	await new Promise((resolve) => setImmediate(resolve));
	return markers;
}

it("all OCR/STT record hooks match the HTTP six-case guard and never reject unhandled", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		for (const mode of [
			"throw",
			"reject",
			"never",
			"species",
			"frozen",
			"thenable",
			"garbage-number",
			"garbage-object",
		] as const) {
			const expected = await httpMarkers(mode);
			for (const operation of [
				"recognize-success",
				"recognize-error",
				"captcha-success",
				"captcha-error",
				"stt-success",
				"stt-error",
			] as const) {
				let markers = 0;
				const sink = {
					record: () => hostile(mode),
					markTelemetryFailed: () => {
						markers++;
					},
				};
				const failure = new Error("operation failed");
				if (operation.startsWith("stt")) {
					const client = bindSttTelemetry(
						{
							transcribe: async () => {
								if (operation.endsWith("error")) throw failure;
								return { text: "ok" };
							},
							extractVerificationCode: () => ({
								code: "1",
								candidates: [],
								normalizedText: "1",
							}),
						},
						sink,
					);
					await client.transcribe({ audio: image }).catch((error) => expect(error).toBe(failure));
				} else {
					const client = bindOcrTelemetry(
						{
							recognize: async () => {
								if (operation.endsWith("error")) throw failure;
								return { text: "ok", model: "m" };
							},
							extractCaptchaText: async () => {
								if (operation.endsWith("error")) throw failure;
								return { text: "ok", model: "m", candidates: [], satisfiesConstraints: true };
							},
						},
						sink,
					);
					const run = operation.startsWith("captcha")
						? client.extractCaptchaText(image)
						: client.recognize({ image });
					await run.catch((error) => expect(error).toBe(failure));
				}
				await new Promise((resolve) => setImmediate(resolve));
				expect(markers, `${mode} ${operation}`).toBe(expected);
			}
		}

		for (const mode of ["throw", "reject", "never", "species", "frozen", "thenable"] as const) {
			for (const operation of ["recognize", "captcha", "stt"] as const) {
				let markerCalls = 0;
				const sink = {
					record: () => hostile(mode),
					markTelemetryFailed: () => {
						markerCalls++;
						return hostile(mode);
					},
				};
				if (operation === "stt") {
					const client = bindSttTelemetry(
						{
							transcribe: async () => ({ text: "ok" }),
							extractVerificationCode: () => ({
								code: "1",
								candidates: [],
								normalizedText: "1",
							}),
						},
						sink,
					);
					await client.transcribe({ audio: image });
				} else {
					const client = bindOcrTelemetry(
						{
							recognize: async () => ({ text: "ok", model: "m" }),
							extractCaptchaText: async () => ({
								text: "ok",
								model: "m",
								candidates: [],
								satisfiesConstraints: true,
							}),
						},
						sink,
					);
					await (operation === "captcha"
						? client.extractCaptchaText(image)
						: client.recognize({ image }));
				}
				await new Promise((resolve) => setImmediate(resolve));
				expect(markerCalls, `failure marker ${mode} ${operation}`).toBe(1);
			}
		}
		await new Promise((resolve) => setImmediate(resolve));
		expect(unhandled).toEqual([]);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
