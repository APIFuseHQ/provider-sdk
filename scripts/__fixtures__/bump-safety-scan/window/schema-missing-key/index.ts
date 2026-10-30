import {
	defineOperation,
	defineProvider,
	describeKey,
	type ProviderContextOf,
	z,
} from "@apifuse/provider-sdk/provider";

// bump-safety-scan window fixture: every public schema node carries a locale key except output.ok, which has no description at all, so only the "(no description)" tag fires.
const buildProvider = defineProvider({
	id: "bump-scan-window-schema-missing-key",
	version: "1.0.0",
	runtime: "standard",
	allowedHosts: ["api.example.com"],
	reviewed: "community",
	meta: {
		displayName: "bump-scan-window-schema-missing-key",
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
			input: describeKey(
				z.object({ value: describeKey(z.string(), "fields.value") }),
				"operations.ping.input",
			),
			output: describeKey(z.object({ ok: z.boolean() }), "operations.ping.output"),
			handler: async () => ({ ok: true }),
			fixtures: { request: { value: "hello" }, response: { ok: true } },
			healthCheckUnsupported: {
				reason: "bump-safety-scan window fixture; nothing upstream to probe.",
			},
		}),
	},
});
