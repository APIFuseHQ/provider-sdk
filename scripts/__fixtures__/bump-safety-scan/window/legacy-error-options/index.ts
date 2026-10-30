import {
	defineOperation,
	defineProvider,
	type ProviderContextOf,
	ProviderError,
	z,
} from "@apifuse/provider-sdk/provider";

// bump-safety-scan window fixture: trips the "legacy-error-options" window rule under the base SDK.
const buildProvider = defineProvider({
	id: "bump-scan-window-legacy-error-options",
	version: "1.0.0",
	runtime: "standard",
	allowedHosts: ["api.example.com"],
	reviewed: "community",
	meta: {
		displayName: "bump-scan-window-legacy-error-options",
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
			handler: async (_ctx, input) => {
				if (input.value === "boom") {
					throw new ProviderError("upstream refused", {
						code: "UPSTREAM_REFUSED",
						retryable: false,
					});
				}
				return { ok: true };
			},
			fixtures: { request: { value: "hello" }, response: { ok: true } },
			healthCheckUnsupported: {
				reason: "bump-safety-scan window fixture; nothing upstream to probe.",
			},
		}),
	},
});
