# ADR-0013 — Health-monitor upstream capture mode

**Status:** Proposed (pending apifuse#2602 review and the deploy freeze lift on 2026-10-14 18:00Z). This PR lands only the pure, boundary-owned masking core and this record; the directive verification, upstream buffering, and response attachment wiring follow once the contract is accepted.
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
   `buildCaptureEvidence` (this PR): declared `observability.sensitive.output`
   paths are redacted first, then `sanitizeFixture` redacts credential-named keys
   and heuristic-confirmed secrets everywhere else, and request provenance is
   reduced to a query-free scrubbed path (`requestPathForFixture`). Credentials,
   cookies, `Authorization`, tokens, and URL query values never enter the
   evidence.

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
- The masking core is independently testable (`src/__tests__/capture-evidence.test.ts`)
  and asserts that no credential, cookie, token, `Authorization`, or query value
  survives — the security-critical invariant — before any wiring exists.
- A follow-up PR wires directive verification, upstream buffering, and response
  attachment; its release rides with the `beta.71+` bundle after the freeze.
