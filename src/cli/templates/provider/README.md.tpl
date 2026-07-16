# {{DISPLAY_NAME}}

Generated with `apifuse create`.

## Commands

```bash
bun run dev
bun run check
bun run test
bun run submit-check -- --smoke
bunx apifuse perf . --operation <operation-id> --runs 3
```


## Module layout

The generated provider uses the recommended split layout:

```text
index.ts              # composition root: defineProvider() and wiring only
meta.ts               # provider metadata
operations/           # APIFuse operation contracts and handlers
schemas/              # public input/output schemas near operations
upstream/             # upstream ceremony: clients, auth, request builders
mappers/              # upstream-to-APIFuse normalization helpers
domain/               # shared provider-specific business ceremony
```

Small providers may stay in one file, but larger providers are easier to
review when `index.ts` remains a short composition root.

## Pre-submission report

Before posting bounty evidence, run:

```bash
bun run submit-check -- --smoke
```

This writes `submission-report.md` with a review-readiness score, blockers,
warnings, health coverage notes, fixture/schema evidence, and remediation. A
score is not a payout guarantee; blockers must be fixed before maintainer
review. The generated `ping` starter intentionally warns until you replace it
with real upstream-backed Operations. `APIFUSE__PROVIDER__*` env vars enable
live upstream calls; without them, structured provider errors can still verify
runtime routing. The full public-only checklist is shipped in
`node_modules/@apifuse/provider-sdk/SUBMISSION.md`.


## Operation guide

### Parameters

Starter `ping` accepts `{ "value": string }`. Replace this section with each
real operation's input schema, required fields, formats, limits, and examples
before submitting bounty evidence.

### Response

Starter `ping` returns `{ "ok": boolean, "message": string }`. Replace this
section with the normalized response fields, units, enum values, pagination,
and upstream caveats for each real operation.

### Example

```json
{
	"requestId": "req_local_ping",
	"input": { "value": "hello" },
	"headers": {}
}
```

## Provider server contract

- Dev default: `3900`
- Start/Docker/container contract: `3000`
- `GET /health`
- `POST /v1/{operation}`
- `POST /auth/start`
- `POST /auth/continue`
- `POST /auth/poll`
- `POST /auth/disconnect`

## Local smoke

```bash
curl -s http://localhost:3900/health
curl -s -X POST http://localhost:3900/v1/ping \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"req_local_ping","input":{"value":"hello"},"headers":{}}'
```

The `POST /v1/{operation}` body is a request envelope:

- `requestId` is required and can be any unique local debugging string.
- `input` contains the operation input shape.
- `headers` is optional.
- `connectionId` is optional connection identity only and does not include
  credentials. The gateway sends it for `optional` connection mode.
- `connection` is optional credential-bearing connection data. The gateway
  sends it for `required` connection mode; for local debugging, pass
  `{ "id", "mode", "secrets", "metadata", "externalRef" }` with local-only
  secret values.

The gateway sends only `connection` for `required` mode, only `connectionId`
for `optional` mode, and neither field for `none` mode. If a malformed or
manually constructed envelope contains both, nested `connection.id` takes
precedence over the top-level `connectionId`.

Structured errors return an `error` object with `code`, `message`,
`requestId`, and optional `details`; validation failures include field paths in
`details`, and the `apifuse dev` terminal prints a structured provider log.

## Debugging checklist

- `invalid_request`: include `requestId` and `input`; omit `connection` for
  public/no-auth operations and never send `connection: null`.
- Credentials: declare `credential.keys`, pass local-only values through
  `connection.secrets`, and read them with `ctx.credential`.
- Auth flow: call `/auth/start`, then `/auth/continue` with the same `flowId`;
  carry returned `contextPatch` values into the next request's `context`.
- Stealth/browser runtime: keep access-sensitive operations on `ctx.stealth.fetch()` with an
  SDK stealth `profile`; the TypeScript stealth runtime uses `impit` internally.
  `ctx.stealth` supports Chrome/Firefox-style profiles. For TypeScript browser
  Providers or Safari-specific behavior use `browser.engine: "playwright-stealth"`
  (`nodriver` is Python-runtime only), then install local Chromium with
  `bunx playwright install chromium` or set `APIFUSE__CDP_POOL__URL`.

## Next steps

1. Replace the sample `ping` operation with real upstream logic.
2. Once the real operation declares `upstream.baseUrl` and uses `ctx.http` or
   `ctx.stealth`, record a fixture with:
   `bun run record -- --operation <operation> --params '<json-input>'`.
3. Replace the starter `healthCheckUnsupported` with a real `healthCheck` for read-only upstream operations when safe.
4. Extend tests and operation metadata until the provider is bounty-ready.

`apifuse record` is not expected to work with the generated local-only `ping`
operation because it intentionally has no upstream response to capture.

## Health-check authorship

Every operation must declare exactly one of:

- `healthCheck` — preferred for safe read-only upstream probes.
- `healthCheckUnsupported` — allowed only when a probe is destructive, paid,
  credential-sensitive, flaky by design, or otherwise unsafe. Use a specific
  reason; reviewers reject placeholder reasons such as "TODO" or "later".

The generated `ping` operation uses `healthCheckUnsupported` only because it is
a local scaffold check, not a real upstream API probe.

`healthCheck.cases[].assertions` receives `{ data, status, durationMs, meta }`.
`data` is the parsed operation output. Use this shape in real operations:

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
