---
name: fixtures-and-recording
description: Recording live fixtures and writing trustworthy tests from them. Load before touching __fixtures__/ or writing operation tests.
---

# Fixtures and recording

Fixtures are evidence, not examples. Reviewers treat fixtures as proof your
provider ran against the real upstream.

## Recording
- Always record from the live upstream: `bun run record -- --operation <op>
  --params '<json>'` with the real service key configured.
- Record queries that RETURN DATA. Choose dense/known-good inputs (major city
  district, a real entity id from a prior list call).
- Re-record after any request-param or mapper change; stale fixtures make
  every downstream test meaningless.

## Forbidden fixture states
- **Hand-written fixtures.** Values like `02-1234-5678`, "테헤란로 123",
  round-number coordinates, or sequential ids are fabrication tells. If it
  wasn't returned by the upstream, it cannot be in `__fixtures__/`.
- **Empty-result fixtures for dense queries.** `items: [], total_count: 0`
  for "hospitals within 5km of Gangnam" is not a fixture — it is an
  unfixed request bug (wrong param name/format). Investigate first.
- **Fixtures that contradict each other.** If one operation's fixture proves
  `total_count: 541` while returning 1 filtered row, your count semantics are
  broken (see pagination skill), not your fixture.

## Fixture shape
`apifuse record` (`bun run record`) writes the captured RAW UPSTREAM payload
to `__fixtures__/raw.json` (secrets sanitized). With `--append` it
accumulates an array of raw payloads. The recorder does NOT write your
normalized output — raw.json is upstream evidence only.

Derive normalized expectations in TESTS, not in the fixture file: load the
recorded raw payload, run your mapper over it, and assert the exact expected
normalized rows inline in the test. If you keep expected-output snapshots,
generate them from the mapper and review them row by row — never hand-author
values that the upstream did not return.

## Tests to derive from fixtures
- Mapper: `map(recordedUpstreamRow)` equals the expected normalized row
  (toEqual, not toMatchObject, for full rows — partial matching hides
  dropped fields).
- Edge rows: single-item object vs array (`items.item` unwrapping), missing
  optional fields, unpadded/numeric time values, vendor error headers.
- Error paths: upstream error `resultCode`, HTTP failure, missing secret,
  NO_DATA — each asserts the structured `ProviderError` code.
- Handler-level: run the operation handler against a mock ctx that returns
  the fixture upstream body; assert the full normalized envelope.

## Checklist
- [ ] Every fixture recorded live; no placeholder-looking values
- [ ] No empty-result fixture for a query that must have data
- [ ] normalized expectations derived from mapper(recorded raw), not
      hand-authored
- [ ] Error and edge-shape rows covered, not just the happy row
