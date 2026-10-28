// The `X-ApiFuse-Error-Observability` values the Gateway's origin pair test
// (TestProviderProxyVerifiesTheOriginCategoryPair, in the platform monorepo's
// gateway handler tests) hands to the Gateway's parser. Each is an SDK
// 2.2.0-beta.78 error response, recorded byte for byte, with `origin` added
// beside the recorded fields by that test's withOrigin helper, so the keys are
// in Go's encoding order. The SDK's assembly test serves the same failures
// through a real server and checks that the header it writes is the same JSON
// value, so both sides of the header are held to one set of examples.

/** Origin and category pairs the Gateway accepts and classifies from. */
export const GATEWAY_ACCEPTED_ORIGIN_HEADERS = {
	"runtime: plain Error thrown":
		'{"category":"internal_error","origin":"platform","retryable":false,"taxonomyVersion":"2026-10-23"}',
	"runtime: output fails its schema":
		'{"category":"output_validation","origin":"platform","retryable":false,"taxonomyVersion":"2026-10-23"}',
	"runtime: PROXY_REQUIRED code":
		'{"category":"proxy_pool","origin":"platform","retryable":true,"taxonomyVersion":"2026-10-23"}',
	"provider sets upstream_http":
		'{"category":"upstream_http","origin":"provider","retryable":false,"taxonomyVersion":"2026-10-23"}',
	'provider sets credential_unavailable, origin "provider"':
		'{"category":"credential_unavailable","origin":"provider","retryable":false,"taxonomyVersion":"2026-10-23"}',
	'provider sets credential_unavailable, origin "platform"':
		'{"category":"credential_unavailable","origin":"platform","retryable":false,"taxonomyVersion":"2026-10-23"}',
} as const;

/**
 * Pairs the Gateway rejects as `unknown_origin_category_pair`: a platform word
 * reported by provider code, or a provider word reported by the platform. The
 * SDK never writes one of these.
 */
export const GATEWAY_REJECTED_ORIGIN_HEADERS = {
	"provider sets internal_error":
		'{"category":"internal_error","origin":"provider","retryable":false,"taxonomyVersion":"2026-10-23"}',
	"provider sets dependency_unavailable":
		'{"category":"dependency_unavailable","origin":"provider","retryable":true,"taxonomyVersion":"2026-10-23"}',
	'provider sets upstream_http, origin "platform"':
		'{"category":"upstream_http","origin":"platform","retryable":false,"taxonomyVersion":"2026-10-23"}',
} as const;
