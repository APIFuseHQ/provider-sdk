## Generator and runtime alignment

- Canonical scaffolding command: `apifuse create`
- External bounty workspaces are one-provider repositories initialized with the standalone create flow. `--preset monorepo` is an internal APIFuse maintainer path only and must reject outside the private monorepo detected by `packages/provider-sdk/package.json`.
- Standalone bounty contributors should use `bunx @apifuse/provider-sdk@beta create <name> --yes` until this release is promoted to `latest`
- Provider server contract is:
  - dev default `3900`
  - start/Docker/container `3000`
  - `GET /health`
  - `POST /v1/{operation}`
  - `POST /auth/start`
  - `POST /auth/continue`
  - `POST /auth/poll`
  - `POST /auth/disconnect`
- Generator v1 for this redesign scaffolds TypeScript providers only. Python generation is future work.

## Provider Authoring Guide

Provider code is the declaration input to the internal platform registry. The public SDK owns provider authoring/runtime ergonomics; internal docs, deploy, and discovery projections are built downstream from those declarations. `bun run lint:providers` enforces provider authoring standards.

### Description template

Every operation `description` MUST be at least 150 characters and follow this structure:

```
<What the tool does in one sentence>. Use when <specific scenarios>. Do NOT use for <counter-scenarios; point to alternatives>. Returns <key output fields>. <Important caveats: rate limits, auth, freshness>.
```

Example:
```ts
description:
  "Retrieves KMA ultra-short-term weather observation for a given grid coordinate in South Korea, " +
  "including temperature, humidity, wind speed, precipitation, and sky condition. " +
  "Use when the user asks about current or hourly weather at a specific Korean location. " +
  "Do NOT use for forecasts beyond 2 days — use kma_mid_forecast instead. " +
  "Returns hourly data in KST timezone; null values indicate data unavailable. " +
  "Rate-limited to 1000 calls/day on the free tier.",
```

### Language policy

- **Structural text**: English (operation `description`, Zod `.describe()`, `whenToUse`, `whenNotToUse`, `derivations`, `inputExamples.scenario/rationale`).
- **Values only**: native language (fixtures payloads, `inputExamples[].input` values like "대방동", "KRW-BTC", entity catalog entries).

### Required per operation

- `description` — 150+ chars English (error-level rule)
- Every Zod field in input AND output has `.describe()` including nested objects + array items (error-level rule)
- `fixtures.request` + `fixtures.response` both present (error-level rule)
- Exactly one of `healthCheck`, `healthCheckUnsupported`, or `healthJourneys[].coversOperations` coverage per operation. Prefer `healthCheck` for safe read-only upstream probes; use `healthCheckUnsupported` only with a specific reason for destructive, paid, credential-sensitive, flaky, or otherwise unsafe probes. Use a provider-level health journey when a destructive or credential-sensitive flow can be proven safely only as a multi-step boundary test, such as stopping at a payment WebView URL.

### Factored operations

Use `defineOperation()` when an operation is large enough to live beside helper functions or in a separate module. It preserves the same type inference as inline `defineProvider()` operations and can be placed directly in the provider `operations` map. `defineProvider()` accepts Zod and Standard Schema v1-compatible schemas. If config validation fails, the SDK names the field to fix, for example `runtime`, `auth.mode`, `operations.<id>.handler`, or `operations.<id>.fixtures.response`.

### Health assertion context

`healthCheck.cases[].assertions` receives a `HealthCheckAssertionContext` with
`data`, `status`, `durationMs`, and optional `meta`. `data` is typed from the
operation output schema, so assertions should inspect normalized output instead
of reaching into transport internals.

<!-- @magic-start:sample -->
```ts
healthCheck: {
  interval: "5m",
  cases: [{
    name: "lookup baseline",
    input: { q: "btc" },
    assertions: ({ data, status, durationMs }) => {
      if (status !== 200 || data.results.length === 0 || durationMs > 3000) {
        return { status: "degraded", label: "lookup baseline changed" };
      }
    },
  }],
}
```
<!-- @magic-end:sample -->

### Strongly recommended (warn-level rules)

- `description` includes "use" AND "when" phrasing
- `inputExamples` with 2+ scenarios for complex input (nested objects, enums, format-sensitive strings)
- `derivations` for parameters not directly visible in the user query (e.g., `gridX` derived from geocoding)

### Optional but valuable

- `annotations`: `{ readOnly, destructive, idempotent, openWorld, rateLimit }` — agentic safety signals
- `tags`: operation-level semantic tags for retrieval (e.g., `["weather", "korea", "realtime"]`)
- `relatedOperations`: `{ alternatives?: string[] }` — links to fallback/sibling operations

### STT runtime capability for audio OTP and short transcription

Providers that need speech-to-text should use the SDK runtime capability instead
of constructing a vendor client inside provider code. Declare STT at the provider
level, then call `ctx.stt` from operation handlers or auth-flow handlers.

<!-- @magic-start:sample -->
```ts
export default defineProvider({
  id: "example-provider",
  // ...metadata, auth, operations, allowedHosts
  stt: { mode: "required" },
  operations: {
    verifyAudioOtp: {
      input: z.object({
        audioBase64: z.string().describe("Base64-encoded short OTP audio"),
        mediaType: z.string().optional().describe("Audio MIME type"),
      }),
      output: z.object({ code: z.string().describe("Verification code") }),
      async handler(ctx, input) {
        const transcript = await ctx.stt.transcribe({
          audio: {
            kind: "base64",
            data: input.audioBase64,
            mediaType: input.mediaType,
          },
          language: "ko-KR",
          mode: "otp",
          verificationCode: { codeLengths: [4, 6] },
        });

        const code =
          transcript.verificationCode?.code ??
          ctx.stt.extractVerificationCode(transcript.text, {
            locale: "ko-KR",
            codeLengths: [4, 6],
          }).code;

        return { code };
      },
      healthCheckUnsupported: {
        reason: "Audio OTP transcription is cost-bearing and requires explicit smoke evidence.",
      },
    },
  },
});
```
<!-- @magic-end:sample -->

Best-practice rules:

- `stt: { mode: "required" }` is the production path for providers that depend
  on STT; APIFuse provider manifests project STT credentials, model config, and
  Cloudflare egress only for required STT. Use `mode: "optional"` only when STT
  is a host/test override or truly best-effort capability that can remain
  unavailable in production.
- Do not assume OTPs are always four digits. Configure accepted lengths, for
  example `[4, 6]`, and keep the returned code as a string to preserve leading
  zeros.
- Prompts are hints, not correctness guarantees. General transcription sends no
  prompt by default. OTP mode may send a default digit-preserving hint. Use a
  custom `initialPrompt` only with `promptPolicy: "custom-hint"`, and do not log
  prompts, transcripts, raw audio, or OTP values.
- STT v1 accepts JSON-safe base64 audio only. Do not fetch arbitrary audio URLs
  from provider code; URL input needs separate SSRF/private-network policy.
- Local and production wiring use the same env-backed runtime path. For the
  Cloudflare Workers AI backend, set `APIFUSE__STT__BACKEND=cloudflare-workers-ai`,
  `APIFUSE__STT__MODEL=@cf/openai/whisper-large-v3-turbo`,
  `APIFUSE__CLOUDFLARE__ACCOUNT_ID`, and `APIFUSE__STT__CLOUDFLARE_API_TOKEN` in `.env.local` or the
  provider workload environment. Do not deploy a Cloudflare Worker proxy for the
  MVP; the SDK runtime calls Workers AI REST directly.
- Submission checks and health checks must not invoke live STT by default.
  Provide explicit smoke evidence when a provider depends on audio OTP behavior.


### Health journey DX for SMS/payment flows

Use `defineSmsOtpMatcher()` plus `defineHealthJourney()` when a real health signal requires an OTP ceremony and a safe handoff boundary. Keep matcher fields standards-backed: ISO 3166-1 alpha-2 `country`, BCP 47 `locale`, E.164 `phoneNumber` when present, ISO 8601 durations, and `nationalServiceCode` origins for local service senders. Do not add custom allowlist fields such as `senderAllowlist`; model the sender as an origin instead.

<!-- @magic-start:sample -->
```ts
import {
	defineHealthJourney,
	defineProvider,
	defineSmsOtpMatcher,
	every,
} from "@apifuse/provider-sdk";

const phoneOtp = defineSmsOtpMatcher({
	id: "phone-otp",
	country: "KR",
	locale: "ko-KR",
	origins: [
		{
			kind: "nationalServiceCode",
			country: "KR",
			value: "16615270",
			display: "1661-5270",
		},
	],
	code: { pattern: /인증번호는\s*\[([0-9]{4})\]/, capture: 1 },
	maxAge: "PT5M",
	waitTimeout: "PT2M30S",
	clockSkew: "PT10S",
});

const paymentWebviewJourney = defineHealthJourney({
	id: "sms-payment-webview",
	schedule: every("8h", { jitter: "PT20M" }),
	timeout: "PT5M",
	cooldown: "PT8H",
	requiredSecrets: [
		"APIFUSE__HEALTH_MONITOR__PROVIDER_PHONE",
		"APIFUSE__HEALTH_MONITOR__PROVIDER_PASSWORD",
		"APIFUSE__HEALTH_MONITOR__PROVIDER_CANARY_ORDER_JSON",
	],
	coversOperations: ["verify-phone", "confirm-phone", "place-order"],
	smsMatchers: [phoneOtp],
	steps: [
		{ id: "send-phone-otp", kind: "operation", operationId: "verify-phone" },
		{ id: "wait-phone-otp", kind: "smsOtp", usesSmsMatcher: "phone-otp" },
		{ id: "confirm-phone-otp", kind: "operation", operationId: "confirm-phone" },
		{
			id: "create-payment-webview",
			kind: "operation",
			operationId: "place-order",
			safeBoundary: "paymentWebviewUrl",
		},
	],
});

export default defineProvider({
	id: "example-provider",
	// ...metadata, auth, operations, allowedHosts
	healthJourneys: [paymentWebviewJourney],
});
```
<!-- @magic-end:sample -->

The journey runner supplies `ctx.gateway`, `ctx.sms.waitForOtp()`, `ctx.journal.sideEffect()`, `ctx.state`, and `ctx.event.operation()` to the optional journey `run` function. Provider authors should keep `run` small: call the covered operations in step order, stop at the declared safe boundary, and let the generated health metadata carry schedule, timeout, required secret, and SMS matcher information to the health monitor.

For authenticated journeys, open a fresh connection inside `run` with `ctx.gateway.connect({ input: { ... } })`, execute covered operations with the returned `connectionId`, and disconnect in a `finally` block. Do not require or store long-lived `HEALTH_MONITOR_*_CONNECTION_ID` secrets; those stale connection IDs can hide broken login ceremonies.

Use the runtime capabilities narrowly:

- `ctx.gateway.execute()` is the default path for operation health evidence; the runner records operation success/failure automatically.
- `ctx.journal.sideEffect()` wraps non-replayable provider mutations such as create/cancel/send operations.
- `ctx.state.namespace(name, policy)` stores bounded lifecycle memory and recovery cursors with TTL/quota/value-size policy. It is not a replacement for the side-effect journal.
- `ctx.event.operation()` records only synthetic operation outcomes proven by the journey, such as recovery/manual-review checks that are not direct gateway calls. The runtime rejects events for operations outside `coversOperations`.

Do not import `apps/health-monitor`, generated health artifacts, database repositories, schedulers, or recorders from provider code. If a journey needs provider-specific helper code, place it under the provider package (for example `providers/<id>/health-journeys/*`) and keep the SDK boundary generic.

### External bounty submission evidence

External contributors are expected to submit standalone Provider source plus:

- SDK version/tag and create command used.
- Provider id, version, runtime, auth mode, and Operation list.
- Health coverage table for every Operation.
- `bun run check` output.
- `bun run test` output.
- `bun run submit-check` score/verdict and generated `submission-report.md`.
- Fixture evidence and known upstream constraints.

Maintainers own monorepo import under `providers/<id>/`, registry generation,
deployment projection checks, and release workflows.

### Public local debugging checklist

- Operation smoke requests use the provider server envelope:
  `{"requestId":"req_local_<operation>","input":{...},"headers":{}}`.
  Omit `connection` for public/no-auth operations; do not send `connection: null`.
- Credential-backed smoke requests pass local-only credential material in
  `connection.secrets`. Keep real values in shell env or `.env`, never in source
  or fixtures.
- Credentials auth providers should use `defineCredentialsAuth()` instead of
  hand-writing `auth.flow.start/continue`. The helper exposes one happy path:
  declare form `fields`, declare `credentialKeys`, and put upstream login/session
  creation in `login(ctx, input)`. It returns both `auth` and `credential` for
  `defineProvider()` and builds the complete turn as `data.credential`, which is
  the only value Gateway persists onto the connection.

```ts
import { defineCredentialsAuth, defineProvider } from "@apifuse/provider-sdk";

const credentialsAuth = defineCredentialsAuth({
  fields: {
    email: { type: "email", labelKey: "auth.email.label" },
    password: { type: "password", labelKey: "auth.password.label" },
  },
  credentialKeys: ["cookie"] as const,
  storesReusableSecret: true,
  justification: "Session cookie is required for authenticated operations.",
  async login(ctx, input) {
    const cookie = await loginAndBuildSessionCookie(ctx, input);
    return { credential: { cookie } };
  },
});

export default defineProvider({
  id: "example-provider",
  version: "1.0.0",
  runtime: "standard",
  auth: credentialsAuth.auth,
  credential: credentialsAuth.credential,
  context: credentialsAuth.context,
  // ...metadata and operations
});
```

For OTP, MFA, CAPTCHA handoff, or user-approved login, return a challenge from
`login()` instead of hand-writing `contextPatch`, `poll`, and final credential
turns. SDK stores the pending challenge in auth-flow context, returns the next
form/pending turn, and still persists only the final `data.credential`.

```ts
import {
  credentialsAuthChallenge,
  defineCredentialsAuth,
} from "@apifuse/provider-sdk";

const credentialsAuth = defineCredentialsAuth({
  fields: {
    email: { type: "email" },
    password: { type: "password" },
  },
  credentialKeys: ["cookie"] as const,
  async login(ctx, input) {
    const result = await passwordLogin(ctx, input);
    if (result.otpRequired) {
      return credentialsAuthChallenge("otp", {
        state: { transactionId: result.transactionId },
        hintKey: "auth.otp.prompt",
      });
    }
    if (result.manualApprovalRequired) {
      return credentialsAuthChallenge("manualApproval", {
        state: { transactionId: result.transactionId },
        hintKey: "auth.manualApproval.openApp",
        timing: { suggestedPollIntervalMs: 3000, maxWaitMs: 120000 },
      });
    }
    return { credential: { cookie: result.cookie } };
  },
  challenges: {
    otp: {
      fields: { otp: { type: "otp", labelKey: "auth.otp.label" } },
      async verify(ctx, input, state) {
        const result = await verifyOtp(ctx, state.transactionId, input.otp);
        return { credential: { cookie: result.cookie } };
      },
    },
    manualApproval: {
      async poll(ctx, state) {
        const result = await checkApproval(ctx, state.transactionId);
        if (!result.approved) return null;
        return { credential: { cookie: result.cookie } };
      },
    },
  },
});
```
- Auth-flow debugging starts with `/auth/start`, continues with
  `/auth/continue`, and carries returned `contextPatch` values into the next
  request's `context`.
- Stealth/browser providers may require local runtime setup outside Provider code:
  keep access-sensitive operations on `ctx.stealth.fetch()` with an SDK stealth
  `profile`; the TypeScript runtime uses `impit` behind that interface, so do
  not add per-operation JA3, HTTP/2 SETTINGS, or pseudo-header tuning. `ctx.stealth`
  supports Chrome/Firefox-style profiles; use `browser.engine:
  "playwright-stealth"` for Safari-specific or real browser Providers
  (`nodriver` is Python-runtime only); install local browser assets with
  `bunx playwright install chromium`, or set
  `APIFUSE__CDP_POOL__URL` for remote browser debugging.

### Running the pre-submission report

```bash
bun run submit-check
```

The report scores review readiness across definition metadata, operation/schema quality, fixtures/tests, health coverage, local smoke evidence, auth safety, secret hygiene, and submission docs. It is not a payout guarantee; any blocker must be fixed before review. For the complete public-only submission checklist, see `SUBMISSION.md` in the SDK package.

### Running the lint locally

```bash
bun run lint:providers
```

- Exit 0: all providers pass error-level rules (warnings may still appear)
- Exit 1: at least one error-level violation; CI will block merge

### CI enforcement

`bun run lint:providers` runs in the `lint-and-typecheck` job on every pull request. Error-level violations block merges.
