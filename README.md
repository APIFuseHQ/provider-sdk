# @apifuse/provider-sdk

APIFuse Provider SDK — build provider declarations and runtimes with one public SDK surface and one canonical CLI.

## Install

```bash
bun add @apifuse/provider-sdk
```

For external bounty scaffolding, use the beta tag until this release is promoted
to `latest`:

```bash
bunx @apifuse/provider-sdk@beta create my-provider --yes
```

## Create a provider

### Standalone (default)

```bash
bunx @apifuse/provider-sdk@beta create my-provider --yes
```

The canonical `create` flow:
1. scaffolds the provider,
2. installs dependencies,
3. runs baseline validation,
4. prints the exact next local-dev command.

### Repository shape

The Provider SDK is a public bounty-contributor tool first. External bounty workspaces are one-provider repositories initialized from the standalone create flow. The generated provider must be installable without private APIFuse monorepo access.

Do not use internal monorepo placement for bounty workspaces. Accepted provider work is imported into the private APIFuse monorepo later by maintainers or trusted automation.

## Provider server contract

- Dev default: `3900`
- Start/Docker/container contract: `3000`
- `GET /health`
- `POST /v1/{operation}`
- `POST /auth/start`
- `POST /auth/continue`
- `POST /auth/poll`
- `POST /auth/disconnect`

Removed legacy runtime paths are not supported:
- `/execute/*`
- `/auth/abort`

## Local workflow

```bash
cd my-provider
bun run check
bun run test
bun run submit-check -- --smoke
bun run dev
```

Smoke the generated local server:

```bash
curl -s http://localhost:3900/health
curl -s -X POST http://localhost:3900/v1/ping \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"req_local_ping","input":{"value":"hello"},"headers":{}}'
```

The operation request body is the same envelope used by the APIFuse gateway:

| Field | Required | Notes |
|---|---:|---|
| `requestId` | yes | Any unique string is fine for local debugging; it is echoed in structured errors. |
| `input` | yes | The operation input after schema validation. |
| `headers` | no | Extra caller headers to expose through `ctx.request.headers`. |
| `connectionId` | no | Connection identity only; it does not include credentials. The gateway sends it for `optional` connection mode. |
| `connection` | no | Credential-bearing connection data. The gateway sends it for `required` connection mode; for local debugging, pass an object with `id`, `mode`, `secrets`, `metadata`, and `externalRef`. Do not pass `null`. |

The gateway sends only `connection` for `required` mode, only `connectionId`
for `optional` mode, and neither field for `none` mode. If a malformed or
manually constructed envelope contains both, nested `connection.id` takes
precedence over the top-level `connectionId`.

Credential-bearing local smoke example:

```bash
curl -s -X POST http://localhost:3900/v1/me \
  -H 'Content-Type: application/json' \
  -d '{
    "requestId":"req_local_me",
    "input":{},
    "connection":{
      "id":"af_con_local_debug",
      "mode":"credentials",
      "secrets":{"apiKey":"dev-only-secret"},
      "scopes":[],
      "metadata":{},
      "externalRef":"local-debug"
    }
  }'
```

Auth-flow endpoints use the same `requestId` convention:

```bash
curl -s -X POST http://localhost:3900/auth/start \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"req_auth_start","flowId":"flow_local_1","providerId":"my-provider","context":{}}'
```

If a local smoke returns `{"error":...}`, inspect the JSON error body and the
`apifuse dev` server log. Validation failures include a `details` array with
the bad request path; provider/runtime failures include `code`, `message`, and
`requestId`.

### Local debugging checklist

- **`invalid_request` on `/v1/{operation}`**: confirm the request body includes
  `requestId` and `input`. Omit `connection` for public/no-auth operations;
  never send `connection: null`.
- **Credential-backed operations**: declare `credential.keys`, then pass matching
  local-only values through `connection.secrets`. Read them in handlers with
  `ctx.credential.get("key")` or `ctx.credential.getAccessToken()`.
- **Provider env secrets**: declare `secrets[]`, set values in your shell or
  `.env`, and read only those names through `ctx.env.get("NAME")`.
- **Credentials auth flows**: prefer `defineCredentialsAuth()` over hand-written
  `auth.flow`. Declare the form fields and credential keys once, then put the
  upstream login/session creation in `login(ctx, input)`. Return
  `credentialsAuthChallenge("otp" | "manualApproval" | ...)` for MFA, CAPTCHA
  handoff, or user-approved login branches. The helper returns
  `{ auth, credential, context }` for `defineProvider()` and always completes
  with `data.credential`, which is the value Gateway persists onto the
  connection.
- **Auth flows**: call `/auth/start`, then `/auth/continue` with the same
  `flowId`; preserve any returned `contextPatch` in the next local request's
  `context` object.
- **Stealth-sensitive providers**: use `ctx.http` for normal JSON/REST calls and
  `ctx.stealth.fetch()` when you need browser-like session or cookie control.
  `ctx.stealth.fetch()` uses the impit-backed browser stealth transport and
  accepts request controls for `params`, `proxy`, `timeout`, `profile`,
  `redirect`, `throwOnHttpError`, and `stealth.insecureSkipVerify`. For login
  flows that must inspect intermediate `Location`/`Set-Cookie` headers, create
  a session with `ctx.stealth.createSession()` and use `session.redirects.run()`;
  inspect accumulated cookies through `session.cookies`. Select an SDK stealth
  `profile` such as `chrome-146`; do not tune JA3, HTTP/2 SETTINGS, or
  pseudo-header order in provider code. Chrome/Firefox-style profiles are
  supported; use `ctx.browser` when Safari-specific behavior is required.
- **Browser providers**: for TypeScript Providers use `runtime: "browser"` plus
  `browser.engine: "playwright-stealth"`; `nodriver` is a Python-runtime path.
  Install local browser assets with `bunx playwright install chromium` when
  using the Playwright runtime, or set `APIFUSE__CDP_POOL__URL`
  when debugging against a remote browser pool.

## Authoring ergonomics

`defineProvider()` infers each operation handler input from the operation `input` schema. For larger providers, factor operations with `defineOperation()` and compose them later:

```ts
import { defineOperation, defineProvider, z } from "@apifuse/provider-sdk/provider"

const search = defineOperation({
  input: z.object({ q: z.string().describe("Search query") }),
  output: z.object({ count: z.number().describe("Result count") }),
  async handler(ctx, input) {
    return { count: input.q.length }
  },
  healthCheckUnsupported: {
    reason: "Example operation only; replace with a real upstream probe.",
  },
})

export default defineProvider({
  id: "factored-provider",
  version: "1.0.0",
  runtime: "standard",
  meta: { displayName: "Factored", category: "demo" },
  operations: { search },
})
```

Operation schemas may be Zod schemas or Standard Schema v1-compatible schemas. Invalid configs throw `ProviderError`/`ValidationError` messages that name the offending field, such as `auth.mode` or `operations.search.fixtures.request`.

### Operation health coverage

Every operation must declare exactly one of:

- `healthCheck` — preferred for safe read-only upstream probes.
- `healthCheckUnsupported` — allowed only when a probe is destructive, paid,
  credential-sensitive, flaky by design, or otherwise unsafe. The `reason` must
  be specific.

The generated `ping` operation uses `healthCheckUnsupported` only because it is
a local scaffold check, not a real upstream API probe.

`healthCheck.cases[].assertions` receives `{ data, status, durationMs, meta }`.
`data` is the operation output parsed by the declared output schema:

```ts
healthCheck: {
  interval: "5m",
  cases: [{
    name: "search responds",
    input: { q: "weather" },
    assertions: ({ data, status, durationMs }) => {
      if (status !== 200 || data.count < 1 || durationMs > 3000) {
        return { status: "degraded", label: "unexpected search baseline" }
      }
    },
  }],
}
```

### Operation annotations

Operations declare non-functional metadata via `annotations`:

| Field | Type | Notes |
|---|---|---|
| `readOnly` | `boolean` | Operation has no side effects (safe to test in production). |
| `destructive` | `boolean` | Operation modifies/deletes state. |
| `idempotent` | `boolean` | Safe to retry without duplicate side effects. |
| `openWorld` | `boolean` | Callable without authentication. |
| `rateLimit` | `{ calls, window }` | Per-operation rate hint. `window` is `"minute"\|"hour"\|"day"`. |
| `timeoutMs` | `number` | Per-operation upstream timeout (1–60000 ms). Omit to inherit the gateway global default. |

`defineProvider()` validates `timeoutMs` is an integer in `[1, 60000]` and throws `ValidationError` otherwise. The gateway applies the value via `context.WithTimeout` on every proxied call and clamps defensively to the same bound.

## Canonical CLI surface

```bash
apifuse create <name>
apifuse dev [path]
apifuse check [path]
apifuse record providers/korea-air-quality --operation realtime --params '{"stationName":"종로구"}'
apifuse test [path]
apifuse submit-check [path] --tier bronze --markdown submission-report.md
apifuse bounty-check [path]
apifuse perf providers/korea-air-quality --operation realtime --params '{"stationName":"종로구"}'
```

`apifuse record` is for real upstream-backed operations that declare
`upstream.baseUrl` and call the upstream through `ctx.http` or `ctx.stealth`. The
generated local-only `ping` operation intentionally has no upstream and should
be replaced before recording fixtures.

## Bounty submission readiness

Standalone providers include a pre-submission script:

```bash
bun run submit-check -- --smoke
```

This runs the public review-readiness evaluator and writes `submission-report.md`. The report contains provider metadata, a 100-point readiness score, hard blockers, warnings, checklist evidence, measured smoke details, and remediation. Blockers override the score; fix them before posting bounty evidence. `--smoke` boots the local dev server, checks `/health`, and POSTs every operation fixture. Set `APIFUSE__PROVIDER__*` env vars when live upstream credentials are available; without them, structured provider errors can still earn runtime-path smoke credit. See [`SUBMISSION.md`](./SUBMISSION.md) for the full public-only bounty submission checklist shipped in the npm package.

## Scope boundary

Generator v1 scaffolds **TypeScript providers only** for this redesign. Python generation remains future work.


## Boundary

Provider cataloging, deployment enrollment, docs indexing, and runtime discovery are internal platform-registry responsibilities and are not part of the public `@apifuse/provider-sdk` contract.

External bounty contributors should submit standalone Provider source plus
`bun run check` / `bun run test` evidence. APIFuse maintainers own monorepo
import, registry generation, deployment projection checks, and release
publishing.
