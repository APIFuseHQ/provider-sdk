import { describe, expect, it } from "bun:test";
import ts from "typescript";
import {
	getTypeScript,
	isTypeScriptCompilerModule,
	loadTypeScriptModule,
	TYPESCRIPT_COMPILER_MODULE_SPECIFIERS,
} from "../typescript-module.js";

/** What `require("typescript")` returns under the 7.x native toolchain: a version shell, no parser. */
const TYPESCRIPT_7_SHELL = { version: "7.0.2", getExePath: () => "/usr/bin/tsgo" };

describe("typescript compiler module resolution", () => {
	it("recognizes a compiler API module by its parser surface", () => {
		expect(isTypeScriptCompilerModule(ts)).toBe(true);
		expect(isTypeScriptCompilerModule(TYPESCRIPT_7_SHELL)).toBe(false);
		expect(isTypeScriptCompilerModule(undefined)).toBe(false);
		expect(isTypeScriptCompilerModule(null)).toBe(false);
	});

	it("tries typescript before @typescript/typescript6", () => {
		expect(TYPESCRIPT_COMPILER_MODULE_SPECIFIERS).toEqual([
			"typescript",
			"@typescript/typescript6",
		]);
	});

	it("uses typescript when it carries the compiler API", () => {
		const loaded: string[] = [];
		const module = loadTypeScriptModule((specifier) => {
			loaded.push(specifier);
			return ts;
		});
		expect(module).toBe(ts);
		expect(loaded).toEqual(["typescript"]);
	});

	it("falls back to @typescript/typescript6 when typescript is the 7.x shell", () => {
		const loaded: string[] = [];
		const module = loadTypeScriptModule((specifier) => {
			loaded.push(specifier);
			return specifier === "typescript" ? TYPESCRIPT_7_SHELL : ts;
		});
		expect(module).toBe(ts);
		expect(loaded).toEqual(["typescript", "@typescript/typescript6"]);
	});

	it("falls back when typescript is not installed at all", () => {
		const module = loadTypeScriptModule((specifier) => {
			if (specifier === "typescript") throw new Error("Cannot find module 'typescript'");
			return ts;
		});
		expect(module).toBe(ts);
	});

	it("names every attempt when no candidate exposes the parser", () => {
		expect(() =>
			loadTypeScriptModule((specifier) => {
				if (specifier === "typescript") return TYPESCRIPT_7_SHELL;
				throw new Error("Cannot find module");
			}),
		).toThrow(
			/typescript: resolved 7\.0\.2 without a compiler API; @typescript\/typescript6: not resolvable/,
		);
	});

	it("resolves a compiler API module from the SDK install", () => {
		const module = getTypeScript();
		expect(isTypeScriptCompilerModule(module)).toBe(true);
		expect(getTypeScript()).toBe(module);
	});
});
