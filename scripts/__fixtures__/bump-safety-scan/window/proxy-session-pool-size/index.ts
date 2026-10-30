import {
	defineOperation,
	defineProvider,
	type ProviderContextOf,
	z,
} from "@apifuse/provider-sdk/provider";

// bump-safety-scan window fixture: trips the "proxy-session-pool-size" window rule under the base SDK.
const buildProvider = defineProvider({
	id: "bump-scan-window-proxy-session-pool-size",
	version: "1.0.0",
	runtime: "standard",
	allowedHosts: ["api.example.com"],
	reviewed: "community",
	meta: {
		displayName: "bump-scan-window-proxy-session-pool-size",
		displayNameKey: "meta.displayName",
		descriptionKey: "meta.description",
		category: "data",
	},
	proxy: {
		mode: "required",
		providers: ["smartproxy", "nodemaven"],
		session: { affinity: "connection", lifetimeMinutes: 120, poolSize: 6 },
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
			healthCheckUnsupported: {
				reason: "bump-safety-scan window fixture; nothing upstream to probe.",
			},
		}),
	},
});
