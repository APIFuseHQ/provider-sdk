import {
	defineCursor,
	defineOperation,
	defineProvider,
	type ProviderContextOf,
	z,
} from "@apifuse/provider-sdk/provider";

const PageCursor = defineCursor({
	name: "page",
	schema: z.object({ offset: z.number() }),
	ttl: "10m",
	fieldName: "page_token",
});

// bump-safety-scan window fixture: trips the "legacy-handle-declaration" window rule under the base SDK.
const buildProvider = defineProvider({
	id: "bump-scan-window-legacy-handle-declaration",
	version: "1.0.0",
	runtime: "standard",
	allowedHosts: ["api.example.com"],
	reviewed: "community",
	meta: {
		displayName: "bump-scan-window-legacy-handle-declaration",
		displayNameKey: "meta.displayName",
		descriptionKey: "meta.description",
		category: "data",
	},
	state: true,
	handle: [PageCursor],
});

type ProviderContext = ProviderContextOf<typeof buildProvider>;

export default buildProvider({
	operations: {
		ping: defineOperation<ProviderContext>()({
			connectionMode: "none",
			riskClass: "read",
			descriptionKey: "operations.ping.description",
			input: z.object({ value: z.string() }),
			output: z.object({ ok: z.boolean(), page_token: PageCursor.field() }),
			handler: async () => ({ ok: true, page_token: "next" }),
			fixtures: { request: { value: "hello" }, response: { ok: true, page_token: "next" } },
			healthCheckUnsupported: {
				reason: "bump-safety-scan window fixture; nothing upstream to probe.",
			},
		}),
		next: defineOperation<ProviderContext>()({
			connectionMode: "none",
			riskClass: "read",
			descriptionKey: "operations.next.description",
			input: z.object({ page_token: PageCursor.field() }),
			output: z.object({ ok: z.boolean() }),
			handler: async () => ({ ok: true }),
			fixtures: { request: { page_token: "next" }, response: { ok: true } },
			healthCheckUnsupported: {
				reason: "bump-safety-scan window fixture; nothing upstream to probe.",
			},
		}),
	},
});
