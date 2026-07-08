# APIFuse Provider Workspace — Agent Guide

You are building an APIFuse provider. APIFuse turns messy upstream APIs into
normalized, typed, evidence-backed public APIs. A provider that merely proxies
the upstream is a failed provider, even if every check passes.

This file is the core contract. Detailed procedures live in `skills/` — load
the matching skill BEFORE working on that area (index at the bottom).

## Non-negotiable principles

### 1. Normalize, don't proxy
Public output is an APIFuse contract, not the upstream's shape.
- Field names: `snake_case`, semantic, English. Never leak vendor keys
  (`dutyTel1`, `hvec`, `MKioskTy7`) into public output.
- Timestamps: ISO 8601 in public output. Vendor formats (`20260707222855`)
  are parsed inside mappers only. If a value cannot be parsed, omit/null it —
  never pass the raw vendor string through.
- Enums: normalize vendor status text/codes (`Y` / `불가능` / `정보미제공`) into a
  declared enum. Mixed raw-text passthrough is a contract failure.
- Units: every numeric field name states its unit (`distance_meters`), and the
  mapper proves the conversion. Never relabel an upstream number without
  verifying its unit against docs or live data.

### 2. Fail closed, never fabricate
- Never invent output values to satisfy a schema. Missing upstream data → null
  field or structured error, never a plausible dummy.
- Parse failures are errors, not defaults. Returning `0`, `[]`, or `null`
  when the upstream shape changed hides breakage from every downstream gate.
- If a non-empty upstream collection normalizes to zero rows, throw
  `UPSTREAM_SCHEMA_ERROR` — silent empty success is the worst failure mode.
- Model the upstream's real value domain. Check live data before adding
  constraints like `nonnegative()` — some upstreams legitimately return
  negative counts (e.g. overcapacity) and a wrong constraint silently
  nulls real data.

### 3. Preserve every input or fail loudly
- Every accepted input must be representable in the upstream request. If it
  isn't, reject at the schema or throw — never silently drop it.
- Upstream parameter dependencies (param B ignored without param A) must be
  enforced in YOUR schema. The upstream ignoring input silently is not an
  excuse for your provider to do the same.

### 4. Evidence over assumption
- Upstream parameter names and response fields must be verified against the
  official spec AND at least one live call. Do not guess casing or
  underscores; do not copy from a sibling API without re-verifying.
- No speculative field probing (`row.distance ?? row.dist ?? row.Distance`).
  Map exactly the fields you have evidence for. One verified name per field.
- Fixtures are recorded live evidence (`bun run record`), never hand-written.
  Placeholder-looking values (`02-1234-5678`, "테헤란로 123") mean the fixture
  is fabricated and the submission is not reviewable.
- An empty result set from a dense query (0 hospitals within 5km of a city
  center) is a request bug, not a valid fixture. Investigate before recording.

### 5. Honest pagination and counts
- If you filter rows client-side, the upstream `totalCount` is no longer your
  `total_count`. Either expose upstream semantics honestly (documented) or
  don't expose a total at all. A count the caller cannot page against is a lie.

### 6. Health checks must detect real regressions
- `Array.isArray(data.items)` alone can never fail. Every list operation's
  health check must also flag the zero-rows case for a query that is known to
  return data (dense-area query), so a broken upstream contract degrades
  visibly instead of passing forever.

## Verification loop (before every submit)

```bash
bun run check        # apifuse check + type-check
bun run test         # your tests — cover mappers, error paths, edge rows
bun run submit-check # structural score; a high score does NOT prove quality
```

`submit-check` is a structural gate. Every principle above can be violated
while scoring 95/100 — reviewers and CI audit for exactly these classes.

## Skill index — load before working on:

| Area | Load |
| --- | --- |
| Output schemas, mappers, field naming, timestamps, enums | `skills/normalization-standards/SKILL.md` |
| Upstream request params, new endpoint wiring, field mapping | `skills/upstream-contract-verification/SKILL.md` |
| Recording fixtures, writing tests against fixtures | `skills/fixtures-and-recording/SKILL.md` |
| List operations, paging, totals, client-side filtering | `skills/pagination-and-counts/SKILL.md` |
| healthCheck blocks, error classification, fail-closed guards | `skills/health-checks-and-fail-closed/SKILL.md` |
| Upstream-specific known pitfalls for THIS bounty | `skills/upstream-notes/` (read every file) |
