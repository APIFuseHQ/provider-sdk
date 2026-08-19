import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
	CHOICE_WORD_ENTROPY_BITS,
	CHOICE_WORDLIST_SIZE,
	choiceWordAt,
	EFF_SHORT_WORDLIST_2,
	HIGH_CHOICE_ENTROPY_BITS,
	STANDARD_CHOICE_ENTROPY_BITS,
} from "./choice-wordlist.js";

describe("EFF Short Wordlist #2", () => {
	it("embeds the official 1,296 entries unchanged", () => {
		const sourceDigest = createHash("sha256")
			.update(`${EFF_SHORT_WORDLIST_2.join("\n")}\n`)
			.digest("hex");

		expect(EFF_SHORT_WORDLIST_2).toHaveLength(CHOICE_WORDLIST_SIZE);
		expect(sourceDigest).toBe("7aa57a4d3ecf6581729992bad9575bacdebf7c28378af2aec6a50f11aec326f5");
		expect(choiceWordAt(0)).toBe("aardvark");
		expect(choiceWordAt(CHOICE_WORDLIST_SIZE - 1)).toBe("zucchini");
	});

	it("pins charset, length, uniqueness, and unique three-character prefixes", () => {
		const officialNonLetterEntries = EFF_SHORT_WORDLIST_2.filter((word) => !/^[a-z]+$/.test(word));
		const uniqueWords = new Set(EFF_SHORT_WORDLIST_2);
		const uniquePrefixes = new Set(EFF_SHORT_WORDLIST_2.map((word) => word.slice(0, 3)));

		// The unchanged official artifact has exactly one internal-hyphen entry.
		expect(officialNonLetterEntries).toEqual(["yo-yo"]);
		expect(EFF_SHORT_WORDLIST_2.every((word) => /^[a-z-]+$/.test(word))).toBe(true);
		expect(EFF_SHORT_WORDLIST_2.every((word) => word.length >= 3 && word.length <= 10)).toBe(true);
		expect(uniqueWords.size).toBe(CHOICE_WORDLIST_SIZE);
		expect(uniquePrefixes.size).toBe(CHOICE_WORDLIST_SIZE);
	});

	it("exports the standard and high-strength entropy constants", () => {
		expect(CHOICE_WORD_ENTROPY_BITS).toBeCloseTo(10.33985, 5);
		expect(STANDARD_CHOICE_ENTROPY_BITS).toBeCloseTo(41.3594, 4);
		expect(HIGH_CHOICE_ENTROPY_BITS).toBeCloseTo(51.69925, 4);
	});
});
