function getDateParts(date: Date, timezone: string) {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});

	const parts = Object.fromEntries(
		formatter.formatToParts(date).map((part) => [part.type, part.value]),
	) as Record<string, string>;

	return {
		year: parts.year,
		month: parts.month,
		day: parts.day,
		hour: parts.hour,
		minute: parts.minute,
		second: parts.second,
	};
}

function getTimezoneOffsetMinutes(date: Date, timezone: string): number {
	const parts = getDateParts(date, timezone);
	const asUTC = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour),
		Number(parts.minute),
		Number(parts.second),
	);

	return (asUTC - date.getTime()) / 60000;
}

function buildUtcInstantFromLocalParts(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	timezone: string,
): Date {
	const guess = Date.UTC(year, month - 1, day, hour, minute, second);
	let utc = guess;

	for (let i = 0; i < 2; i += 1) {
		const offset = getTimezoneOffsetMinutes(new Date(utc), timezone);
		const nextUtc = guess - offset * 60_000;
		if (nextUtc === utc) {
			break;
		}
		utc = nextUtc;
	}

	return new Date(utc);
}

function formatOffset(offsetMinutes: number): string {
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const abs = Math.abs(offsetMinutes);
	const hours = String(Math.floor(abs / 60)).padStart(2, "0");
	const minutes = String(abs % 60).padStart(2, "0");
	return `${sign}${hours}:${minutes}`;
}

function formatIso(date: Date, timezone: string): string {
	const parts = getDateParts(date, timezone);
	const offset = getTimezoneOffsetMinutes(date, timezone);
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${formatOffset(offset)}`;
}

function parseDateValue(v: unknown, timezone: string): Date | null {
	if (v instanceof Date) {
		return Number.isNaN(v.getTime()) ? null : v;
	}

	if (typeof v === "number") {
		const date = new Date(v);
		return Number.isNaN(date.getTime()) ? null : date;
	}

	if (typeof v !== "string") {
		return null;
	}

	const value = v.trim();
	if (value === "") {
		return null;
	}

	const compactDate = /^(\d{4})(\d{2})(\d{2})$/;
	const compactDateTime = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/;
	const dashedDate = /^(\d{4})-(\d{2})-(\d{2})$/;

	let match = value.match(compactDateTime);
	if (match) {
		const [, year, month, day, hour, minute, second = "00"] = match;
		return buildUtcInstantFromLocalParts(
			Number(year),
			Number(month),
			Number(day),
			Number(hour),
			Number(minute),
			Number(second),
			timezone,
		);
	}

	match = value.match(compactDate);
	if (match) {
		const [, year, month, day] = match;
		return buildUtcInstantFromLocalParts(
			Number(year),
			Number(month),
			Number(day),
			0,
			0,
			0,
			timezone,
		);
	}

	match = value.match(dashedDate);
	if (match) {
		const [, year, month, day] = match;
		return buildUtcInstantFromLocalParts(
			Number(year),
			Number(month),
			Number(day),
			0,
			0,
			0,
			timezone,
		);
	}

	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Convert various date formats to ISO 8601 string */
export function toISODate(v: unknown, timezone: string): string {
	const date = parseDateValue(v, timezone);
	return date ? formatIso(date, timezone) : "";
}

/** Get today's date as ISO 8601 string in given timezone */
export function today(timezone: string): string {
	const parts = getDateParts(new Date(), timezone);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Get current hour as string in given timezone */
export function currentHour(timezone: string): string {
	return getDateParts(new Date(), timezone).hour;
}
