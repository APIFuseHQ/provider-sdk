import { createHttpClient } from "../../runtime/http.js";
import type { HttpTelemetryRequestSink } from "../../runtime/http-telemetry.js";

const mode = process.argv[2];
let fetches = 0;
let markers = 0;
let thenCalls = 0;
let speciesReads = 0;
let observed: object | undefined;
let previousConstructor: PropertyDescriptor | undefined;

class BadPromise<T> extends Promise<T> {
	static get [Symbol.species](): PromiseConstructor {
		speciesReads++;
		throw new Error("observer promise species");
	}
}

function observerReturn(): unknown {
	if (mode === "throwing-then") {
		return {
			// biome-ignore lint/suspicious/noThenProperty: exercise a hostile observer then getter.
			get then() {
				throw new Error("observer then getter");
			},
		};
	}
	if (mode === "sync-reject-thenable") {
		return {
			// biome-ignore lint/suspicious/noThenProperty: exercise an observer's synchronous thenable.
			then(_resolve: unknown, reject: (reason: Error) => void) {
				thenCalls++;
				reject(new Error("synchronous thenable rejection"));
			},
		};
	}
	const promise =
		mode === "frozen-promise"
			? Object.freeze(Promise.reject(new Error("observer rejection")))
			: new BadPromise((_resolve, reject) => reject(new Error("observer rejection")));
	if (mode === "throwing-then-promise") {
		// biome-ignore lint/suspicious/noThenProperty: rejected Promises may hide their then method.
		Object.defineProperty(promise, "then", {
			get() {
				throw new Error("observer promise then getter");
			},
		});
	}
	if (mode === "own-constructor") {
		Object.defineProperty(promise, "constructor", {
			value: BadPromise,
			writable: true,
			configurable: false,
			enumerable: false,
		});
	}
	observed = promise;
	previousConstructor = Object.getOwnPropertyDescriptor(promise, "constructor");
	return promise;
}

globalThis.fetch = Object.assign(
	async () => {
		fetches++;
		await new Promise((resolve) => setTimeout(resolve, 20));
		return new Response("ok");
	},
	{ preconnect() {} },
);

const client = createHttpClient(undefined, {
	...(mode === "off"
		? {}
		: {
				httpTelemetry: {
					startRequest() {
						if (mode === "species-marker") throw new Error("trigger observer failure");
						// test-invalid: public synchronous hooks can return hostile asynchronous objects.
						return observerReturn() as HttpTelemetryRequestSink;
					},
					markTelemetryFailed() {
						markers++;
						if (mode === "species-marker") return observerReturn();
					},
				},
			}),
});
const result = await client.get("https://example.com/probe", { retry: false });
const afterConstructor = observed && Object.getOwnPropertyDescriptor(observed, "constructor");
const constructorRestored =
	previousConstructor === undefined
		? afterConstructor === undefined
		: afterConstructor?.value === previousConstructor.value &&
			afterConstructor?.writable === previousConstructor.writable &&
			afterConstructor?.enumerable === previousConstructor.enumerable &&
			afterConstructor?.configurable === previousConstructor.configurable;
console.log(
	JSON.stringify({
		status: result.status,
		fetches,
		body: await result.text(),
		markers,
		thenCalls,
		speciesReads,
		constructorRestored,
	}),
);
