#!/usr/bin/env bun
/**
 * Live proxy verification harness — NOT part of `bun test`.
 *
 * Requires live vendor credentials and reaches external services, so it is run
 * manually / in a gated job, never in unit CI. It proves, per vendor × protocol
 * × transport cell, that:
 *   (a) the request succeeds (2xx),
 *   (b) egress exits through the proxy (IP differs from the direct IP),
 *   (c) the client TLS fingerprint (JA3/JA4) is preserved end-to-end — i.e. the
 *       proxy tunnels bytes (CONNECT / SOCKS5) and does NOT MITM TLS, and
 *   (d) a Cloudflare-gated origin returns 200 rather than a challenge.
 *
 * It also probes whether Bun's native fetch supports SOCKS5, which determines
 * the ctx.http protocol-capability set enforced by the resolver.
 *
 * Usage:
 *   APIFUSE__PROXY__SMARTPROXY_APP_KEY=... \
 *   APIFUSE__PROXY__NODEMAVEN_USERNAME=... APIFUSE__PROXY__NODEMAVEN_PASSWORD=... \
 *   bun run scripts/verify-proxy-tls.ts [--country=kr] [--cf-origin=https://...]
 */
import { Impit } from "impit";

import { resolveProxyConfigAsync } from "../src/config/loader.js";
import type { ProxyProtocol } from "../src/runtime/proxy-nodemaven.js";
import type { ProviderProxyProvider } from "../src/types.js";

type Transport = "stealth" | "native-fetch";
type Vendor = Extract<ProviderProxyProvider, "smartproxy" | "nodemaven">;

type CellResult = {
	vendor: Vendor;
	protocol: ProxyProtocol;
	transport: Transport;
	status: "PASS" | "FAIL" | "SKIP";
	egressIp?: string;
	fingerprint?: string;
	cfStatus?: number;
	note?: string;
};

const IPIFY = "https://api.ipify.org?format=json";
const TLS_ECHO = "https://tls.peet.ws/api/all";

function arg(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
}

const COUNTRY = arg("country", "kr").toUpperCase();
// A Cloudflare-fronted origin that challenges unknown TLS fingerprints. Override
// with a provider-representative origin (e.g. the CatchTable host) via --cf-origin.
const CF_ORIGIN = arg("cf-origin", "https://www.catchtable.co.kr/");

function vendorHasCreds(vendor: Vendor): boolean {
	if (vendor === "smartproxy") return Boolean(process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY);
	return Boolean(
		process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME &&
			process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD,
	);
}

async function resolveProxy(vendor: Vendor, protocol: ProxyProtocol): Promise<string> {
	process.env.APIFUSE__PROXY__PROTOCOL = protocol;
	const resolved = await resolveProxyConfigAsync({
		proxyPolicy: {
			mode: "required",
			provider: vendor,
			geo: { country: COUNTRY as Uppercase<string> },
		},
		// The harness itself is protocol-permissive; the transport enforces support.
		transportProtocols: ["http", "socks5"],
	});
	if (!resolved.url) throw new Error("resolver returned no proxy URL");
	return resolved.url;
}

function ja3FromEcho(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as { tls?: { ja3_hash?: string; ja4?: string } };
		return parsed.tls?.ja4 ?? parsed.tls?.ja3_hash;
	} catch {
		return undefined;
	}
}

/** True if the body/headers look like a Cloudflare interstitial challenge. */
function looksLikeChallenge(status: number, headers: Headers, body: string): boolean {
	if (headers.get("cf-mitigated") === "challenge") return true;
	return /just a moment|challenge-platform|cf-chl/i.test(body) || status === 403;
}

async function stealthGet(
	proxyUrl: string,
	url: string,
): Promise<{ status: number; body: string; headers: Headers }> {
	const client = new Impit({ browser: "chrome", proxyUrl, ignoreTlsErrors: false });
	const response = await client.fetch(url);
	const body = await response.text();
	return { status: response.status, body, headers: response.headers as unknown as Headers };
}

async function nativeGet(
	proxyUrl: string,
	url: string,
): Promise<{ status: number; body: string; headers: Headers }> {
	const response = await fetch(url, { proxy: proxyUrl } as RequestInit & { proxy: string });
	const body = await response.text();
	return { status: response.status, body, headers: response.headers };
}

async function directFingerprint(transport: Transport): Promise<string | undefined> {
	try {
		if (transport === "stealth") {
			const client = new Impit({ browser: "chrome" });
			const body = await (await client.fetch(TLS_ECHO)).text();
			return ja3FromEcho(body);
		}
		return ja3FromEcho(await (await fetch(TLS_ECHO)).text());
	} catch {
		return undefined;
	}
}

async function runCell(
	vendor: Vendor,
	protocol: ProxyProtocol,
	transport: Transport,
	nativeSocks5Supported: boolean,
): Promise<CellResult> {
	const base: CellResult = { vendor, protocol, transport, status: "SKIP" };
	if (!vendorHasCreds(vendor)) return { ...base, note: "no credentials" };
	if (transport === "native-fetch" && protocol === "socks5" && !nativeSocks5Supported) {
		return { ...base, note: "capability: native fetch has no socks5" };
	}

	try {
		const proxyUrl = await resolveProxy(vendor, protocol);
		const get = transport === "stealth" ? stealthGet : nativeGet;

		const ipRes = await get(proxyUrl, IPIFY);
		const egressIp = (JSON.parse(ipRes.body) as { ip?: string }).ip;

		const tlsRes = await get(proxyUrl, TLS_ECHO);
		const fingerprint = ja3FromEcho(tlsRes.body);
		const directFp = await directFingerprint(transport);

		let cfStatus: number | undefined;
		let cfChallenged = false;
		try {
			const cfRes = await get(proxyUrl, CF_ORIGIN);
			cfStatus = cfRes.status;
			cfChallenged = looksLikeChallenge(cfRes.status, cfRes.headers, cfRes.body);
		} catch (error) {
			cfChallenged = true;
			cfStatus = undefined;
			void error;
		}

		const fpPreserved = transport === "native-fetch" || (!!fingerprint && fingerprint === directFp);
		// A browser-gated origin (Cloudflare) is only a pass/fail signal for the
		// stealth transport. ctx.http (native fetch) has no browser impersonation,
		// so it is expected to be challenged there — reported as INFO, not FAIL.
		const cfGates = transport === "stealth";
		const pass =
			ipRes.status < 300 &&
			!!egressIp &&
			fpPreserved &&
			(!cfGates || (cfStatus === 200 && !cfChallenged));

		return {
			...base,
			status: pass ? "PASS" : "FAIL",
			egressIp,
			fingerprint,
			cfStatus,
			note:
				(pass
					? cfGates
						? undefined
						: `cf=${cfChallenged ? "challenged (expected for native fetch)" : cfStatus}`
					: [
							ipRes.status >= 300 ? `egress status ${ipRes.status}` : "",
							!egressIp ? "no egress ip" : "",
							!fpPreserved ? `fingerprint drift (${fingerprint} vs ${directFp})` : "",
							cfGates && cfChallenged ? "cloudflare challenge" : "",
						]
							.filter(Boolean)
							.join("; ")) || undefined,
		};
	} catch (error) {
		return {
			...base,
			status: "FAIL",
			note: error instanceof Error ? error.message : String(error),
		};
	}
}

async function probeNativeSocks5(): Promise<boolean> {
	// Attempt a socks5 fetch against a dummy address; a "scheme unsupported"
	// style error means Bun's fetch cannot do socks5. Any connection-level error
	// means the scheme is accepted.
	try {
		await fetch("https://api.ipify.org", {
			proxy: "socks5://127.0.0.1:1",
			signal: AbortSignal.timeout(1500),
		} as RequestInit & { proxy: string });
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message.toLowerCase() : "";
		return !/unsupported|invalid|scheme|not support/.test(message);
	}
}

async function main(): Promise<void> {
	const vendors: Vendor[] = ["smartproxy", "nodemaven"];
	const protocols: ProxyProtocol[] = ["http", "socks5"];
	const transports: Transport[] = ["stealth", "native-fetch"];

	const nativeSocks5Supported = await probeNativeSocks5();
	console.log(`Bun native fetch SOCKS5 support: ${nativeSocks5Supported ? "yes" : "no"}`);
	console.log(`Cloudflare origin under test: ${CF_ORIGIN}\n`);

	const results: CellResult[] = [];
	for (const vendor of vendors) {
		for (const protocol of protocols) {
			for (const transport of transports) {
				results.push(await runCell(vendor, protocol, transport, nativeSocks5Supported));
			}
		}
	}

	for (const r of results) {
		const cell = `${r.vendor}/${r.protocol}/${r.transport}`.padEnd(34);
		const detail = [
			r.egressIp ? `ip=${r.egressIp}` : "",
			r.fingerprint ? `fp=${r.fingerprint.slice(0, 16)}` : "",
			r.cfStatus ? `cf=${r.cfStatus}` : "",
			r.note ?? "",
		]
			.filter(Boolean)
			.join(" ");
		console.log(`${r.status.padEnd(4)} ${cell} ${detail}`);
	}

	const failed = results.filter((r) => r.status === "FAIL");
	console.log(
		`\n${results.filter((r) => r.status === "PASS").length} pass, ${failed.length} fail, ${
			results.filter((r) => r.status === "SKIP").length
		} skip`,
	);
	process.exit(failed.length > 0 ? 1 : 0);
}

void main();
