import { createRequire } from "node:module";

const requireModule = createRequire(import.meta.url);

/**
 * Lazily loaded `typescript` module shared by the source-level lint rules.
 *
 * `typeof import(...)` keeps the type without emitting a static import: the
 * typescript package is a devDependency of the SDK and only the CLI and the
 * lint rules need it at runtime, which the typescript-import-boundary test
 * enforces for production sources. Resolution starts at the installed SDK, so
 * the caller's dependency tree must provide `typescript`.
 */
let typeScriptModule: typeof import("typescript") | undefined;

export function getTypeScript(): typeof import("typescript") {
	typeScriptModule ??= requireModule("typescript") as typeof import("typescript");
	return typeScriptModule;
}
