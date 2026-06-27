export type ApifuseCommandName =
	| "create"
	| "dev"
	| "check"
	| "submit-check"
	| "bounty-check"
	| "record"
	| "test"
	| "perf";

export type ApifuseCommandManifest = {
	name: ApifuseCommandName;
	summary: string;
	usage: string;
	examples: string[];
	modulePath: string;
};

export const COMMAND_MANIFEST: Record<
	ApifuseCommandName,
	ApifuseCommandManifest
> = {
	create: {
		name: "create",
		summary:
			"Scaffold a provider, install dependencies, run baseline validation, and print the next local-dev command.",
		usage: "apifuse create <provider-name> [--json] [--dry-run]",
		examples: [
			"apifuse create weather-provider",
			"apifuse create --config ./apifuse.create.json --json",
		],
		modulePath: "./apifuse-create",
	},
	dev: {
		name: "dev",
		summary:
			"Start the local provider dev server with the standard provider server contract.",
		usage: "apifuse dev [path]",
		examples: ["apifuse dev .", "apifuse dev providers/korea-air-quality"],
		modulePath: "./apifuse-dev",
	},
	check: {
		name: "check",
		summary: "Validate provider structure, metadata, fixtures, and schemas.",
		usage: "apifuse check [path]",
		examples: ["apifuse check .", "apifuse check providers/korea-air-quality"],
		modulePath: "./apifuse-check",
	},
	"submit-check": {
		name: "submit-check",
		summary:
			"Score provider bounty submission readiness and emit checklist evidence.",
		usage:
			"apifuse submit-check [path] [--tier bronze|silver|gold|diamond] [--json] [--markdown <path>] [--smoke-note <text>]",
		examples: [
			"apifuse submit-check .",
			"apifuse submit-check . --tier silver --markdown submission-report.md",
		],
		modulePath: "./apifuse-submit-check",
	},
	"bounty-check": {
		name: "bounty-check",
		summary: "Alias for submit-check.",
		usage:
			"apifuse bounty-check [path] [--tier bronze|silver|gold|diamond] [--json] [--markdown <path>] [--smoke-note <text>]",
		examples: ["apifuse bounty-check . --markdown submission-report.md"],
		modulePath: "./apifuse-submit-check",
	},
	record: {
		name: "record",
		summary: "Call a provider operation and capture upstream raw fixture data.",
		usage:
			'apifuse record [path] --operation <operation> --params \'{"value":"hello"}\'',
		examples: [
			'apifuse record providers/korea-air-quality --operation realtime --params \'{"stationName":"종로구"}\'',
		],
		modulePath: "./apifuse-record",
	},
	test: {
		name: "test",
		summary: "Run provider-focused tests and surface actionable failures.",
		usage: "apifuse test [path] [--json] [--verbose]",
		examples: [
			"apifuse test .",
			"apifuse test providers/korea-air-quality --json",
		],
		modulePath: "./apifuse-test",
	},
	perf: {
		name: "perf",
		summary:
			"Profile a provider operation and export latency/trace diagnostics.",
		usage:
			"apifuse perf <path> --operation <operation> [--params '<json>'] [options]",
		examples: [
			'apifuse perf providers/korea-air-quality --operation realtime --params \'{"stationName":"종로구"}\' --runs 5',
		],
		modulePath: "./apifuse-perf",
	},
};

export const COMMAND_ORDER: ApifuseCommandName[] = [
	"create",
	"dev",
	"check",
	"submit-check",
	"record",
	"test",
	"perf",
];
