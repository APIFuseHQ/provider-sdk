---
"@apifuse/provider-sdk": major
---

Phase 3 of the Akamai SBSD track (ADR-0008 / ADR-0010 v1.1): explicit unsafe
replay, engine ceremony egress lease, paid-call metering.

**Breaking: `StealthSession.replayChallenged(response)` is a new required
member.** Providers that keep a structural `StealthSession` double (nol
`__tests__/auth.test.ts`, kakaot `__tests__/stealth-helpers.ts`) add one member:

```ts
const session: StealthSession = {
  fetch,
  replayChallenged: async () => {
    throw new Error("this double does not replay challenged requests");
  },
  cookies,
  redirects: { run },
  close,
};
```

`fetch` never solves or replays an unsafe request (anything but a body-less
GET): a challenged POST/PUT/DELETE returns with
`response.challenge.outcome === "replay_required"`.
`session.replayChallenged(response)` solves the challenge on the same bound
session and replays the original method, URL, headers, and body bytes exactly
once, with the same `throwOnHttpError`, proxy telemetry, and error
normalisation as `fetch`. A second replay (`REPLAY_ALREADY_ATTEMPTED`), a
response from another session (`REPLAY_SESSION_MISMATCH`), and a body outside
`string | Buffer` on the first request (`STEALTH_BODY_UNSUPPORTED`) are typed
errors. The recorded transport in `@apifuse/provider-sdk/testing` rejects
replay with `REPLAY_SESSION_MISMATCH`.

**Ceremony egress lease** — auth flows of providers that declare the
`akamai_sbsd` resolver kind with proxy egress (today: zozotown once it adopts
the SDK resolver). Each auth turn binds the exact proxy endpoint the ceremony
first succeeded on and returns it as an opaque AES-256-GCM handle in the new
wire field `engine.egressLease` of the auth response; the caller (gateway)
carries it verbatim in `engine.egressLease` of the next `/auth/*` request. The
handle is bound to tenant, provider, flow, and affinity and is never projected
into `ctx.context` or `contextPatch`. The binding is best effort, as ADR-0010
requires of a raw Smartproxy endpoint: it is bounded by the vendor session
lifetime (`proxy.session.lifetimeMinutes`, counted from the mint), and it is
released early when the bound endpoint fails at the transport (proxy refusal,
CONNECT failure, socket reset, timeout). Either way the ceremony drops the
remembered SBSD state, selects a fresh endpoint, binds it, and returns the new
handle; after a proxy refusal or CONNECT failure the fresh attempt happens in
the same request whatever the method (the origin never saw the request), after
a reset or timeout the ordinary method-aware retry rule decides. An origin
response of any status keeps the binding. Only an unverifiable or foreign
handle is rejected (`EGRESS_LEASE_INVALID`, 409). Limitation until the gateway
also carries `engine` on error responses: a turn that fails on a dead endpoint
without a same-request retry returns no new handle, so the gateway echoes the
old one and the next turn repeats the release. These turns require `tenantId`
(409 without it); `abort` never evaluates the key or the handle. Engine host
configuration: `APIFUSE__ENGINE__CEREMONY_LEASE_KEY`, at least 32 random bytes
(`openssl rand -base64 32`): a missing key fails these turns with
`EGRESS_LEASE_KEY_MISSING` and a shorter key with `EGRESS_LEASE_KEY_WEAK`
(both 500); rotating it invalidates outstanding handles. The whole
`APIFUSE__ENGINE__*` family is rejected from provider `secrets`.

**Metering.** Every paid resolver vendor call records a `resolver.usage` trace
span (`vendor`, `challenge_kind`, `endpoint`, `billable_units`, `billing`,
`vendor_index` when the resolver chain made the call, `round` for Hyper payload
rounds, `outcome`), including failed creates the vendor may still bill; cache
hits and preflight failures that make no vendor call record nothing. Hyper's
`/ip` reflector is recorded with `billable_units: 0` and
`billing: "unconfirmed"`. `ResolverVendorAdapter.solve` gains an optional
trailing `usage?: ResolverPaidUsageContext` parameter (exported from the package
root and `@apifuse/provider-sdk/runtime/resolver`); existing adapters are
unaffected.
