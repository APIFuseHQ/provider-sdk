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
