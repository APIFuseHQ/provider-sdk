import { mock } from "bun:test";

for (const modulePath of [
	"../../runtime/browser.js",
	"../../runtime/native-network.js",
	"../../runtime/resolver.js",
	"../../runtime/stealth.js",
	"../../stateful/stateful-provider-session-routing.js",
]) {
	const resolvedPath = new URL(modulePath, import.meta.url).pathname;
	mock.module(resolvedPath, () => {
		throw new Error(`unexpected heavy module load: ${modulePath}`);
	});
}
