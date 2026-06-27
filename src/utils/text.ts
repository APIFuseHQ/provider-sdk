/** Remove HTML tags from string */
export function stripHtml(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Truncate string to maxLength with optional suffix */
export function truncate(
	str: string,
	maxLength: number,
	suffix = "...",
): string {
	if (str.length <= maxLength) {
		return str;
	}

	return `${str.slice(0, maxLength)}${suffix}`;
}
