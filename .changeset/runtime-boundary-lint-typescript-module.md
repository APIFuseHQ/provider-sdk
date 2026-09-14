---
"@apifuse/provider-sdk": patch
---

Runtime boundary lint: accept an injected TypeScript compiler module, and fall back to `@typescript/typescript6` when `typescript` resolves to the 7.x native shell.

- `lintRuntimeBoundarySources(files, { typescript })` takes a loaded compiler API module (`typescript` 6.x or `@typescript/typescript6`) so a caller that pins its own compiler — the APIFuse monorepo contract check, whose root pins `typescript@7` — parses with that module instead of whatever hoists next to the SDK. A module without `createSourceFile` is rejected up front with a `TypeError` naming the requirement.
- The shared lazy loader (`getTypeScript`, used by every source-level lint rule and by `apifuse check` / `submit-check`) now tries `typescript` and then `@typescript/typescript6`, accepting the first module that exposes the parser. Under `typescript@7` the JavaScript entry exports only `version`/`getExePath`; the rules used to throw `undefined is not an object (evaluating 'ts.ScriptTarget.Latest')` from inside the parse. When neither package provides the API the error now names each attempt and the install that fixes it.
- Exported alongside: `LintRuntimeBoundarySourcesOptions`, `TypeScriptCompilerModuleLike` (the structural option type, so a caller under a `typescript@7` pin can pass `@typescript/typescript6` without a cast) and `TYPESCRIPT_COMPILER_MODULE_SPECIFIERS`.
