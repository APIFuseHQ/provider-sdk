import { createRequire } from "node:module";

const requireModule = createRequire(import.meta.url);

/** The TypeScript compiler API surface the source-level lint rules parse with. */
export type TypeScriptModule = typeof import("typescript");

/**
 * What a caller hands over as a compiler module. Typed structurally so the
 * option does not depend on which `typescript` package the caller's own type
 * resolution lands on: under a `typescript@7` pin `typeof import("typescript")`
 * is the native shell's version module, not the compiler API. The members are
 * optional for the same reason — the shell has none of them — and
 * `isTypeScriptCompilerModule` decides at runtime whether the module can parse.
 */
export type TypeScriptCompilerModuleLike = {
	readonly createSourceFile?: (...parameters: never[]) => unknown;
	readonly ScriptTarget?: object;
	readonly version?: string;
};

/**
 * Package specifiers that may carry the compiler API, in resolution order.
 *
 * `typescript@7` (the Go-native toolchain) resolves but its JavaScript entry
 * exports only `version`/`getExePath` — no `createSourceFile`, so the lint
 * rules cannot parse with it. The compiler API of that generation is published
 * as `@typescript/typescript6`, which is what a `typescript@7` dependency tree
 * (for example the APIFuse monorepo root) installs alongside the shell.
 */
export const TYPESCRIPT_COMPILER_MODULE_SPECIFIERS = [
	"typescript",
	"@typescript/typescript6",
] as const;

/**
 * True when `candidate` is a loaded module that exposes the parser the lint
 * rules need. Internal (narrows to the `typescript` module type, which is not
 * part of the package surface); `lintRuntimeBoundarySources` applies it to the
 * caller-supplied option.
 */
export function isTypeScriptCompilerModule(candidate: unknown): candidate is TypeScriptModule {
	return (
		typeof candidate === "object" &&
		candidate !== null &&
		typeof (candidate as { createSourceFile?: unknown }).createSourceFile === "function" &&
		typeof (candidate as { ScriptTarget?: unknown }).ScriptTarget === "object"
	);
}

function describeCandidate(candidate: unknown): string {
	if (typeof candidate === "object" && candidate !== null) {
		const version = (candidate as { version?: unknown }).version;
		if (typeof version === "string") return `resolved ${version} without a compiler API`;
	}
	return "resolved without a compiler API";
}

/**
 * Resolve the compiler API through `load`, trying each specifier in order and
 * accepting the first module that exposes `createSourceFile`. Exposed for the
 * tests; production code uses `getTypeScript()`.
 */
export function loadTypeScriptModule(
	load: (specifier: string) => unknown,
	specifiers: readonly string[] = TYPESCRIPT_COMPILER_MODULE_SPECIFIERS,
): TypeScriptModule {
	const attempts: string[] = [];
	for (const specifier of specifiers) {
		let candidate: unknown;
		try {
			candidate = load(specifier);
		} catch {
			attempts.push(`${specifier}: not resolvable`);
			continue;
		}
		if (isTypeScriptCompilerModule(candidate)) return candidate;
		attempts.push(`${specifier}: ${describeCandidate(candidate)}`);
	}
	throw new Error(
		`The provider source lint needs the TypeScript compiler API (createSourceFile) and none of the resolvable packages provide it — ${attempts.join("; ")}. Install typescript 6.x as a devDependency, or @typescript/typescript6 next to a typescript 7 toolchain, in the dependency tree that installs @apifuse/provider-sdk.`,
	);
}

/**
 * Lazily loaded TypeScript compiler API shared by the source-level lint rules.
 *
 * `typeof import(...)` keeps the type without emitting a static import: the
 * typescript package is a devDependency of the SDK and only the CLI and the
 * lint rules need it at runtime, which the typescript-import-boundary test
 * enforces for production sources. Resolution starts at the installed SDK, so
 * the caller's dependency tree must provide one of
 * `TYPESCRIPT_COMPILER_MODULE_SPECIFIERS`.
 */
let typeScriptModule: TypeScriptModule | undefined;

export function getTypeScript(): TypeScriptModule {
	typeScriptModule ??= loadTypeScriptModule(requireModule);
	return typeScriptModule;
}
