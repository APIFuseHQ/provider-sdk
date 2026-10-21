/**
 * Upstream capture recorder (ADR-0013).
 *
 * The server enters a recorder only around the execution of an operation
 * request whose health-monitor capture directive it accepted. The SDK-owned
 * clients (`ctx.http` native responses, `ctx.stealth` responses) report each
 * exchange whose body they read; the recorder keeps only the last one.
 *
 * With no recorder active the client hot path does nothing beyond the
 * `getStore()` lookup in `activeUpstreamCaptureRecorder()`.
 *
 * The recorded copy holds no request or response header, so it never carries
 * `Authorization`, `Cookie`, or `Set-Cookie`, and it keeps the URL path only,
 * so it never carries origin, userinfo, query values, or fragment. The body is
 * masked later, when the server builds the evidence.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Raw upstream body size, in bytes, above which an exchange is recorded as too
 * large and its text is not kept (skip reason `upstream_body_too_large`).
 */
export const CAPTURE_UPSTREAM_BODY_MAX_BYTES = 1_048_576;

/** One completed upstream exchange, as the recorder keeps it. */
export type RecordedUpstreamExchange =
	| {
			readonly kind: "body";
			/** URL path only: no origin, userinfo, query, or fragment. */
			readonly path: string;
			readonly status: number;
			/** Raw `Content-Type`; reduced to a bare media type in evidence. */
			readonly contentType?: string;
			readonly bodyText: string;
	  }
	| {
			readonly kind: "too_large";
			readonly path: string;
			readonly status: number;
			readonly contentType?: string;
	  };

export interface UpstreamExchangeReport {
	/** Request or final response URL; only its path is kept. */
	readonly url: string;
	readonly status: number;
	readonly contentType: string | undefined;
	/** Raw body size in bytes, before decoding. */
	readonly byteLength: number;
	/** Decoded body text the client already holds; dropped when over the cap. */
	readonly bodyText: string;
}

/** Keeps the last upstream exchange reported inside one capture-active request. */
export class UpstreamCaptureRecorder {
	#last: RecordedUpstreamExchange | undefined;

	get last(): RecordedUpstreamExchange | undefined {
		return this.#last;
	}

	record(report: UpstreamExchangeReport): void {
		const path = urlPath(report.url);
		const contentType = report.contentType === undefined ? {} : { contentType: report.contentType };
		this.#last =
			report.byteLength > CAPTURE_UPSTREAM_BODY_MAX_BYTES
				? { kind: "too_large", path, status: report.status, ...contentType }
				: { kind: "body", path, status: report.status, ...contentType, bodyText: report.bodyText };
	}
}

const recorders = new AsyncLocalStorage<UpstreamCaptureRecorder>();

/** The recorder of the current capture-active request, or `undefined` (the normal case). */
export function activeUpstreamCaptureRecorder(): UpstreamCaptureRecorder | undefined {
	return recorders.getStore();
}

/** Runs `fn` with `recorder` receiving the SDK clients' upstream exchanges. */
export function runWithUpstreamCaptureRecorder<T>(
	recorder: UpstreamCaptureRecorder,
	fn: () => T,
): T {
	return recorders.run(recorder, fn);
}

/** Path of an http(s) URL, resolved like the clients resolve it; `/` for anything else. */
function urlPath(url: string): string {
	try {
		const parsed = new URL(url, "https://capture.invalid");
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.pathname : "/";
	} catch {
		return "/";
	}
}
