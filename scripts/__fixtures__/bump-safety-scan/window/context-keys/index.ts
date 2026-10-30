import {
	defineOperation,
	defineProvider,
	type ProviderContextOf,
	z,
} from "@apifuse/provider-sdk/provider";

// bump-safety-scan window fixture: trips the "context-keys" window rule under the base SDK.
const buildProvider = defineProvider({
	id: "bump-scan-window-context-keys",
	version: "1.0.0",
	runtime: "standard",
	allowedHosts: ["api.example.com"],
	reviewed: "community",
	meta: {
		displayName: "bump-scan-window-context-keys",
		displayNameKey: "meta.displayName",
		descriptionKey: "meta.description",
		category: "data",
	},
	auth: {
		mode: "credentials",
		flow: {
			start: async (ctx) => {
				const state = ctx.context.get("state");
				return { kind: "input", turnId: typeof state === "string" ? state : "1" };
			},
			continue: async () => ({ kind: "complete", turnId: "2" }),
		},
	},
	credential: { keys: ["account_id"] },
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
