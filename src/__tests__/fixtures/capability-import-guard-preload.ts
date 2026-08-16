import { mock } from "bun:test";

const mode = process.argv[2] ?? "standard";
const state = {
	stealthCreateArgs: [] as unknown[][],
	stealthLoads: 0,
};
Reflect.set(globalThis, "__capabilityImportGuardState", state);

for (const modulePath of [
	"../../runtime/browser.js",
	"../../runtime/native-network.js",
	"../../runtime/resolver.js",
	"../../runtime/stealth.js",
	"../../stateful/stateful-provider-session-routing.js",
]) {
	const resolvedPath = new URL(modulePath, import.meta.url).pathname;
	mock.module(resolvedPath, () => {
		if (
			modulePath === "../../runtime/stealth.js" &&
			(mode === "tier1-stealth" || mode === "tier2-stealth" || mode === "tier2-stealth-session")
		) {
			state.stealthLoads += 1;
			return {
				createStealthClient(...args: unknown[]) {
					state.stealthCreateArgs.push(args);
					return {
						async fetch() {
							return { status: 204 };
						},
						createSession() {
							return {
								cookies: { deserialize() {} },
								async fetch() {
									return { status: 204 };
								},
								redirects: {
									async run() {
										throw new Error("unused fake stealth redirects");
									},
								},
								close() {},
							};
						},
						close() {},
					};
				},
			};
		}
		if (modulePath === "../../runtime/stealth.js" && mode === "primitive") {
			throw "primitive stealth failure";
		}
		throw new Error(`unexpected heavy module load: ${modulePath}`);
	});
}
