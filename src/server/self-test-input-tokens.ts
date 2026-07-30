/**
 * Relative date-token resolution for health-check case inputs and fixture
 * requests. The calendar defaults to KST; callers that need UTC must opt in
 * explicitly so UTC and KST do not silently disagree from 15:00–23:59 UTC.
 *
 * Supported token: `+<days>d` or `+<days>d:YYYYMMDD` (1..365 days ahead).
 */
const RELATIVE_DATE_TOKEN = /^\+(\d{1,3})d(?::(YYYYMMDD))?$/i;

export type InputDateTokenCalendar = "KST" | "UTC";

function dateFromDaysAhead(
	daysAhead: number,
	now = new Date(),
	format: "YYYY-MM-DD" | "YYYYMMDD" = "YYYY-MM-DD",
	calendar: InputDateTokenCalendar = "KST",
): string {
	const calendarNow = new Date(now.getTime() + (calendar === "KST" ? 9 * 60 * 60 * 1000 : 0));
	const date = new Date(
		Date.UTC(
			calendarNow.getUTCFullYear(),
			calendarNow.getUTCMonth(),
			calendarNow.getUTCDate() + daysAhead,
		),
	);
	const isoDate = date.toISOString().slice(0, 10);
	return format === "YYYYMMDD" ? isoDate.replace(/-/g, "") : isoDate;
}

export function resolveHealthCheckInputDateTokens(
	value: unknown,
	now = new Date(),
	calendar: InputDateTokenCalendar = "KST",
): unknown {
	if (typeof value === "string") {
		const relative = value.match(RELATIVE_DATE_TOKEN);
		if (!relative) return value;
		const daysAhead = Number(relative[1]);
		if (!Number.isInteger(daysAhead) || daysAhead < 1 || daysAhead > 365) {
			return value;
		}
		const format = relative[2]?.toUpperCase() === "YYYYMMDD" ? "YYYYMMDD" : "YYYY-MM-DD";
		return dateFromDaysAhead(daysAhead, now, format, calendar);
	}
	if (Array.isArray(value)) {
		const resolved = value.map((entry) => resolveHealthCheckInputDateTokens(entry, now, calendar));
		return resolved.some((entry, index) => entry !== value[index]) ? resolved : value;
	}
	if (value && typeof value === "object") {
		const resolved = Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				resolveHealthCheckInputDateTokens(entry, now, calendar),
			]),
		);
		return Object.entries(resolved).some(([key, entry]) => entry !== Reflect.get(value, key))
			? resolved
			: value;
	}
	return value;
}
