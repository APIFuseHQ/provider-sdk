import { describe, expect, it } from "bun:test";

import { redirectHopHeaders } from "../runtime/redirect-hop-headers.js";

const headers = {
	Authorization: "Bearer token",
	"Proxy-Authorization": "Basic proxy",
	Cookie: "sid=1",
	"Content-Type": "application/x-www-form-urlencoded",
	Origin: "https://www.example.com",
	Referer: "https://www.example.com/",
};

function hop(from: string, to: string, methodChanged = false) {
	return Object.keys(redirectHopHeaders({ from, to, methodChanged }, headers));
}

describe("redirectHopHeaders", () => {
	it("keeps every header on a same-origin hop without a method change", () => {
		expect(hop("https://www.example.com/a", "https://www.example.com/b")).toEqual(
			Object.keys(headers),
		);
	});

	it("drops the request-body headers and Origin only when the method changes", () => {
		expect(hop("https://www.example.com/a", "https://www.example.com/b", true)).toEqual([
			"Authorization",
			"Proxy-Authorization",
			"Cookie",
			"Referer",
		]);
	});

	it("drops credentials on a cross-origin hop and the Cookie only on a cross-site one", () => {
		// Same site, other origin: host, port, or subdomain differs.
		for (const to of [
			"https://auth.example.com/b",
			"https://www.example.com:8443/b",
			"https://example.com/b",
		]) {
			expect(hop("https://www.example.com/a", to)).toEqual([
				"Cookie",
				"Content-Type",
				"Origin",
				"Referer",
			]);
		}
		// Other site: registrable domain or scheme differs.
		for (const to of [
			"https://www.example.net/b",
			"http://www.example.com/b",
			"https://example.com.evil.test/b",
		]) {
			expect(hop("https://www.example.com/a", to)).toEqual(["Content-Type", "Origin", "Referer"]);
		}
	});

	it("reads sites from the public suffix list, including private suffixes", () => {
		expect(hop("https://www.amazon.co.jp/a", "https://signin.amazon.co.jp/b")).toContain("Cookie");
		expect(hop("https://www.amazon.co.jp/a", "https://www.other.co.jp/b")).not.toContain("Cookie");
		expect(hop("https://alice.github.io/a", "https://mallory.github.io/b")).not.toContain("Cookie");
	});

	it("compares an IP host as a whole", () => {
		expect(hop("http://127.0.0.1:4000/a", "http://127.0.0.1:5000/b")).toEqual([
			"Cookie",
			"Content-Type",
			"Origin",
			"Referer",
		]);
		expect(hop("http://127.0.0.1:4000/a", "http://127.0.0.2:4000/b")).toEqual([
			"Content-Type",
			"Origin",
			"Referer",
		]);
	});
});
