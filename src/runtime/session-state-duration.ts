/** Session-state durations share the grammar of `ProviderStateDurationString`. */

const SHORT_DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const ISO_DURATION = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/;
const UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/** Parses `"20m"` or `"PT20M"` to milliseconds; undefined when it is not a positive duration. */
export function parseSessionStateDurationMs(value: string): number | undefined {
	const short = SHORT_DURATION.exec(value);
	let ms: number | undefined;
	if (short) {
		ms = Number(short[1]) * (UNIT_MS[short[2] as string] as number);
	} else {
		const iso = ISO_DURATION.exec(value);
		if (iso && (iso[1] !== undefined || iso[2] !== undefined || iso[3] !== undefined)) {
			ms =
				Number(iso[1] ?? 0) * 3_600_000 +
				Number(iso[2] ?? 0) * 60_000 +
				Number(iso[3] ?? 0) * 1_000;
		}
	}
	return ms !== undefined && Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : undefined;
}
