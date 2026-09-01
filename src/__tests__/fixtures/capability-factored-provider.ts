import { defineProvider, type ProviderDeclaration } from "../../define.js";
import type { ProviderContext } from "../../types.js";
import { factoredOperation } from "./capability-factored-operation.js";

export const declaration = {
	id: "capability-factored",
	version: "1.0.0",
	runtime: "standard",
	http: {},
	meta: {
		displayName: "Capability Factored",
		descriptionKey: "capability-factored.description",
		category: "test",
	},
} as const satisfies ProviderDeclaration;

export type Ctx = ProviderContext<typeof declaration>;

const buildProvider = defineProvider(declaration);
export default buildProvider({ operations: { factored: factoredOperation } });
