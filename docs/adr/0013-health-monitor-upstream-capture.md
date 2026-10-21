# ADR-0013 — Health-monitor upstream capture mode

**Status:** Accepted, with apifuse openspec change `add-health-monitor-upstream-capture` (apifuse#2602). The pure masking core (`src/capture-evidence.ts`) landed with provider-sdk#380. The wiring (directive acceptance, upstream buffering, response attachment) and the resolution of the upstream-coordinate open item land with the wiring PR that adds `src/server/upstream-capture.ts` and `src/runtime/upstream-capture-recorder.ts`.
**Type:** Contract / Runtime boundary / Observability
**Date:** 2026-10-13 (wiring and option (a) resolution: 2026-10-21)
**Relationship:** Builds on ADR-0010 (`0010-provider-engine-boundary.md`) and ADR-0011 (`0011-remote-only-provider-engine.md`): the capture directive is engine-owned, exactly like the engine-owned env and resolver credentials that ADR-0010/0011 keep off `ctx`. Consumes the credential-masking toolkit in `src/fixture-sanitization.ts`.

## Context

catchtable `reviews` fails closed with `UPSTREAM_SCHEMA_ERROR` because the review
rows only arrive on a *logged-in* upstream session (the authenticated 10-key
review shape, not the anonymous shape the mapper expects). Writing the
`listed`-state mapper and fixture needs a recording of that authenticated
upstream body, which is currently un-gettable:

- A person cannot re-record it: the seed password lives only inside the
  production credential envelope and the authoring host is not a KR residential
  IP (403). The owner declined to record it personally.
- The gateway's `provider-payload-observability` sees only what the *provider*
  returns to the gateway. On fail-close that is an error envelope, not the raw
  upstream body the handler fetched and then rejected. **The upstream body exists
  only inside the provider process, only at the SDK boundary, and only until the
  handler throws.**

So the authenticated body can only be recovered from inside production, through
the seed Connection the health monitor already resolves for authenticated-read
probes — and it must never expose a secret to a person, and the body itself must
be masked before anyone (operator or coordinator) reads it.

## Decision

Add an inert-by-default **capture mode** at the SDK execution boundary.

1. **Engine-owned directive.** An authenticated, single-use capture directive
   (bound to `providerId` + `operationId` + a short expiry) is recognized only
   for a health-monitor-identity request. Like the engine-owned env of ADR-0010,
   it is never attached to handler `ctx`, never a provider-declarable surface,
   and never projected into `ctx.env`. Provider code can neither read nor forge
   it, so capture mode cannot change provider behavior.

2. **Masked evidence on both paths.** When a valid directive is active, the
   boundary buffers the upstream response the handler fetched through SDK-owned
   clients (`ctx.http`, `ctx.stealth`) and attaches masked evidence to the
   operation response whether the handler returned successfully OR failed closed.
   The error envelope is unchanged; evidence rides alongside it and never
   converts a failure into a success or writes a canonical result.

3. **Defense-in-depth masking, inside the process.** Evidence is built by
   `buildCaptureEvidence` (`src/capture-evidence.ts`), which redacts this set
   and claims no more:
   - declared `observability.sensitive.upstream` paths, in the raw upstream
     body coordinates, applied first (resolution below);
   - declared `observability.sensitive.output` paths. These are OUTPUT
     coordinates: they match only a body shaped like the operation's output,
     not a vendor upstream body, so on their own they do not protect a typical
     upstream body (catchtable my-profile declares `name`/`display_name`/`phone`/`email`; the
     upstream carries `data.{name,displayName,phone,email}`);
   - reserved secret-like keys (`isReservedSensitiveKey`, the set the SDK
     already redacts in observability) and credential-named keys
     (`isSensitiveFixtureKey`) at any depth, as whole values;
   - the request's registered secret values (request credentials, connection
     secrets, runtime-registered values) by exact value through the request's
     `DiagnosticRedactor`, in every string, object key, and number; the option
     is required so the wiring cannot omit it;
   - string heuristics (`sanitizeCaptureEvidenceString`): PEM private keys,
     credential header and credential-named assignments, keyless
     `Bearer`/`Negotiate`/`NTLM` tokens of any length, keyless `Basic` tokens
     that decode to `user-id:password`, known token shapes, opaque runs of 24+
     characters that are hex or high-entropy, and the query and fragment of
     absolute, other-scheme, protocol-relative, and relative URL-like runs;
   - request provenance reduced to a query-free scrubbed path
     (`requestPathForFixture`), and the upstream media type reduced to a bare
     lowercased `type/subtype` (omitted when it is not one).

   It **cannot see**, so evidence may still carry:
   - short tokens under non-credential key names (`sessionKey`, `sid`,
     `PHPSESSID`, `authKey`, `loginKey`) unless the value is a registered
     request secret;
   - opaque tokens under 24 characters in prose, outside an auth-scheme echo;
   - personal data under keys that neither the upstream nor the output paths
     declare (the author's declaration is the control for provider data);
   - an unregistered secret used as an object key (keys get registered-value
     redaction only, because the entropy heuristic would rewrite long field
     names);
   - structure inside non-JSON bodies (HTML, form-encoded, XML): such a body is
     one string, so only the string heuristics and registered values apply.

   The health monitor's second masking pass (apifuse#2602) is the next layer,
   not a guarantee that closes these gaps.

4. **Boundary-produced only.** Evidence is produced only by the SDK boundary,
   never by provider code, and never carries the handler's auth or connection
   state.

The health monitor (apifuse) triggers capture through its durable manual-trigger
ledger, applies a second masking pass, and writes a signed, bounded artifact to
the registry bucket for the coordinator to read. Those pieces are specified in
apifuse openspec change `add-health-monitor-upstream-capture` (apifuse#2602).

## Resolution of the upstream-coordinate gap (option a)

The open item recorded with the masking core (output paths do not match an
upstream-shaped body) is resolved with option (a) of the apifuse design: a
provider-declared upstream sensitive path set. An operation declares
`observability.sensitive.upstream`, dot paths with `*` wildcards in the RAW
upstream body coordinates, with the same grammar and the same define-time
validation as `sensitive.input` and `sensitive.output`, for example
`upstream: ["data.name", "data.displayName", "data.email", "data.phone"]`.
`defineProvider()` rejects a malformed path; the contract carries the
declaration verbatim under `observability`.

- `buildCaptureEvidence` applies the upstream paths first, then the output
  paths, then the key and value heuristics.
- Evidence is emitted only for an operation that declares the array. `[]` is the
  author's reviewed statement that the raw body carries no provider-sensitive
  field. An operation without it answers a directive with the skip reason
  `upstream_sensitive_paths_undeclared` and no body, and nothing is buffered for
  it: heuristic masking alone never stands in for a declared field.
- Option (c), a provider-owned raw-to-public mapping, was not chosen because it
  would run provider code on the capture path.

## Wiring (as built)

**Directive.** The Gateway builds `engine.capture` on the operation request
envelope only for an authenticated health-monitor request that asked for
capture: `{ version: 1, nonce, providerId, operationId, requestId, expiresAt }`.
`OperationRequestSchema` accepts any `engine` value (a malformed one parses as
absent), and the `/v1/:operation` route removes the field before anything else
sees the request, so it never reaches `ctx`, `ctx.env`, `ctx.request`, `input`,
or an `operationExecutor` (`ExecutableOperationRequest` is the request without
it). The server accepts the directive only when all of these hold:

- `version` is `1` (`CAPTURE_DIRECTIVE_VERSION`);
- `providerId` is the serving provider and `operationId` is the route operation,
  a declared one;
- `requestId` equals the envelope `requestId`;
- `nonce` matches `^[0-9a-f]{32}$` and this process has not accepted it before.
  The nonce ledger is process-wide, keeps each nonce until its `expiresAt`, and
  when full (10 000 live nonces, the stateful replay cache's default) refuses
  new nonces instead of evicting live ones. Only a directive that passed every
  other rule claims its nonce;
- `expiresAt` is RFC 3339 UTC with milliseconds and
  `now < expiresAt <= now + CAPTURE_DIRECTIVE_MAX_TTL_MS (120000) + CAPTURE_DIRECTIVE_CLOCK_SKEW_MS (5000)`.

Any failed rule leaves capture inactive: the response is byte for byte the one
the request gets without the field. The only trace is the operator log line
`provider_capture_directive` with `result: "inactive"` and the reason
(`CAPTURE_DIRECTIVE_INACTIVE_REASONS`); it never carries a directive field, the
nonce, or evidence. Capture is also inactive on a streaming transport, on auth
routes (`AuthFlowRequestSchema` accepts `engine.capture` and the route drops it
unread), and on a stateful-forwarded execution: the forward envelope schema
omits `engine` from its operation request, so the forwarder cannot carry it and
an owner pod strips it.

**Buffer.** For an accepted directive the server runs the handler inside an
`AsyncLocalStorage` capture recorder (`runtime/upstream-capture-recorder.ts`).
The native `ctx.http` response reader (`toNativeHttpResponse`) and the stealth
response reader (`normalizeResponseWithSignal`, not the SDK's own proxy
diagnostic probe) report each exchange whose body they read; the recorder keeps
the last one as `{ path, status, contentType, bodyText }`. It keeps no header
and only the URL path, so the buffer holds no `Authorization`, cookie, origin,
userinfo, query value, or fragment. A raw body over
`CAPTURE_UPSTREAM_BODY_MAX_BYTES` (1 MiB) is recorded as too large and its text
is not kept. Without a recorder the client hot path does only the
`getStore()` lookup.

**Response.** The JSON operation response gets a top-level
`engine: { capture }` (`OperationEngineResponse`) on the success path
(`{ data, meta?, engine }`) and the error path (`{ error, engine }`) alike; the
error envelope object is unchanged. `capture` (`OperationCaptureOutcome`) is
`{ version: 1, outcome: "captured", evidence }` or
`{ version: 1, outcome: "skipped", reason }`, with reasons
(`CAPTURE_SKIP_REASONS`) in this order: `upstream_sensitive_paths_undeclared`,
`no_upstream_exchange`, `upstream_body_too_large`, `evidence_too_large`
(serialized evidence over `CAPTURE_EVIDENCE_MAX_BYTES`, 512 KiB). The evidence
is `buildCaptureEvidence` over the last exchange (body parsed as JSON when it
parses, else the string), with the operation's upstream and output paths and the
request's `DiagnosticRedactor`. A handler's raw `Response` keeps its
representation, except that a JSON-object body gets the SDK's `engine` key,
replacing any `engine` the handler wrote, so a capture outcome only ever comes
from the SDK; any other raw body is returned unchanged with no outcome
(`non_json_response` in the log). If building the evidence throws, the response
carries no `engine` key (`evidence_build_failed` in the log).

**What stays unseen.** Everything in the cannot-see list above still applies to
the evidence body. In addition, only exchanges whose body the SDK client read are
recorded: a non-2xx `ctx.http` answer that the client discards
(`throwOnHttpError`, retried statuses), streamed bodies (`ctx.http.stream`,
`sse`), and traffic outside `ctx.http`/`ctx.stealth` (browser, native network,
resolver vendors) are not captured. On a stateful source pod whose operation is
forwarded, the handler's upstream call runs on the owner pod, so the source
answers `no_upstream_exchange`.

## Why not the alternatives

- **Reuse payload-observability.** It only has the provider error envelope on
  fail-close, not the raw upstream body — the exact thing we need — and its
  snapshots are truncated for customer traffic. Kept as a diagnostic, not the
  capture mechanism.
- **Provider writes the artifact.** Providers are stateless and must never hold
  durable-write credentials.
- **A capture flag on `ctx`.** Would let provider code branch on capture and
  forge or suppress evidence. The directive is engine-owned precisely to prevent
  that.

## Consequences

- Capture mode is additive and inert: no directive means byte-for-byte identical
  behavior, so normal traffic and synthetic monitoring are unaffected.
- The masking core is independently testable (`src/__tests__/capture-evidence.test.ts`):
  the tests assert the masked set above, record that output paths alone miss the
  catchtable my-profile upstream shape, and show the upstream paths masking it.
- The wiring is covered by `src/__tests__/upstream-capture.test.ts` (acceptance
  rules, nonce ledger, recorder, stealth seam, outcomes) and by the assembled
  `src/__tests__/serve-upstream-capture.test.ts` (the app as `serve()` builds it,
  a `defineProvider` provider, real `ctx.http` against a local upstream).
- The open item raised on apifuse#2602 (upstream-coordinate masking) is closed by
  `observability.sensitive.upstream`. Value masking of email and phone stays a
  possible extra layer, not the control.
- Release: capture becomes reachable with the first release carrying the wiring.
  A provider opts in per operation by declaring `observability.sensitive.upstream`;
  an SDK older than that release rejects the key as an unknown
  `observability.sensitive` field at `defineProvider()`, so a provider declares it
  only once its SDK pin carries the wiring. The Gateway may ship first: an older
  SDK strips the unknown `engine` envelope key.
