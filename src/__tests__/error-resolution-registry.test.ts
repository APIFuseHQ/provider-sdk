import { describe, expect, it } from "bun:test";

import {
	SDK_CANONICAL_ERROR_CODE_RETRYABILITY,
	SDK_RUNTIME_OWNED_ERROR_CODES,
	SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES,
} from "../error-resolution.js";

const FLEET_CONSENSUS_CODES = [
	"UPSTREAM_AUTH_ERROR",
	"UPSTREAM_SCHEMA_ERROR",
	"INVALID_REQUEST",
] as const;

describe("fleet-consensus error code registration", () => {
	it("maps each consensus code to its canonical status", () => {
		expect(SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.get("UPSTREAM_AUTH_ERROR")).toBe(400);
		expect(SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.get("UPSTREAM_SCHEMA_ERROR")).toBe(502);
		expect(SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.get("INVALID_REQUEST")).toBe(400);
	});

	it("keeps the consensus codes out of the runtime-owned set", () => {
		// Load-bearing. These codes are thrown by provider code, so an existing
		// operation declaration must keep winning in toStatusCode; moving them
		// into the runtime-owned set would silently rewrite the status of every
		// provider that already declares one, and would also silence the
		// authoring lint that reports the divergence.
		for (const code of FLEET_CONSENSUS_CODES) {
			expect(SDK_RUNTIME_OWNED_ERROR_CODES.has(code)).toBe(false);
		}
	});

	it("does not register the minority spellings", () => {
		// They converge on the consensus spelling via the contract track;
		// registering them here would freeze the divergence instead.
		for (const code of ["UPSTREAM_SCHEMA_CHANGED", "INVALID_INPUT", "VALIDATION_ERROR"]) {
			expect(SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.has(code)).toBe(false);
		}
	});

	it("declares retryability only for codes the status map registers", () => {
		// A stale retryability entry would make the authoring lint contradict a
		// declaration for a code the SDK does not actually resolve.
		for (const code of SDK_CANONICAL_ERROR_CODE_RETRYABILITY.keys()) {
			expect(SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.has(code)).toBe(true);
		}
	});

	it("declares every consensus code non-retryable", () => {
		for (const code of FLEET_CONSENSUS_CODES) {
			expect(SDK_CANONICAL_ERROR_CODE_RETRYABILITY.get(code)).toBe(false);
		}
	});
});
