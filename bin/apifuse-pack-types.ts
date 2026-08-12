#!/usr/bin/env bun

// Guards the published artifact against the nodenext type-resolution regression
// shipped in 2.2.0-beta.1/beta.2: emitted dist/*.d.ts (and dist/*.js) carried
// EXTENSIONLESS relative imports, so external provider repos compiling with
// moduleResolution nodenext could not resolve them. With skipLibCheck the
// errors were masked and types silently degraded — re-exported ProviderError
// lost its inherited Error members (name/message) and re-exported zod stopped
// inferring .refine() callback params (~17 false type errors in
// apifuse-provider-tabelog, see its PR #16).
//
// Three layers, all against the packed tarball (what consumers actually get):
//   1. @arethetypeswrong/cli — resolution/module-kind audit of every exports
//      subpath, including internal resolution of relative specifiers in d.ts.
//   2. A fixture consumer compiled with real tsc under moduleResolution
//      nodenext and skipLibCheck:false, asserting ProviderError keeps
//      inherited Error members and zod re-exports keep .refine() inference.
//   3. A Node (not bun) ESM runtime import — node does not tolerate
//      extensionless relative specifiers, bun does.
//
// Deliberate negative controls prove the fixture compiler actually fails on
// type errors, so this check cannot rot into a false-positive green.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const PACK_RESULT_SCHEMA = z.array(
	z.object({
		filename: z.string(),
	}),
);

const KEEP_TEMP = process.env.APIFUSE__PACK_TYPES__KEEP_TEMP === "1";
const sdkRoot = process.cwd();

const NEGATIVE_CONTROLS = [
	{
		filename: "negative-control-provider-error-name.ts",
		expectedCode: "TS2322",
		description: "ProviderError.name remains a string",
		source: [
			'import { ProviderError } from "@apifuse/provider-sdk";',
			"",
			"// Intentionally wrong: name is a string. If this file compiles, the",
			"// fixture consumer is not actually type-checking and the guard is void.",
			'export const mustNotCompile: number = new ProviderError("boom").name;',
			"",
		].join("\n"),
	},
	{
		filename: "negative-control-unknown-resolver-vendor.ts",
		expectedCode: "TS2322",
		description: "ProviderResolverConfig rejects an unknown vendor",
		source: [
			'import type { ProviderResolverConfig } from "@apifuse/provider-sdk";',
			"",
			"export const mustNotCompile: ProviderResolverConfig = {",
			'\tvendors: ["unknown-vendor"],',
			'\tkinds: ["turnstile"],',
			"};",
			"",
		].join("\n"),
	},
	{
		filename: "negative-control-define-provider-resolver-vendor.ts",
		expectedCode: "TS2322",
		description: "defineProvider rejects an unknown resolver vendor",
		source: [
			'import { defineProvider, z } from "@apifuse/provider-sdk";',
			"",
			"export const mustNotCompile = defineProvider({",
			'\tid: "invalid-resolver-vendor",',
			'\tversion: "1.0.0",',
			'\truntime: "standard",',
			'\tresolver: { vendors: ["unknown-vendor"], kinds: ["turnstile"] },',
			'\tmeta: { displayName: "Invalid Resolver Vendor", descriptionKey: "meta.description", category: "test" },',
			"\toperations: {",
			"\t\tprobe: {",
			"\t\t\tinput: z.object({}),",
			"\t\t\toutput: z.object({ ok: z.boolean() }),",
			"\t\t\thandler: async () => ({ ok: true }),",
			'\t\t\thealthCheckUnsupported: { reason: "type fixture" },',
			"\t\t},",
			"\t},",
			"});",
			"",
		].join("\n"),
	},
	{
		filename: "negative-control-unknown-challenge-kind.ts",
		expectedCode: "TS2820",
		description: "ProviderChallenge rejects an unknown challenge kind",
		source: [
			'import type { ProviderChallenge } from "@apifuse/provider-sdk";',
			"",
			"export const mustNotCompile: ProviderChallenge = {",
			'\tkind: "funcaptcha",',
			'\tsiteKey: "key",',
			'\tpageUrl: "https://example.com",',
			"};",
			"",
		].join("\n"),
	},
	{
		filename: "negative-control-cookie-solution-token-read.ts",
		expectedCode: "TS2339",
		description: "ChallengeSolution requires narrowing before reading token",
		source: [
			'import type { ChallengeSolution } from "@apifuse/provider-sdk";',
			"",
			"export function mustNotCompile(solution: ChallengeSolution): string {",
			"\treturn solution.token;",
			"}",
			"",
		].join("\n"),
	},
	{
		filename: "negative-control-cookie-challenge-site-key.ts",
		expectedCode: "TS2353",
		description: "cookie-family challenges reject token-family fields",
		source: [
			'import type { ProviderChallenge } from "@apifuse/provider-sdk";',
			"",
			"export const mustNotCompile: ProviderChallenge = {",
			'\tkind: "cloudflare_interstitial",',
			'\tpageUrl: "https://example.com",',
			'\tsiteKey: "not-allowed",',
			"};",
			"",
		].join("\n"),
	},
	{
		filename: "negative-control-recaptcha-v3-action.ts",
		expectedCode: "TS2322",
		description: "recaptcha_v3 challenges require action",
		source: [
			'import type { ProviderChallenge } from "@apifuse/provider-sdk";',
			"",
			"export const mustNotCompile: ProviderChallenge = {",
			'\tkind: "recaptcha_v3",',
			'\tsiteKey: "key",',
			'\tpageUrl: "https://example.com",',
			"};",
			"",
		].join("\n"),
	},
	{
		filename: "negative-control-browser-cookie-expires.ts",
		expectedCode: "TS2322",
		description: "BrowserCookie.expires remains optional for session cookies",
		source: [
			'import type { BrowserCookie } from "@apifuse/provider-sdk";',
			"",
			"export function mustNotCompile(cookie: BrowserCookie): number {",
			"\treturn cookie.expires;",
			"}",
			"",
		].join("\n"),
	},
	{
		filename: "negative-control-resolver-runtime-identity.ts",
		expectedCode: "TS2353",
		description: "ResolverRuntimeOptions does not accept caller-synthesized identity",
		source: [
			'import type { ResolverRuntimeOptions } from "@apifuse/provider-sdk";',
			"",
			"export const mustNotCompile: ResolverRuntimeOptions = {",
			'\tidentity: "caller-controlled",',
			"};",
			"",
		].join("\n"),
	},
	{
		filename: "negative-control-resolver-runtime-allowed-hosts.ts",
		expectedCode: "TS2322",
		description: "ResolverRuntimeOptions.allowedHosts accepts only host strings",
		source: [
			'import type { ResolverRuntimeOptions } from "@apifuse/provider-sdk";',
			"",
			"export const mustNotCompile: ResolverRuntimeOptions = {",
			'\tallowedHosts: ["example.com", 42],',
			"};",
			"",
		].join("\n"),
	},
	{
		filename: "negative-control-resolver-signal.ts",
		expectedCode: "TS2345",
		description: "ResolverContext.solve accepts only AbortSignal as its optional signal",
		source: [
			'import type { ProviderChallenge, ResolverContext } from "@apifuse/provider-sdk";',
			"",
			"declare const resolver: ResolverContext;",
			"declare const challenge: ProviderChallenge;",
			"resolver.solve(challenge, { aborted: false });",
			"",
		].join("\n"),
	},
] as const;

const tempRoot = mkdtempSync(join(tmpdir(), "apifuse-provider-sdk-pack-types-"));
const packDir = join(tempRoot, "pack");
const consumerDir = join(tempRoot, "consumer");

try {
	mkdirSync(packDir, { recursive: true });
	mkdirSync(consumerDir, { recursive: true });

	const packed = packSdk(packDir);
	const tarballPath = resolve(packDir, packed.filename);

	runAreTheTypesWrong(tarballPath);
	setUpFixtureConsumer(consumerDir, tarballPath);
	run("bun", ["install"], consumerDir);
	compileFixtureConsumer(consumerDir);
	assertNegativeControlFails(consumerDir);
	runNodeRuntimeImport(consumerDir);

	console.log(`Packed artifact types OK under nodenext: ${tarballPath}`);
} finally {
	if (KEEP_TEMP) {
		console.log(`Keeping pack-types temp directory: ${tempRoot}`);
	} else {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function runAreTheTypesWrong(tarballPath: string): void {
	// esm-only profile: this package publishes ESM only, so CJS-consumer
	// resolution failures are expected and out of scope for this guard.
	run(
		"bun",
		[join(sdkRoot, "node_modules", ".bin", "attw"), tarballPath, "--profile", "esm-only"],
		sdkRoot,
	);
}

function setUpFixtureConsumer(consumerDir: string, tarballPath: string): void {
	writeFileSync(
		join(consumerDir, "package.json"),
		`${JSON.stringify(
			{
				private: true,
				type: "module",
				dependencies: {
					"@apifuse/provider-sdk": `file:${tarballPath}`,
				},
				devDependencies: {
					// Pinned to TS 5.x independently of the repo's own TypeScript 7
					// toolchain: this must reflect what external provider polyrepos
					// (e.g. apifuse-provider-tabelog) run in their CI.
					typescript: "^5.9.3",
					// skipLibCheck:false type-checks transitive deps too (ioredis
					// references Buffer), so the fixture needs node types like any
					// real provider repo.
					"@types/node": "^25.9.3",
				},
			},
			null,
			2,
		)}\n`,
	);

	writeFileSync(
		join(consumerDir, "tsconfig.json"),
		`${JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "nodenext",
					moduleResolution: "nodenext",
					strict: true,
					// skipLibCheck must stay off: it is exactly what masked the
					// extensionless-d.ts regression downstream.
					skipLibCheck: false,
					noEmit: true,
				},
				include: ["consumer.ts"],
			},
			null,
			2,
		)}\n`,
	);

	writeFileSync(
		join(consumerDir, "consumer.ts"),
		[
			'import { defineProvider, invalidateResolverSolution, ProviderError, resolveProxy, SessionExpiredError, z } from "@apifuse/provider-sdk";',
			'import type { BrowserCookie, ChallengeSolution, NativeNetworkClient, NativeNetworkConnection, NativeProviderConfig, NativeProviderContext, NativeTcpEgressGrant, ProviderChallenge, ProviderContext, ProviderFileRef, ProviderFilesContext, ProviderResolvedFile, ProviderResolverConfig, ResolverContext, ResolverRuntimeOptions } from "@apifuse/provider-sdk";',
			'import type { ProxyProtocol, ProxyResolutionOptions, ProxyResolutionSource, ProxyVendorName, RequestOptions, ResolvedProxyConfig } from "@apifuse/provider-sdk";',
			'import { defineCredentialsAuth } from "@apifuse/provider-sdk/provider";',
			'import type { NativeNetworkClient as ProviderEntryNativeNetworkClient, ProviderFilesContext as ProviderEntryFilesContext } from "@apifuse/provider-sdk/provider";',
			'import { extractProviderContract } from "@apifuse/provider-sdk/contract";',
			'import { AUTH_TURN_SCHEMA } from "@apifuse/provider-sdk/auth-turn";',
			'import { serve } from "@apifuse/provider-sdk/server";',
			'import { runStandardTests } from "@apifuse/provider-sdk/testing";',
			"",
			"// ProviderError must keep its inherited Error members under nodenext.",
			"// When dist d.ts imports fail to resolve, the class type degrades and",
			"// name/message disappear (the tabelog false-error mode).",
			'const providerError = new ProviderError("boom");',
			"const inheritedName: string = providerError.name;",
			"const inheritedMessage: string = providerError.message;",
			"const inheritedStack: string | undefined = providerError.stack;",
			"const isError: Error = providerError;",
			"const sessionExpired: ProviderError = new SessionExpiredError();",
			"",
			"// Re-exported zod must keep .refine() callback parameter inference.",
			"const refined = z.object({ shopId: z.string() }).refine((value) => value.shopId.length > 0);",
			'const refinedString = z.string().refine((value) => value.startsWith("tabelog:"));',
			'const proxyOptions: ProxyResolutionOptions = { proxyPolicy: { mode: "disabled" } };',
			'const proxyProtocol: ProxyProtocol = "http";',
			"const proxyResult: Promise<ResolvedProxyConfig> = resolveProxy(proxyOptions);",
			'const proxySource: ProxyResolutionSource = "smartproxy-allocator";',
			'const proxyVendor: ProxyVendorName = "smartproxy";',
			'const requestFile: ProviderFileRef = { type: "request_file", id: "photo", filename: "photo.jpg", mime_type: "image/jpeg", size: 4 };',
			'const resolvedFile: ProviderResolvedFile = { type: "request_file", id: requestFile.id, filename: requestFile.filename, size: requestFile.size, sha256: requestFile.sha256, mimeType: requestFile.mime_type, arrayBuffer: async () => new ArrayBuffer(0), bytes: async () => new Uint8Array(), stream: () => new ReadableStream<Uint8Array>() };',
			"const files: ProviderFilesContext = { has: () => true, resolve: async () => resolvedFile };",
			"const providerEntryFiles: ProviderEntryFilesContext = files;",
			"const connection: NativeNetworkConnection = { read: async () => null, write: async () => {}, close: async () => {} };",
			"const network: NativeNetworkClient = { connectTcp: async () => connection, connectTls: async () => connection, grantTcpEgress: () => ({ revoke() {} }) };",
			"const providerEntryNetwork: ProviderEntryNativeNetworkClient = network;",
			"const nativeContext: NativeProviderContext = { network };",
			'const grant: NativeTcpEgressGrant = network.grantTcpEgress({ sourceHost: "booking-loco.kakao.com", sourcePort: 443, host: "loco.kakao.com", port: 5228, tls: "disabled" });',
			'const nativeConfig: NativeProviderConfig = { network: { tcp: [{ host: "booking-loco.kakao.com", ports: [443], tls: "required" }] } };',
			"const providerContext = undefined as unknown as ProviderContext;",
			"const optionalFiles: ProviderFilesContext | undefined = providerContext.files;",
			"const optionalNative: NativeProviderContext | undefined = providerContext.native;",
			"export const providerResolver: ResolverContext = providerContext.resolver;",
			'export const resolverRuntimeOptions: ResolverRuntimeOptions = { allowedHosts: ["example.com"], cache: providerContext.cache };',
			"",
			'export const turnstileChallenge: ProviderChallenge = { kind: "turnstile", siteKey: "key", pageUrl: "https://example.com" };',
			"export const abortableResolverSolve = providerResolver.solve(turnstileChallenge, new AbortController().signal);",
			'export const recaptchaV2Challenge: ProviderChallenge = { kind: "recaptcha_v2", siteKey: "key", pageUrl: "https://example.com" };',
			'export const recaptchaV3Challenge: ProviderChallenge = { kind: "recaptcha_v3", siteKey: "key", pageUrl: "https://example.com", action: "login" };',
			'export const hcaptchaChallenge: ProviderChallenge = { kind: "hcaptcha", siteKey: "key", pageUrl: "https://example.com" };',
			'export const cloudflareInterstitialChallenge: ProviderChallenge = { kind: "cloudflare_interstitial", pageUrl: "https://example.com", blockedHtml: "<html></html>" };',
			'export const awsWafChallenge: ProviderChallenge = { kind: "aws_waf", pageUrl: "https://example.com", captchaScript: "script" };',
			'export const tokenSolution: ChallengeSolution = { form: "token", token: "solved-token" };',
			'export const cookieSolution: ChallengeSolution = { form: "cookies", cookies: { cf_clearance: "clearance" }, userAgent: "fixture-agent" };',
			"export const invalidation = invalidateResolverSolution(providerContext.resolver, awsWafChallenge, cookieSolution);",
			'export const resolverConfig: ProviderResolverConfig = { vendors: ["browser", "capsolver"], kinds: ["cloudflare_interstitial", "turnstile"] };',
			'export const resolverProvider = defineProvider({ id: "pack-types-resolver", version: "1.0.0", runtime: "standard", resolver: resolverConfig, meta: { displayName: "Pack Types Resolver", descriptionKey: "meta.description", category: "test" }, operations: { probe: { input: z.object({}), output: z.object({ ok: z.boolean() }), handler: async () => ({ ok: true }), healthCheckUnsupported: { reason: "type fixture" } } } });',
			"export const resolverContext: ResolverContext = { solve: async () => tokenSolution };",
			'export const browserCookie: BrowserCookie = { name: "persistent-id", value: "persistent-token", domain: "example.com", path: "/", expires: 1786698176, httpOnly: true, secure: true };',
			'const browserPage = undefined as unknown as Awaited<ReturnType<ProviderContext["browser"]["newPage"]>>;',
			"export const browserCookies: Promise<readonly BrowserCookie[]> = browserPage.cookies();",
			'const queryCredentialOptions: RequestOptions = { sensitiveParams: { serviceKey: "type-test-key" } };',
			"",
			"export const witnesses = {",
			"	inheritedName,",
			"	inheritedMessage,",
			"	inheritedStack,",
			"	isError,",
			"	sessionExpired,",
			"	refined,",
			"	refinedString,",
			"	proxyResult,",
			"	proxyProtocol,",
			"	proxySource,",
			"	proxyVendor,",
			"	requestFile,",
			"	resolvedFile,",
			"	files,",
			"	providerEntryFiles,",
			"	connection,",
			"	network,",
			"	providerEntryNetwork,",
			"	nativeContext,",
			"	grant,",
			"	nativeConfig,",
			"	optionalFiles,",
			"	optionalNative,",
			"	browserCookie,",
			"	browserCookies,",
			"	queryCredentialOptions,",
			"	defineCredentialsAuth,",
			"	extractProviderContract,",
			"	AUTH_TURN_SCHEMA,",
			"	serve,",
			"	runStandardTests,",
			"};",
			"",
		].join("\n"),
	);

	for (const negativeControl of NEGATIVE_CONTROLS) {
		writeFileSync(join(consumerDir, negativeControl.filename), negativeControl.source);
	}
}

function compileFixtureConsumer(consumerDir: string): void {
	run(
		"bun",
		[join(consumerDir, "node_modules", ".bin", "tsc"), "-p", "tsconfig.json"],
		consumerDir,
	);
}

function assertNegativeControlFails(consumerDir: string): void {
	for (const negativeControl of NEGATIVE_CONTROLS) {
		const result = spawnSync(
			"bun",
			[
				join(consumerDir, "node_modules", ".bin", "tsc"),
				"--target",
				"ES2022",
				"--module",
				"nodenext",
				"--moduleResolution",
				"nodenext",
				"--strict",
				"--noEmit",
				negativeControl.filename,
			],
			{ cwd: consumerDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		if (result.status === 0) {
			throw new Error(
				'Negative control "' +
					negativeControl.description +
					'" (' +
					negativeControl.filename +
					") compiled cleanly: the fixture consumer is not detecting its error, so the guard proves nothing.",
			);
		}
		const output = `${result.stdout}\n${result.stderr}`;
		if (!output.includes(negativeControl.expectedCode)) {
			throw new Error(
				`Negative control "${negativeControl.description}" (${negativeControl.filename}) failed for an unexpected reason (wanted ${negativeControl.expectedCode}):\n${output}`,
			);
		}
	}
}

function runNodeRuntimeImport(consumerDir: string): void {
	// Node, not bun: bun resolves extensionless relative specifiers in
	// published dist/*.js, node correctly refuses them (ERR_MODULE_NOT_FOUND).
	run(
		"node",
		[
			"--input-type=module",
			"-e",
			[
				'const sdk = await import("@apifuse/provider-sdk");',
				'const error = new sdk.ProviderError("boom");',
				'if (error.name !== "ProviderError" || error.message !== "boom" || !(error instanceof Error)) {',
				'	throw new Error("ProviderError runtime shape is wrong: " + JSON.stringify({ name: error.name, message: error.message }));',
				"}",
				'console.log("node ESM runtime import OK");',
			].join("\n"),
		],
		consumerDir,
	);
}

function packSdk(destination: string): { filename: string } {
	const raw = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
		cwd: sdkRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
	const parsed = PACK_RESULT_SCHEMA.parse(JSON.parse(raw));
	const first = parsed[0];
	if (!first) {
		throw new Error("npm pack --json returned no package metadata.");
	}
	return first;
}

function run(command: string, args: string[], cwd: string): void {
	const result = spawnSync(command, args, {
		cwd,
		env: process.env,
		stdio: "inherit",
	});

	if (result.error) {
		throw result.error;
	}

	if (result.status !== 0) {
		throw new Error(
			`Command failed (${[command, ...args].join(" ")}) in ${cwd} with exit code ${result.status}`,
		);
	}
}
