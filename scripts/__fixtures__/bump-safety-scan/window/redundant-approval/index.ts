import {
	defineOperation,
	defineProvider,
	type ProviderContextOf,
	z,
} from "@apifuse/provider-sdk/provider";

// bump-safety-scan window fixture: trips the "redundant-approval" window rule under the base SDK.
const buildProvider = defineProvider({
	id: "bump-scan-window-redundant-approval",
	version: "1.0.0",
	runtime: "standard",
	allowedHosts: ["api.example.com"],
	reviewed: "community",
	meta: {
		displayName: "bump-scan-window-redundant-approval",
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
			approval: "never",
			descriptionKey: "operations.ping.description",
			input: z.object({ value: z.string() }),
			output: z.object({ ok: z.boolean() }),
			handler: async () => ({ ok: true }),
			fixtures: { request: { value: "hello" }, response: { ok: true } },
			healthCheckUnsupported: {
				reason: "bump-safety-scan window fixture; nothing upstream to probe.",
			},
		}),
	},
});
