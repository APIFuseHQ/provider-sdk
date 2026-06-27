import { computePercentile } from "./perf";
import type { Span, SpanAttributeValue } from "./trace";

export type InsightSeverity = "info" | "warning" | "error";

export type Insight = {
	id: string;
	severity: InsightSeverity;
	message: string;
	fix?: string;
};

type InsightResult = {
	message: string;
	fix?: string;
	triggered: boolean;
};

type DnsHostInsight = {
	hostname: string;
	avgDnsMs: number;
};

const LARGE_RESPONSE_BYTES = 100_000;
const SLOW_TRANSFORM_MS = 10;
const DNS_WARN_MS = 5;
const BROWSER_IDLE_MS = 5_000;
const REFRESH_WARN_RATE = 0.1;

const TLS_REUSE_FIX = `const session = ctx.stealth.createSession({ profile: 'chrome-146' });
const resp = await session.fetch(url, opts);`;

const TRANSFORM_FIX = `transformResponse: (raw) => {
	return raw.items.map(({ id, name, price }) => ({ id, name, price }));
}`;

const LARGE_RESPONSE_FIX = `const resp = await ctx.http.get('/items', {
	params: { limit: 50, page: 1 },
});`;

const DNS_FIX = `// Enable DNS caching or reuse a long-lived session per host.
const session = ctx.stealth.createSession({ profile: 'chrome-146' });
await session.fetch(url, opts);`;

const PROXY_FIX = `// Re-check whether this operation really needs a proxy.
await ctx.stealth.fetch(url, { ...opts, proxy: undefined });`;

const BROWSER_FIX = `await page.waitForSelector('[data-ready="true"]', {
	timeout: 5_000,
});`;

const SESSION_FIX = `export default defineProvider({
	session: {
		ttl: 60 * 60,
	},
});`;

function isNumber(value: SpanAttributeValue | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: SpanAttributeValue | undefined): value is boolean {
	return typeof value === "boolean";
}

function isString(value: SpanAttributeValue | undefined): value is string {
	return typeof value === "string" && value.length > 0;
}

function getNumberAttribute(span: Span, key: string): number | undefined {
	const value = span.attributes[key];
	return isNumber(value) ? value : undefined;
}

function getBooleanAttribute(span: Span, key: string): boolean | undefined {
	const value = span.attributes[key];
	return isBoolean(value) ? value : undefined;
}

function getStringAttribute(span: Span, key: string): string | undefined {
	const value = span.attributes[key];
	return isString(value) ? value : undefined;
}

function formatPercent(value: number): string {
	return `${Math.round(value)}%`;
}

function formatMs(value: number): string {
	const rounded = Number(value.toFixed(value >= 10 ? 0 : 1));
	return `${rounded}ms`;
}

function formatBytes(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}MB`;
	}

	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}KB`;
	}

	return `${value}B`;
}

function parseHostname(url: string | undefined): string | undefined {
	if (!url) {
		return undefined;
	}

	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

function makeInsight(
	id: string,
	severity: InsightSeverity,
	result: InsightResult,
): Insight {
	return {
		id,
		severity,
		message: result.message,
		...(result.fix ? { fix: result.fix } : {}),
	};
}

function isStealthSpan(span: Span): boolean {
	return span.name.startsWith("stealth.");
}

function isRequestSpan(span: Span): boolean {
	return span.name === "stealth.fetch" || span.name.startsWith("http.");
}

function isBrowserSpan(span: Span): boolean {
	return span.name.startsWith("browser.") || span.name.startsWith("page.");
}

function hasProxy(span: Span): boolean {
	const proxy = span.attributes.proxy;
	return proxy === true || (typeof proxy === "string" && proxy.length > 0);
}

function getTlsReuseInsight(spans: Span[]): InsightResult {
	const tlsSpans = spans.filter(isStealthSpan);
	if (tlsSpans.length === 0) {
		return {
			triggered: false,
			message: "✓ Stealth connection reuse: no stealth spans sampled yet",
		};
	}

	const reusedCount = tlsSpans.filter(
		(span) => getBooleanAttribute(span, "connection_reused") === true,
	).length;
	const reuseRate = reusedCount / tlsSpans.length;

	if (1 - reuseRate >= 0.8) {
		return {
			triggered: true,
			message: `⚠ Stealth connection reuse: ${formatPercent(reuseRate * 100)} reused — stealth handshakes are happening on most requests`,
			fix: TLS_REUSE_FIX,
		};
	}

	return {
		triggered: false,
		message: `✓ Stealth connection reuse: ${formatPercent(reuseRate * 100)} (good)`,
	};
}

function getSlowTransformInsight(spans: Span[]): InsightResult {
	const durations = spans
		.filter((span) => span.name === "transformResponse")
		.map((span) => span.duration_ms)
		.filter((value) => Number.isFinite(value));

	if (durations.length === 0) {
		return {
			triggered: false,
			message: "✓ Transform overhead: no transformResponse spans sampled yet",
		};
	}

	const p95 = computePercentile(
		[...durations].sort((a, b) => a - b),
		95,
	);
	if (p95 > SLOW_TRANSFORM_MS) {
		return {
			triggered: true,
			message: `⚠ Transform overhead: p95 ${formatMs(p95)} — trim array size or transformation complexity`,
			fix: TRANSFORM_FIX,
		};
	}

	return {
		triggered: false,
		message: `✓ Transform overhead: p95 ${formatMs(p95)} (good)`,
	};
}

function getLargeResponseInsight(spans: Span[]): InsightResult {
	const sizes = spans
		.map((span) => getNumberAttribute(span, "response_size"))
		.filter((value): value is number => value !== undefined);

	if (sizes.length === 0) {
		return {
			triggered: false,
			message: "✓ Response size: no response payloads sampled yet",
		};
	}

	const maxSize = Math.max(...sizes);
	if (maxSize > LARGE_RESPONSE_BYTES) {
		return {
			triggered: true,
			message: `⚠ Response size: ${formatBytes(maxSize)} — consider pagination or a lower limit`,
			fix: LARGE_RESPONSE_FIX,
		};
	}

	return {
		triggered: false,
		message: `✓ Response size: ${formatBytes(maxSize)} max (good)`,
	};
}

function getDnsRepeatedCandidate(spans: Span[]): DnsHostInsight | null {
	const grouped = new Map<
		string,
		{ dnsDurations: number[]; reuseCount: number; totalCount: number }
	>();

	for (const span of spans.filter(isStealthSpan)) {
		const hostname = parseHostname(getStringAttribute(span, "url"));
		const dnsMs = getNumberAttribute(span, "dns_ms");
		if (!hostname || dnsMs === undefined) {
			continue;
		}

		const entry = grouped.get(hostname) ?? {
			dnsDurations: [],
			reuseCount: 0,
			totalCount: 0,
		};

		entry.dnsDurations.push(dnsMs);
		entry.totalCount += 1;
		if (getBooleanAttribute(span, "connection_reused") === true) {
			entry.reuseCount += 1;
		}

		grouped.set(hostname, entry);
	}

	let candidate: DnsHostInsight | null = null;
	for (const [hostname, entry] of grouped) {
		if (entry.totalCount < 2) {
			continue;
		}

		const avgDnsMs =
			entry.dnsDurations.reduce((sum, value) => sum + value, 0) /
			entry.dnsDurations.length;
		const reuseRate = entry.reuseCount / entry.totalCount;

		if (avgDnsMs > DNS_WARN_MS && reuseRate < 0.2) {
			if (!candidate || avgDnsMs > candidate.avgDnsMs) {
				candidate = {
					hostname,
					avgDnsMs,
				};
			}
		}
	}

	return candidate;
}

function getDnsRepeatedInsight(spans: Span[]): InsightResult {
	const candidate = getDnsRepeatedCandidate(spans);
	if (!candidate) {
		return {
			triggered: false,
			message: "✓ DNS resolution: no repeated DNS bottleneck detected",
		};
	}

	return {
		triggered: true,
		message: `⚠ DNS resolution: ${formatMs(candidate.avgDnsMs)} avg for ${candidate.hostname} — consider DNS caching`,
		fix: DNS_FIX,
	};
}

function getProxyOverheadInsight(spans: Span[]): InsightResult {
	const requestSpans = spans.filter(isRequestSpan);
	const proxiedDurations = requestSpans
		.filter(hasProxy)
		.map((span) => span.duration_ms);
	const directDurations = requestSpans
		.filter((span) => !hasProxy(span))
		.map((span) => span.duration_ms);

	if (proxiedDurations.length === 0 || directDurations.length === 0) {
		return {
			triggered: false,
			message: "✓ Proxy overhead: insufficient proxy/direct samples",
		};
	}

	const proxyAvg =
		proxiedDurations.reduce((sum, value) => sum + value, 0) /
		proxiedDurations.length;
	const directAvg =
		directDurations.reduce((sum, value) => sum + value, 0) /
		directDurations.length;

	if (directAvg > 0 && proxyAvg >= directAvg * 2) {
		return {
			triggered: true,
			message: `⚠ Proxy overhead: ${formatMs(proxyAvg)} avg with proxy vs ${formatMs(directAvg)} direct`,
			fix: PROXY_FIX,
		};
	}

	return {
		triggered: false,
		message: `✓ Proxy overhead: ${formatMs(proxyAvg)} avg with proxy vs ${formatMs(directAvg)} direct (good)`,
	};
}

function getBrowserIdleInsight(spans: Span[]): InsightResult {
	const waits = spans
		.filter(isBrowserSpan)
		.map((span) => {
			const waitMs = getNumberAttribute(span, "wait_ms");
			if (waitMs !== undefined) {
				return waitMs;
			}

			return span.name.toLowerCase().includes("wait")
				? span.duration_ms
				: undefined;
		})
		.filter((value): value is number => value !== undefined);

	if (waits.length === 0) {
		return {
			triggered: false,
			message: "✓ Browser waits: no idle wait spans sampled yet",
		};
	}

	const maxWait = Math.max(...waits);
	if (maxWait > BROWSER_IDLE_MS) {
		return {
			triggered: true,
			message: `⚠ Browser idle wait: ${formatMs(maxWait)} — optimize waitFor conditions`,
			fix: BROWSER_FIX,
		};
	}

	return {
		triggered: false,
		message: `✓ Browser waits: ${formatMs(maxWait)} max (good)`,
	};
}

function getSessionExpiryInsight(spans: Span[]): InsightResult {
	const refreshCount = spans.filter(
		(span) => span.name === "credential.refresh",
	).length;
	const requestCount = spans.filter(isRequestSpan).length;

	if (requestCount === 0) {
		return {
			triggered: false,
			message: "✓ Session refresh frequency: no request spans sampled yet",
		};
	}

	const refreshRate = refreshCount / requestCount;
	if (refreshRate > REFRESH_WARN_RATE) {
		return {
			triggered: true,
			message: `⚠ Session refresh frequency: ${formatPercent(refreshRate * 100)} of requests — adjust session TTL`,
			fix: SESSION_FIX,
		};
	}

	return {
		triggered: false,
		message: `✓ Session refresh frequency: ${formatPercent(refreshRate * 100)} of requests (good)`,
	};
}

export function generateInsights(spans: Span[]): Insight[] {
	if (spans.length === 0) {
		return [];
	}

	const tlsReuse = getTlsReuseInsight(spans);
	const slowTransform = getSlowTransformInsight(spans);
	const largeResponse = getLargeResponseInsight(spans);
	const dnsRepeated = getDnsRepeatedInsight(spans);
	const proxyOverhead = getProxyOverheadInsight(spans);
	const browserIdle = getBrowserIdleInsight(spans);
	const sessionExpiry = getSessionExpiryInsight(spans);

	const rules = [
		makeInsight(
			"tls_reuse_failure",
			tlsReuse.triggered ? "warning" : "info",
			tlsReuse,
		),
		makeInsight(
			"slow_transform",
			slowTransform.triggered ? "warning" : "info",
			slowTransform,
		),
		makeInsight(
			"large_response",
			largeResponse.triggered ? "warning" : "info",
			largeResponse,
		),
		makeInsight(
			"dns_repeated",
			dnsRepeated.triggered ? "warning" : "info",
			dnsRepeated,
		),
		makeInsight(
			"proxy_overhead",
			proxyOverhead.triggered ? "warning" : "info",
			proxyOverhead,
		),
		makeInsight(
			"browser_idle",
			browserIdle.triggered ? "warning" : "info",
			browserIdle,
		),
		makeInsight(
			"session_expiry_frequent",
			sessionExpiry.triggered ? "warning" : "info",
			sessionExpiry,
		),
	];

	return rules;
}
