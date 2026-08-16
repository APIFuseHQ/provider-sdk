import type { createStealthClient } from "../../runtime/stealth.js";

export type StealthCreateArgs = Parameters<typeof createStealthClient>;

export type CapabilityImportGuardState = {
	heavyLoads: string[];
	stealthCreateArgs: StealthCreateArgs[];
	stealthLoads: number;
};
