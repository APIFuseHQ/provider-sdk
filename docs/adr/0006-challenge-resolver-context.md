# ADR: Challenge resolver context

- Status: proposed
- Date: 2026-08-10
- Deciders: Taehoon (owner), Soju (agent)
- Scope: `@apifuse/provider-sdk` anti-bot challenge resolution — provider declaration, `ProviderContext` surface, vendor adapters, and identity binding
- Builds on: `0004-dynamic-egress-ipv4-cidr-targets.md`, `0005-native-egress-ipv6-and-source-cidr-selectors.md` (Pitfall 13 precedent)

## Context

Providers whose upstreams sit behind an anti-bot challenge currently have no
SDK surface to pass one. The measured state across the 31 in-repo providers is
that none solves a challenge: `daiso`, `ohouse`, and `naver-map` detect a
challenge page and raise a typed error, and no provider calls
`ctx.browser.solveChallenge()`.

`ctx.browser.solveChallenge()` already exists but cannot be that surface. Its
implementation locates a reCAPTCHA iframe, clicks `#recaptcha-anchor`, and
returns `{ solved: true }` without reading a token, so a caller receives no
material to submit and no evidence that a challenge was actually satisfied. Its
request type admits only `type: "recaptcha"`.

The trigger is NOL (야놀자). Its login API was measured to be reachable without
a browser and without a proxy from an ordinary data-centre host:

```
POST https://accounts.yanolja.com/api/login/email   (impit, chrome TLS profile)
→ 400 {"error":{"code":"TURNSTILE_TOKEN_FAIL", ...}}   application/json
```

TLS impersonation alone therefore clears transport admission; an empty token and
a syntactically plausible fake token are both rejected, so the server verifies
the token server-side. One field remains unfilled, and no existing SDK surface
can fill it.

Owner directive, verbatim:

> Capsolver같은 resolver를 provider sdk에 정식 도입해서, 확장성 좋게, 프로바이더
> 개념으로 확장해야하는게, 주 목표야

and on scope:

> 이거 뿐만아니라 AWS WAF, CF, hcaptcha, recaptcha등 모두 통용되는 구조로
> 만들었으면 좋겠어

ADR 0005 Pitfall 13 applies directly: this is a public SDK surface whose first
consumer is known, so the extension axis — challenge kind and vendor — is in
scope now rather than after a breaking release.

### Measured vendor contracts

Vendor task shapes were read from vendor documentation rather than inferred.
Two families exist, and they differ in what they return and what they require:

| Family | Vendor task (Capsolver / CapMonster) | Required inputs | Solution | Proxy |
| --- | --- | --- | --- | --- |
| Token | `AntiTurnstileTaskProxyLess` | `websiteURL`, `websiteKey`, optional `metadata.action`/`cdata` | `token` string | not required |
| Token | reCAPTCHA v2/v3, hCaptcha | `websiteURL`, `websiteKey` (+ `action` for v3) | `token` string | not required |
| Cookie | `AntiCloudflareTask` | `websiteURL`, **`proxy` (required)**, optional `userAgent`, optional `html` of the 403 body | `cf_clearance` cookie | required |
| Cookie | `AmazonTask` with `cookieSolution: true` | `websiteURL`, `websiteKey`, `captchaScript`, `context`, `iv`, proxy fields | `cookies` map **and** `userAgent` | required |

The Cloudflare task documents `proxy` as `Required`, and the AWS WAF solution
returns a `userAgent` alongside `aws-waf-token`. Cookie-family solutions are
therefore bound to the network identity that produced them; token-family
solutions are not.

## Decision

### 1. A new `ctx.resolver` context, separate from `ctx.ocr`

Challenge resolution is not an OCR variant and does not share `ctx.ocr`'s
shape. Measured differences:

| Axis | `ctx.ocr` (in design) | `ctx.resolver` |
| --- | --- | --- |
| Call shape | one request/response | create task, then poll |
| Latency | sub-second | seconds to a documented 120 s ceiling |
| Input | image bytes | site key and page URL; Turnstile has no image at all |
| Output | text a caller can read | opaque material a caller cannot verify locally |
| Cost | inference price | per-solve billing, charged on failed attempts too |
| Failure | misrecognition | timeout, vendor balance exhaustion, vendor outage |

`ctx.ocr` remains a general image-to-text capability and is unchanged by this
ADR. A future image-captcha challenge kind may consume it internally, but the
two contexts stay independent.

### 2. Provider declaration gates the capability

Following `ProviderSttConfig`, a provider declares the capability or does not
receive it:

```ts
export interface ProviderResolverConfig {
	/** Ordered vendor fallback chain. */
	readonly vendors: readonly ProviderResolverVendor[];
	/** Challenge kinds this provider is permitted to request. */
	readonly kinds: readonly ProviderChallengeKind[];
}
```

`ProviderDefinition.resolver?: ProviderResolverConfig`, and
`ProviderContext.resolver: ResolverContext`.

An undeclared provider receives an unsupported client whose every call throws,
matching `createUnsupportedSttClient`. Requesting a kind outside the declared
`kinds` is a declaration error, not a silent pass-through: the declaration is
what platform review reads.

### 3. Ordered vendor fallback, following the proxy policy

`ProviderProxyPolicy.providers?: ProviderProxyProvider[]` already models an
ordered vendor chain where "the SDK tries each vendor in order and fails over
to the next when a vendor lacks credentials or its allocation / transport is
exhausted". Resolver vendors have the same properties — external, paid,
credentialed, individually exhaustible — so they take the same shape rather
than `ctx.stt`'s single `APIFUSE__STT__BACKEND`.

Failover advances on: missing credentials, vendor-reported balance exhaustion,
vendor outage or transport failure, and per-vendor timeout. It does not advance
on a vendor's negative verdict about the challenge itself, which is a result,
not a vendor fault.

### 4. SDK-owned neutral challenge and solution types

Providers declare intent; vendor task names, polling cadence, and endpoints are
SDK-owned. This mirrors `ProviderProxyPolicy`, whose type documentation states
that "transport details such as raw CONNECT, origin certificate verification,
and vendor allocator endpoints are SDK-owned".

```ts
export type ProviderChallenge =
	| { kind: "turnstile"; siteKey: string; pageUrl: string; action?: string; cdata?: string }
	| { kind: "recaptcha_v2"; siteKey: string; pageUrl: string }
	| { kind: "recaptcha_v3"; siteKey: string; pageUrl: string; action: string; minScore?: number }
	| { kind: "hcaptcha"; siteKey: string; pageUrl: string }
	| { kind: "cloudflare_interstitial"; pageUrl: string; blockedHtml?: string }
	| { kind: "aws_waf"; pageUrl: string; captchaScript?: string; context?: string; iv?: string };

export type ChallengeSolution =
	| { form: "token"; token: string }
	| { form: "cookies"; cookies: Readonly<Record<string, string>>; userAgent: string };
```

The solution is a discriminated union so a cookie-family result cannot be
submitted as a form token, and a token cannot be installed as a cookie. A
provider that declares only token kinds never handles the cookie branch.

### 5. The SDK binds cookie-family identity; providers never do

For cookie-family kinds the SDK passes the current request's proxy lease and
user agent to the vendor, and installs the returned cookies into the session
that will use them, through the existing
`StealthSessionCookies.setFromCookieStrings`. The provider calls one method and
never learns which proxy lease was assigned.

The rejected alternative is returning cookies for the provider to install. It
fails in a specific and hard-to-debug way: a cookie minted against one egress
IP or user agent is silently invalid on another, so the resolver reports
success and the next upstream request is refused. The provider also cannot
implement it correctly even in principle, because lease assignment is internal
SDK state.

Token-family kinds carry no identity binding, so the same call path performs no
binding work for them.

`ctx.stealth` currently has no user-agent concept; its impit clients derive one
from a browser profile. Cookie-family binding requires the SDK to expose and
pin that value so the vendor is told the same user agent the session will send.
This is new work introduced by this decision, not an existing capability.

### 6. Fail closed, never silently degrade

Missing configuration, an unknown kind, an exhausted vendor chain, and a
timeout all raise a typed `ProviderError` carrying a `fix` message, following
`createUnsupportedSttClient`. There is no fallback to an unsolved request and
no partial success. A caller that receives a `ChallengeSolution` has material
that a vendor asserted is valid.

## Consequences

Positive:

- Providers behind Turnstile, reCAPTCHA v2/v3, hCaptcha, Cloudflare
  interstitials, or AWS WAF share one declaration and one call.
- Vendor substitution is a declaration edit; provider code does not name a
  vendor task type.
- Cookie/token confusion is prevented by the type system rather than review.
- Identity binding lives where the identity is known, so the "solved but
  refused" failure mode cannot be reached by provider mistake.

Negative / accepted:

- Resolver couples to the stealth/HTTP session lifecycle, which is a larger
  change than replicating `ctx.stt`.
- The SDK must introduce user-agent pinning in stealth sessions.
- Cookie-family kinds require a proxy vendor to be configured; without one they
  fail closed.
- Per-solve vendor cost becomes part of a provider's operating profile and is
  charged even for attempts that do not yield a usable solution.

## Rejected alternatives

- **Extend `ctx.browser.solveChallenge()`.** Its result type reports only a
  boolean and a frame URL, it never returns a token, and its request type is
  reCAPTCHA-only. Retrofitting six kinds and two solution families onto it
  would replace the contract while keeping a name that implies browser
  execution is mandatory, which is false for the token family.
- **Fold challenge solving into `ctx.ocr`.** Turnstile supplies no image, so
  OCR's input concept does not exist for the triggering case. The shared
  vocabulary is "captcha", not a shared interface.
- **Expose vendor task names to providers.** `type: "AntiTurnstileTaskProxyLess"`
  in provider source makes the vendor chain inoperative, because a fallback
  vendor uses a different task vocabulary.
- **Single backend selected by env, as `ctx.stt` does.** Solver vendors exhaust
  balance and suffer per-kind outages, so a single backend converts a vendor
  incident into a provider outage.
- **Return cookies for the provider to install.** See Decision 5.
- **Require a browser for every kind.** Token-family vendors document
  proxyless operation, and the measured NOL login path needs no browser at all.
  Mandating a CDP lease would add cost and failure surface to the common case.

## Verification

These must hold before `Status: accepted`:

- A live token-family solve against a real vendor account returns a token that
  the upstream accepts. Not yet run: no solver vendor credential exists in the
  secret store as of this date.
- A live `cloudflare_interstitial` solve returns `cf_clearance` that authorizes
  a subsequent `ctx.stealth` request over the same proxy lease and user agent.
  The `AntiCloudflareTask` `html` field expects the actual 403 body, so the
  request shape cannot be finalized from documentation alone.
- Requesting an undeclared kind throws before any vendor call.
- A token-family provider never triggers proxy or user-agent binding.
- Exhausting every vendor raises a typed error naming the attempted vendors and
  never returns a partial solution.

## When this might break

- A vendor moves a kind from proxyless to proxy-required, which would move that
  kind from the token family to the cookie family.
- Cloudflare or AWS binds a token-family solution to network identity, which
  would collapse the two families into one and make binding universal.
- A challenge kind appears whose solution is neither a form token nor cookies,
  for example a required header or a signed request body.

## References

- `docs/adr/0004-dynamic-egress-ipv4-cidr-targets.md`
- `docs/adr/0005-native-egress-ipv6-and-source-cidr-selectors.md` — the
  half-scoped-axis precedent this ADR is scoped against
- `src/runtime/stt.ts` — capability declaration, gating, and fail-closed pattern
- `src/types.ts` — `ProviderProxyPolicy` vendor chain, `StealthSessionCookies`
- `src/runtime/browser.ts` — the existing `solveChallenge` implementation
- Capsolver documentation: Cloudflare Challenge (`AntiCloudflareTask`, proxy
  required), Turnstile (`AntiTurnstileTaskProxyLess`)
- CapMonster documentation: `AmazonTask` with `cookieSolution`
