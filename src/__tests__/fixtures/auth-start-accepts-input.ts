import { defineOperation, defineProvider, z } from "../../provider";

const noop = defineOperation({
	descriptionKey: "operations.noop.description",
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	handler: async () => ({ ok: true }),
});

defineProvider({
	id: "bad-auth-start",
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Bad Auth Start",
		descriptionKey: "providers.badAuthStart.description",
		category: "test",
	},
	auth: {
		mode: "credentials",
		flow: {
			start: async (_ctx, input?: Record<string, unknown>) => ({
				kind: "form",
				turnId: String(input?.turnId ?? "start"),
			}),
			continue: async () => ({ kind: "complete", turnId: "complete" }),
		},
	},
	operations: { noop },
});
