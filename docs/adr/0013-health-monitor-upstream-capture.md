# ADR-0013 — Health-monitor upstream capture mode

**Status:** Accepted, with apifuse openspec change `add-health-monitor-upstream-capture` (apifuse#2602), which lands first. This record lands with the pure, boundary-owned masking core (`src/capture-evidence.ts`); the directive verification, upstream buffering, and response attachment wiring follow in a separate PR.
**Type:** Contract / Runtime boundary / Observability
**Date:** 2026-10-13
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
   - declared `observability.sensitive.output` paths. These are OUTPUT
     coordinates: they match only a body shaped like the operation's output,
     not a vendor upstream body, so they do not protect a typical upstream body
     (catchtable my-profile declares `name`/`display_name`/`phone`/`email`; the
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
   - personal data under undeclared or upstream-shaped keys (above);
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
  the tests assert the masked set above and record the known misses (the
  catchtable my-profile upstream shape keeps `name`, `displayName`, and `email`).
- Open item before the wiring PR (raised on apifuse#2602): masking in upstream
  coordinates, or value masking of email/phone (for example with the existing
  `EMAIL_ADDRESS_RUN`), so declared personal data is masked in an upstream body.
- Release: this core is not part of the `beta.71` bundle (`beta.71` = #378 +
  #379). It is internal and unexported, so it ships in whichever release follows
  its landing; the wiring PR decides when capture becomes reachable.
