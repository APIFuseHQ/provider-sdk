/**
 * Relative-KST date token resolution for health-check case inputs, ported from
 * the monorepo health-monitor (`apps/health-monitor/src/lib/health-check-input.ts`)
 * so provider self-tests resolve durable probe inputs identically.
 *
 * Supported token: `+<days>d` or `+<days>d:YYYYMMDD` (1..365 days ahead, KST).
 */
const RELATIVE_KST_DATE_TOKEN = /^\+(\d{1,3})d(?::(YYYYMMDD))?$/i;

function dateFromKstDaysAhead(
	daysAhead: number,
	now = new Date(),
	format: "YYYY-MM-DD" | "YYYYMMDD" = "YYYY-MM-DD",
): string {
	const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
	const date = new Date(
		Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate() + daysAhead),
	);
	const isoDate = date.toISOString().slice(0, 10);
	return format === "YYYYMMDD" ? isoDate.replace(/-/g, "") : isoDate;
}

export function resolveHealthCheckInputDateTokens(value: unknown, now = new Date()): unknown {
	if (typeof value === "string") {
		const relative = value.match(RELATIVE_KST_DATE_TOKEN);
		if (!relative) return value;
		const daysAhead = Number(relative[1]);
		if (!Number.isInteger(daysAhead) || daysAhead < 1 || daysAhead > 365) {
			return value;
		}
		const format = relative[2]?.toUpperCase() === "YYYYMMDD" ? "YYYYMMDD" : "YYYY-MM-DD";
		return dateFromKstDaysAhead(daysAhead, now, format);
	}
	if (Array.isArray(value)) {
		return value.map((entry) => resolveHealthCheckInputDateTokens(entry, now));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				resolveHealthCheckInputDateTokens(entry, now),
			]),
		);
	}
	return value;
}
