import { defineProvider, type ProviderContextOf } from "../../define.js";
import { factoredOperation } from "./capability-factored-operation.js";

const buildProvider = defineProvider({
	id: "capability-factored",
	version: "1.0.0",
	runtime: "standard",
	http: true,
	meta: {
		displayName: "Capability Factored",
		descriptionKey: "capability-factored.description",
		category: "test",
	},
});

export type ProviderContext = ProviderContextOf<typeof buildProvider>;

export default buildProvider({ operations: { factored: factoredOperation } });
