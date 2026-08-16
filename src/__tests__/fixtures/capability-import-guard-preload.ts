import { mock } from "bun:test";
import type {
	CapabilityImportGuardState,
	StealthCreateArgs,
} from "./capability-import-guard-state.js";

const mode = process.argv[2] ?? "standard";
const state: CapabilityImportGuardState = {
	heavyLoads: [],
	stealthCreateArgs: [],
	stealthLoads: 0,
};
Reflect.set(globalThis, "__capabilityImportGuardState", state);

for (const modulePath of [
	"../../runtime/browser.js",
	"../../runtime/native-network.js",
	"../../runtime/resolver.js",
	"../../runtime/resolver-vendors/bindings.js",
	"../../runtime/resolver-vendors/browser.js",
	"../../runtime/resolver-vendors/hosts.js",
	"../../runtime/resolver-vendors/twocaptcha.js",
	"../../runtime/resolver-vendors/types.js",
	"../../runtime/stealth.js",
	"../../stateful/stateful-provider-session-routing.js",
]) {
	const resolvedPath = new URL(modulePath, import.meta.url).pathname;
	mock.module(resolvedPath, () => {
		state.heavyLoads.push(modulePath);
		if (
			modulePath === "../../runtime/stealth.js" &&
			(mode === "tier1-stealth" || mode === "tier2-stealth" || mode === "tier2-stealth-session")
		) {
			state.stealthLoads += 1;
			return {
				createStealthClient(...args: StealthCreateArgs) {
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
		if (modulePath === "../../runtime/stealth.js" && mode === "sync-esm") {
			throw Object.assign(new Error("require() of ES Module is unavailable"), {
				code: "ERR_REQUIRE_ESM",
			});
		}
		throw new Error(`unexpected heavy module load: ${modulePath}`);
	});
}
