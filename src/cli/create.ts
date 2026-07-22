import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cancel, intro, isCancel, note, outro, select, text } from "@clack/prompts";
import { z } from "zod";

import packageJson from "../../package.json";
import {
	buildPromptAssetManifest,
	buildPromptAssetPlanEntries,
	PROMPT_ASSET_MANIFEST_PATH,
} from "./prompt-assets.js";

export const PROVIDER_NAME_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const CATEGORY_OPTIONS = [
	"developer-tools",
	"finance",
	"commerce",
	"productivity",
	"marketing",
	"data",
	"communication",
	"other",
] as const;
export const AUTH_MODE_OPTIONS = ["none", "platform-managed", "credentials", "oauth2"] as const;
export const RUNTIME_OPTIONS = ["standard", "browser"] as const;
export const PRESET_OPTIONS = ["standalone", "monorepo"] as const;

export type CreateCategory = (typeof CATEGORY_OPTIONS)[number];
export type CreateAuthMode = (typeof AUTH_MODE_OPTIONS)[number];
export type CreateRuntime = (typeof RUNTIME_OPTIONS)[number];
export type CreatePreset = (typeof PRESET_OPTIONS)[number];

export type CreateConfigFile = Partial<CreateResolvedOptions> & {
	name?: string;
	outputDir?: string;
};

const CREATE_CONFIG_SCHEMA = z.object({
	authMode: z.enum(AUTH_MODE_OPTIONS).optional(),
	category: z.enum(CATEGORY_OPTIONS).optional(),
	displayName: z.string().optional(),
	dryRun: z.boolean().optional(),
	json: z.boolean().optional(),
	name: z.string().optional(),
	outputDir: z.string().optional(),
	preset: z.enum(PRESET_OPTIONS).optional(),
	runtime: z.enum(RUNTIME_OPTIONS).optional(),
	sdkSpecifier: z.string().optional(),
	yes: z.boolean().optional(),
});

export type CreateResolvedOptions = {
	authMode: CreateAuthMode;
	category: CreateCategory;
	displayName: string;
	dryRun: boolean;
	json: boolean;
	name: string;
	outputDir?: string;
	preset: CreatePreset;
	runtime: CreateRuntime;
	sdkSpecifier?: string;
	yes: boolean;
};

export type ProviderPlanFile = {
	path: string;
	/** File content, or the symlink target (relative path) for kind "symlink". */
	content: string;
	/** Absent kind means "file" (backward compatible with older consumers). */
	kind?: "file" | "symlink";
};

export type ProviderCreatePlan = {
	displayName: string;
	installCommand: string;
	installCwd: string;
	name: string;
	nextDevCommand: string;
	outputDir: string;
	packageName: string;
	preset: CreatePreset;
	providerRoot: string;
	validationCommands: string[];
	files: ProviderPlanFile[];
	workspaceRoot?: string;
};

const TEMPLATE_DIR = fileURLToPath(new URL("./templates/provider/", import.meta.url));
const HELP_TEXT = `Usage: apifuse create <provider-name> [options]
Examples:
  apifuse create my-provider
  apifuse create --config ./apifuse.create.json --json

Options:
  --config <path>
  --output-dir <path>
  --display-name <name>
  --category <category>
  --auth-mode <mode>
  --runtime <standard|browser>
  --yes
  --dry-run
  --json
  --sdk-specifier <specifier>   # internal/testing override for dependency resolution
  --help, -h`;

export async function main() {
	const args = process.argv.slice(2);
	const normalizedArgs = normalizeArgs(args);

	if (normalizedArgs.includes("--help") || normalizedArgs.includes("-h")) {
		console.log(HELP_TEXT);
		return;
	}

	const parsed = parseArgs(normalizedArgs);
	const config = parsed.configPath ? await loadConfig(parsed.configPath) : undefined;
	const resolved = await resolveCreateOptions(parsed, config, process.cwd());
	const plan = await buildProviderCreatePlan(resolved, process.cwd());

	if (resolved.dryRun) {
		return printResult(plan, resolved.json, true);
	}

	await writePlan(plan);
	await installDependencies(plan, resolved.json);
	await runBaselineValidation(plan, resolved.json);
	printResult(plan, resolved.json, false);
}

function normalizeArgs(argv: string[]): string[] {
	return argv[0] === "create" ? argv.slice(1) : argv;
}

type ParsedArgs = {
	authMode?: CreateAuthMode;
	category?: CreateCategory;
	configPath?: string;
	displayName?: string;
	dryRun: boolean;
	json: boolean;
	name?: string;
	outputDir?: string;
	preset?: CreatePreset;
	runtime?: CreateRuntime;
	sdkSpecifier?: string;
	yes: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
	const parsed: ParsedArgs = {
		dryRun: false,
		json: false,
		yes: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) continue;

		const [flag, inlineValue] = arg.split("=", 2);
		const value = inlineValue ?? argv[index + 1];
		const consumeValue = () => {
			if (inlineValue === undefined) {
				index += 1;
			}
			return value;
		};

		switch (flag) {
			case "--preset":
				parsed.preset = parseEnum("preset", consumeValue(), PRESET_OPTIONS);
				break;
			case "--config":
				parsed.configPath = ensureValue(flag, consumeValue());
				break;
			case "--output-dir":
				parsed.outputDir = ensureValue(flag, consumeValue());
				break;
			case "--display-name":
				parsed.displayName = ensureValue(flag, consumeValue());
				break;
			case "--category":
				parsed.category = parseEnum("category", consumeValue(), CATEGORY_OPTIONS);
				break;
			case "--auth-mode":
				parsed.authMode = parseEnum("auth mode", consumeValue(), AUTH_MODE_OPTIONS);
				break;
			case "--runtime":
				parsed.runtime = parseEnum("runtime", consumeValue(), RUNTIME_OPTIONS);
				break;
			case "--sdk-specifier":
				parsed.sdkSpecifier = ensureValue(flag, consumeValue());
				break;
			case "--dry-run":
				parsed.dryRun = true;
				break;
			case "--json":
				parsed.json = true;
				break;
			case "--yes":
				parsed.yes = true;
				break;
			default:
				if (flag.startsWith("-")) {
					throw new Error(`Unknown option: ${flag}`);
				}
				if (!parsed.name) {
					parsed.name = arg;
					break;
				}
				throw new Error(`Unexpected argument: ${arg}`);
		}
	}

	return parsed;
}

function ensureValue(flag: string, value: string | undefined): string {
	if (!value) {
		throw new Error(`Missing value for ${flag}`);
	}
	return value;
}

function parseEnum<T extends readonly string[]>(
	label: string,
	value: string | undefined,
	options: T,
): T[number] {
	const resolvedValue = ensureValue(`--${label}`, value);
	const matchedValue = options.find((option) => option === resolvedValue);
	if (!matchedValue) {
		throw new Error(`Invalid ${label}: ${resolvedValue}. Expected one of: ${options.join(", ")}`);
	}
	return matchedValue;
}

async function loadConfig(configPath: string): Promise<CreateConfigFile> {
	const resolvedPath = resolve(process.cwd(), configPath);
	const raw = await readFile(resolvedPath, "utf8");
	return CREATE_CONFIG_SCHEMA.parse(JSON.parse(raw));
}

async function resolveCreateOptions(
	parsed: ParsedArgs,
	config: CreateConfigFile | undefined,
	cwd: string,
): Promise<CreateResolvedOptions> {
	const internalWorkspaceRoot = findApifuseInternalWorkspaceRoot(cwd);

	const partial: Partial<CreateResolvedOptions> = {
		name: parsed.name ?? config?.name,
		preset: parsed.preset ?? config?.preset ?? "standalone",
		outputDir: parsed.outputDir ?? config?.outputDir,
		displayName: parsed.displayName ?? config?.displayName,
		category: parsed.category ?? config?.category,
		authMode: parsed.authMode ?? config?.authMode,
		runtime: parsed.runtime ?? config?.runtime,
		sdkSpecifier:
			parsed.sdkSpecifier ?? config?.sdkSpecifier ?? process.env.APIFUSE__SDK__SPECIFIER,
		dryRun: parsed.dryRun,
		json: parsed.json,
		yes: parsed.yes,
	};

	if (partial.preset === "monorepo" && !internalWorkspaceRoot) {
		throw new Error(
			"Monorepo preset is internal to the APIFuse repository. External bounty workspaces are one-provider repositories; use the standalone default create flow.",
		);
	}

	if (partial.yes) {
		if (!partial.name) {
			throw new Error("--yes requires a provider name (positional or via config).");
		}

		return {
			name: validateProviderName(partial.name),
			displayName: (partial.displayName ?? toDisplayName(partial.name)).trim(),
			category: partial.category ?? "other",
			authMode: partial.authMode ?? "none",
			runtime: partial.runtime ?? "standard",
			preset: partial.preset ?? "standalone",
			outputDir: partial.outputDir,
			dryRun: partial.dryRun ?? false,
			json: partial.json ?? false,
			sdkSpecifier: partial.sdkSpecifier,
			yes: true,
		};
	}

	if (!partial.json) {
		intro("Create a new APIFuse provider");
		note(
			"External bounty workspaces are one-provider repositories. The public create flow defaults to standalone.",
			"Provider workspace",
		);
	}

	const name = validateProviderName(
		partial.name ??
			(await promptValue(
				text({
					message: "Provider name",
					initialValue: undefined,
					placeholder: "my-provider",
					validate(value) {
						try {
							validateProviderName(value ?? "");
						} catch (error) {
							return error instanceof Error ? error.message : String(error);
						}
					},
				}),
			)),
	);

	return {
		name,
		displayName: (
			partial.displayName ??
			(await promptValue(
				text({
					message: "Display name",
					initialValue: toDisplayName(name),
					validate(value) {
						if (!(value?.trim() ?? "")) {
							return "Display name is required.";
						}
					},
				}),
			))
		).trim(),
		category:
			partial.category ??
			(await promptValue(
				select({
					message: "Category",
					options: CATEGORY_OPTIONS.map((value) => ({ label: value, value })),
					initialValue: "other",
				}),
			)),
		authMode:
			partial.authMode ??
			(await promptValue(
				select({
					message: "Auth mode",
					options: AUTH_MODE_OPTIONS.map((value) => ({ label: value, value })),
					initialValue: "none",
				}),
			)),
		runtime:
			partial.runtime ??
			(await promptValue(
				select({
					message: "Runtime",
					options: RUNTIME_OPTIONS.map((value) => ({ label: value, value })),
					initialValue: "standard",
				}),
			)),
		preset: partial.preset ?? "standalone",
		outputDir: partial.outputDir,
		dryRun: partial.dryRun ?? false,
		json: partial.json ?? false,
		sdkSpecifier: partial.sdkSpecifier,
		yes: false,
	};
}

async function promptValue<T>(prompt: Promise<T | symbol>): Promise<T> {
	const result = await prompt;
	if (isCancel(result)) {
		cancel("Operation cancelled.");
		process.exit(0);
	}
	return result;
}

export async function buildProviderCreatePlan(
	options: CreateResolvedOptions,
	cwd: string,
): Promise<ProviderCreatePlan> {
	const resolvedWorkspaceRoot =
		options.preset === "monorepo" ? findApifuseInternalWorkspaceRoot(cwd) : undefined;
	if (options.preset === "monorepo" && !resolvedWorkspaceRoot) {
		throw new Error(
			"Monorepo preset is internal to the APIFuse repository. External bounty workspaces are one-provider repositories; use the standalone default create flow.",
		);
	}
	let providerRoot: string;
	let installCwd: string;

	if (options.outputDir) {
		providerRoot = resolve(cwd, options.outputDir);
		installCwd =
			options.preset === "monorepo" && resolvedWorkspaceRoot ? resolvedWorkspaceRoot : providerRoot;
	} else if (options.preset === "monorepo" && resolvedWorkspaceRoot) {
		providerRoot = resolve(resolvedWorkspaceRoot, "providers", options.name);
		installCwd = resolvedWorkspaceRoot;
	} else {
		providerRoot = resolve(cwd, options.name);
		installCwd = providerRoot;
	}

	if (existsSync(providerRoot)) {
		throw new Error(`Target directory already exists: ${providerRoot}`);
	}

	if (options.sdkSpecifier?.startsWith("workspace:") && !resolvedWorkspaceRoot) {
		throw new Error(
			"workspace:* is only valid inside the APIFuse monorepo because public Provider SDK scaffolds must install from npm or an explicit tarball/file specifier.",
		);
	}

	const sdkSpecifier =
		options.sdkSpecifier ??
		(options.preset === "monorepo" && resolvedWorkspaceRoot
			? "workspace:*"
			: `^${packageJson.version}`);
	const relativeProviderRoot = relative(cwd, providerRoot) || options.name;
	const nextDevCommand = `cd ${relativeProviderRoot} && bun run dev`;
	const packageName =
		options.preset === "monorepo"
			? `@apifuse/provider-${options.name}`
			: `apifuse-provider-${options.name}`;
	const templateValues = {
		PROVIDER_ID: options.name,
		DISPLAY_NAME: escapeTemplate(options.displayName),
		CATEGORY: options.category,
		RUNTIME: options.runtime,
		BROWSER_BLOCK:
			options.runtime === "browser"
				? ',\n  browser: {\n    engine: "playwright-stealth",\n  }'
				: "",
		SECRETS_BLOCK: renderSecretsBlock(options.authMode),
		CREDENTIAL_BLOCK: renderCredentialBlock(options.authMode),
		AUTH_BLOCK: renderAuthBlock(options.authMode),
	};

	const files: ProviderPlanFile[] = [
		{
			path: resolve(providerRoot, ".dockerignore"),
			content: await renderTemplate(".dockerignore.tpl", {}),
		},
		{
			path: resolve(providerRoot, ".gitignore"),
			content: await renderTemplate(".gitignore.tpl", {}),
		},
		{
			path: resolve(providerRoot, "index.ts"),
			content: await renderTemplate("index.ts.tpl", templateValues),
		},
		{
			path: resolve(providerRoot, "meta.ts"),
			content: await renderTemplate("meta.ts.tpl", {
				PROVIDER_ID: options.name,
				DISPLAY_NAME: escapeTemplate(options.displayName),
				CATEGORY: options.category,
			}),
		},
		{
			path: resolve(providerRoot, "operations", "index.ts"),
			content: await renderTemplate("operations/index.ts.tpl", {}),
		},
		{
			path: resolve(providerRoot, "operations", "ping.ts"),
			content: await renderTemplate("operations/ping.ts.tpl", {
				DISPLAY_NAME: escapeTemplate(options.displayName),
				HANDLER_CTX: options.runtime === "browser" ? "ctx" : "_ctx",
				BROWSER_HANDLER_BLOCK:
					options.runtime === "browser"
						? '\n    const page = await ctx.browser.newPage();\n    await page.goto("https://example.com");\n    const title = await page.title();\n    const frames = await page.frames();\n    await page.close();\n'
						: "",
				BROWSER_RESPONSE_FIELDS:
					options.runtime === "browser"
						? ",\n      pageTitle: title,\n      frameCount: frames.length"
						: "",
			}),
		},
		{
			path: resolve(providerRoot, "schemas", "ping.ts"),
			content: await renderTemplate("schemas/ping.ts.tpl", {}),
		},
		{
			path: resolve(providerRoot, "upstream", "README.md"),
			content: await renderTemplate("upstream/README.md.tpl", {}),
		},
		{
			path: resolve(providerRoot, "mappers", "README.md"),
			content: await renderTemplate("mappers/README.md.tpl", {}),
		},
		{
			path: resolve(providerRoot, "domain", "README.md"),
			content: await renderTemplate("domain/README.md.tpl", {}),
		},
		{
			path: resolve(providerRoot, "locales", "en.json"),
			content: renderStarterLocaleCatalog(options.displayName, "en"),
		},
		{
			path: resolve(providerRoot, "locales", "ko.json"),
			content: renderStarterLocaleCatalog(options.displayName, "ko"),
		},
		{
			path: resolve(providerRoot, "package.json"),
			content: renderPackageJson({
				packageName,
				sdkSpecifier,
			}),
		},
		{
			path: resolve(providerRoot, "Dockerfile"),
			content: await renderTemplate("Dockerfile.tpl", {}),
		},
		{
			path: resolve(providerRoot, "dev.ts"),
			content: await renderTemplate("dev.ts.tpl", {}),
		},
		{
			path: resolve(providerRoot, "start.ts"),
			content: await renderTemplate("start.ts.tpl", {}),
		},
		{
			path: resolve(providerRoot, "tsconfig.json"),
			content: renderTsconfig(),
		},
		{
			path: resolve(providerRoot, "README.md"),
			content: await renderTemplate("README.md.tpl", {
				DISPLAY_NAME: escapeTemplate(options.displayName),
			}),
		},
		{
			path: resolve(providerRoot, "__fixtures__", "raw.json"),
			content: "{}\n",
		},
		{
			path: resolve(providerRoot, "__tests__", "index.test.ts"),
			content: await renderTemplate("index.test.ts.tpl", {
				PROVIDER_ID: options.name,
			}),
		},
	];

	const promptAssetEntries = await buildPromptAssetPlanEntries(renderTemplate);
	for (const entry of promptAssetEntries) {
		files.push({
			path: resolve(providerRoot, entry.path),
			content: entry.content,
			...(entry.kind === "symlink" ? { kind: "symlink" as const } : {}),
		});
	}
	// Manifest last: writePlan writes in order, so a crash mid-scaffold never
	// leaves a manifest that claims assets which were not written.
	files.push({
		path: resolve(providerRoot, PROMPT_ASSET_MANIFEST_PATH),
		content: buildPromptAssetManifest(promptAssetEntries, packageJson.version),
	});

	return {
		displayName: options.displayName,
		files,
		installCommand: "bun install",
		installCwd,
		name: options.name,
		nextDevCommand,
		outputDir: providerRoot,
		packageName,
		preset: options.preset,
		providerRoot,
		validationCommands: [
			"bun run check",
			"bun run type-check",
			"bun run submit-check -- --smoke",
			"bun run test",
		],
		workspaceRoot: resolvedWorkspaceRoot,
	};
}

async function renderTemplate(fileName: string, values: Record<string, string>): Promise<string> {
	const templatePath = resolve(TEMPLATE_DIR, fileName);
	const template = await readFile(templatePath, "utf8");
	return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => {
		return values[key] ?? "";
	});
}

function renderPackageJson(input: { packageName: string; sdkSpecifier: string }): string {
	return `${JSON.stringify(
		{
			name: input.packageName,
			version: "1.0.0",
			private: true,
			type: "module",
			main: "./index.ts",
			scripts: {
				dev: "apifuse dev .",
				check: "apifuse check . && bun run type-check",
				"type-check": "tsc --noEmit",
				"submit-check": "apifuse submit-check . --markdown submission-report.md",
				"sync-assets": "apifuse sync-assets .",
				test: "apifuse test .",
				record: "apifuse record .",
				start: "bun start.ts",
			},
			dependencies: {
				"@apifuse/provider-sdk": input.sdkSpecifier,
			},
			devDependencies: {
				"@types/bun": "latest",
				typescript: "^6.0.3",
			},
		},
		null,
		2,
	)}\n`;
}

function renderTsconfig(): string {
	return `${JSON.stringify(
		{
			compilerOptions: {
				target: "ES2022",
				module: "ES2022",
				moduleResolution: "bundler",
				strict: true,
				noEmit: true,
				skipLibCheck: true,
				resolveJsonModule: true,
				types: ["bun"],
			},
			include: ["**/*.ts"],
			exclude: ["node_modules"],
		},
		null,
		2,
	)}\n`;
}

function renderStarterLocaleCatalog(displayName: string, locale: "en" | "ko"): string {
	const catalog = {
		meta: {
			displayName,
			description:
				locale === "ko"
					? `${displayName} APIFuse 커뮤니티 기여용 provider starter입니다.`
					: `${displayName} provider starter for APIFuse community contributions.`,
		},
		operations: {
			ping: {
				description:
					locale === "ko"
						? "생성된 provider wiring이 APIFuse runtime contract를 통해 작은 샘플 payload를 정상적으로 round-trip하는지 확인합니다. 로컬 개발, baseline check, 첫 bounty scaffold 검증에 사용합니다. production data retrieval이나 upstream-specific workflow에는 사용하지 마세요. 이 starter operation은 생성된 프로젝트가 compile, serve, input/output round-trip을 수행하는지 증명하기 위한 용도입니다."
						: "Confirms the generated provider wiring is operational by echoing a small sample payload through the APIFuse runtime contract. Use when validating local development, baseline checks, or first-pass bounty scaffolds. Do NOT use for production data retrieval or upstream-specific workflows because this starter operation exists only to prove the generated project compiles, serves, and round-trips input/output correctly.",
			},
		},
		schemaDescriptions: {
			input: {
				root:
					locale === "ko"
						? "생성된 ping operation의 입력 payload"
						: "Input payload for the generated ping operation.",
				value:
					locale === "ko"
						? "생성된 provider scaffold wiring 검증에 사용하는 샘플 입력값"
						: "Sample input value used to verify the generated provider scaffold is wired correctly.",
			},
			output: {
				root:
					locale === "ko"
						? "생성된 ping operation이 반환하는 출력 payload"
						: "Output payload returned by the generated ping operation.",
				ok:
					locale === "ko"
						? "생성된 provider가 샘플 요청을 성공적으로 처리했는지 여부"
						: "Whether the generated provider handled the sample request successfully.",
				message:
					locale === "ko"
						? "생성된 provider가 샘플 payload를 round-trip했음을 보여주는 사람이 읽을 수 있는 확인 메시지"
						: "Human-readable confirmation that the generated provider round-tripped the sample payload.",
				pageTitle:
					locale === "ko"
						? "browser 런타임 provider일 때 로드된 페이지의 제목 (해당되지 않으면 생략)"
						: "Title of the loaded page when the provider uses the browser runtime; omitted otherwise.",
				frameCount:
					locale === "ko"
						? "browser 런타임 provider일 때 로드된 페이지의 frame 개수 (해당되지 않으면 생략)"
						: "Number of frames in the loaded page when the provider uses the browser runtime; omitted otherwise.",
			},
		},
	};
	return `${JSON.stringify(catalog, null, 2)}\n`;
}

function renderAuthBlock(authMode: CreateAuthMode): string {
	switch (authMode) {
		case "none":
			return '{ mode: "none" }';
		case "platform-managed":
			return '{ mode: "platform-managed" }';
		case "credentials":
			return `{
    mode: "credentials",
    flow: {
      start: async (_ctx) => ({
        kind: "form",
        turnId: crypto.randomUUID(),
        expectedInput: {
          schema: {
            type: "object",
            required: ["username", "password"],
            properties: {
              username: { type: "string", minLength: 1 },
              password: { type: "string", minLength: 1 },
            },
            additionalProperties: false,
          },
        },
        hint: "Replace the generated credential prompt with the real upstream login flow.",
      }),
      continue: async (_ctx, input = {}) => ({
        kind: "complete",
        turnId: crypto.randomUUID(),
        data: {
          credential: {
            username: String(input.username ?? ""),
            password: String(input.password ?? ""),
          },
        },
        hint: "Generated placeholder credential flow completed. Replace this with real auth logic.",
      }),
      refresh: async () => ({
        kind: "complete",
        turnId: crypto.randomUUID(),
        data: {
          credential: {
            username: "replace-with-refreshed-username",
            password: "replace-with-refreshed-password",
          },
        },
        hint: "Return refreshed credential data here, or throw AuthError with code AUTH_REQUIRED when silent refresh is not possible.",
      }),
    },
  }`;
		case "oauth2":
			return `{
    mode: "oauth2",
    flow: {
      start: async (_ctx) => ({
        kind: "redirect",
        turnId: crypto.randomUUID(),
        data: {
          authorizeUrl: "https://example.com/oauth/authorize",
        },
        hint: "Replace the generated OAuth authorize URL and token exchange flow.",
      }),
      continue: async () => ({
        kind: "complete",
        turnId: crypto.randomUUID(),
        data: {
          credential: {},
        },
        hint: "Generated placeholder OAuth flow completed. Replace this with the real token exchange logic.",
      }),
    },
  }`;
	}
}

function renderSecretsBlock(authMode: CreateAuthMode): string {
	switch (authMode) {
		case "platform-managed":
			return 'secrets: [{ name: "EXAMPLE_API_KEY", required: true }],\n  ';
		case "oauth2":
			return 'secrets: [{ name: "EXAMPLE_OAUTH_CLIENT_ID", required: true }, { name: "EXAMPLE_OAUTH_CLIENT_SECRET", required: true }],\n  ';
		default:
			return "";
	}
}

function renderCredentialBlock(authMode: CreateAuthMode): string {
	if (authMode !== "credentials") {
		return "";
	}

	return `credential: {
    keys: ["username", "password"],
    storesReusableSecret: true,
    justification:
      "The generated credential starter persists reusable login fields so contributors can replace the placeholder flow with a real upstream session exchange without rewriting the surrounding contract.",
  },
  `;
}

function validateProviderName(value: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new Error("Provider name is required.");
	}
	if (!PROVIDER_NAME_REGEX.test(normalized)) {
		throw new Error("Use kebab-case, e.g. my-provider.");
	}
	return normalized;
}

export function toDisplayName(name: string): string {
	return name
		.split("-")
		.filter(Boolean)
		.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
		.join(" ");
}

function findApifuseInternalWorkspaceRoot(cwd: string): string | undefined {
	let currentDirectory = cwd;

	while (true) {
		if (isApifuseInternalWorkspaceRoot(currentDirectory)) {
			return currentDirectory;
		}

		const parentDirectory = dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return undefined;
		}

		currentDirectory = parentDirectory;
	}
}

function isApifuseInternalWorkspaceRoot(workspaceRoot: string): boolean {
	const providerSdkPackageJsonPath = resolve(
		workspaceRoot,
		"packages",
		"provider-sdk",
		"package.json",
	);
	if (!existsSync(providerSdkPackageJsonPath)) {
		return false;
	}
	try {
		const packageJson = JSON.parse(readFileSync(providerSdkPackageJsonPath, "utf8"));
		return (
			typeof packageJson === "object" &&
			packageJson !== null &&
			"name" in packageJson &&
			packageJson.name === "@apifuse/provider-sdk"
		);
	} catch {
		return false;
	}
}

async function writePlan(plan: ProviderCreatePlan): Promise<void> {
	for (const file of plan.files) {
		await mkdir(dirname(file.path), { recursive: true });
		if (file.kind === "symlink") {
			// rm operates on the link itself (lstat semantics) and tolerates
			// directories, so whatever occupies the path is replaced by the link.
			await rm(file.path, { recursive: true, force: true });
			await symlink(file.content, file.path);
			continue;
		}
		await writeFile(file.path, file.content);
	}
}

async function installDependencies(plan: ProviderCreatePlan, jsonMode: boolean): Promise<void> {
	await runCommand(plan.installCommand, plan.installCwd, jsonMode);
}

async function runBaselineValidation(plan: ProviderCreatePlan, jsonMode: boolean): Promise<void> {
	for (const command of plan.validationCommands) {
		await runCommand(command, plan.providerRoot, jsonMode);
	}
}

async function runCommand(command: string, cwd: string, jsonMode: boolean): Promise<void> {
	const [binary, ...args] = command.split(" ");
	if (!binary) {
		throw new Error(`Cannot run empty command in ${cwd}`);
	}

	await new Promise<void>((resolvePromise, rejectPromise) => {
		const child = spawn(binary, args, {
			cwd,
			env: process.env,
			stdio: jsonMode ? "pipe" : "inherit",
			shell: false,
		});

		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", rejectPromise);
		child.on("close", (code) => {
			if (code === 0) {
				resolvePromise();
				return;
			}
			rejectPromise(
				new Error(
					`Command failed (${command}) in ${cwd}${
						stdout || stderr ? `\n${[stdout, stderr].filter(Boolean).join("\n")}` : ""
					}`,
				),
			);
		});
	});
}

function printResult(plan: ProviderCreatePlan, jsonMode: boolean, dryRun: boolean) {
	const payload = {
		success: true,
		dryRun,
		preset: plan.preset,
		provider: {
			name: plan.name,
			displayName: plan.displayName,
			packageName: plan.packageName,
			outputDir: plan.outputDir,
		},
		install: {
			cwd: plan.installCwd,
			command: plan.installCommand,
		},
		validationCommands: plan.validationCommands,
		nextDevCommand: plan.nextDevCommand,
		files: plan.files.map((file) => {
			const relativePath = relative(plan.providerRoot, file.path) || file.path;
			return file.kind === "symlink" ? `${relativePath} -> ${file.content} (symlink)` : relativePath;
		}),
	};

	if (jsonMode) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	outro(`${dryRun ? "Planned" : "Created"} ${plan.outputDir}`);
	console.log(`\nPreset: ${plan.preset}`);
	console.log(`Install: (cd ${plan.installCwd} && ${plan.installCommand})`);
	for (const command of plan.validationCommands) {
		console.log(`Validation: (cd ${plan.providerRoot} && ${command})`);
	}
	console.log(`Next local dev: ${plan.nextDevCommand}`);
	console.log(
		"Submission evidence: run `bun run submit-check -- --smoke` to archive measured `/health` and `POST /v1/{operation}` results.",
	);
	if (plan.files.some((file) => file.content.includes('runtime: "browser"'))) {
		console.log(
			"Browser runtime: run `bunx playwright install chromium` locally or set `APIFUSE__CDP_POOL__URL` before browser-backed smoke tests.",
		);
	}
}

function escapeTemplate(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
