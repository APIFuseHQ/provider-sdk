import { Cookie, CookieJar as ToughCookieJar } from "tough-cookie";

import { SDKError, StealthCookieStoreVersionError } from "../errors.js";
import type {
	CookieJar,
	StealthCookieStore,
	StealthCookieStoreV1,
	StealthSessionCookies,
} from "../types.js";

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

const LEGACY_COOKIE_ORIGIN = "https://legacy-cookie.invalid/";

export class StealthCookieJar implements CookieJar, StealthSessionCookies {
	private cookies: ToughCookieJar;
	private readonly defaultUrl: string;
	private readonly register: ((value: string) => void) | undefined;

	constructor(
		cookieStrings: readonly string[],
		defaultUrl = LEGACY_COOKIE_ORIGIN,
		register?: (value: string) => void,
	) {
		this.cookies = new ToughCookieJar(undefined, {
			allowSecureOnLocal: false,
			rejectPublicSuffixes: true,
		});
		this.defaultUrl = this.normalizeUrl(defaultUrl) ?? LEGACY_COOKIE_ORIGIN;
		this.register = register;
		this.setFromCookieStrings(cookieStrings);
	}

	setFromCookieStrings(cookieStrings: readonly string[], url = this.defaultUrl): void {
		const cookieUrl = this.normalizeUrl(url);
		if (!cookieUrl) return;
		for (const cookieString of cookieStrings) {
			const cookie = Cookie.parse(cookieString);
			if (cookie?.value) this.register?.(cookie.value);
			this.cookies.setCookieSync(cookieString, cookieUrl, { ignoreError: true });
		}
	}

	get(name: string, url?: string): string | undefined {
		return this.getAll(url)[name];
	}

	getAll(url?: string): Record<string, string> {
		return Object.fromEntries(
			this.getUniqueCookies(url ?? this.defaultUrl).map((cookie) => [cookie.key, cookie.value]),
		);
	}

	has(name: string, url?: string): boolean {
		return Object.hasOwn(this.getAll(url), name);
	}

	toString(url?: string): string {
		return this.getUniqueCookies(url ?? this.defaultUrl)
			.map((cookie) => cookie.cookieString())
			.join("; ");
	}

	toHeader(url?: string): string {
		return this.toString(url);
	}

	snapshot(): Record<string, string> {
		const entries: [string, string][] = [];
		for (const cookie of this.serialize().jar.cookies) {
			if (typeof cookie.key === "string" && typeof cookie.value === "string" && cookie.key) {
				entries.push([cookie.key, cookie.value]);
			}
		}
		return Object.fromEntries(entries);
	}

	restore(cookies: Record<string, string>): void {
		this.clear();
		for (const [name, value] of Object.entries(cookies)) {
			if (!name) continue;
			this.register?.(value);
			this.cookies.setCookieSync(new Cookie({ key: name, path: "/", value }), this.defaultUrl, {
				ignoreError: true,
			});
		}
	}

	serialize(): StealthCookieStoreV1 {
		const jar = this.cookies.serializeSync();
		if (!jar) {
			throw new SDKError("Stealth cookie store could not be serialized", {
				code: "stealth_cookie_store_serialize_failed",
			});
		}
		return { version: 1, jar };
	}

	deserialize(state: StealthCookieStore): void {
		const version = isRecord(state) ? state.version : undefined;
		if (version !== 1) {
			throw new StealthCookieStoreVersionError(version);
		}
		const restored = ToughCookieJar.deserializeSync(state.jar);
		Reflect.set(restored, "allowSecureOnLocal", false);
		this.cookies = restored;
	}

	clear(): void {
		this.cookies.removeAllCookiesSync();
	}

	find(predicate: (cookie: string) => boolean, url?: string): string | undefined {
		for (const cookie of this.getUniqueCookies(url ?? this.defaultUrl)) {
			const cookieString = cookie.cookieString();
			if (predicate(cookieString)) return cookieString;
		}
		return undefined;
	}

	names(url?: string): string[] {
		return this.getUniqueCookies(url ?? this.defaultUrl).map((cookie) => cookie.key);
	}

	private normalizeUrl(url: string): string | undefined {
		try {
			return new URL(url).toString();
		} catch {
			return undefined;
		}
	}

	private getUniqueCookies(url: string): Cookie[] {
		const cookieUrl = this.normalizeUrl(url);
		if (!cookieUrl) return [];
		const names = new Set<string>();
		return this.cookies.getCookiesSync(cookieUrl).filter((cookie) => {
			if (cookie.value) this.register?.(cookie.value);
			if (names.has(cookie.key)) return false;
			names.add(cookie.key);
			return true;
		});
	}
}
