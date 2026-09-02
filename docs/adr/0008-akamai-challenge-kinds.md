# ADR-0008 v1.1 amendment: SBSD and safe challenge refetch

- Status: **Accepted (v1.1 amendment)** — ratified by owner (Taehoon) 2026-09-02 on PR #249 ("249 이거 진행 ㄱㄱ")
- Amendment date: 2026-09-02
- Amends: ADR-0008 without superseding its SDK-owned Akamai loop or transport-seam decision
- Implementation status: deferred; this amendment is paper-only
- Evidence snapshots: provider SDK `origin/main` at `55540d7a762fbc9f382d4da1d61ddd4fd94ecce8` and ZOZOTOWN `main` at `85fbd652e579eb6e51c5f990e8654b1993609376`

The owner asked, verbatim:

> 이거 왜 provider가 프록시를 소유해야하는걸까?

and:

> 그리고 Akamai/SBSD가 챌린지도 sdk가 가지고 있어야할것 같네

This amendment does not reverse ADR-0008. D4 already decided that the SDK owns
the Akamai loop and its identity-bound transport. The amendment names the SBSD
protocol the first consumer actually implemented and bounds which initiating
requests the engine may replay after a solve.

## v1.1 evidence

The shipped model has `akamai_sec_cpt` and `_abck`-centred `akamai_sensor`, but
no SBSD kind ([`src/types.ts:290-346`](../../src/types.ts#L290-L346)). The
ZOZOTOWN default branch instead reads `sbsd_o` or `bm_so`, and its README states
that no `_abck` loop is used
([`upstream/sbsd.ts:615-616`](https://github.com/APIFuseHQ/apifuse-provider-zozotown/blob/85fbd652e579eb6e51c5f990e8654b1993609376/upstream/sbsd.ts#L615-L616),
[`README.md:92-97`](https://github.com/APIFuseHQ/apifuse-provider-zozotown/blob/85fbd652e579eb6e51c5f990e8654b1993609376/README.md#L92-L97)). It fetches the
SBSD script, sends the script and state-cookie inputs to Hyper, and posts the
returned payload to the upstream script on the same session
([`upstream/sbsd.ts:556-695`](https://github.com/APIFuseHQ/apifuse-provider-zozotown/blob/85fbd652e579eb6e51c5f990e8654b1993609376/upstream/sbsd.ts#L556-L695)).

That provider implementation also supplies later evidence for D4's rejected
alternative. Commit
[`5d579528`](https://github.com/APIFuseHQ/apifuse-provider-zozotown/commit/5d5795284b91a3416c6e7e22155b94576f445dc4)
added a provider-owned signed exact-route descriptor, validation, binding, and
candidate acquisition on 2026-08-27
([`upstream/sbsd.ts:189-378`](https://github.com/APIFuseHQ/apifuse-provider-zozotown/blob/85fbd652e579eb6e51c5f990e8654b1993609376/upstream/sbsd.ts#L189-L378)). This is the
rejected provider-owned identity/loop design implemented independently, not a
reason to move ownership out of the SDK.

Finally, automatic challenge refetch is a replay operation. The existing
stealth path defaults retries to safe methods and validates explicit unsafe
method policies ([`src/runtime/stealth.ts:1337-1357`](../../src/runtime/stealth.ts#L1337-L1357));
its shared retry policy names `GET`, `HEAD`, and `OPTIONS` as the default safe
set and rejects unsafe methods unless explicitly allowed
([`src/runtime/proxy-retry-policy.ts:29-48`](../../src/runtime/proxy-retry-policy.ts#L29-L48),
[`src/runtime/proxy-retry-policy.ts:346-361`](../../src/runtime/proxy-retry-policy.ts#L346-L361)).
ZOZOTOWN has both a credential-bearing login POST and BFF POSTs
([`domain/auth.ts:712-730`](https://github.com/APIFuseHQ/apifuse-provider-zozotown/blob/85fbd652e579eb6e51c5f990e8654b1993609376/domain/auth.ts#L712-L730),
[`upstream/zozotown.ts:568-574`](https://github.com/APIFuseHQ/apifuse-provider-zozotown/blob/85fbd652e579eb6e51c5f990e8654b1993609376/upstream/zozotown.ts#L568-L574)), so
"retry every fetch transparently" is not a safe contract.

## v1.1 decisions

| # | Decision | Core |
|---|---|---|
| D8 | Add a distinct `akamai_sbsd` challenge kind | SBSD's `sbsd_o`/`bm_so` state and payload exchange are not the `_abck`/`bm_sz` sensor protocol |
| D9 | Preserve D4 ownership for detection, solve, cookie mutation, and eligible refetch | The provider declares site knowledge; the SDK/engine owns solver protocol and exact transport identity |
| D10 | Automatic challenge refetch is unconditional only for safe reads | Unsafe requests, including credential-bearing and BFF POSTs, require an explicit replay contract |

### D8 — SBSD is a separate public kind

`ProviderChallengeKind` is an open extension axis. It gains `akamai_sbsd`; it
does not widen or reinterpret `akamai_sensor`. The kind models the measured
SBSD exchange: page URL, discovered script URL and its UUID/token parameters,
the current session's `sbsd_o` or `bm_so` state, the selected client profile,
and the identity-bound transport needed to fetch the script and submit the
payload. Session cookies and exact egress details remain engine state rather
than provider-supplied values.

`akamai_sbsd` is identity-scoped and not direct-cacheable. A vendor capability
entry may be added only with a measured SBSD task/envelope; the first measured
backend is Hyper Solutions. This closes the public-API extension axis now,
rather than shipping an `_abck`-only abstraction when the first consumer is
measurably SBSD.

### D9 — the engine owns the whole challenge transaction

The initiating stealth session detects the challenge, the resolver adapter
performs its vendor and upstream exchanges through a transport created from
that exact session, the engine installs resulting cookies into that session,
and the engine performs an eligible refetch. A second independent
`resolveProxyConfigAsync` call is not an identity-binding mechanism: current
resolver code does exactly that ([`src/runtime/resolver.ts:824-867`](../../src/runtime/resolver.ts#L824-L867)),
while its optional transport seam is created separately
([`src/runtime/resolver.ts:934-950`](../../src/runtime/resolver.ts#L934-L950)).
The operation and auth assembly paths currently pass proxy intent but no
transport factory ([`src/server/serve-implementation.ts:786-804`](../../src/server/serve-implementation.ts#L786-L804),
[`src/server/serve-implementation.ts:983-1001`](../../src/server/serve-implementation.ts#L983-L1001)).

Providers retain only site knowledge: challenge admission fingerprints,
allowed hosts, geo intent, page/BFF schemas, and success semantics. They declare
`proxy: { mode: "required" }` and the necessary client profile. They do not
receive an exact proxy endpoint, SID, pool index, solver key, or lease-binding
API. ADR-0009 v1.1 defines the engine-owned credential and ceremony-handle
boundary used here.

### D10 — refetch is safe-read-only by default

After one bounded solve, the engine may automatically refetch an initiating
`GET` or `HEAD` using the same session, cookie jar, client profile, and ceremony
lease. `OPTIONS` remains safe in the general retry vocabulary, but is not
assumed to be a protected-resource read. The automatic challenge budget is one
solve and one refetch unless a later decision supplies a narrower measured
budget.

An unsafe method is never replayed merely because challenge detection fired.
It needs an explicit replay contract that identifies the eligible operation,
establishes that its body can be replayed within a bound, and states how
duplicate effects are prevented or tolerated. Without that contract, the
engine may solve and update the session but must return the challenge/replay
requirement instead of resubmitting the request. A credential-bearing POST is
not made replay-safe by hiding its credentials, and a BFF POST is not made
replay-safe by carrying an empty JSON object.

## Anti-goals

- Provider-owned SBSD or `_abck` loops. ADR-0008 D4 already rejected this;
  ZOZOTOWN commit `5d579528` now demonstrates the resulting provider-owned
  transport, signing, and lease complexity.
- Folding SBSD into `akamai_sensor` without a new kind.
- A provider-facing lease acquire/bind API such as
  `ctx.proxy.lease.acquire()` or `ctx.proxy.lease.bind()`.
- Transparent retry of unsafe methods, or a policy that retries every fetch.
- Self-ratification: the draft was Proposed until the owner explicitly
  approved PR #249; only that approval moved the status to Accepted.
- Implementing the Hyper adapter, challenge detection, ceremony lease, cookie
  installation, or refetch machinery in this PR.

## Consequences

- The kind table reflects the measured protocol instead of forcing unrelated
  Akamai artifact families through one shape.
- Providers cannot accidentally split the solver payload, upstream POST, and
  redemption request across identities.
- Protected safe reads can eventually recover without provider wrappers, while
  mutations and credential submissions fail closed until replay semantics are
  explicit.
- The engine must retain session and ceremony state long enough to bind the
  solve and refetch, increasing state-lifecycle and observability work.

## Implementation Roadmap

This ordered gap table records deferred work. It is not an implementation plan
file and does not add decisions beyond D8-D10 and ADR-0009 v1.1.

| Order | Current gap | Deferred implementation work |
|---:|---|---|
| 1 | The model has `_abck`-style `akamai_sensor`, but no measured SBSD kind ([`src/types.ts:330-346`](../../src/types.ts#L330-L346)). | Add `akamai_sbsd` inputs, binding metadata, capability-table drift coverage, and public type/API-report coverage. |
| 2 | No registered adapter serves either Akamai kind; `custom` is the only declared Akamai-capable vocabulary and is unimplemented ([`src/runtime/resolver-vendors/types.ts:34-44`](../../src/runtime/resolver-vendors/types.ts#L34-L44), [`src/runtime/resolver.ts:209-238`](../../src/runtime/resolver.ts#L209-L238), [`src/runtime/resolver.ts:274-279`](../../src/runtime/resolver.ts#L274-L279)). | Add a measured `hypersolutions` SBSD adapter with bounded `/sbsd` and `/ip` response handling and exact host policy. |
| 3 | Hyper is a provider secret in ZOZOTOWN, while SDK solver keys are runtime env inputs ([`index.ts:21-29`](https://github.com/APIFuseHQ/apifuse-provider-zozotown/blob/85fbd652e579eb6e51c5f990e8654b1993609376/index.ts#L21-L29), [`src/runtime/resolver-config.ts:1-5`](../../src/runtime/resolver-config.ts#L1-L5)). | Implement ADR-0009 v1.1's engine-owned Hyper credential and reject/filter every engine-owned solver key at the provider boundary. |
| 4 | Stealth returns responses without challenge detection or resolver invocation ([`src/runtime/stealth.ts:1336-1470`](../../src/runtime/stealth.ts#L1336-L1470), [`src/runtime/stealth.ts:1988-2018`](../../src/runtime/stealth.ts#L1988-L2018)). | Add a bounded response-detector pipeline that classifies supported Akamai HTML/JSON and constructs `akamai_sbsd`. |
| 5 | Resolver identity is independently resolved and server assembly supplies no session-derived transport ([`src/runtime/resolver.ts:824-867`](../../src/runtime/resolver.ts#L824-L867), [`src/server/serve-implementation.ts:786-804`](../../src/server/serve-implementation.ts#L786-L804)). | Create `ResolverVendorTransport` from the initiating stealth session so solver IP measurement, upstream exchange, cookies, UA, and egress are identical. |
| 6 | Stable affinity exists, but Smartproxy extraction is cached for only 15 seconds and pool selection can rotate ([`src/config/loader.ts:243-248`](../../src/config/loader.ts#L243-L248), [`src/runtime/stealth.ts:1394-1460`](../../src/runtime/stealth.ts#L1394-L1460)). | Implement ADR-0009 v1.1's opaque ceremony/solve handle preserving vendor, exact endpoint or SID inputs, pool index, expiry, and affinity. |
| 7 | Resolver returns a solution to provider code; the initiating request is not automatically retried ([`src/types.ts:350-370`](../../src/types.ts#L350-L370), [`src/runtime/resolver.ts:885-1001`](../../src/runtime/resolver.ts#L885-L1001)). | Install cookies into the initiating jar and add the D10 one-solve/one-refetch path for safe reads plus explicit replay contracts for unsafe requests. |
| 8 | Auth request `context` and response `contextPatch` are plain records ([`src/server/types.ts:86-102`](../../src/server/types.ts#L86-L102)). | Keep ceremony/session state engine-side behind opaque handles so cross-turn callers cannot alter affinity or lease selection. |
| 9 | Resolver spans identify vendor and kind but do not record billable units or charge outcome ([`src/runtime/resolver.ts:952-966`](../../src/runtime/resolver.ts#L952-L966)). | Emit one engine-owned usage event per paid task creation, correlated with vendor, kind, attempt, and outcome without exposing credentials. |

---

# ADR: Akamai Bot Manager challenge kinds and the sensor-loop transport seam

- Status: proposed
- Date: 2026-08-12
- Deciders: Taehoon (owner), Soju (agent)
- Scope: `@apifuse/provider-sdk` `ctx.resolver` challenge kinds, vendor capability table, solution forms, and adapter transport contract
- Builds on: `0006-challenge-resolver-context.md`

## Context

ADR 0006 shipped `ctx.resolver` with six challenge kinds (`turnstile`,
`recaptcha_v2`, `recaptcha_v3`, `hcaptcha`, `cloudflare_interstitial`,
`aws_waf`), a five-vendor union, an ordered fallback chain, and
identity-scoped caching (PR #120, `0f21a29`). Akamai Bot Manager is absent
from that set. This ADR adds it, and in doing so hits a contract limit that
none of the existing six kinds exposed.

The trigger is `zozotown` (zozo.jp), whose provider work has been blocked
since 2026-08-07 under the recorded diagnosis "zozo.jp 403, Akamai". That
diagnosis was measured to be wrong in two ways on 2026-08-12, and the
corrected measurements are what this ADR rests on. All of the below was
measured from a KR residential host plus NodeMaven residential leases, same
URL within the same minutes.

### Measurement 1 — refusal is TLS/H2 fingerprint, not IP reputation

ADR 0006's `aws_waf` experience (buyee) established the two-gate model:
admission first, challenge second. On buyee, admission was refused by IP and
a residential proxy was the precondition. **zozo.jp behaves the opposite
way.** Five distinct egress identities across three countries, all refused
identically:

| egress | IP | country | result |
|---|---|---|---|
| direct dev host | `125.176.207.140` | KR | 403, 357 B |
| NodeMaven default | `103.11.50.10` | SG | 403 |
| NodeMaven `country-jp` | `124.211.221.69` | JP | 403 |
| NodeMaven `country-jp` | `153.202.52.138` | JP | 403 |
| NodeMaven `country-kr` | `221.149.173.90` | KR | 403 |

A residential proxy — the buyee remedy — buys nothing here. What decides
admission is the client fingerprint (`curl_cffi`, one host, one minute):

| impersonation profile | result |
|---|---|
| `chrome131` / `chrome124` / `chrome116` | 403 `Access Denied` (`Server: AkamaiGHost`) |
| `firefox133` | 403 `Access Denied` |
| **`safari17_0`** | **200 + challenge document** |

### Measurement 2 — no browser in the ladder passes admission

ADR 0006 Revision 1 made `"browser"` a first-class vendor because a headless
Chromium solved buyee's `aws_waf` challenge in 4.5 s. That result does not
generalize to this gate. Every browser rung was run:

| rung | result |
|---|---|
| Playwright Chromium headless | 45 s navigation timeout (challenge loop) |
| Playwright Chromium headful (Xvfb) | 403 |
| real `google-chrome` 149 over CDP | 403 |
| Playwright WebKit headless | 403 |
| Playwright WebKit headful (Xvfb) | 403 |

WebKit is the load-bearing negative: the Safari **TLS profile** passes
admission while the Playwright **WebKit engine** does not, so the boundary is
the full client fingerprint (TLS + HTTP/2 framing + header order) as emitted
by a real macOS Safari, which no Linux browser build in the ladder
reproduces. `curl_cffi` passes precisely because it replays that byte-level
profile without being a browser.

Consequence for the vendor chain: for this kind, `"browser"` is not merely
slower or costlier, it is **incapable** — it cannot obtain the challenge it
would solve. This is the first kind where that is true.

### Measurement 3 — the gate is Bot Manager v3 with three artifact families

The admitted document (2,598 B) and its two scripts (534 KB + 574 KB,
`\xNN`-escaped, `eval`/`new Function` count 0) yield:

- **SEC-CPT press-and-hold**: `sec-if-cpt-container`, `sec-bc-tile-container`,
  `sec-bc-text-container`, `progress-button`, `behavioral-content` all
  present; the deobfuscated script references `sec-cpt`.
- **`_abck` sensor cookie family**: `_abck`, `ak_bmsc`, `bm_s`, `bm_sc`,
  `bm_so`, `bm_sz`, plus the ALB cookie. `bmak` appears 41 times in the
  deobfuscated script — the Bot Manager v3 sensor object.
- **SBSD**: the script names `/.well-known/sbsd`, and that path answers
  `200` to both GET and POST.

Grepping the raw script for fingerprint signals returns nothing; the hex
escaping hides them. Any future audit of an Akamai script must deobfuscate
`(?:\\x[0-9a-fA-F]{2})+` before concluding a signal is absent — a raw grep
here reported zero signals for a script that carries `bmak` 41 times.

### Measurement 4 — WAF scope is per path prefix, and the open lanes are useless

With `safari17_0`, `/brand/` returns 3.4 MB of real content (11,488 brand
slugs), `/shop/` 2.0 MB, `/zozovilla/` 148 KB — while `/search/`,
`/brand/nike/`, `/shop/_/goods/<id>/`, `/category/*`, `/ranking/*` all serve
the challenge. The open lanes are index pages with no product records, so
"some lanes are open" does not yield a viable read path. Do not report a
partially open host as reachable without checking whether the open prefixes
carry the entities the provider needs.

### The contract limit this kind exposes

`ResolverVendorAdapter.solve(challenge, identity, signal, traceRecorder)`
receives no HTTP transport, and `ChallengeSolution` has exactly two forms,
`{form:"token"}` and `{form:"cookies", cookies, userAgent}`. Both existing
cookie-family flows fit that shape because the vendor performs the whole
exchange on its own infrastructure and hands back a finished artifact.

An `_abck` sensor flow does not fit. It is an iterative exchange against the
**upstream's own** script URL: generate a sensor payload, POST it, read the
rotated `_abck` from the response, repeat (vendors document roughly three
rounds before the cookie is trusted). Somebody must hold an HTTP client
bound to the solving identity across those rounds. Today nobody in the
resolver can.

Also measured, and decisive for identity binding: 2captcha's own
press-and-hold documentation states *"You cannot solve the challenge on the
solver's server and then pass the token to your scraper running on a
different IP."* So this kind is identity-scoped, the opposite of `aws_waf`,
which ADR 0006 measured portable on buyee.

## Decision

| # | Decision | Core |
|---|---|---|
| D1 | Add two kinds, `akamai_sec_cpt` and `akamai_sensor`, not one `akamai` | They differ in artifact, vendor capability, and whether interaction is required |
| D2 | `RESOLVER_CHALLENGE_BINDINGS` marks both `identity_scoped` | Vendor-documented IP binding; the safe error direction |
| D3 | `"browser"` declares **neither** kind in `RESOLVER_VENDOR_CAPABILITIES` | Measurement 2: it cannot reach the challenge, so it must report `KIND_UNSUPPORTED_BY_CHAIN`, never `missing_credentials` |
| D4 | Adapters may request an SDK-owned HTTP transport via a new optional `ResolverVendorTransport` seam | The sensor loop needs a client bound to the solving identity; the SDK owns it, per ADR 0006 D5 |
| D5 | No third `ChallengeSolution` form | A sensor loop resolves to `{form:"cookies"}` like any cookie family; the loop is adapter-internal |
| D6 | Provider declaration additionally carries `clientProfile?` | The provider knows which fingerprint reaches its upstream; the SDK cannot guess `safari17_0` |
| D7 | Ship both kinds with `2captcha` capability only, `capsolver`/`capmonster` omitted until measured | Vendor task vocabularies are not interchangeable (ADR 0006 Rev 1); an unmeasured entry is a false capability claim |

### D1 — why two kinds

`sec_cpt` is a rendered widget requiring a press-and-hold gesture;
`sensor` is a headless payload exchange. A vendor can support one without
the other, they need different inputs (page HTML and tile context vs script
URL, current `_abck`, `bmsz`, UA, egress IP), and a lane can be promoted from
`sensor` to `sec_cpt`. Collapsing them into `akamai` reproduces exactly the
`challenge`-vs-`captcha` conflation ADR 0006 Rev 1 warned about for AWS WAF,
and would make the capability table lie for whichever half a vendor lacks.

zozo.jp currently serves both families on the same host, which is why the
first consumer needs both declared rather than one now and one later
(`architectural-decision-records` Pitfall 13: do not ship a half-scoped axis
when the first consumer measurably needs the whole axis).

**[v1.1 amend 2026-09-02: Subsequent implementation evidence showed that the
first consumer's solved protocol is SBSD (`sbsd_o`/`bm_so`), not the `_abck`
sensor loop. D8 closes this Pitfall 13 scope gap by adding distinct
`akamai_sbsd`; the original statement remains as the historical v1.0 record.]**

### D3 — capability and availability stay orthogonal

ADR 0006 Rev 3 recorded three green-suite regressions from conflating "what a
vendor can do" with "whether it is configured". Measurement 2 is the first
case where a vendor's incapability is a *measured upstream property* rather
than a vocabulary gap, so it is also the first real test of that separation.
`{vendors:["browser"], kinds:["akamai_sensor"]}` must resolve to
`KIND_UNSUPPORTED_BY_CHAIN` ("declare a vendor that supports it"), never to
`missing_credentials` ("set the CDP URL", which would never help).

### D4 — the transport seam, and why the provider cannot own the loop

Rejected alternative: return sensor payloads to the provider and let it run
the POST loop. It breaks ADR 0006 Decision 5 — the SDK binds cookie-family
identity because lease assignment is internal SDK state — and `_abck` is
IP-bound, so a provider looping from a different egress than the payload was
generated for produces a cookie the upstream refuses, with the resolver
reporting success. Same failure direction ADR 0006 D3b guards against.

**[v1.1 amend 2026-09-02: ZOZOTOWN commit `5d579528` independently implemented
this rejected provider-owned direction for SBSD, including a signed exact-route
descriptor and bind/acquire machinery. D4 remains unchanged; v1.1 records the
implementation as evidence and assigns the deletable machinery to the engine.]**

The seam is therefore SDK-owned and optional, mirroring how the `"browser"`
adapter receives `cdpUrl`: an adapter that declares no transport need keeps
the current signature, and an adapter that needs one gets a client already
bound to the resolved proxy lease and client profile. Absent transport is a
`missing_transport` unavailability (the reason code already exists), not a
silent direct-egress fallback.

### D6 — `clientProfile` is required, not a nicety

Measurement 1 makes the fingerprint a *precondition for the challenge
existing*. A resolver that dials this upstream with a Chrome profile gets a
403 and no challenge, then reports `CHAIN_EXHAUSTED` — indistinguishable from
an adapter bug, and precisely the misdiagnosis ADR 0006 Rev 3 recorded for
buyee's 49-byte 403. The provider declares the profile; the SDK applies it to
the transport it owns.

## Anti-goals

- **No Akamai support on the `"browser"` vendor.** Measured incapable
  (Measurement 2). Revisit only if a browser build reproduces a real Safari
  fingerprint end to end.
- **No `capsolver`/`capmonster` capability entries** until each vendor's task
  name and solution envelope are measured against a live account.
- **No jsdom or synthetic-browser path.** ADR 0006 Rev 1's reasoning applies
  unchanged, and here the script is a 574 KB hex-escaped fingerprint
  collector with zero `eval`.
- **No proxy requirement inherited from `aws_waf`.** Proxy remains a policy
  the provider declares; five-lease measurement shows it is not the lever for
  this gate. It stays relevant only because `_abck` is identity-bound once
  minted.
- **This ADR does not authorize live solver spend.** Adapters land with unit
  coverage; a live run against a paid vendor is production spend needing
  separate owner approval.

## Pitfalls

1. Grepping an Akamai script for fingerprint signals without deobfuscating
   `\xNN` first. Measured: raw grep reported zero signals; deobfuscated
   grep found `bmak` 41 times.
2. Reading a 403 as IP reputation. Run the fingerprint matrix before buying
   or blaming proxy egress.
3. Treating a `200` from this host as success. The admitted document is a
   2,598 B challenge page; assert absence of `sec-if-cpt-container` and
   presence of real entities, never HTTP status.
4. Reporting a partially open host as reachable. Check whether the open path
   prefixes carry the needed entities (Measurement 4).
5. Caching an `_abck` artifact portably. It is identity-bound by vendor
   documentation; the portable direction caches a cookie the upstream
   refuses and the failure surfaces one request later.
6. Passing identity material through a cache-key field whose name contains
   `cookie`. ADR 0006 Rev 3: `ProviderCache.key()` silently redacts it and
   every identity collapses onto one entry. Assert two identities produce
   two different keys.
7. Adding a kind to `ProviderChallenge` without extending both the
   capability table and its drift test. The drift test compares the static
   table against every adapter's `supports()` across all kinds; a new kind
   that skips it rots the table silently.

## Verification

```bash
bun install --frozen-lockfile
bun test                      # baseline solo, never chained after install
bun run check
bun run pack:check
bun run pack:smoke
```

Kind-specific assertions that must hold:

- `{vendors:["browser"], kinds:["akamai_sensor"]}` → `KIND_UNSUPPORTED_BY_CHAIN`.
- `{vendors:["2captcha"], kinds:["akamai_sensor"]}` with no API key →
  `missing_credentials`; with a key but no transport → `missing_transport`.
- Capability verdicts are identical with and without credentials present.
- `resolverChallengeIsIdentityScoped()` is `true` for both new kinds.
- Two different `(proxyUrl, userAgent)` identities produce two different
  cache keys, and neither key contains the proxy password substring.
- Capability-table drift test covers all kinds including the two new ones.

## When this might break

- A browser build reproduces a real Safari TLS/H2 profile → revisit D3.
- Akamai retires SEC-CPT or SBSD, or promotes zozo's lanes to a human
  CAPTCHA → the chain must gain a human-capable vendor; kinds stay valid.
- zozo.jp begins gating by IP as well → the proxy conclusion in Measurement 1
  is time-bound; re-run the five-lease matrix before relying on it.
- A sensor-payload vendor (hypersolutions, anysolver, NSLSolver) is adopted →
  it generates payloads for our egress rather than solving remotely, which
  D4's transport seam already accommodates, but it needs its own capability
  entry and a vocabulary measurement.

## References

- `0006-challenge-resolver-context.md` — resolver contract, chain rules,
  identity-scoped caching, AWS WAF measurements this ADR contrasts against
- `0004-dynamic-egress-ipv4-cidr-targets.md` /
  `0005-native-egress-ipv6-and-source-cidr-selectors.md` — the half-scoped
  axis precedent motivating D1's "both kinds now"
- `src/runtime/resolver-vendors/types.ts` — capability table, adapter
  contract, unavailability reasons
- `src/runtime/resolver-vendors/bindings.ts` — `RESOLVER_CHALLENGE_BINDINGS`
- 2captcha press-and-hold documentation — the same-IP redemption constraint
  behind D2

## Revision 1

D4's transport response carries attributed cookies rather than a flat
name/value record so an adapter can propagate the expiry required for resolver
caching. Expiry uses epoch seconds; session cookies are represented by an
absent value, never CDP's `-1` sentinel, which would appear already expired.

D7 is amended from "2captcha capability only" to "2captcha and custom
capability." `custom` represents an operator-supplied adapter, so filtering it
out as incapable would prevent that adapter from declaring either Akamai kind.
With both kinds declared, an adapter-less `custom` chain now reaches its
supporting attempt and reports `missing_transport` instead of
`RESOLVER_KIND_UNSUPPORTED_BY_CHAIN`, preserving the capability/availability
separation required by ADR 0006 Revision 3.

The Verification claim for keyed `2captcha` is corrected: keyless `2captcha`
reports `missing_credentials`, while keyed `2captcha` reports `not_implemented`
until its adapter lands. `missing_transport` is asserted through a
`requiresTransport` stub adapter, the only reachable transport-requirement path
in this contract-only change.

Resolver cache behavior is now declared exhaustively per challenge kind beside
its identity binding. An IP-bound artifact minted without a recorded egress
identity is unsafe to share, so both Akamai kinds reject direct cache writes;
`cloudflare_interstitial` retains its pre-existing direct-index behavior pending
measurement. Token-family kinds are declared non-cacheable and skip cache reads.

Pitfall 6 above is superseded by #132, which landed on `main` while this branch
was in review. `ProviderCache.key()` no longer drops secret-named selectors: it
keeps them in the key material with their values replaced by an HMAC-SHA256
digest (keyed by `APIFUSE__CACHE__KEY_PEPPER` when configured), so distinct
values no longer collapse onto one entry. The original text is kept because the
identity-separation tests in this change were written against that trap, and
#132's own test update inverted the same assertion from
`firstCookieKey !== secondCookieKey` to `===`. The naming guidance survives the
change for a different reason: field names matching the secret patterns are
still reported as `[secret-scoped#N]` markers in response metadata rather than
raw keys, so identity material belongs under a neutral name such as
`issuerDigest` to stay diagnosable.
