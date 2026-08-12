# ADR: Image-to-text context (`ctx.ocr`)

- Status: proposed
- Date: 2026-08-11
- Deciders: Taehoon (owner), Soju (agent)
- Scope: `@apifuse/provider-sdk` image-to-text capability — provider declaration, `ProviderContext` surface, backend selection, and the CAPTCHA domain helper
- Builds on: `0006-challenge-resolver-context.md` (Decision 1 draws the boundary this ADR sits on the other side of)

## Context

The SDK has no image-to-text surface. A provider that must read characters out
of an image has to leave the SDK entirely.

### Measured consumer: the ZOZOTOWN bounty submission

`APIFuseBounty/apifuse-zozotown-bounty-rmagur1203` commit `0fa837f` (2026-06-25)
implements 9 operations plus an id/password login whose CAPTCHA is an 8-character
image (`/^[A-Za-z0-9]{8}$/`, served from `zozo.jp/captcha` under the login
session). To read it, the submission ships its own OCR stack inside the provider
repository:

```
ocr/main.py          149 lines   HTTP service exposing POST /solve
ocr/rectify.py       193 lines   TPS + homography candidate rectifier (OpenCV)
ocr/ocr_client.py     77 lines   OpenAI-compatible /chat/completions client
docker-compose.yml              llama.cpp serving ggml-org/GLM-OCR-GGUF (CPU),
                                plus a vLLM GPU profile for zai-org/GLM-OCR
```

`domain/auth.ts` reaches it with `process.env.ZOZO_OCR_URL` and a bare global
`fetch`, bypassing `ctx.env` and `ctx.http` — its own comment says so:

> Uses the global fetch because the sidecar is an operator-trusted internal
> dependency, not the upstream API.

That is the shape of a missing SDK layer, not contributor error. STT has five
layers the same problem would otherwise need: `ctx.stt`, env-driven backend
selection, a fail-closed unsupported client, the `extractVerificationCode`
domain helper, and a test override. OCR has none of them, so the contributor
rebuilt all five in Python.

### GLM-OCR is not available on Workers AI

Measured against our account (61 models): the only `zai-org` entries are
`@cf/zai-org/glm-4.7-flash` and `@cf/zai-org/glm-5.2`, both Text Generation with
no vision capability. GLM-OCR exists only as weights to self-host. A
Cloudflare-only backend set therefore cannot express the choice this consumer
already made.

### Measured model benchmark (2026-08-10/11)

120 8-character CAPTCHAs from `szili2011/captcha-ocr-dataset` (Apache-2.0),
40 per difficulty tier, 600 calls total, 0 transport errors. Full method and
caveats: `~/benchmarks/ocr-captcha/2026-08-10/README.md`.

| Model | exact | char_acc | p50 | p95 | $/1k calls |
| --- | --- | --- | --- | --- | --- |
| `@cf/google/gemma-4-26b-a4b-it` | **70.8%** | **92.4%** | 0.57s | 2.92s | **$0.032** |
| `@cf/moonshotai/kimi-k2.7-code` | 64.2% | 85.8% | 2.52s | 40.4s | $1.21 |
| `@cf/moonshotai/kimi-k2.6` | 63.3% | 83.2% | 3.38s | 41.9s | $2.50 |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | 60.0% | 86.2% | 0.54s | 1.02s | $0.054 |
| `@cf/moondream/moondream3.1-9B-A2B` | 44.2% | 80.5% | 0.34s | 1.54s | $0.234 |

Per-tier exact match, 40 samples each:

| Model | easy | medium | hard |
| --- | --- | --- | --- |
| gemma-4-26b | 87.5% | **77.5%** | **47.5%** |
| kimi-k2.7-code | **97.5%** | 57.5% | 37.5% |
| kimi-k2.6 | 95.0% | 57.5% | 37.5% |
| llama-4-scout | 87.5% | 52.5% | 40.0% |
| moondream3.1 | 77.5% | 37.5% | 17.5% |

Four results drive the decisions below.

**Scale does not buy CAPTCHA accuracy.** A 26B model beats both 1T reasoning
models. kimi-k2.6 costs 78x more per call, runs 6x slower, and scores 7.5pp
lower. Per correct hard-tier answer: gemma $0.00007, kimi-k2.6 $0.00667 (95x).

**Reasoning inverts under distortion.** kimi leads easy by 10pp then loses
20pp on medium. Hard-tier char_acc separates the mechanism: gemma 84.3% vs
kimi-k2.6 61.9%. gemma degrades toward the right answer; kimi produces confident
different answers.

**An OCR-tagged model finished last.** moondream3.1 is documented for OCR and
scored 44.2%, with 27/120 wrong-length answers and outright hallucination
(`MUSIC` for truth `zvDsARKR`). It is also second most expensive: 752 input
tokens per image against ~300 for messages-style models, at 3x the unit price.

**Every candidate needed a different calling convention.** Each was established
by measurement, and each fails silently with HTTP 200 if ignored:

| Model | Requirement | Failure if ignored |
| --- | --- | --- |
| moondream3.1 | `task:"query"` + `stream:true` | `{"result":{}}` |
| gemma-4-26b | `chat_template_kwargs.enable_thinking:false` | empty `content`, 8x neurons |
| kimi-k2.6 / k2.7-code | `max_tokens>=3000`; thinking cannot be disabled | `finish_reason:"length"`, empty `content` |
| llama-4-scout | plain OpenAI messages | — |

`llama-3.2-11b-vision` was excluded: Workers AI requires an account-level
acceptance of Meta's Community Licence including a domicile representation,
which is an owner decision.

### Relationship to ADR 0006

ADR 0006 Decision 1 already drew this boundary from the other side, and its
axis table is reproduced here as the shared record:

| Axis | `ctx.ocr` | `ctx.resolver` |
| --- | --- | --- |
| Call shape | one request/response | create task, then poll |
| Latency | sub-second | seconds to a documented 120 s ceiling |
| Input | image bytes | site key and page URL; Turnstile has no image at all |
| Output | text a caller can read | opaque material a caller cannot verify locally |
| Cost | inference price | per-solve billing, charged on failed attempts too |
| Failure | misrecognition | timeout, vendor balance exhaustion, vendor outage |

Two further asymmetries were measured while writing this ADR.
`ChallengeSolution` is `{form:"token"}` or `{form:"cookies", userAgent}`; OCR
output is plaintext a provider types into a form field and fits neither. And
0006's identity binding — for the solutions that bind, one is only valid on the
egress and user agent that produced it — has no analogue here, because recognised
characters do not depend on the egress that fetched the image. That asymmetry
holds however narrow the binding turns out to be: 0006 treats binding as a
property of `(kind, vendor, mode)` rather than a constant, and Revision 4 has
since measured `aws_waf` cookies as portable across egresses, splitting cookie
cache scope per kind. OCR output is unbound under every one of those readings.

## Decision

### 1. A new `ctx.ocr` context, independent of `ctx.resolver`

`ProviderContext.ocr: OcrContext`. The two contexts stay independent per ADR
0006 Decision 1. A future `kind: "image_text"` challenge may consume `ctx.ocr`
internally; that is layering, not merging, and does not change either surface.

```ts
export interface OcrContext {
	recognize(request: OcrRecognizeRequest): Promise<OcrResult>;
	extractCaptchaText(
		image: OcrImageInput,
		options?: OcrCaptchaOptions,
	): Promise<OcrCaptchaResult>;
}
```

Two methods, not one. `recognize` is the general capability; `extractCaptchaText`
carries the constraint and candidate handling that Decisions 4 and 5 justify.
Document OCR with structured output is deliberately absent: no in-repo provider
needs it, so the option surface is kept extensible (`hint`, and room for an
output shape) rather than the contract being fixed on speculation.

### 2. Provider declaration gates the capability

Following `ProviderSttConfig` and `ProviderResolverConfig`:

```ts
export interface ProviderOcrConfig {
	readonly mode: "required" | "optional";
}
```

`ProviderDefinition.ocr?: ProviderOcrConfig`. An undeclared provider receives an
unsupported client whose every call throws `OCR_UNAVAILABLE` with a `fix`
message, matching `createUnsupportedSttClient`. `define.ts` validates the shape
the way it already validates `stt`.

### 3. Env-selected backend, with an OpenAI-compatible second backend

```
APIFUSE__OCR__BACKEND               "cloudflare-workers-ai" | "openai-compatible"
APIFUSE__OCR__MODEL                 defaults per backend
APIFUSE__OCR__CLOUDFLARE_API_TOKEN  cloudflare-workers-ai
APIFUSE__CLOUDFLARE__ACCOUNT_ID     shared with STT
APIFUSE__OCR__BASE_URL              openai-compatible
APIFUSE__OCR__API_KEY               openai-compatible, optional
```

Default backend `cloudflare-workers-ai`, default model
`@cf/google/gemma-4-26b-a4b-it`. STT already uses this Cloudflare account and
token pattern, so the default path adds no operational surface.

The second backend is required, not a convenience. GLM-OCR is absent from
Workers AI, and the ZOZOTOWN submission is measured demand for exactly that
model. `openai-compatible` covers self-hosted llama.cpp and vLLM through one
`/chat/completions` shape — the same interface the contributor's `ocr_client.py`
already speaks.

The SDK owns per-model quirks. `enable_thinking:false` for gemma, stream parsing
for moondream, and a large token budget for reasoning models are applied by the
runtime, so switching `APIFUSE__OCR__MODEL` cannot silently produce empty
results. An unknown model id on a known backend uses the messages shape and is
reported in the error `fix` if it returns nothing usable.

### 4. `length` and `charset` are contract-level constraints

```ts
export interface OcrCaptchaOptions {
	readonly length?: number;
	readonly charset?: string | RegExp;
	readonly caseSensitive?: boolean;   // default true
	readonly maxCandidates?: number;    // default 3
}
```

Measured value on the benchmark set: relaxing case moves gemma from 70.8% to
74.2%, and folding homoglyphs (`I/l/1`, `O/0`, `S/5`, `Z/2`) reaches 83.3%.
Half of gemma's 35 errors are of that class: 4 case-only and 11 homoglyph
against 20 genuine misreads. Sites differ on whether their CAPTCHA comparison is
case-sensitive, so the SDK must not fold silently — the provider declares it.

Length is the cheap filter. moondream returned a wrong-length answer 27 times in
120; gemma 7, kimi-k2.6 8, and kimi-k2.7-code / llama-4-scout 6 each. A declared
`length` lets the runtime mark those results invalid before a provider submits
them.

`charset` means "the set of characters this text may contain", and both accepted
forms mean exactly that: a string is checked per character, and **a RegExp is
also applied per character, never to the whole string**. Whole-string matching
was implemented first and failed open — `RegExp.prototype.test` is a substring
search, so an unanchored `/[A-Za-z0-9]/` accepted `ab!!cd12`. A provider writing
the natural unanchored character class must not silently lose the constraint,
and the two forms must not diverge in meaning.

Candidate generation is bounded on two independent axes, because an
unsatisfiable constraint otherwise walks the whole homoglyph product space:
substitution cannot change length, so a `length` mismatch short-circuits before
the search starts, and an absolute visited-node ceiling caps charset-only
constraints. Measured on a 13-character wrong-length input: 71,960 ms before the
bounds, 0.02 ms after. A CAPTCHA read sits inside a login flow with a session
timeout, so an unbounded local search defeats the p95 that selected the default
model.

### 5. Results carry candidates, because one shot is not enough

```ts
export interface OcrCaptchaResult {
	readonly text: string;
	readonly candidates: readonly OcrCaptchaCandidate[];
	readonly satisfiesConstraints: boolean;
	readonly model: string;
}
```

Single-shot hard-tier accuracy is 47.5% with the winning model. CAPTCHAs are
re-issuable, so the realistic flow is read, submit, and on rejection fetch a new
image and retry: three attempts reach roughly 86% and five roughly 96%. A bare
string forces every provider to reimplement that loop; `satisfiesConstraints`
plus ranked candidates makes the retry decision available at the call site.

The SDK does not retry on its own. Re-fetching the image requires the upstream
session the provider owns, so the loop stays with the provider, exactly as
`ctx.stt` returns a transcript rather than re-dialling a phone call.

### 6. No SDK-side image preprocessing

The contributor's 193-line rectifier assumes heavy curved-baseline warping, and
the benchmark set does not contain it — its difficulty comes mostly from colour
contrast. The value of preprocessing is therefore **unmeasured**, and porting
OpenCV TPS to TypeScript on speculation is rejected. Providers may preprocess
and pass bytes to `ctx.ocr`. If a measured consumer later shows a gain, a
`preprocess` option is additive.

### 7. Fail closed, never silently degrade

Undeclared capability, missing credentials, unknown backend, or an empty model
response all raise a typed `ProviderError` with a `fix`. The failure mode this
guards against was observed three times during benchmarking: every candidate
model has a configuration under which it returns HTTP 200 with no usable text.

## Consequences

- ZOZOTOWN can drop `ocr/` (419 Python lines), both OCR services from its
  compose file, and the `process.env` + global `fetch` bypass, replacing them
  with `ctx.ocr.extractCaptchaText`. The workspace stops shipping a model
  server.
- Providers gain a measured default instead of choosing a vision model per
  repository.
- Self-hosted CAPTCHA-specialised models stay reachable through
  `openai-compatible`, so the default being Cloudflare does not trap anyone.
- The SDK takes on per-model protocol maintenance. That cost is the point: the
  alternative is every provider rediscovering that `stream:true` is mandatory.
- `ctx.ocr` is a new always-present context field, so `ProviderContext`
  construction changes in `auth-flow.ts` and both `serve.ts` sites, mirroring
  `stt`.

## Rejected alternatives

- **Fold OCR into `ctx.resolver`.** Rejected symmetrically to ADR 0006's
  rejection of the reverse: request/response versus task-and-poll, plaintext
  versus opaque material, no identity binding, and misrecognition versus vendor
  outage.
- **Cloudflare-only backend.** GLM-OCR is not served there; the first real
  consumer chose it.
- **moondream3.1 as default because it is OCR-tagged.** Measured last at 44.2%
  and second most expensive.
- **A reasoning model as default for hard CAPTCHAs.** Measured worse on hard
  tier than the 26B default, at 40s p95 and up to 95x the cost per correct
  answer.
- **A single `recognize` method.** Constraint handling and candidate ranking are
  CAPTCHA-specific; forcing them into a general signature would make the
  general case awkward and the CAPTCHA case implicit.
- **SDK-managed retry.** Re-issuing a CAPTCHA needs the provider's upstream
  session.
- **Port the rectifier.** Unmeasured on any dataset we have.

## Verification

- Unit: backend selection from env, unsupported-client throw path, gemma
  thinking-disabled payload, moondream stream parsing, reasoning-model budget,
  constraint validation, homoglyph folding, candidate ordering.
- Integration: a `defineProvider` fixture declaring `ocr` receives a working
  context; one not declaring it throws `OCR_UNAVAILABLE`.
- Contract: `ProviderContext` construction covered at all three sites.
- Live: re-run the benchmark harness through `ctx.ocr` and reproduce gemma's
  70.8% / 47.5% within noise, proving the SDK path does not lose accuracy the
  raw API had.
- Repo gates: `bun test`, `bun run check`, `bun run pack:check`,
  `bun run pack:smoke` per CONTRIBUTING.

## When this might break

- Workers AI adds a CAPTCHA-strong OCR model, or gemma-4 is deprecated. The
  default model is one env value; the benchmark harness is checked in and
  re-runnable.
- A provider needs document OCR with structured output. `recognize`'s option
  object is designed to extend; the contract does not have to be reopened.
- An image-captcha challenge kind lands in `ctx.resolver`. Expected: that vendor
  calls `ctx.ocr` internally per ADR 0006 Decision 1.
- A site's CAPTCHA proves to need rectification. Additive `preprocess` option,
  with the measurement attached.
- A CAPTCHA alphabet needs whole-string pattern semantics rather than a
  character set (for example a checksum or a positional pattern). `charset` is
  deliberately per-character; that would be a new option, not a change to this
  one.

## References

- `0006-challenge-resolver-context.md` — Decision 1 boundary
- `~/benchmarks/ocr-captcha/2026-08-10/README.md` — benchmark method, results, dataset caveats
- `src/runtime/stt.ts` — the five-layer pattern this ADR mirrors
- `APIFuseBounty/apifuse-zozotown-bounty-rmagur1203` @ `0fa837f` — measured consumer
