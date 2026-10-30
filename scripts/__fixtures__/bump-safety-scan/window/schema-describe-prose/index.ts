import {
	defineOperation,
	defineProvider,
	type ProviderContextOf,
	z,
} from "@apifuse/provider-sdk/provider";

// bump-safety-scan window fixture: trips the "schema-describe-prose" window rule under the base SDK.
const buildProvider = defineProvider({
	id: "bump-scan-window-schema-describe-prose",
	version: "1.0.0",
	runtime: "standard",
	allowedHosts: ["api.example.com"],
	reviewed: "community",
	meta: {
		displayName: "bump-scan-window-schema-describe-prose",
		displayNameKey: "meta.displayName",
		descriptionKey: "meta.description",
		category: "data",
	},
});

type ProviderContext = ProviderContextOf<typeof buildProvider>;

export default buildProvider({
	operations: {
		ping: defineOperation<ProviderContext>()({
			connectionMode: "none",
			riskClass: "read",
			descriptionKey: "operations.ping.description",
			input: z.object({ value: z.string() }),
			output: z.object({ ok: z.boolean().describe("whether the ping succeeded") }),
			handler: async () => ({ ok: true }),
			fixtures: { request: { value: "hello" }, response: { ok: true } },
			healthCheckUnsupported: {
				reason: "bump-safety-scan window fixture; nothing upstream to probe.",
			},
		}),
	},
});
