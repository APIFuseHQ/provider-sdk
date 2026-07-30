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

### User-input round-trips: never dead-end (`needs_input`)

A mutation MUST NOT fail for a problem the end user can resolve by choosing among live options (a required menu/course selection, a form question, a stale-but-recoverable state token). Throwing an error there strands the consuming agent: consumer error-shaping layers routinely strip error metadata, and a model that only sees "error" narrates failure to the user instead of relaying the choice.

Return the official success-shaped contract from `src/user-input.ts` instead (`ProviderNeedsInputPayload`, guard `isProviderNeedsInputPayload`):

- `status: "needs_input"` plus `required_selections` — only the still-pending questions, with human-readable `label`s and `valid_options` the agent relays verbatim. The agent never chooses for the user; anything with no real choice (agreement checkboxes, single-option required groups) is the provider's job to auto-answer.
- `selected_options` — selections already settled, echoed so the retry keeps them (copy them back and add the user's new answers).
- a freshly minted provider state token in the same response, so the retry never races an expired token.

No retry templates, next-action routing, or other agent choreography: provider payloads carry upstream-backed data only, and the consumer owns how the ask is phrased and how the retry call is shaped.

Declare the union in the operation `output` schema (`z.union([CreatedSchema, NeedsInputSchema])`). Reserve hard errors for genuinely unrecoverable flows (payment-gated, unsupported input kinds) and state the concrete reason in the error `message` itself, not only in `details`. Reference implementation: `providers/catchtable` `reserve` in the platform monorepo.

### Attempt tokens: the server carries the decisions

When a mutation needs more than one user decision (or one decision plus a
final go/no-go), do not make the agent re-send accumulated state across
rounds — weak models drop or corrupt it. Split the operation into a
**prepare/confirm pair** driven by a server-held attempt record:

- The prepare operation is non-destructive. A start call takes only the
  scalar intent fields; every response returns a fresh `attempt_token`
  referencing a server-side record (`ctx.choice.issue` with
  `storage.mode: "server"`) that stores every settled decision. Continue
  calls take `attempt_token` plus only the NEW answers.
- `needs_input` rounds list only the still-pending selections; settled
  decisions may ride along in a display-only field but are never re-sent.
- When nothing is pending, the prepare operation returns `status: "ready"`
  with a human-readable summary — the consumer's user-facing confirmation.
- The confirm operation is the only mutation and takes exactly
  `{attempt_token}`. It re-validates everything live before executing and
  returns `needs_input` (fresh token) instead of proceeding when upstream
  drift invalidates a stored decision — never substitute a different option
  for what the user picked.
- Expired or foreign tokens fail factually (nothing happened; start a new
  attempt with the scalar fields) — no answer salvage from a dead token.
- **The provider must enforce consumption itself.** `ctx.choice` server
  storage keeps tokens parseable until TTL — `parse` does not invalidate
  them, so a confirm handler that only parses can be replayed into a second
  booking or payment. After a successful execution, record the result under
  the token's digest in `ctx.state` and make replays idempotent: a repeated
  confirm returns the original created payload without touching upstream,
  and later prepare rounds on the consumed token fail factually with the
  existing reference. Record the result only after upstream success, so an
  interrupted confirm stays retryable.

The invariant behind all of it: complex flow state is the system's job, not
the model's. The model carries exactly one opaque key between calls.
Reference implementations: `providers/catchtable` `reserve`/`reserve-confirm`
(including the consume-on-success guard) and `providers/modu-parking`
payment state tokens in the platform monorepo.

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

### Replay-safe fixtures

Keep public operation schemas strict: date fields should accept absolute dates,
not relative tokens. Inside `fixtures.request` only, the SDK resolves `+Nd` and
`+Nd:YYYYMMDD` (1–365 days ahead) before import-time schema validation and
stores the resolved request in provider metadata. Health-check case inputs use
the same resolver when a probe runs. The default calendar is **KST**, including
the 15:00–23:59 UTC window when KST is already on the next day.

`fixtures.recordedAt` is the KST `YYYY-MM-DD` date when the response evidence
was captured. It must be a real, non-future calendar date. Response date fields
are expected to align with `recordedAt`, not with the newly resolved request;
this permits stable recorded evidence alongside a replay-safe request.

```ts
const FlightInput = z.object({
  departureDate: z.string().date(), // public calls remain absolute-date only
});

const searchFlights = {
  input: FlightInput,
  output: FlightOutput,
  async handler(ctx, input) {
    return fetchAndNormalizeFlights(ctx, input);
  },
  fixtures: {
    request: { departureDate: "+45d" },
    response: recordedFlightResponse, // dates reflect the capture below
    recordedAt: "2026-07-15",
  },
  healthCheckUnsupported: { reason: "Upstream search is cost-bearing." },
};
```

For code that explicitly calls the shared resolver, omit the third argument to
use KST or pass `"UTC"` deliberately:

```ts
import { resolveHealthCheckInputDateTokens } from "@apifuse/provider-sdk/server";

const kstInput = resolveHealthCheckInputDateTokens({ date: "+45d" });
const utcInput = resolveHealthCheckInputDateTokens({ date: "+45d" }, new Date(), "UTC");
```

Do not re-resolve a health assertion's dates in UTC when its case input used the
default KST calendar.

### Real-handler E2E in standard tests

`runStandardTests(provider)` validates declarations and fixtures but reports a
per-operation warning because it has no handler E2E coverage. Opt in with an
`upstreamStub`: the runner calls each fixture-backed real handler with its
already-resolved fixture request, routes ProviderContext upstream transports to
the stub, and validates the result against the output schema. It never compares
the result to the recorded response because that evidence belongs to
`recordedAt`.

```ts
import { runStandardTests } from "@apifuse/provider-sdk/testing";
import provider from "../index.js";

runStandardTests(provider, {
  upstreamStub: ({ transport, method, url }) => {
    if (
      transport === "http" &&
      method === "GET" &&
      url === "https://api.example.test/flights"
    ) {
      return Response.json({ flights: [{ id: "fixture-flight" }] });
    }
    return undefined; // fails the test: live-network passthrough is forbidden
  },
});
```

The stub also identifies `stealth`, `browser`, and `native` interactions. Return
a Web `Response` or `{ status, headers, body }`; an unmatched call fails with
the operation, transport, and method named in the error. Browser handlers expose
method-level calls such as `goto`, `evaluate`, and `locator.click`, so provide a
canned result for each method the handler uses. Native connections similarly
identify `connectTcp`/`connectTls` and subsequent `write` calls. Direct global
`fetch` or socket usage is outside this ProviderContext seam and should not be
used by provider handlers.

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

### Declared secrets are SDK-enforced

Environment/secret presence validation is single-sourced in the SDK. Declare
every env secret the provider needs in `defineProvider`:

```ts
secrets: [
  {
    name: "APIFUSE__PROVIDER__MY_PROVIDER__API_KEY",
    required: true,
    description: "Upstream API key from the vendor portal",
  },
],
```

The runtime validates every `required: true` declaration before any operation
handler or auth-flow handler (except `abort`) runs. When a required secret is
unset or whitespace-only, the invocation fails with the canonical structured
error — code `MISSING_SECRET`, HTTP 400, `details.category:
"credential_unavailable"`, `retryable: false`, and a `fix` naming every missing
secret — across `/v1/{operation}`, self-test probes, `apifuse perf`, and
`apifuse record`. The server also emits a `provider_secrets_missing` warn log
at boot so unprovisioned deployments are visible immediately without crashing
the pod.

Provider-local presence re-validation is **deprecated**: do not write
`requireServiceKey`/`requireApiKey`-style guards that re-check `ctx.env.get()`
and throw a hand-rolled `CONFIGURATION_ERROR`/`MISSING_SECRET`. Those guards
are dead weight (the SDK gate runs first) and historically diverged into
inconsistent error shapes. The `sdk-owned-secret-presence` submit-check rule
flags them at warn level; acknowledge a deliberate exception with
`// @apifuse-allow sdk-owned-secret-presence: <reason>`.

```ts
// Before (deprecated): provider-local double validation
function requireServiceKey(ctx: ProviderContext): string {
  const value = ctx.env.get(SERVICE_KEY_ENV);
  if (!value?.trim()) {
    throw new ProviderError(`Missing required provider secret: ${SERVICE_KEY_ENV}`, {
      code: "CONFIGURATION_ERROR",
    });
  }
  return value;
}

// After: declare { name: SERVICE_KEY_ENV, required: true } and read directly.
const serviceKey = ctx.env.get(SERVICE_KEY_ENV);
```

Note the asymmetry: the gate treats whitespace-only values as missing, but
`ctx.env.get()` still returns the raw value to handlers — trim at the point of
use if the upstream is whitespace-sensitive.

### Public local debugging checklist

- Operation smoke requests use the provider server envelope:
  `{"requestId":"req_local_<operation>","input":{...},"headers":{}}`.
  Omit `connection` for public/no-auth operations; do not send `connection: null`.
- Credential-backed smoke requests pass local-only credential material in
  `connection.secrets`. Keep real values in shell env or `.env`, never in source
  or fixtures.
- Hand-written auth flows should use `ctx.auth` helpers and return exactly one
  terminal/next turn from each handler: `ctx.auth.nextForm(...)` or
  `ctx.auth.nextPoll(...)` to ask Gateway for the next user/system step,
  `ctx.auth.complete(...)` to finish with `data.credential`, or
  `ctx.auth.abort(...)` to stop safely. Keep abort `data` and `actionHint`
  JSON-safe and secret-free; never include raw cookies, credentials, headers,
  HTML, or upstream `Error` objects.

```ts
export default defineProvider({
  id: "example-provider",
  version: "1.0.0",
  runtime: "standard",
  auth: {
    mode: "credentials",
    flow: {
      async start(ctx) {
        return ctx.auth.nextForm({
          fields: {
            email: { type: "email", labelKey: "auth.email.label" },
            password: { type: "password", labelKey: "auth.password.label" },
          },
          hintKey: "auth.signIn",
        });
      },
      async continue(ctx, input) {
        const result = await loginWithSubmittedFields(ctx, input);
        if (result.blocked) {
          return ctx.auth.abort({
            code: "account_action_required",
            retry: "after_user_action",
            actionHint: { kind: "open_provider_app" },
            message: "Approve the login in the provider app.",
          });
        }
        return ctx.auth.complete({
          credential: { cookie: result.cookie },
          metadata: { accountId: result.accountId },
        });
      },
    },
  },
  credential: { keys: ["cookie"] },
  // ...metadata and operations
});
```

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

### Limiting stealth response bodies

Set `maxBodyBytes` on `ctx.stealth.fetch()` or `session.redirects.run()` when an
upstream response has a known safe maximum. The limit is opt-in and counts
decoded bytes as impit streams them. It applies to every redirect hop, uses a
parseable `Content-Length` for an early rejection, and still enforces the limit
incrementally when the header is absent or inaccurate. Exceeding the limit
aborts the response and throws a non-retryable `TransportError` with code
`response_too_large`.

Pass the limit to the transport instead of checking `Content-Length` in provider
code:

```ts
const response = await ctx.stealth.fetch("/api/search", {
  params: { query: input.query },
  maxBodyBytes: 2 * 1024 * 1024,
})
```

### Persisting stealth session cookies

Persist `session.cookies.serialize()` as JSON when an authenticated session must
survive a restart or move to another replica. The returned
`StealthCookieStoreV1` has an explicit version and retains every cookie together
with its Domain, Path, Secure, expiry, host-only, and other cookie attributes.
Restore it with `session.cookies.deserialize()`. Unsupported future versions
fail explicitly instead of being accepted as a partial cookie jar.

Credential values are strings, so stringify the store at the credential
boundary and parse it when rebuilding the session:

```ts
// After login (including any redirects across sibling hosts):
const result = await session.redirects.run({ url: loginUrl });
return {
  credential: {
    cookieStore: JSON.stringify(result.cookieStore),
  },
};

// In a later operation or replica:
const persisted = ctx.credential.get("cookieStore");
if (persisted) {
  session.cookies.deserialize(JSON.parse(persisted));
}
```

`snapshot()` and `restore()` remain only for backward compatibility with flat
`Record<string, string>` credentials. `snapshot()` enumerates cookies across all
hosts and paths, but the flat shape is inherently lossy: duplicate names
collapse and Domain, Path, Secure, expiry, and host-only attributes cannot be
represented. `restore()` therefore recreates host-only `Path=/` cookies on the
session base origin. Do not use the flat form for new persistence code. Cookie
headers remain origin-filtered: use `toHeader(url)` for a particular request and
never build a request header from serialized or snapshotted persistence data.

### Recording and replaying streaming responses

`apifuse record` passes responses returned by `ctx.http.stream()` directly to the operation
handler while incrementally capturing a bounded preview. If the handler returns or cancels its
reader before EOF, the recorder drains the retained upstream reader before writing a JSON evidence
record to `__fixtures__/raw.json`. The record contains the status, success
flag, `content-type`/`content-length`/`content-disposition` headers when present, the
full body SHA-256 and byte count, and a base64 preview up to the configured stream preview limit.
Textual previews are decoded and passed through the fixture sanitizer before base64 encoding.
Classification uses both the declared content type and the preview bytes, so missing or incorrect
content-type headers do not bypass sanitization. PEM private-key blocks and long high-entropy
tokens in otherwise unstructured text are redacted as well. If the full preview is not valid UTF-8,
the longest valid prefix is scanned and sanitized while its undecodable tail is retained. Only a
magic-number-confirmed binary preview with no textual-secret pattern in that window bypasses
sanitization; other undecodable data fails closed.
Sanitized previews carry `preview_sanitized: true`, plus a
`preview_redaction_reason` when capture had to fail closed. The original hash and byte count always
describe upstream bytes, not a sanitized preview.

Each record includes query-free request provenance (`method`, `path`, and a one-based stream call
ordinal). Provenance never stores the origin, URL userinfo, query, or fragment. Every retained path
segment is scrubbed before persistence: credential-key segments, values following those keys,
known token shapes, and long high-entropy opaque segments become `[REDACTED]`. If an operation
opens multiple streams, the recorder finalizes every retained reader and
writes all evidence records in stream call order. Stream invocations use a tagged capture envelope
whose items distinguish stream evidence from ordinary JSON responses. Evidence-only snapshot replay
consumes that exact call order and fails immediately when evidence is exhausted or a call kind is
reordered. When request provenance is present, replay also rejects method or path changes (relative
URLs are resolved against the recorded path prefix); ordinals remain diagnostic and are not matched.
Appended fixtures replay a stream envelope only when it is the latest invocation. SSE
recording remains unsupported and fails explicitly instead of retaining an unrelated earlier
response.

Stream fixture replay in `runStandardTests(..., { snapshot: true })` is evidence-only:
`ctx.http.stream()` returns a usable stream containing exactly the recorded preview,
not a fabricated full body. The replay response also carries runtime metadata
`evidence_only: true`, `body_sha256`, `body_bytes`, and the optional preview sanitization fields
for assertions about the original capture. Do not assert that the replay body hashes to
`body_sha256` when `body_bytes`
exceeds the decoded preview length or `preview_sanitized` is present; use the metadata for
full-body integrity and limit body-content assertions to the preview.

Golden snapshot suites can set `requireSnapshot: true` so a missing committed snapshot fails instead
of being created implicitly. Regenerate intentional changes with
`bun test --update-snapshots`; review and commit the resulting `transform.snap.json` file.

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
