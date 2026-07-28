const MIN_RECORDED_DELIMITED_TEXT_LENGTH = 200;
const MIN_RECORDED_DELIMITED_TEXT_LINES = 3;
const MAX_SAMPLED_DELIMITED_TEXT_LINES = 10;
const DELIMITER_CANDIDATES = [",", "\t", ";"] as const;

// Recognizes a recorded operation value that is a substantive tabular text
// payload. The length floor and repeated, quote-aware field structure keep
// short strings and prose from being treated as fixture provenance.
export function hasSubstantiveDelimitedTextStructure(value: string): boolean {
	if (value.length < MIN_RECORDED_DELIMITED_TEXT_LENGTH) {
		return false;
	}

	const lines = value
		.replace(/^\uFEFF/, "")
		.split(/\r\n?|\n/)
		.filter((line) => line.trim().length > 0);
	if (lines.length < MIN_RECORDED_DELIMITED_TEXT_LINES) {
		return false;
	}

	const sampledLines = lines.slice(0, MAX_SAMPLED_DELIMITED_TEXT_LINES);
	return DELIMITER_CANDIDATES.some((delimiter) => {
		const fieldCounts = sampledLines.map((line) => countDelimitedFields(line, delimiter));
		const expectedFieldCount = fieldCounts[0];
		return (
			expectedFieldCount !== undefined &&
			expectedFieldCount >= 2 &&
			fieldCounts.every((fieldCount) => fieldCount === expectedFieldCount)
		);
	});
}

function countDelimitedFields(line: string, delimiter: string): number | undefined {
	let fieldCount = 1;
	let insideQuotes = false;
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index];
		if (character === '"') {
			if (insideQuotes && line[index + 1] === '"') {
				index += 1;
			} else {
				insideQuotes = !insideQuotes;
			}
		} else if (!insideQuotes && character === delimiter) {
			fieldCount += 1;
		}
	}
	return insideQuotes ? undefined : fieldCount;
}
