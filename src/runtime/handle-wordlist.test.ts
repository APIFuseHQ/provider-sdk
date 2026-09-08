import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	BOUND_HANDLE_WORD_COUNT,
	EFF_SHORT_WORDLIST_2,
	findHandleWordWithinDistance,
	HANDLE_WORD_ENTROPY_BITS,
	HANDLE_WORDLIST_SIZE,
	HIGH_PUBLIC_HANDLE_ENTROPY_BITS,
	HIGH_PUBLIC_HANDLE_WORD_COUNT,
	handleWordAt,
	ISSUABLE_HANDLE_WORDS,
	isHandleWord,
	PUBLIC_HANDLE_ENTROPY_BITS,
	PUBLIC_HANDLE_WORD_COUNT,
} from "./handle-wordlist.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

function singleEditVariants(word: string): string[] {
	const variants = new Set<string>();
	for (let position = 0; position < word.length; position += 1) {
		variants.add(word.slice(0, position) + word.slice(position + 1));
		for (const letter of ALPHABET) {
			variants.add(word.slice(0, position) + letter + word.slice(position + 1));
		}
	}
	for (let position = 0; position <= word.length; position += 1) {
		for (const letter of ALPHABET) {
			variants.add(word.slice(0, position) + letter + word.slice(position));
		}
	}
	variants.delete(word);
	return Array.from(variants);
}

describe("EFF Short Wordlist #2", () => {
	it("embeds the official 1,296 entries unchanged", () => {
		const sourceDigest = createHash("sha256")
			.update(`${EFF_SHORT_WORDLIST_2.join("\n")}\n`)
			.digest("hex");

		expect(EFF_SHORT_WORDLIST_2).toHaveLength(HANDLE_WORDLIST_SIZE);
		expect(sourceDigest).toBe("7aa57a4d3ecf6581729992bad9575bacdebf7c28378af2aec6a50f11aec326f5");
		expect(handleWordAt(0)).toBe("aardvark");
		expect(handleWordAt(HANDLE_WORDLIST_SIZE - 1)).toBe("zucchini");
	});

	it("pins charset, length, uniqueness, and unique three-character prefixes", () => {
		const officialNonLetterEntries = EFF_SHORT_WORDLIST_2.filter((word) => !/^[a-z]+$/.test(word));
		const uniqueWords = new Set(EFF_SHORT_WORDLIST_2);
		const uniquePrefixes = new Set(EFF_SHORT_WORDLIST_2.map((word) => word.slice(0, 3)));

		// The unchanged official artifact has exactly one internal-hyphen entry.
		expect(officialNonLetterEntries).toEqual(["yo-yo"]);
		expect(EFF_SHORT_WORDLIST_2.every((word) => /^[a-z-]+$/.test(word))).toBe(true);
		expect(EFF_SHORT_WORDLIST_2.every((word) => word.length >= 3 && word.length <= 10)).toBe(true);
		expect(uniqueWords.size).toBe(HANDLE_WORDLIST_SIZE);
		expect(uniquePrefixes.size).toBe(HANDLE_WORDLIST_SIZE);
	});

	it("never issues the hyphenated entry because `-` is the word separator", () => {
		expect(ISSUABLE_HANDLE_WORDS).toHaveLength(HANDLE_WORDLIST_SIZE - 1);
		expect(ISSUABLE_HANDLE_WORDS.includes("yo-yo")).toBe(false);
		expect(ISSUABLE_HANDLE_WORDS.every((word) => isHandleWord(word))).toBe(true);
	});

	it("exports the word-count and entropy constants", () => {
		expect(BOUND_HANDLE_WORD_COUNT).toBe(2);
		expect(PUBLIC_HANDLE_WORD_COUNT).toBe(4);
		expect(HIGH_PUBLIC_HANDLE_WORD_COUNT).toBe(5);
		expect(HANDLE_WORD_ENTROPY_BITS).toBeCloseTo(10.33985, 5);
		expect(PUBLIC_HANDLE_ENTROPY_BITS).toBeCloseTo(41.3594, 4);
		expect(HIGH_PUBLIC_HANDLE_ENTROPY_BITS).toBeCloseTo(51.69925, 4);
	});
});

describe("findHandleWordWithinDistance", () => {
	it("returns exact words unchanged and null for empty or far input", () => {
		expect(findHandleWordWithinDistance("aardvark", 1)).toBe("aardvark");
		expect(findHandleWordWithinDistance("yo-yo", 1)).toBe("yo-yo");
		expect(findHandleWordWithinDistance("", 1)).toBeNull();
		expect(findHandleWordWithinDistance("zzzzzzzz", 1)).toBeNull();
		expect(findHandleWordWithinDistance("aardvarkxx", 1)).toBeNull();
	});

	it("resolves every single-character edit of every word to that word or null, never another", () => {
		let resolved = 0;
		let unresolved = 0;
		for (const word of EFF_SHORT_WORDLIST_2) {
			for (const variant of singleEditVariants(word)) {
				const match = findHandleWordWithinDistance(variant, 1);
				if (match === null) {
					unresolved += 1;
					continue;
				}
				if (match !== word) {
					throw new Error(`"${variant}" (edit of "${word}") resolved to "${match}"`);
				}
				resolved += 1;
			}
		}
		// Pairwise distance >= 3 means a distance-1 neighbourhood never overlaps
		// another word's neighbourhood, so the fallback to null must never fire.
		expect(unresolved).toBe(0);
		expect(resolved).toBeGreaterThan(HANDLE_WORDLIST_SIZE * 100);
	});
});
