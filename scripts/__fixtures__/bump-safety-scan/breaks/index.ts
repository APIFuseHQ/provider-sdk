import {
	defineOperation,
	defineProvider,
	type ProviderContextOf,
	z,
} from "@apifuse/provider-sdk/provider";

const buildProvider = defineProvider({
	id: "bump-scan-breaks",
	version: "1.0.0",
	runtime: "standard",
	allowedHosts: ["api.example.com"],
	reviewed: "community",
	meta: {
		displayName: "bump-scan-breaks",
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
			output: z.object({ ok: z.boolean() }),
			handler: async () => ({ ok: true }),
			fixtures: { request: { value: "hello" }, response: { ok: true } },
			healthCheckUnsupported: { reason: "bump-safety-scan fixture; nothing upstream to probe." },
		}),
	},
});
