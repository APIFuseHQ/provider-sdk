import { describe, expect, it } from "bun:test";

import { resolveResolverDeadlineAtMs } from "../server/resolver-deadline.js";

const NOW = 1_700_000_000_000;

describe("resolveResolverDeadlineAtMs", () => {
	it("uses the declared operation timeout when no envelope deadline is present", () => {
		expect(resolveResolverDeadlineAtMs(NOW, 60_000, undefined)).toBe(NOW + 60_000);
	});

	it("tightens the declared deadline to an earlier envelope deadline", () => {
		expect(resolveResolverDeadlineAtMs(NOW, 60_000, NOW + 20_000)).toBe(NOW + 20_000);
	});

	it("keeps the declared deadline when the envelope deadline is later", () => {
		expect(resolveResolverDeadlineAtMs(NOW, 30_000, NOW + 90_000)).toBe(NOW + 30_000);
	});

	it("falls back to the envelope deadline when the operation declares no usable timeout", () => {
		expect(resolveResolverDeadlineAtMs(NOW, undefined, NOW + 20_000)).toBe(NOW + 20_000);
		expect(resolveResolverDeadlineAtMs(NOW, 0, NOW + 20_000)).toBe(NOW + 20_000);
	});

	it("yields no deadline when neither source is present", () => {
		expect(resolveResolverDeadlineAtMs(NOW, undefined, undefined)).toBeUndefined();
	});
});
