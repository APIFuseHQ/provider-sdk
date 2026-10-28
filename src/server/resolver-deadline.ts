/** Declared operation timeout from `nowMs`, tightened to the hub's envelope deadline when present. */
export function resolveResolverDeadlineAtMs(
	nowMs: number,
	operationTimeoutMs: number | undefined,
	envelopeDeadlineAtMs: number | undefined,
): number | undefined {
	const declared =
		operationTimeoutMs !== undefined && operationTimeoutMs > 0
			? nowMs + operationTimeoutMs
			: undefined;
	if (declared === undefined) return envelopeDeadlineAtMs;
	if (envelopeDeadlineAtMs === undefined) return declared;
	return Math.min(declared, envelopeDeadlineAtMs);
}
