# ADR: Challenge resolver context

- Status: proposed
- Date: 2026-08-10 (revised same day — see Revision history)
- Deciders: Taehoon (owner), Soju (agent)
- Scope: `@apifuse/provider-sdk` anti-bot challenge resolution — provider declaration, `ProviderContext` surface, vendor adapters, and identity binding
- Builds on: `0004-dynamic-egress-ipv4-cidr-targets.md`, `0005-native-egress-ipv6-and-source-cidr-selectors.md` (Pitfall 13 precedent)

## Revision history

This ADR is still `proposed`; the record below is amended in place rather than
superseded, because the decision did not reverse — an axis was added to it.

**Revision 10 (2026-08-19).** Opening the local Playwright path exposed two
pre-existing assumptions that made it unsafe and non-functional. Authenticated
proxy URL userinfo is now percent-decoded and passed to Playwright as separate
`username` and `password` fields; the `server` contains only scheme, host, and
port. Resolver pages now run inside the existing fail-closed
`withResourcePolicy` interception scope: each exact request URL, including
redirect hops and subresources, is checked against provider `allowedHosts`
before the request is continued. Live Buyee measurement also proved that AWS
WAF challenge infrastructure is required outside the provider host, so
HTTPS subdomains of the explicit internal `.awswaf.com` infrastructure suffix
are admitted for `aws_waf` only; arbitrary third-party hosts remain blocked.
The live policy-constrained solve minted `aws-waf-token` in 4.6 s. Sections
changed: Decision 3a and Verification.

**Revision 9 (2026-08-19).** Revision 8 admitted the browser adapter without a
pool URL but represented the absent optional value as `""`. Because the adapter
uses presence (`cdpUrl !== undefined`) to derive `BrowserClient.requireCdpPool`,
that sentinel incorrectly re-enabled the production pool requirement and kept
the local Playwright path unreachable. Absence now remains `undefined` through
the adapter-factory boundary; the solve-time identity gate and existing
`requireCdpPool` semantics are unchanged. Sections changed: Decision 3a and
Verification.

**Revision 8 (2026-08-19).** The local Playwright path added with Revision 6
could not run through the env-configured resolver: vendor availability treated
an absent `APIFUSE__CDP_POOL__URL` as a missing credential and replaced the
browser adapter before its solve-time proxy-identity gate could run. The CDP
pool URL is optional browser configuration, not a credential. The `"browser"`
vendor is therefore always admitted to its adapter, which fails closed when
neither a pool URL nor a resolved proxy identity exists. Solver-vendor API keys
remain availability credentials. Sections changed: Decision 3a and
Verification.

**Revision 7 (2026-08-18).** The first lazy resolver wiring passed a user agent
only when a provider declared `stealth.profile`. `danawa` and `naver-map` both
declare `proxy: { mode: "required" }` without a stealth profile, so their leases
resolved while the chain still failed closed with `missing_proxy_identity`.
This revision settles the omitted source in subsection 5a: the resolver derives
the user agent from `DEFAULT_PROFILE` (`chrome-146`) through the shared stealth
profile registry when the caller supplies no declared user agent, and records
whether the identity was `declared` or `defaulted` in proxy telemetry and the
resolver trace. A resolved lease with no derivable user agent is classified as
`missing_client_profile`; an absent or unresolvable lease remains
`missing_proxy_identity`. Both are vendor-availability failures and therefore
follow the existing failover rule; optional and absent proxy policies retain
their prior direct/optional behaviour. Sections changed: Decision 5a,
Verification, and the resolver vendor-unavailable reason vocabulary.

**Revision 6 (2026-08-16).** The first provider to declare
`proxy: { mode: "required" }` (`buyee`) exposed that Decision 5 named the SDK as
the identity binder without naming the seam, so no identity ever reached the
chain and every vendor failed closed with `missing_proxy_identity` (#138 Gap 1).
This revision withdraws the `createTransport` seam this ADR itself had proposed —
it carries neither `proxyUrl` nor `userAgent`, and it is not even invoked for the
`browser` or `2captcha` adapters — and records four decisions in its place: lazy
resolution, lease-before-cache ordering, SDK-internal lease resolution driven by
caller-supplied intent, and a grouped `proxyIntent` option. It also extends the
CLI harnesses to resolve a lease, on the grounds that a fixture's validity is
egress-dependent. Revision 4's portability finding was independently
re-confirmed across a different vendor pair while settling the last of these.
Sections changed: Decision 5 (new subsection 5a).

**Revision 5 (2026-08-13).** Implementing the `2captcha` adapter (#135) found
this ADR internally inconsistent about `aws_waf`, and the inconsistency had
already propagated into the shipped type. The vendor task table in Context
records `AmazonTask` as requiring `websiteURL`, `websiteKey`, `captchaScript`,
`context`, and `iv`, and the Revision 1 measurement notes that the page supplies
`window.gokuProps` as (`key`, `iv`, `context`). The proposed `ProviderChallenge`
in Decision 4 nevertheless declared the `aws_waf` variant as `pageUrl`,
`captchaScript?`, `context?`, `iv?` — the site key was dropped between the
measurement and the type. Because the `"browser"` vendor needs only `pageUrl`,
nothing exercised the gap until a solver adapter tried to build the task, so
`aws_waf` shipped as a kind no solver vendor can ever serve. Decision 4 now
carries `siteKey?: string` on the variant, and Decision 8 (new) states how an
absent site key must fail. Sections changed: Context (the table and the
`gokuProps` note are reconciled), Decision 4 (variant gains the field),
Decision 8 (new), and Verification.

**Revision 4 (2026-08-11).** The `"browser"` leg was verified end to end
through a proxy lease, which closes the Revision 3 gap: it reaches the
challenge and solves it from a datacentre host. The same run refuted a claim
this ADR had held since the first draft. `aws_waf` cookie-family solutions are
**not** bound to the egress identity that produced them — a token minted on one
residential lease was accepted verbatim on a different lease, with controls
proving the second lease was genuinely gated without it. Binding is therefore a
per-kind property to be measured, not a property of the cookie family. Sections
changed: Context (Fourth measurement), Decision 3b (cache scope keyed by a
declared binding property), Decision 5 (binding split into a pre-solve axis
that is confirmed and a post-solve axis that is per-kind), Verification (the
negative binding assertion is scoped to kinds that actually bind), and
Consequences.

**Revision 3 (2026-08-11).** The first live run of the `"browser"` vendor
against the real `cdp-pool` in the production cluster failed, and the failure
was environmental rather than a defect: the cluster's egress IP is refused by
`buyee` before any challenge is issued. This exposes an axis both earlier
revisions missed — reaching a challenge is itself IP-gated, so `"browser"` is
not identity-free the way the token family is. Sections changed: Context (Third
measurement), Decision 3a (egress prerequisite), Decision 5 (the binding axis
is reframed from solution-family to reachability), Verification, and Consequences.

**Revision 2 (2026-08-10).** Implementation of the `"browser"` vendor found
that the SDK's browser contract cannot express what Decisions 3b and 5 assume.
`BrowserPage` exposes navigation, input, `evaluate`, frames, and screenshots,
but no cookie accessor, and `src/runtime/browser.ts` contains no cookie handling
at all. `evaluate(() => document.cookie)` is not a substitute for two
independent reasons: it returns only `name=value` pairs, so the `expires` signal
Decision 3b requires cannot be read from it — the Revision 1 measurement of
345,035 s came from a cookie-jar API, not from `document.cookie` — and it cannot
see `httpOnly` cookies at all, which `cf_clearance` is. Decision 3c therefore
adds a cookie accessor to the browser contract as a prerequisite. Sections
changed: Decision 3c (new), Decision 5 (binding sources its values from that
accessor), Verification.

**Revision 1 (2026-08-10).** A second consumer, `buyee`, was measured after the
first draft. It contradicted a premise that had been carried from vendor
documentation alone: that solver vendors are the natural implementation of
every kind. Measured, a local browser resolves the same `aws_waf` challenge
roughly 4x faster than a paid vendor and at zero marginal cost. `"browser"` is
therefore added as a first-class vendor in the chain rather than being treated
as the thing the SDK avoids. Sections changed: Context (Second consumer),
Decision 3, Decision 4 (vendor union), Rejected alternatives (the
browser entry is narrowed to what was actually rejected), Verification, and
Consequences. ADR 0005 Pitfall 13 is the reason this landed as an amendment
now and not as a later widening release.

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
POST https://accounts.yanolja.com/api/login/email   (browser-like Chrome TLS profile)
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

### 2captcha is already in production, without an SDK surface

The gap is not hypothetical. `apifuse-provider-tabelog` solves reCAPTCHA today
from its own provider source, because no SDK surface exists. Measured
2026-08-10:

- Doppler `apifuse/dev` carries `TABELOG_AUTH_CAPTCHA_PROVIDER=2captcha` and a
  populated `TABELOG_AUTH_CAPTCHA_API_KEY`.
- `upstream/auth.ts` (2341 lines) contains `solveRecaptchaTokenWithTwoCaptcha`,
  a full `createTask` / `getTaskResult` client with a 3 s poll interval and a
  180 s ceiling.
- That provider already declares its own solver-vendor union,
  `"2captcha" | "capsolver" | "http"`, and its own captcha proxy policy:

```ts
const TABELOG_CAPTCHA_PROXY_POLICY = {
	mode: "optional",
	providers: ["smartproxy", "nodemaven"],
	geo: { country: "JP" },
	session: { affinity: "auth-flow", lifetimeMinutes: 30, poolSize: 1 },
} satisfies ProviderProxyPolicy;
```

Two conclusions follow. First, a provider re-implementing a vendor client and a
vendor union inside its own source is evidence of a missing SDK capability,
mirroring the `ctx.ocr` track's origin. Second, `ProviderProxyPolicy` is
already the shape a real consumer reached for when binding a solver to network
identity, including an `auth-flow` session affinity — which is the
identity-binding requirement of Decision 5, discovered independently.

`2captcha` is therefore a first-class vendor in this contract, not a future
addition.

### Measured vendor contracts

Vendor task shapes were read from vendor documentation and from the measured
tabelog implementation, rather than inferred. Two families exist, and they
differ in what they return and what they require:

| Family | Vendor task (Capsolver / CapMonster) | Required inputs | Solution | Proxy |
| --- | --- | --- | --- | --- |
| Token | `AntiTurnstileTaskProxyLess` | `websiteURL`, `websiteKey`, optional `metadata.action`/`cdata` | `token` string | not required |
| Token | reCAPTCHA v2/v3, hCaptcha | `websiteURL`, `websiteKey` (+ `action` for v3) | `token` string | not required |
| Cookie | `AntiCloudflareTask` | `websiteURL`, **`proxy` (required)**, optional `userAgent`, optional `html` of the 403 body | `cf_clearance` cookie | required |
| Cookie | `AmazonTask` with `cookieSolution: true` | `websiteURL`, `websiteKey`, `captchaScript`, `context`, `iv`, proxy fields | `cookies` map **and** `userAgent` | required |

The Cloudflare task documents `proxy` as `Required`, and the AWS WAF solution
returns a `userAgent` alongside `aws-waf-token`. Read at the time, that suggested
cookie-family solutions are always bound to the network identity that produced
them. Revision 4 measured otherwise: a vendor's proxy requirement describes how it
obtains a solution, not what the upstream enforces on redemption, and `aws_waf` on
buyee proved portable across leases. Binding is per kind — see Revision 4 and
Decision 5.

Token-family solutions are **conditionally** bound. Capsolver's Turnstile task
is proxyless, but the measured tabelog client selects its 2captcha task by mode:

```ts
type: proxy ? "RecaptchaV2Task" : "RecaptchaV2TaskProxyless",
// and, when proxied, forwards userAgent and cookies alongside the proxy fields
```

A proxied token task is solved from the caller's egress identity, and a
reCAPTCHA token minted that way can be scored against that identity. Binding is
therefore a property of `(kind, vendor, mode)`, not of the kind alone. Recording
it as a per-kind constant would repeat the ADR 0005 Pitfall 13 failure — a
narrowed axis discovered too late by the first real consumer — except that here
the consumer already exists and its code says otherwise.

### Second consumer, measured: `buyee` (2026-08-10)

`buyee` reaches production the same day this ADR was drafted. Four of its
upstream lanes (`mercari`, `rakuma`, `paypayfleamarket`, and Yahoo Auctions)
sit behind AWS WAF, so it is the first real `aws_waf` consumer. Per ADR 0005
Pitfall 13, its measured inputs — not its documentation — were read before
freezing this contract. Every number below is from a live probe against
`https://buyee.jp/mercari/search?keyword=pokemon&lang=en`.

**The challenge is fingerprint-based, not proof-of-work.** The name "JS
challenge" invites the assumption that a JS engine suffices. It does not.
`challenge.js` is 643 KB on one line with 27,462 `_0x`-style identifiers, and
what it computes is a browser fingerprint: canvas rendering (`toDataURL`,
`fillText`, `globalCompositeOperation`), `AudioContext` oscillator output,
`navigator.webdriver` / `plugins` / `hardwareConcurrency` / `battery`, plus
layout and interaction signals (`getBoundingClientRect`, `scrollX/Y`,
`clicks`, `pageY`). It contains no `eval` and no `new Function`.

Execution attempts, in ascending order of environment fidelity:

| Environment | Result |
| --- | --- |
| `curl_cffi` TLS impersonation (`chrome`, `chrome131`, `safari17_0`) | 202 `x-amzn-waf-action: challenge` on all four lanes; JS never runs |
| Warm-up on a WAF-free lane, then cookie carry-over | still 202 |
| Node, no browser globals | `ReferenceError: window is not defined` |
| Node + `window`/`document`/`navigator` shim | `TypeError: document.addEventListener is not a function` |
| Headless Chromium (Playwright) | **solved in 4.5 s**, unattended |
| 2captcha `AmazonTaskProxyless` | **solved in 17.5 s and 25.1 s** across two runs |

Shimming further leads to jsdom, which has no canvas rasterisation, no
WebAudio, and no layout engine — precisely the three signal sources the script
reads. That path is not "add a few globals"; it is authoring a synthetic
browser that must be re-authored whenever the fingerprint logic changes.

**The token is portable and long-lived.** The browser is needed to *mint* the
token, not to serve traffic. Once minted, the `aws-waf-token` cookie (310
chars) transplants into an ordinary stealth session and works there:
`mercari` and Yahoo Auctions both returned 200 with real listings parsed, and
pages 1-3 of a paginated search reused the same token with no re-challenge.
Measured TTL is **345,035 s ≈ 4.0 days** (`expires` 1786698176, minted
2026-08-10T09:12Z). One 4.5 s bootstrap therefore covers roughly four days of
requests, which changes the cost shape of a browser from per-request to
per-lease.

**The solver path works but is strictly worse here**, and two vendor-contract
details in this ADR's original table were wrong for 2captcha and are corrected
by measurement:

- The task type is `AmazonTaskProxyless`, not the Capsolver-vocabulary
  `AntiAwsWafTask`. Sending the latter returns `ERROR_TASK_ABSENT`.
- The solution's token is under `existing_token`, not `cookie` or `token`.
  Reading `cookie` yields an empty string and a silently unusable result — the
  first probe run reported success and then failed verification for exactly
  this reason.
- The page supplies `window.gokuProps` (`key`, `iv`, `context`) plus the
  `challenge.js` URL, so the full-context request shape is available. The
  `key` element of that triple is the site key the `AmazonTask` family requires;
  Revision 5 records that it was missing from the declared variant until #136.

**A solver vendor is itself a browser.** Vendors solve a fingerprint challenge
by running a real browser on their own infrastructure. Choosing a vendor for
this kind is not choosing "no browser"; it is renting someone else's, with a
network round trip and per-solve billing attached.

**We already operate the browser fleet.** `apps/cdp-pool` is a running service
(~1,400 lines) with endpoint health checks, quarantine, queue depth limits, and
per-endpoint page caps, and `createBrowserClient({ cdpUrl })` already attaches
to it. Meanwhile the monorepo contains no solver client at all: the only
solver integration anywhere is `apifuse-provider-tabelog`, which hand-rolled a
`"2captcha" | "capsolver" | "http"` selector inside the provider — evidence
both that the capability belongs in the SDK and that a vendor abstraction with
one in-tree implementation is the status quo being replaced.

### Third measurement: reaching the challenge is IP-gated (2026-08-11)

The first live run of the implemented `"browser"` vendor against the production
`cdp-pool` failed. The proximate error was a CDP `-32000 Failed to find context
with id ...`, which reads like a defect in the adapter. It is not. Narrowing it
by polling `evaluate()` across the whole solve window produced this, twelve
times identically:

```
GOTO ok
POLL_1..12   host=buyee.jp  title="403 Forbidden"  outerHTML.length=117
COOKIES 0
```

A 117-byte `403 Forbidden` is an upstream refusal page. The challenge page is
2,161 bytes and carries `x-amzn-waf-action: challenge`. So the browser was not
failing to solve a challenge — it was never offered one. The `-32000` was a
secondary effect: an isolated world created against the 403 document is
destroyed when the adapter re-navigates on retry.

Confirmed by comparing egress identities against the same URL at the same time:

| Origin | Egress | `buyee` response |
| --- | --- | --- |
| Dev host (the Revision 1 measurement) | residential KR IP | **202, `x-amzn-waf-action: challenge`** |
| Production cluster pod | EKS NAT | **403 Forbidden, 117 bytes** |

Two conclusions, and the second is the load-bearing one:

1. The Revision 1 measurement stands. 4.5 s unattended resolution was real; it
   was measured from an egress that AWS WAF is willing to challenge.
2. **`aws_waf` applies an IP-reputation gate ahead of the challenge gate.** A
   datacentre egress can be refused outright, in which case no amount of
   browser fidelity helps, because the fingerprint script is never served.
   Revisions 1 and 2 both modelled `"browser"` as needing no network identity —
   that framing came from the token/cookie solution split, and it is wrong for
   this kind. Proxy identity is not merely what binds a cookie *after* a solve;
   for `aws_waf` and `cloudflare_interstitial` it is a precondition for the
   solve being possible at all.

This also explains why the failure appeared only now: every earlier probe ran
from the dev host, which is exactly the environment that is not gated. A
capability verified only from a developer workstation can be structurally
unavailable in production.

### Fourth measurement: proxy closes the gate, and binding is absent for `aws_waf` (2026-08-11)

Two questions were open after Revision 3: whether a proxy lease restores the
`"browser"` leg, and whether the post-solve cookie binding this ADR assumed is
real. Both were measured against `buyee` with NodeMaven JP residential leases.

**A proxy lease restores challenge issuance.** A cheap header-only pre-check
established this before spending a browser on it:

| Egress | `buyee` response |
| --- | --- |
| Dev host, no proxy | 202 `x-amzn-waf-action: challenge` |
| NodeMaven, `country-jp` sticky lease | **202 challenge** |
| NodeMaven, no geo targeting | 202 challenge |
| `APIFUSE__PROXY__URL` (smartproxy `as.smartproxy.net`) | **connection failure** |

**The `"browser"` leg then completes from a datacentre host.** Headless Chromium
launched with the lease as its proxy solved the challenge unattended:

```
egress_ip=14.12.148.129   elapsed=13.8s   html_len=615,882
title="pokemon | Shop at Mercari from Japan! | Buyee"   item_anchors=92
aws-waf-token  len=310  domain=.buyee.jp  ttl_s=345,593
```

This closes the Revision 3 outstanding item: `"browser"` is no longer verified
only on developer hardware. Note the solve took 13.8 s rather than the 4.5 s of
Revision 1 — the proxy round trip is a real latency cost, and 13.8 s is the
number a production estimate should use. It is still inside the 120 s vendor
ceiling and remains free of per-solve billing.

**The cookie is NOT bound to its egress identity.** Replaying the token from
lease A on a different lease B was accepted. Because a bare 200 on a residential
IP proves nothing on its own, three controls were run before drawing any
conclusion:

| Control | Result |
| --- | --- |
| C1 — are the leases actually different egresses? | `14.12.148.129` vs `14.11.160.226`, distinct |
| C2 — lease B with **no** cookie | **202 challenge**, 2,161 bytes, 0 items |
| C3 — lease B with a 310-char garbage token | **202 challenge**, 0 items |
| C4 — lease B with the real token from lease A | **200**, 633,670 bytes, 92 items |

C2 is the one that makes the inference sound: lease B is gated on its own, so
the 200 in C4 was produced by the token and not by the IP's reputation. C3 shows
the token is genuinely validated rather than merely present. So for `aws_waf`
the solution is portable across egress identities.

This refutes a claim carried since the first draft — that a cookie minted
against one egress is "silently invalid on another". That statement came from
Capsolver's documentation, which requires `proxy` on the Cloudflare task and
returns a `userAgent` with the AWS WAF solution. Documented proxy requirements
turn out to describe how the vendor obtains the solution, not a constraint the
upstream enforces on redemption, and the two do not have to match.

The honest scope of this measurement: it covers `aws_waf` on `buyee` only.
`cloudflare_interstitial` is untested here, and `cf_clearance` is widely
described as IP-bound, so the likely truth is that binding varies by kind. That
is why Revision 4 makes binding a declared, measured per-kind property instead
of flipping the blanket assumption from "always" to "never".

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

`ProviderResolverVendor` is `"browser" | "2captcha" | "capsolver" |
"capmonster" | "custom"`. `2captcha` is listed before the other paid vendors
because it is the vendor already carrying production traffic; union order is
documentation only, and the effective fallback order is whatever `vendors`
declares.

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

Vendors do not cover the same kinds. A chain therefore skips a vendor that does
not support the requested kind, and exhausting every supporting vendor is
distinct from declaring a chain whose vendors all lack the kind — the latter is
a declaration error surfaced before any network call.

#### 3a. `"browser"` is a first-class vendor, not an escape hatch

```ts
export type ProviderResolverVendor =
	| "browser"      // in-house CDP pool (apps/cdp-pool) via createBrowserClient
	| "capsolver"
	| "capmonster"
	| "2captcha"     // measured in tabelog; see Measured vendor contracts
	| "custom";
```

The `buyee` measurement above showed the first draft had an inverted default:
it modelled resolution as inherently outsourced, when for fingerprint-family
kinds the in-house browser is faster (4.5 s vs 17.5 s), free at the margin,
and already operated as a shared service. A vendor union that omitted
`"browser"` would have forced every AWS WAF provider to pay a vendor to run a
browser we already run.

`"browser"` participates in the chain under the same rules as any other
vendor, which is what makes this an addition rather than a special case. Its
failover triggers map cleanly onto the existing four:

| Chain rule | `"browser"` instance |
| --- | --- |
| missing credentials | neither `cdpUrl` nor a resolved proxy identity is available at solve time |
| allocation exhausted | pool queue depth exceeded, no endpoint available |
| outage / transport failure | CDP connect failure, endpoint quarantined |
| per-vendor timeout | navigation or solve budget elapsed |
| **egress refused before challenge** | upstream returns a block page instead of a challenge (Revision 3) |
| *not* a failover cause | the challenge itself proving unsolvable in a browser |

An omitted pool URL remains `undefined` through browser adapter construction.
It must not be represented by an empty-string sentinel: the adapter derives
`requireCdpPool` from whether the optional value is present, while independently
using its truthiness in the solve-time identity gate.

For a local launch, authenticated proxy URLs are split at the Playwright launch
boundary. URL userinfo is percent-decoded into Playwright's credential fields;
the credential-free server string is the only URL passed as `proxy.server`.
Unauthenticated proxy URLs retain their existing pass-through behavior, and
parse failures never include the supplied URL or userinfo in diagnostics.

The local resolver page applies the provider host declaration to every network
request through `BrowserPage.withResourcePolicy`, not only to the initial
`pageUrl`. The route authorizes the exact `request.url` that Playwright is about
to dial with `assertResolverHostAllowed`; allowed GET, HEAD, and POST requests
continue, while unmatched methods or hosts use the policy's fail-closed block.
This covers top-level navigation, each redirect hop, and subresources.

One challenge-specific exception is required. A live Buyee run observed the
initial challenge script on a tenant `token.awswaf.com` host, an exact
`sdk.awswaf.com` request that returned a 307 to a second tenant token host, and
GET/POST token traffic before the cookie appeared. A policy-constrained run
that admitted only `buyee.jp` plus HTTPS subdomains of `.awswaf.com` solved in
4.6 s while unrelated analytics, advertising, CDN, and translation hosts were
blocked. The AWS suffix is therefore an explicit internal challenge-
infrastructure constant applied only to `aws_waf`; it is not added to provider
`allowedHosts` and is not a general wildcard facility.

This change deliberately does not harden the spelling semantics of
`normalizedResolverHostname`. That matcher still only trims, lowercases, and
strips one trailing dot; legacy-numeric IP forms, IDNA equivalence, and
delimiter-truncation spellings remain a known follow-up. Revision 10 only
applies the existing matcher to every provider-host request and must not be read
as resolving those representation limits.

That last row is the important one and it is load-bearing: if AWS promotes a
lane from `challenge` to `captcha` — a human puzzle — the browser cannot solve
it unattended, and that is a challenge verdict rather than a browser fault.
A declaration of `vendors: ["browser", "capsolver"]` is what makes that
transition survivable without a code change, because a paid vendor with human
solvers remains the only path for a true CAPTCHA. This is the concrete reason
the chain must be ordered and heterogeneous rather than a single selector.

The `egress refused` row is added by Revision 3 and is a genuine vendor fault
rather than a challenge verdict, so it advances the chain: this vendor's egress
is unacceptable to the upstream, and the next vendor — which resolves from its
own network — may still succeed. The adapter must distinguish it from a solve
failure, because the two are indistinguishable at the symptom level: a block
page yields no challenge to fail at, and any execution-context error observed
afterwards is downstream of the refusal, not its cause. Detection is on the
served document (block page versus challenge markers), never on the CDP error.

#### 3a-bis. `"browser"` requires an egress policy for fingerprint kinds

Because reaching the challenge is IP-gated, a `"browser"` leg declared for
`aws_waf` or `cloudflare_interstitial` is only usable from an egress the
upstream will challenge. The SDK already owns this concept:
`ProviderProxyPolicy` with an ordered vendor chain and geo/session affinity,
which `apifuse-provider-tabelog` uses for exactly this purpose
(`{ mode: "optional", providers: ["smartproxy", "nodemaven"], geo: { country: "JP" } }`).

Consequences for this decision:

- The `"browser"` vendor participates in proxy resolution for fingerprint
  kinds, rather than being exempt from it. Its CDP session egresses through the
  resolved lease.
- `mode` must be effectively required, not `optional`, for these kinds. An
  optional policy silently degrades to the cluster's own NAT, which is the
  measured failure — a fail-closed error naming the missing proxy policy is
  strictly better than a 403 surfacing as an opaque CDP error.
- The pool's own egress is a deployment property, not something a provider can
  assert. So this cannot be validated by declaration review alone; it needs the
  live check in Verification.

Recommended orderings, from the measured families:

| Kind | Recommended `vendors` | Why |
| --- | --- | --- |
| `aws_waf`, `cloudflare_interstitial` | `["browser", "capsolver"]` + proxy policy | fingerprint work the in-house pool does faster and free; vendor covers promotion to a human puzzle; proxy is a precondition for both legs |
| `turnstile`, `recaptcha_v2/v3`, `hcaptcha` | `["capsolver", "capmonster"]` | vendors document proxyless operation and a browser adds cost with no fidelity gain |

The `aws_waf` row is measured rather than recommended by analogy: with
`["browser", "capsolver"]`, the `buyee` probe resolved in 4.5 s on the first
leg and never reached the second — **from a residential egress**. From the
production cluster's NAT the same first leg is refused outright (Revision 3),
which is why the proxy policy is part of the recommendation rather than a
tuning detail. `2captcha` is a valid substitute in either
row — it resolved the same `aws_waf` challenge in 17.5 s — and is the vendor a
provider already in production (`tabelog`) uses, so an existing credential
covers it.

#### 3c. The browser contract gains a cookie accessor

The `"browser"` vendor resolves cookie-family kinds, so it must return cookies
with their attributes. The contract has no way to do that today:

```ts
interface BrowserPage extends BrowserFrame {
	close, fill, goto, screenshot, click, type,
	waitForSelector, frames, withResourcePolicy
	// evaluate<T> is inherited from BrowserFrame
}
```

`BrowserPage` therefore gains:

```ts
cookies(): Promise<readonly BrowserCookie[]>;

interface BrowserCookie {
	readonly name: string;
	readonly value: string;
	readonly domain: string;
	readonly path: string;
	/** Unix seconds; absent for a session cookie. */
	readonly expires?: number;
	readonly httpOnly: boolean;
	readonly secure: boolean;
	readonly sameSite?: "Strict" | "Lax" | "None";
}
```

`expires` and `httpOnly` are the two fields that make this an addition to the
contract rather than a helper over `evaluate`. Both `BrowserPage`
implementations must provide it: the CDP-managed page through
`Network.getCookies`, and the local Playwright page through its browser
context's cookie jar. A capability present on only one backend would make
provider behaviour depend on deployment topology.

This accessor is not resolver-specific. Any provider that establishes a session
in a browser and continues it over HTTP needs the same values, and the absence
of this method is why no provider does that today.

Reading cookies stays inside `withIsolatedContext`, so cookies belong to the
lease that produced them and the managed-pool boundary is unchanged: providers
still reach only the pool manager, never a Chrome worker directly.

#### 3b. Solutions are cached to their measured lifetime

A 4-day token obtained in seconds is wasted if it is re-minted per request. The
resolver caches a solution for the lifetime the upstream advertised, and only
re-resolves on expiry or rejection. Cache key and storage layer are
implementation concerns for the plan, but two properties are decided here
because they are correctness, not tuning:

- **The cache key includes the issuing identity only for kinds that are
  identity-bound**, and whether a kind binds is a declared property of the kind
  rather than of the solution family. Revision 4 measured `aws_waf` as *not*
  bound: a token minted on one residential lease was accepted on a different
  lease that was itself gated without it. Keying that kind per-lease would be a
  pure cost — every new lease would pay a fresh solve for a token the upstream
  would have honoured.
- Expiry is taken from the upstream's own signal (the cookie's `expires`)
  rather than a hardcoded constant, so a vendor or upstream shortening the
  lifetime cannot strand the SDK on a stale token.

The safe default for an unmeasured kind is identity-scoped. That direction of
error only wastes solves; the opposite direction — assuming portability for a
kind that actually binds — caches a token that the upstream will refuse, so the
resolver would report success and the next request would fail. Widening a kind
to portable therefore requires the control-backed measurement described in
Verification, not an inference from a vendor's documented proxy requirement.

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
	| { kind: "aws_waf"; pageUrl: string; siteKey?: string; captchaScript?: string; context?: string; iv?: string };

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

Revision 3 reframes what this binding is *for*, and Revision 4 splits it in two.
The original framing derived binding from the solution family: cookies are
identity-bound, tokens are not. Measured, identity operates at two independent
points, and only the first is universal:

| Point | What identity determines | Status |
| --- | --- | --- |
| **Before** the solve | whether the upstream serves a challenge instead of a block page | **Confirmed** for `aws_waf`; datacentre NAT refused, residential/proxy lease challenged |
| **After** the solve | whether the minted cookie is accepted on later requests | **Per-kind.** Refuted for `aws_waf` (portable across leases, controls in Context); presumed for `cloudflare_interstitial`, unmeasured |

The pre-solve axis is why Decision 3a-bis makes a proxy policy a precondition
rather than an optimisation: without an acceptable egress there is no challenge
to solve, whichever vendor is selected.

The post-solve axis is narrower than this ADR originally claimed. Where a kind
does bind, the SDK still installs the cookies into the session that will use
them and pins the user agent, and the lease that earned the challenge is the
lease that redeems it — resolving those from different leases would produce a
solve that succeeds and a cookie that is refused. Where a kind does not bind, as
measured for `aws_waf`, the SDK still owns installation; it simply does not
need to scope the cached solution to one lease.

What does not change is who performs the work. The provider calls one method and
never learns which proxy lease was assigned, because lease assignment is
internal SDK state either way.

The rejected alternative is returning cookies for the provider to install. It
fails in a specific and hard-to-debug way: a cookie minted against one egress
IP or user agent is silently invalid on another, so the resolver reports
success and the next upstream request is refused. The provider also cannot
implement it correctly even in principle, because lease assignment is internal
SDK state.

Token-family binding is conditional rather than absent. When the selected
vendor and kind support a proxyless task, no binding work is performed. When
the resolved chain uses a proxied token task — as the measured tabelog 2captcha
path does — the same SDK-owned binding applies, because the token is then
minted from the caller's egress identity. The provider never chooses between
these modes; the SDK selects from the vendor's capabilities and the provider's
proxy policy.

`ctx.stealth` currently has no user-agent concept; its transport clients derive one
from a browser profile. Cookie-family binding requires the SDK to expose and
pin that value so the vendor is told the same user agent the session will send.
This is new work introduced by this decision, not an existing capability.

**The `"browser"` vendor reaches this from the other side.** A CDP page knows
its own user agent (`navigator.userAgent` is readable, and CDP can set it), so
for that vendor the binding value is available at mint time without the stealth transport
having to expose anything. The cookie half comes from the Decision 3c accessor,
which also supplies the `expires` value Decision 3b caches against; neither is
obtainable from `document.cookie`. This does not remove the stealth transport work — a
`"capsolver"` leg in the same chain still needs the session's UA — but it does
mean the risk is no longer all-or-nothing: the browser leg of cookie-family
binding can be implemented and verified before the transport question is settled.
If the transport turns out not to expose or override its UA, cookie-family support
ships browser-only rather than not at all.

#### 5a. How the identity actually reaches the chain (2026-08-16)

The decision above says the SDK binds identity. It did not say through which
seam, and the gap stayed invisible until a provider declared
`proxy: { mode: "required" }`: `serve.ts` builds the resolver client without an
identity, so `options.identity` is `undefined` at the chain and every vendor
reports `missing_proxy_identity` (#138 Gap 1). The fail-closed behaviour is
correct; what was missing is the plumbing it demands.

**`createTransport` is not that seam, for two independent reasons.** It returns a
`ResolverVendorTransport`, an opaque `fetch` wrapper carrying neither `proxyUrl`
nor `userAgent`, and the opacity is deliberate — a provider must not learn which
lease it was assigned. A proxied solver task needs literal values
(`proxyAddress`, `proxyPort`, `proxyLogin`, `proxyPassword`), which cannot be
recovered from a wrapper. Separately, `createTransport` is only invoked for
adapters that require an upstream transport, and neither `browser` nor
`2captcha` does — so on an `aws_waf` path it never runs at all. The guard also
precedes transport construction, so wiring it would not be reached regardless.
This ADR proposed that seam in an earlier draft; the proposal is withdrawn here
rather than in the issue thread alone, because two attempts have now followed it.

The four decisions below close the axis.

**Resolution is lazy, not eager.** `ResolverChainClient.solve` is already async,
so the guard can await a lease without changing `createProviderContext`'s
signature. Eager resolution would make every request pay for a lease even when
no challenge is encountered.

**Ordering is unchanged: the lease attempt precedes the cache.** Revision 4
established that `aws_waf` tokens are portable, so a cache hit could in
principle be served without a lease. It must not be. `required` means the
upstream refuses this egress outright — measured, in-cluster requests get
`403 Forbidden` with 49 bytes and no challenge at all. A token proves a
challenge was passed; it does not exempt the request from admission. Serving a
cached token over unproxied egress would produce a confident 403. This also
preserves the ordering the first fail-open fix established.

**The SDK resolves the lease itself; the caller supplies intent only.**
`serve.ts` already holds every input needed — the declared policy, an affinity
key derived from the request, telemetry, and the stealth profile that owns the
user agent — and `resolveProxyConfigAsync` (`src/config/loader.ts`) is already
the single proxy source of truth for `ctx.http` and `ctx.stealth`. The resolver
calls the same function rather than growing a second path. A
`resolveIdentity?: () => Promise<ResolverIdentity>` callback was rejected: it is
the caller-supplied-factory shape a sibling negative control already forbids,
and it would let a caller decide which identity the resolver binds.

**Proxy inputs are grouped, not added one by one.** `proxyMode` becomes one
field of a single `proxyIntent` object alongside the affinity key and telemetry.
Widening this option type is this repo's recurring defect — three separate
widenings, one of which leaked the platform's solver API key to any caller
registering a factory — so the surface grows by one field instead of three, and
a reader finds every proxy input in one place instead of inferring which loose
fields interact.

**The CLI harnesses resolve a lease too.** Unlike `identityScope`, which
`serve.ts` derives from a request id a CLI does not have, `affinityKey` is
optional in `ProxyResolutionOptions`, so omitting it is legitimate rather than a
synthesized identity. `apifuse record` must proxy because a fixture is evidence
of what the upstream returns, and that is egress-dependent: the same path
answers `202` with a challenge from a residential or vendor exit and `403` from
the cluster. A fixture recorded over unproxied local egress would assert a
response production never sees. Omitting the affinity key is safe for this kind
specifically because Revision 4's portability finding was re-confirmed on a
different vendor pair (a token minted through one vendor's exit was accepted
verbatim through another's, with the same-exit control passing); for a kind that
does bind, a CLI without an affinity key would need its own decision.

**The resolver owns the user-agent fallback.** A provider-declared
`stealth.profile` remains authoritative: its profile's user agent is passed in
the grouped `proxyIntent` and is marked `declared`. When the provider declares
no profile, the resolver looks up `DEFAULT_PROFILE` from `src/runtime/stealth.ts`
through `src/stealth/profiles.ts` and binds that profile's user agent to the
lease. This keeps one source of truth for user-agent strings and avoids making
server, record, and dev callers duplicate the default lookup. The selected
source is recorded in the existing proxy-resolution telemetry and resolver
vendor-attempt trace; no proxy URL is added to either diagnostic surface.

If the lease resolves but the selected profile cannot produce a user agent, the
resolver reports `missing_client_profile`, distinct from
`missing_proxy_identity`, which is reserved for a missing or unresolvable
lease. Both reasons are vendor-availability failures, so a chain may advance
past them under the same failover rule as the other unavailable-vendor reasons;
the required-policy precondition still fails closed before cache lookup. The
fallback is not applied to optional or absent policies in a way that changes
their existing direct-connection behavior.

### 6. Fail closed, never silently degrade

Missing configuration, an unknown kind, an exhausted vendor chain, and a
timeout all raise a typed `ProviderError` carrying a `fix` message, following
`createUnsupportedSttClient`. There is no fallback to an unsolved request and
no partial success. A caller that receives a `ChallengeSolution` has material
that a vendor asserted is valid.

### 7. tabelog is the first migration target

`apifuse-provider-tabelog` is the reference consumer and the first planned
migration: its in-provider `solveRecaptchaTokenWithTwoCaptcha`, vendor union,
and captcha proxy policy are replaced by a `resolver` declaration and
`ctx.resolver.solve({ kind: "recaptcha_v2", ... })`.

That migration is explicitly **not** part of this ADR's implementation. tabelog
is a separate SoT repository with its own release and deploy gates, and it is
currently serving production traffic through the code being replaced. It is
recorded here so the SDK contract is validated against a real consumer rather
than against documentation, and so the token-family binding axis in Decision 5
stays honest.

Migration preconditions: the SDK surface ships, a `2captcha` adapter exists,
and a live reCAPTCHA v2 solve is verified through `ctx.resolver` producing a
token tabelog's upstream accepts.

### 8. An absent `aws_waf` site key fails as unavailability, not as a fabricated task

`siteKey` is optional on the `aws_waf` variant rather than required, because the
`"browser"` vendor solves the kind from `pageUrl` alone and has done so in
production measurements. Making it required would break every existing
`aws_waf` caller to serve a vendor family that is not yet implemented.

The consequence is that a solver adapter can be handed a challenge it cannot
turn into a task. When that happens the adapter MUST throw
`ResolverVendorUnavailableError(vendor, "not_implemented")` before any network
call, so the chain advances to a vendor that can serve the kind — typically
`"browser"`, which needs no site key. Two failure modes are specifically
forbidden: sending the vendor task with an empty or invented `websiteKey`, and
reporting the absence as a generic transport or timeout failure, which would
make a declaration error look like a vendor outage.

Providers that intend to use a solver vendor for `aws_waf` must therefore read
`window.gokuProps.key` from the challenge page and pass it as `siteKey`. A
provider that only ever uses `"browser"` may continue to omit it.

## Consequences

Positive:

- Providers behind Turnstile, reCAPTCHA v2/v3, hCaptcha, Cloudflare
  interstitials, or AWS WAF share one declaration and one call.
- The existing in-provider 2captcha client in tabelog has a defined
  destination, so the next provider hitting a captcha does not write a third
  one.
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
- **Fingerprint kinds require a proxy vendor even on the `"browser"` leg**
  (Revision 3). The in-house pool is free of *solver* cost but not of *egress*
  cost, so `"browser"` first in the chain reduces spend rather than eliminating
  it. A deployment whose pool egresses through plain cloud NAT cannot serve
  `aws_waf` at all, and that is a property of the cluster rather than of any
  provider declaration.
- Per-solve vendor cost becomes part of a provider's operating profile and is
  charged even for attempts that do not yield a usable solution.
- **Verification cannot be completed from developer hardware.** A residential
  dev egress is exactly the environment that is not IP-gated, so a probe that
  passes there proves nothing about production. Every future challenge-kind
  measurement has to be taken from the deployment's own egress path.
- **Solve latency through a proxy is roughly 3x the direct figure** (13.8 s vs
  4.5 s measured). Caching is what keeps that off the request path; a
  cache-miss request pays the full lease round trip.
- **A portable solution is a shared secret with a 4-day life.** Because
  `aws_waf` tokens are not lease-bound, one cached token can serve every request
  for its lifetime — which is the efficiency win, and also means a leaked cache
  entry is usable by anyone until expiry. The cache is internal SDK state and
  never crosses the provider boundary, but it should be treated as credential
  material rather than as a derived value.
- **`APIFUSE__PROXY__URL` (smartproxy `as.smartproxy.net`) does not connect**
  as of 2026-08-11, while the NodeMaven credentials work. Any provider ordering
  smartproxy first has no working egress today. This is an operational finding
  outside this ADR's scope, recorded here because the measurement surfaced it.

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
- **Return cookies for the provider to install.** See Decision 5. Revision 4
  narrows but does not remove this rejection. Its original justification — that
  a cookie minted on one egress is silently invalid on another — is false for
  `aws_waf` as measured, so that specific failure mode does not apply to every
  kind. The rejection stands on the remaining grounds: a provider cannot scope a
  cached solution correctly without knowing whether its kind binds, cannot read
  the `expires` signal Decision 3b needs from `document.cookie`, and cannot see
  lease assignment at all. Installation staying SDK-side is what keeps those
  three concerns in one place.
- **Require a browser for every kind.** Token-family vendors document
  proxyless operation, and the measured NOL login path needs no browser at all.
  Mandating a CDP lease would add cost and failure surface to the common case.
  This rejection stands, and Revision 1 does not weaken it: `"browser"` is one
  vendor a provider may order first, not a mandatory leg. A Turnstile-only
  provider declaring `["capsolver", "capmonster"]` never acquires a CDP lease.
- **Exclude the in-house browser from the vendor union** *(rejected in
  Revision 1; it was the original draft's implicit position)*. Modelling
  resolution as inherently outsourced fails the measured `aws_waf` case in
  three ways at once: it is ~4x slower (17.5 s vs 4.5 s), it bills per solve
  for work `apps/cdp-pool` already performs for free, and it adds an external
  dependency to a path that has an in-house implementation. It is also
  self-defeating, since the vendor satisfies a fingerprint challenge by running
  a browser anyway — the choice was never browser-or-not, only whose browser.
- **Solve fingerprint challenges in a JS engine without a browser.** Measured
  and rejected on evidence, not preference: `challenge.js` reads canvas,
  WebAudio, and layout, so Node fails at `window is not defined` and a
  hand-written shim fails at the first real DOM call. Completing that path
  means maintaining a synthetic browser whose fidelity must track an
  adversary's fingerprint changes. The SDK does not take that maintenance on.
- **Mint a fresh solution per request.** The measured token lives ~4 days and
  transplants across sessions on the same identity, so per-request resolution
  would multiply latency and vendor cost by roughly three orders of magnitude
  against no correctness gain. See Decision 3b.

## Verification

These must hold before `Status: accepted`:

- A required-proxy provider without `stealth.profile` reaches its resolver
  adapter with the user agent from `DEFAULT_PROFILE`, while a provider with a
  declared profile reaches it with that profile's user agent. Existing proxy
  telemetry and resolver traces identify the source as `defaulted` or
  `declared` without carrying a proxy URL.
- A required lease that resolves while profile lookup produces no user agent
  reports `missing_client_profile`; a lease that cannot be resolved continues
  to report `missing_proxy_identity`. Both remain vendor-availability reasons
  and preserve the chain's existing failover classification.
- The `aws_waf` variant carries `siteKey?`, and a `pack:types` negative control
  proves the field is accepted on `aws_waf` while still rejected on
  `cloudflare_interstitial`, so the Decision 4 widening does not become a
  blanket cookie-family relaxation. Existing `aws_waf` callers that omit it
  still compile.
- A solver adapter handed an `aws_waf` challenge without `siteKey` reports
  `not_implemented` before any network call, and a mutation that instead sends
  an empty or invented `websiteKey` fails the suite (Decision 8).
- A live token-family solve against a real vendor account returns a token that
  the upstream accepts. A 2captcha credential does exist
  (`TABELOG_AUTH_CAPTCHA_API_KEY` in Doppler `apifuse/dev`), so reCAPTCHA v2 is
  verifiable now. Two caveats: that key funds tabelog's production traffic, so
  verification spends live balance and needs owner approval; and 2captcha's
  coverage of `turnstile` and `cloudflare_interstitial` has not been confirmed,
  so those kinds may still need a second vendor account.
- **`aws_waf` on 2captcha is confirmed** (2026-08-10, that same key): task type
  `AmazonTaskProxyless`, solved in 17.5 s, and the returned token authorized a
  subsequent stealth request. Note the two contract corrections in Context —
  the task name is not Capsolver's `AntiAwsWafTask`, and the token arrives as
  `solution.existing_token`, not `solution.cookie`. Reading `cookie` returns an
  empty string and produces a solution that silently fails verification.
- **`aws_waf` on `"browser"` is confirmed from a residential egress**
  (2026-08-10): headless Chromium resolved the same challenge unattended in
  4.5 s with no credential and no spend, and the minted token served paginated
  requests for a measured 345,035 s.
- **`aws_waf` on `"browser"` is confirmed from a datacentre host through a
  proxy lease** (2026-08-11, Revision 4): headless Chromium egressing via a
  NodeMaven JP residential lease reached the challenge and solved it in 13.8 s,
  yielding 92 parsed listings and a 310-char token with a 345,593 s TTL. Use
  13.8 s rather than Revision 1's 4.5 s for production estimates; the delta is
  proxy round-trip cost. The Revision 3 outstanding items are closed by this,
  except the two below.
  - The egress-refusal path is classified as a vendor fault and advances the
    chain, asserted on the served document rather than on a CDP error code.
  - A `"browser"` leg declared for a fingerprint kind with no proxy policy
    fails closed naming the missing policy, rather than silently egressing
    through the cluster NAT.
- A live `cloudflare_interstitial` solve returns `cf_clearance` that authorizes
  a subsequent `ctx.stealth` request over the same proxy lease and user agent.
  The `AntiCloudflareTask` `html` field expects the actual 403 body, so the
  request shape cannot be finalized from documentation alone.
- **Per-kind binding is established by measurement with controls, never by
  assumption in either direction.** The negative assertion — a cookie minted on
  one lease is refused on another — applies only to kinds measured as bound; it
  is **false for `aws_waf`** and asserting it there would be a permanently
  failing gate. The measurement protocol that makes such a result sound, from
  Revision 4:
  - the two leases are confirmed to be different egress IPs;
  - the second lease is confirmed to be gated **without** any token (otherwise a
    200 proves nothing about the token);
  - a syntactically valid garbage token on the second lease is refused (proving
    the upstream validates rather than merely observes the cookie);
  - only then is the real token replayed on the second lease.
  A vendor's documented `proxy: required` is not evidence of redemption binding:
  it describes how the vendor obtains a solution, not what the upstream enforces
  when the solution is used.
- `BrowserPage.cookies()` returns identical attribute sets from the CDP-managed
  and local Playwright backends for the same cookie, including `expires` and
  `httpOnly`. A backend-dependent shape would make caching correctness depend on
  deployment topology.
- `cookies()` observes an `httpOnly` cookie that `evaluate(() => document.cookie)`
  cannot see, which is the property that makes it a contract addition rather
  than a convenience wrapper.
- Requesting an undeclared kind throws before any vendor call.
- Browser vendor availability does not depend on `APIFUSE__CDP_POOL__URL`:
  a resolved proxy identity reaches the local Playwright adapter without it,
  the omitted URL remains `undefined` and produces `requireCdpPool: false`, while
  the adapter still reports `missing_credentials` when neither input is present.
  Solver-vendor API keys retain their existing availability gate.
- An authenticated local proxy launch passes a credential-free server plus
  separately decoded username and password fields to Playwright; reverting the
  split makes the launch-layer regression test fail. Unauthenticated URLs remain
  unchanged and malformed userinfo is not exposed by the error.
- Resolver browser interception continues the declared host and required AWS
  WAF challenge infrastructure, but blocks both a redirect from an allowed first
  hop to link-local metadata and an undeclared subresource. Reverting the scoped
  resource policy makes this regression test fail.
- The real Buyee AWS WAF challenge needs cross-host infrastructure: the measured
  SDK 307 and token GET/POST requests use HTTPS `*.awswaf.com`. With only the
  provider host and the explicit AWS infrastructure exception admitted, local
  Chromium still minted the cookie in 4.6 s.
- A token-family provider never triggers proxy or user-agent binding.
- Exhausting every vendor raises a typed error naming the attempted vendors and
  never returns a partial solution.

## When this might break

- A vendor moves a kind from proxyless to proxy-required, which would move that
  kind from the token family to the cookie family.
- Cloudflare or AWS binds a token-family solution to network identity, which
  would collapse the two families into one and make binding universal.
- A vendor drops proxyless support for a kind, moving that kind's binding from
  conditional to mandatory.
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
- `APIFuseHQ/apifuse-provider-tabelog` — `upstream/auth.ts:66-71` (captcha
  proxy policy), `:1031-1140` (`solveRecaptchaTokenWithTwoCaptcha`),
  `domain/runtime-env.ts:3` (in-provider vendor union)
