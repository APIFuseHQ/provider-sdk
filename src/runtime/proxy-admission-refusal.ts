import { TransportError } from "../errors.js";

/**
 * Internal attempt classification for a proxy exit the origin's admission
 * layer refused. Surfaces only in proxy telemetry (`attemptSamples[].o ===
 * "error"`, `c === "PROXY_EXIT_REFUSED"`); the request itself is sent
 * once more through the next pool entry, and that attempt's answer is what the
 * caller sees.
 */
export const PROXY_EXIT_REFUSED_CODE = "PROXY_EXIT_REFUSED";

/**
 * Response headers that mark a 403 as a classified challenge the origin wants
 * solved, not a refusal of the egress. AWS WAF announces its challenge and
 * captcha actions in `x-amzn-waf-action`; Cloudflare in `cf-mitigated`.
 */
const CHALLENGE_HEADER_MARKERS: ReadonlySet<string> = new Set([
	"x-amzn-waf-action",
	"cf-mitigated",
	"cf-chl-bypass",
]);

/**
 * Body markers of a solvable challenge page: AWS WAF (`window.gokuProps`,
 * `challenge.js`), Akamai Bot Manager (`sec-bc-tile-container`, `cpr_chlge`),
 * Cloudflare (`cf_chl_opt`, `_cf_chl`), PerimeterX (`px-captcha`, `_pxhd`) and
 * DataDome (`captcha-delivery.com`). A page carrying any of these was served to
 * this exit deliberately and is solvable where it was served, so it is never
 * read as an exit refusal.
 */
const CHALLENGE_BODY_MARKER =
	/window\.gokuProps|challenge\.js|sec-bc-tile-container|cpr_chlge|cf_chl_opt|_cf_chl|px-captcha|_pxhd|captcha-delivery\.com/iu;

/** Challenge pages are small interstitials; a body past this is not scanned. */
const CHALLENGE_BODY_SCAN_MAX_BYTES = 256 * 1_024;

/**
 * True when a proxied first attempt's response reads as the origin's
 * admission layer refusing this exit rather than answering the request: a
 * 403 with no challenge marker in headers or body (a "headerless" 403), or
 * any 5xx. Proxy-level faults (stale pool, edge auth, CONNECT failure) are
 * classified before this runs and never reach it.
 */
export function isAdmissionRefusalResponse(
	status: number,
	headers: Readonly<Record<string, string>>,
	body: string,
): boolean {
	if (status >= 500 && status <= 599) return true;
	if (status !== 403) return false;
	for (const name of Object.keys(headers)) {
		if (CHALLENGE_HEADER_MARKERS.has(name.toLowerCase())) return false;
	}
	if (body.length <= CHALLENGE_BODY_SCAN_MAX_BYTES && CHALLENGE_BODY_MARKER.test(body)) {
		return false;
	}
	return true;
}

export function createProxyExitRefusedError(status: number): TransportError {
	return new TransportError(`Proxy exit was refused admission with status ${status}`, {
		code: PROXY_EXIT_REFUSED_CODE,
		status,
	});
}
