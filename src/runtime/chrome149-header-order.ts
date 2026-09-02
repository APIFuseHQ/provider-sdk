const U64_MASK = (1n << 64n) - 1n;
const RAPID_SEED = 0xbdd89aa982704029n;
const RAPID_SECRET = [0x2d358dccaa6c78a5n, 0x8bb84b93962eacc9n, 0x4b33a62ed433d4a3n] as const;

interface HashReader {
	readonly compressionFactor: number;
	readonly expansionFactor: number;
	read64(offset: number): bigint;
	read32(offset: number): bigint;
	readSmall(offset: number, length: number): bigint;
}

function latin1CaseFold(character: number): number {
	if (character >= 0x41 && character <= 0x5a) return character + 0x20;
	if (character === 0xb5) return 0x03bc;
	if ((character >= 0xc0 && character <= 0xd6) || (character >= 0xd8 && character <= 0xde))
		return character + 0x20;
	return character;
}

function multiply128(a: bigint, b: bigint): [low: bigint, high: bigint] {
	const product = (a & U64_MASK) * (b & U64_MASK);
	return [product & U64_MASK, (product >> 64n) & U64_MASK];
}

function rapidMix(a: bigint, b: bigint): bigint {
	const [low, high] = multiply128(a, b);
	return low ^ high;
}

class PlainByteHashReader implements HashReader {
	readonly compressionFactor = 1;
	readonly expansionFactor = 1;

	constructor(private readonly bytes: readonly number[]) {}

	read64(offset: number): bigint {
		let result = 0n;
		for (let index = 0; index < 8; index += 1) {
			result |= BigInt(this.bytes[offset + index] ?? 0) << BigInt(index * 8);
		}
		return result;
	}

	read32(offset: number): bigint {
		let result = 0n;
		for (let index = 0; index < 4; index += 1) {
			result |= BigInt(this.bytes[offset + index] ?? 0) << BigInt(index * 8);
		}
		return result;
	}

	readSmall(offset: number, length: number): bigint {
		return (
			(BigInt(this.bytes[offset] ?? 0) << 56n) |
			(BigInt(this.bytes[offset + (length >> 1)] ?? 0) << 32n) |
			BigInt(this.bytes[offset + length - 1] ?? 0)
		);
	}
}

class CaseFoldingLatin1HashReader implements HashReader {
	readonly compressionFactor = 1;
	readonly expansionFactor = 2;

	constructor(private readonly input: string) {}

	private fold(offset: number): bigint {
		return BigInt(latin1CaseFold(this.input.charCodeAt(offset)));
	}

	read64(offset: number): bigint {
		return (
			this.fold(offset) |
			(this.fold(offset + 1) << 16n) |
			(this.fold(offset + 2) << 32n) |
			(this.fold(offset + 3) << 48n)
		);
	}

	read32(offset: number): bigint {
		return this.fold(offset) | (this.fold(offset + 1) << 16n);
	}

	readSmall(offset: number, length: number): bigint {
		if (length !== 2) {
			throw new Error(`CaseFoldingHashReader<LChar> received length ${length}; expected 2.`);
		}
		return this.fold(offset);
	}
}

function rapidHash(reader: HashReader, producedLength: number): bigint {
	const x = reader.compressionFactor;
	const y = reader.expansionFactor;
	if (producedLength % y !== 0) throw new Error("Invalid rapidhash reader length.");

	let seed = RAPID_SEED;
	seed ^= rapidMix(seed ^ RAPID_SECRET[0], RAPID_SECRET[1]) ^ BigInt(producedLength);
	seed &= U64_MASK;
	let offset = 0;
	let a: bigint;
	let b: bigint;

	if (producedLength <= 16) {
		if (producedLength >= 4) {
			const last = offset + Math.trunc(((producedLength - 4) * x) / y);
			a = (reader.read32(offset) << 32n) | reader.read32(last);
			const delta = Math.trunc((((producedLength & 24) >> (producedLength >> 3)) * x) / y);
			b = (reader.read32(offset + delta) << 32n) | reader.read32(last - delta);
		} else if (producedLength > 0) {
			a = reader.readSmall(offset, producedLength);
			b = 0n;
		} else {
			a = 0n;
			b = 0n;
		}
	} else {
		let remaining = producedLength;
		if (remaining > 48) {
			let see1 = seed;
			let see2 = seed;
			do {
				seed = rapidMix(
					reader.read64(offset) ^ RAPID_SECRET[0],
					reader.read64(offset + Math.trunc((8 * x) / y)) ^ seed,
				);
				see1 = rapidMix(
					reader.read64(offset + Math.trunc((16 * x) / y)) ^ RAPID_SECRET[1],
					reader.read64(offset + Math.trunc((24 * x) / y)) ^ see1,
				);
				see2 = rapidMix(
					reader.read64(offset + Math.trunc((32 * x) / y)) ^ RAPID_SECRET[2],
					reader.read64(offset + Math.trunc((40 * x) / y)) ^ see2,
				);
				offset += Math.trunc((48 * x) / y);
				remaining -= 48;
			} while (remaining >= 48);
			seed ^= see1 ^ see2;
		}
		if (remaining > 16) {
			seed = rapidMix(
				reader.read64(offset) ^ RAPID_SECRET[2],
				reader.read64(offset + Math.trunc((8 * x) / y)) ^ seed ^ RAPID_SECRET[1],
			);
			if (remaining > 32) {
				seed = rapidMix(
					reader.read64(offset + Math.trunc((16 * x) / y)) ^ RAPID_SECRET[2],
					reader.read64(offset + Math.trunc((24 * x) / y)) ^ seed,
				);
			}
		}
		a = reader.read64(offset + Math.trunc(((remaining - 16) * x) / y));
		b = reader.read64(offset + Math.trunc(((remaining - 8) * x) / y));
	}

	a ^= RAPID_SECRET[1];
	b ^= seed;
	[a, b] = multiply128(a, b);
	return rapidMix(a ^ RAPID_SECRET[0] ^ BigInt(producedLength), b ^ RAPID_SECRET[1]);
}

function maskTopEightBits(hash: bigint): number {
	const masked = Number(hash & 0xffffffn);
	return masked === 0 ? 0x800000 : masked;
}

/** @internal Chromium 149 DeprecatedCaseFoldingHash for an LChar string. */
export function chrome149CaseFoldingHash(name: string): number {
	const reader = new CaseFoldingLatin1HashReader(name);
	return maskTopEightBits(rapidHash(reader, name.length * reader.expansionFactor));
}

/** @internal Numeric rapidhash fixture from Chromium's string_hasher_test.cc. */
export function chrome149RapidhashFixture(): { full: bigint; masked: number } {
	const fixture = [0x41, 0x95, 0xff, 0x50, 0x01];
	const full = rapidHash(new PlainByteHashReader(fixture), fixture.length);
	return { full, masked: maskTopEightBits(full) };
}

function asciiCaseKey(name: string): string {
	let result = "";
	for (let index = 0; index < name.length; index += 1) {
		const character = name.charCodeAt(index);
		result += String.fromCharCode(
			character >= 0x41 && character <= 0x5a ? character + 0x20 : character,
		);
	}
	return result;
}

class WtfHeaderHashMap {
	private table: Array<string | undefined> = [];
	private keyCount = 0;

	private insertWithoutExpansion(key: string): boolean {
		const mask = this.table.length - 1;
		let index = chrome149CaseFoldingHash(key) & mask;
		let probeCount = 0;
		const keyCaseFolded = asciiCaseKey(key);
		for (;;) {
			const stored = this.table[index];
			if (stored === undefined) {
				this.table[index] = key;
				this.keyCount += 1;
				return true;
			}
			if (asciiCaseKey(stored) === keyCaseFolded) return false;
			probeCount += 1;
			index = (index + probeCount) & mask;
		}
	}

	private rehash(newSize: number): void {
		const oldTable = this.table;
		this.table = Array<string | undefined>(newSize);
		this.keyCount = 0;
		for (const key of oldTable) {
			if (key !== undefined) this.insertWithoutExpansion(key);
		}
	}

	insert(key: string): void {
		if (this.table.length === 0) this.table = Array<string | undefined>(8);
		if (!this.insertWithoutExpansion(key)) return;
		if (this.keyCount * 2 >= this.table.length) this.rehash(this.table.length * 2);
	}

	iterationOrder(): string[] {
		return this.table.filter((key): key is string => key !== undefined);
	}
}

/**
 * HTTPHeaderMap insertion sequence of the fixed headers in a real Chrome
 * 149.0.7827.155 page fetch/XHR (insertion order, not bucket order). Caller
 * headers precede all of these (core/fetch/fetch_manager.cc:1128-1130).
 *
 *   platform/loader/fetch/resource_request_utils.cc:146 UpgradeResourceRequestForLoader
 *     :166 context.UpgradeResourceRequestForLoader
 *          -> core/loader/frame_fetch_context.cc:1000 AddClientHintsIfNecessary
 *             Set sec-ch-ua @737, sec-ch-ua-mobile @748, sec-ch-ua-platform @761
 *          -> :1001 AddReducedAcceptLanguageIfNecessary is a no-op
 *             (kReduceAcceptLanguage[HTTP] are FEATURE_DISABLED_BY_DEFAULT,
 *             services/network/public/cpp/features.cc:204,214)
 *     :214 context.PrepareRequest
 *          -> core/loader/frame_fetch_context.cc:419 SetHTTPUserAgent
 *          -> :455 probe::PrepareRequest, which only touches the map when a
 *             DevTools session has set an Accept-Language override:
 *             InspectorEmulationAgent::PrepareRequest (inspector_emulation_agent.cc
 *             :626-636, Emulation.setUserAgentOverride acceptLanguage; skips a key
 *             the page already set) or InspectorNetworkAgent::PrepareRequest
 *             (inspector_network_agent.cc:1524-1547, Network.setExtraHTTPHeaders;
 *             overwrites)
 *
 * Accept-Language is therefore NOT a map key in real Chrome. //net appends it
 * in URLRequestHttpJob::AddExtraHeaders (net/url_request/url_request_http_job.cc
 * :784-797) after Accept-Encoding, and only when the request does not already
 * carry one (SetHeaderIfMissing), which is why a caller-supplied Accept-Language
 * stays at its map bucket and is never emitted twice. al-placement-capture.json
 * (B: no locale, C: --accept-lang=ja) confirms both the four-key map and the
 * downstream slot.
 *
 * Every earlier corpus (placement-rule-sweep, expansion-sweep, holdout-capture,
 * m1-capture) was captured through Playwright `newContext({ locale })`, which
 * sets that override (Emulation.setUserAgentOverride acceptLanguage) and so
 * inserts Accept-Language into the map as a fifth fixed key. Those fixtures still
 * validate the hash and table mechanics;
 * the tests interpret them through that harness insertion list. No production
 * path uses it.
 */
export const CHROME149_FIXED_MAP_INSERTION = [
	"sec-ch-ua",
	"sec-ch-ua-mobile",
	"sec-ch-ua-platform",
	"User-Agent",
] as const;

/**
 * Appended after PopulateResourceRequest has iterated the map: Fetch Metadata
 * and Referer by the network service, then //net's Accept-Encoding and
 * Accept-Language, then the HTTP/2 Priority header (net/spdy/spdy_http_utils.cc).
 */
const DOWNSTREAM_SUFFIX = [
	"sec-fetch-site",
	"sec-fetch-mode",
	"sec-fetch-dest",
	"referer",
] as const;

/**
 * @internal Header-name order model parameterised by the fixed map insertion
 * sequence. Production always passes {@link CHROME149_FIXED_MAP_INSERTION};
 * tests pass the DevTools-harness sequence to validate corpora captured through
 * Playwright's `locale` option.
 */
export function chrome149HeaderOrderForMapInsertion(
	callerNames: Iterable<string>,
	fixedMapInsertion: readonly string[],
): string[] {
	const unique = new Map<string, string>();
	for (const name of callerNames) {
		const key = asciiCaseKey(name);
		if (!unique.has(key)) unique.set(key, name);
	}

	const headerMap = new WtfHeaderHashMap();
	for (const key of [...unique.keys()].sort()) headerMap.insert(unique.get(key) as string);
	for (const name of fixedMapInsertion) headerMap.insert(name);

	const order = headerMap.iterationOrder().map((name) => name.toLowerCase());
	// SetAcceptHeader adds */* only when the caller Accept was absent.
	if (!order.includes("accept")) order.push("accept");
	order.push(...DOWNSTREAM_SUFFIX);
	// URLRequestHttpJob::AddExtraHeaders: Accept-Encoding, then Accept-Language,
	// each only if the request does not already carry it.
	if (!order.includes("accept-encoding")) order.push("accept-encoding");
	if (!order.includes("accept-language")) order.push("accept-language");
	// CreateSpdyHeadersFromHttpRequest appends the default Priority only if absent.
	if (!order.includes("priority")) order.push("priority");
	return order;
}

/**
 * @internal Predict real Chrome 149's non-pseudo HTTP/2 fetch/XHR header-name
 * order for the given caller header names (no DevTools session attached).
 */
export function chrome149HeaderOrder(callerNames: Iterable<string>): string[] {
	return chrome149HeaderOrderForMapInsertion(callerNames, CHROME149_FIXED_MAP_INSERTION);
}
