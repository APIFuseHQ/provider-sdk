# ADR-0015: smartproxy egress through the vendor gateway with per-attempt session ids, and no proxy pool

- Status: **Proposed**. The owner decided on 2026-10-28 that smartproxy moves to the session-id model NodeMaven already uses and that the allocation pool (`poolSize`, the 15 s extraction cache, the lock) is removed. The username grammar and the sticky lifetime bounds below are read from the vendor's dashboard guide and FAQ and still have to be confirmed against the account's own generated proxy string before the runtime lands.
- Date: 2026-10-28
- Deciders: Taehoon (owner), lane (agent)
- Scope: `@apifuse/provider-sdk` proxy resolution for `ctx.http`, `ctx.stealth`, `ctx.native.network` and the resolver chain; vendor `smartproxy`; the vendor fallback chain.
- Supersedes: ADR-0001 decision 6 ("Scope is the native path only. `ctx.http` / `ctx.stealth` keep using the extraction allocator ... that is a separate change") and the ADR-0003 status note on ADR-0001 that "smartproxy participates through its allocation API". This is that separate change. ADR-0001 decisions 2 to 5 (gateway path, sticky affinity keyed on the account, rotating residential with sticky sessions, SDK-signalled drain) and ADR-0003 decisions 1 and 3 (injected credentials, a real native chain) remain in force and now cover smartproxy on every transport.
- Ticket: APIFUSE-373

## Context

Two proxy resolution models coexisted in the SDK since ADR-0001 (its own
"accepted risk" bullet): NodeMaven synthesized a gateway URL locally with the
session id in the username, smartproxy called an IP-extraction API
(`api.smartproxy.org/web_v1/ip/get-ip-v3?app_key=…&num=<poolSize>&life=<minutes>`)
and received a batch of raw `ip:port` CONNECT endpoints. Everything the
extraction model needed grew around it: a per-affinity pool cache with a 15 s
TTL (a raw endpoint is not a lease), a Redis singleflight lock with a 9 s poll
(`SMARTPROXY_LOCK_POLL_MAX_MS`), up to 3 allocator attempts inside a 9 s
deadline, a stale-pool detector on CONNECT 509/512 with one invalidate-and-refresh
pass, and the policy field `session.poolSize` that sized the batch.

`poolSize` also carried the vendor fallback rule. A transport retry rotated a
flat attempt index across the concatenated per-vendor pool sizes, so the
fallback vendor started at offset `poolSize` of the primary. With the transport
retry ceiling at 8 (`MAX_PROXY_TRANSPORT_RETRY_ATTEMPTS`) every provider on the
`["smartproxy", "nodemaven"]` chain had to declare `poolSize <= 7`, and the
monorepo fix that introduced the rule (apifuse PR #1119, 2026-07-28) bound 8
providers to `poolSize: 6` so NodeMaven was reachable "within the 8-attempt cap".
Thirteen providers declare `session`; their `poolSize` values are 6 (8
providers), 1 (2), 10 (1) and 20 (2), each with a comment restating the offset
rule.

Production did not use the pool as a pool. In the 2026-10-27 16:30Z to
2026-10-28 03:53Z window the CatchTable pods made 254 proxied requests, 622
attempts, 609 successes, all through smartproxy, and the pool index was 0 for
612 attempts and 1 for 10; indexes 2 to 5 were never used. On 2026-10-26 05Z
to 06Z every one of the 6 smartproxy slots failed within 0.45 s ("tunnel closed
immediately") and the 7th attempt succeeded on NodeMaven; the fallback worked,
but only because six attempts had been spent first.

The owner's direction (2026-10-28, verbatim): "애초에 세션 고정용은 그냥
우리가 난수값으로 만들어준 랜덤값 만들어주면 되는거 아니야" and
"poolSize같은 개념 자체가 굳이 있어야하는지?", with the decision that
smartproxy also moves to the session-id model (a random session per request
or connection) and the allocation pool is removed.

### Vendor identity and gateway grammar

Our `smartproxy` is the vendor behind `api.smartproxy.org`; `www.smartproxy.org`
now answers 301 to `www.smartproxy.ai`. It is not Decodo (formerly Smartproxy
Inc., `smartproxy.com`), so Decodo's `session-…-sessionduration-…` grammar does
not apply. The vendor's own text documentation is thin; the user guide pages
carry the grammar only in dashboard screenshots. From the "Residential Proxy →
User&Pass Auth" generator screenshot (user guide, 2026-08):

```
Proxy Server: proxy.smartproxy.net
Port: 3120
username: smart-HUHU123_area-RU_life-5_session-ICUItQ0g4e
password: 6321319abC
```

Tokens are joined with `_`, key and value with `-`: `area-<CC>` (uppercase ISO
3166-1 alpha-2; "Random" omits it), `life-<minutes>` (the "Time" selector:
"Different IP each time" or a fixed number of minutes, the shortest shown is 5),
`session-<id>` (a free-text session field, 10 mixed-case alphanumerics in the
example). The FAQ states "Most plans allow 5-120 min stickiness; exceeding that
limit will force rotation", that username/password works over HTTP and SOCKS5,
and that residential plans are billed per GB, not per session. The dashboard
also offers State and City selectors; their token names are not visible in
text and are not encoded until verified.

User&Pass Auth requires a sub-account ("Please Add User before use"): the
credentials are that user's name and password, not the extraction `app_key`.
No such credentials exist in the deployment today.

## Decision

1. **smartproxy is a gateway vendor on every transport.** The SDK composes
   `http://<user>_area-<CC>_life-<minutes>_session-<id>:<password>@proxy.smartproxy.net:3120`
   (`socks5://` on the same port until the vendor confirms another) from
   `APIFUSE__PROXY__SMARTPROXY_USERNAME` and `APIFUSE__PROXY__SMARTPROXY_PASSWORD`,
   exactly as `proxy-nodemaven.ts` does for NodeMaven. The extraction API, the
   `app_key`, the pool cache, the Redis lock, the allocator retry loop and the
   stale-pool refresh are deleted, not kept behind a flag. The native
   smartproxy adapter uses the same synthesizer, so native connections now get
   `sessionId` and `expiresAt` for smartproxy and the ADR-0001 drain contract
   applies to both vendors.

2. **One session-id rule for both vendors.** `affinity: "request"` (the
   default) mints a random id per attempt: every request, and every retry,
   leaves on a fresh IP. `operation`, `auth-flow` and `connection` derive
   `sid = sha256("<affinityKey>:<windowEpoch>:<attempt>")[0..10)` with
   `windowEpoch = floor(now / lifetimeMinutes)`, so every process serving the
   same key in the same window reaches the same IP with no shared storage, and
   attempt 0 of a request is always the key's own session. Attempt 0 reproduces
   the id NodeMaven derives today, so sticky NodeMaven sessions keep their
   egress across the upgrade. The window is wall-clock aligned on every
   transport; NodeMaven's stealth and HTTP paths previously used the pool
   refresh generation (0 or 1) in place of the epoch and never rotated by time.

3. **A retry is a new session, not a pool slot.** The transport attempt index
   feeds the derivation (rotating: a new random id; sticky: the next derived id),
   so the endpoint that failed is left without any bookkeeping. Nothing
   de-duplicates or refreshes a pool because there is none; `PROXY_POOL_STALE`
   and `PROXY_POOL_EXHAUSTED` keep their code strings (the gateway persists the
   `proxy_pool` category) and now mean "the vendor edge refused this session"
   and "every session the budget allowed was refused".

4. **The fallback rule no longer depends on any policy value.** A request's
   transport attempt budget is split evenly across the declared vendors in
   declaration order: vendor `i` serves attempts `[i × share, (i + 1) × share)`
   with `share = ceil(cap / chainLength)` and the last vendor takes the
   remainder (`mapAttemptToVendor`). The budget is the caller's explicit
   `retry.attempts` when one is pinned, otherwise
   `chainLength × PROXY_ATTEMPTS_PER_VENDOR` (3 per vendor). Every declared
   vendor is reached whenever the budget is at least the chain length, so the
   `poolSize <= 7` rule, the per-provider comments that restate it and the
   runbook section that derives it have no successor. Resolution-time fallover
   (a vendor without credentials or with an unsupported protocol, or an adapter
   error) still moves to the next vendor inside the same attempt.

5. **`session.poolSize` is removed from `ProviderProxyPolicy`** and
   `defineProvider` rejects it as an unknown field. The remaining session
   handles are `affinity`, `lifetimeMinutes` and `drainLeadSeconds`.
   `lifetimeMinutes` is clamped per vendor (smartproxy 5..120, NodeMaven
   1..1440) and the clamp is reported in the resolution diagnostics; a
   provider that declares 1440 on a smartproxy-first chain gets 120 and a
   drain every two hours on that vendor.

6. **The vendor selection is a seam.** `ProxyVendorSelector` (`select` returns
   the vendor and session directive for an attempt plus the resolution-time
   fallbacks; `report` receives every resolution and transport outcome) is the
   only place the chain order and the attempt split live.
   `staticOrderProxyVendorSelector` implements decision 4 and is the process
   default; `setProxyVendorSelector` installs another one. Error-rate or latency
   weighting, circuit breaking, hedging and health checks are the business of a
   separate change that implements the interface; the resolver and the
   transports do not change for it.

7. **Telemetry drops the allocator vocabulary.** The resolution source is
   `smartproxy-gateway`; `cacheStatus` keeps the single value `disabled`; the
   allocator timing, lock wait, pool age and per-attempt pool index fields are
   no longer emitted and persist as NULL in the gateway, as they already did
   for NodeMaven. `ResolvedProxyConfig` carries `sticky`, `sessionId`,
   `expiresAt` and `lifetimeMinutes`; the attempt sample's `proxyHash`
   already differs per session and identifies the attempt's egress. Ceremony
   egress lease handles are minted as v2 without `poolIndex` and `refreshEpoch`
   and with an optional `sessionId`; v1 handles still verify (the version is in
   the AAD) and bind, so a ceremony in flight across the upgrade keeps its
   egress.

## Consequences

Positive:

- No allocator round trip, lock serialization, discarded batch or Redis
  dependency on the proxy path; a resolution is a pure function of the policy,
  the credentials, the affinity key, the attempt and the clock.
- The fallback vendor is reached on attempt `share` of any request, independent
  of any provider declaration; on the 2026-10-26 outage shape (every smartproxy
  session refused in 0.45 s) a CatchTable read reaches NodeMaven on attempt 4
  instead of 7 and an implicit GET on attempt 3 instead of 6.
- Sticky sessions behave the same on every transport and both vendors, and
  native smartproxy connections gain the expiry and drain contract.
- Thirteen provider policies lose a field whose only documented reason was the
  offset rule.

Negative and accepted:

- New vendor credentials. The gateway needs a sub-account username and
  password; `APIFUSE__PROXY__SMARTPROXY_APP_KEY` stops being read by the SDK
  (the monorepo CDP pool keeps its own extraction client and the key). The
  secrets, their registry entries and their projection into provider pods are
  deployment changes that must land before a provider pins this SDK version;
  until then a smartproxy-first chain fails over to NodeMaven at resolution
  time with `no_credentials`.
- Breaking for providers that declare `poolSize` (12 of the 13 clones read on
  2026-10-28): the pin bump fails type-check until the line is removed. The
  comments next to it restate the retired offset rule and are removed with it.
- The smartproxy sticky maximum (120 minutes per the FAQ) is shorter than the
  2000 the extraction `life` accepted and shorter than the 1440 two providers
  declare; those providers rotate every 120 minutes on smartproxy. A native
  provider that needs 24 h stickiness should declare NodeMaven first.
- A rotating policy now resolves a distinct URL per attempt (as NodeMaven
  already does), so the stealth client cache keys one wreq session per attempt
  instead of reusing one for the 15 s batch window; the cache and its bound are
  unchanged.
- Concurrent-session limits on the vendor plan are not documented (the FAQ
  names a 429 for the concurrency tier of unlimited plans only); they are
  observed, not assumed.
- Two vendors still mean two adapters, but they now share the session id, the
  window and the selector, and the username grammar is the only vendor-specific
  part.

## Rejected alternatives

- **Keep `poolSize` as a deprecated, ignored field.** Lets provider pin bumps
  pass unchanged, but leaves a dead declaration (the ADR-0002 failure class)
  and the offset comments in every provider, and `defineProvider`'s unknown
  field check would need a permanent carve-out.
- **A fixed per-vendor attempt budget (3 then the next vendor) regardless of
  the request's budget.** Simpler to state, but an explicit `attempts: 3` on a
  two-vendor chain would never reach the second vendor, which recreates the
  rule this change retires.
- **Alternate vendors on every attempt.** Reaches the fallback on attempt 1
  but spends half of every outage-free retry budget on the fallback vendor;
  the declared order is a preference and the even split keeps it.
- **No session token for rotating policies (vendor-side rotation).** Keeps one
  URL per policy and one wreq session, but the de-duplication and the attempt
  telemetry could no longer tell attempts apart, and the vendor's rotation
  guarantee per CONNECT is not documented.
- **Keep the pool refresh generation as NodeMaven's epoch on stealth and HTTP.**
  Avoids a one-time session change for sticky NodeMaven policies on those
  transports, but leaves `lifetimeMinutes` meaningless there and the native
  path on a different rule.
- **An optional env override for the gateway host and port.** Cheap insurance
  against a wrong port, but a second configuration surface for a value the
  dashboard shows; verification against the account replaces it.
