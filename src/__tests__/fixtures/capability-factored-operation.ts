import { defineOperation } from "../../define.js";
import type { HttpClient } from "../../types.js";
import type { Ctx } from "./capability-factored-provider.js";

async function fetchLabel(http: HttpClient): Promise<string> {
	const response = await http.get("https://example.test/label");
	return (await response.json<{ label: string }>()).label;
}

export const factoredOperation = defineOperation<Ctx>()({
	riskClass: "read",
	input: {
		"~standard": {
			version: 1,
			vendor: "fixture",
			validate: (value: unknown) => ({ value: value as { id: string } }),
		},
	},
	output: {
		"~standard": {
			version: 1,
			vendor: "fixture",
			validate: (value: unknown) => ({ value: value as { label: string } }),
		},
	},
	async handler(ctx) {
		return { label: await fetchLabel(ctx.http) };
	},
	healthCheckUnsupported: { reason: "type fixture" },
});
