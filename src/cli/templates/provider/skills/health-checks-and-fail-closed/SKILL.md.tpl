---
name: health-checks-and-fail-closed
description: Writing health checks that can actually fail, and fail-closed guards at envelope and row level. Load before writing healthCheck blocks or error handling.
---

# Health checks and fail-closed guards

## Health checks that can actually fail
`Array.isArray(data.items)` passes forever, including when the provider is
completely broken (wrong param name → empty array on every call). Every list
operation's health check must be able to detect the zero-rows regression:

```ts
assertions: ({ status, data }) => {
  if (status !== 200) return { status: "down", label: "<op> request failed" };
  if (!Array.isArray(data.items)) {
    return { status: "down", label: "<op> missing items array" };
  }
  // Dense query MUST return rows; zero rows = upstream contract drift
  if (data.items.length === 0) {
    return { status: "degraded", label: "<op> dense query returned 0 rows" };
  }
}
```

- Choose health-check inputs that are guaranteed-dense (major city district,
  a stable well-known entity id). Verify the id still exists when picking it.
- Also assert one semantic field on the first row (e.g. `items[0].name` is a
  non-empty string) so a mapper regression that empties fields degrades too.

## Fail-closed: envelope level
- Upstream error headers/codes → structured `ProviderError` with a stable
  `code` (`UPSTREAM_AUTH_ERROR`, `UPSTREAM_ERROR`, `NO_DATA`, ...).
- Non-JSON body, unexpected content type → `UPSTREAM_SCHEMA_ERROR`.
- HTTP non-2xx → classified error; never a fake empty success envelope.
  Fixture-based tests cannot catch swallowed errors — write an explicit test:
  mock a non-ok response and assert the handler REJECTS.

## Fail-closed: row level
Envelope guards are not enough. The silent killer is: response is valid,
array is non-empty, but every row normalizes to nothing.
- If a non-empty upstream collection produces zero normalized rows, throw
  `UPSTREAM_SCHEMA_ERROR` instead of returning `items: []`.
- Identity fields (id, name) missing on a row → throw, don't skip the row
  silently.
- Regression-test both layers separately: a bad envelope AND a good envelope
  with unmappable rows.

## Error message hygiene
`ProviderError.message` reaches the tenant verbatim. Never interpolate
upstream free text that may contain personal data (names, phone numbers,
addresses); allowlist known code tokens and keep raw bodies in server-side
details/logs only.

## Checklist
- [ ] Every list op health check flags 0 rows on a dense query
- [ ] One semantic field asserted on a real row
- [ ] Swallowed-error test exists (non-ok mock → handler rejects)
- [ ] Non-empty upstream → zero normalized rows throws
- [ ] No upstream free text in customer-facing error messages
