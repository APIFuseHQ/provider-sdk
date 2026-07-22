---
name: upstream-contract-verification
description: How to establish evidence for upstream request params and response fields before coding. Load before wiring any new endpoint or mapping new fields.
---

# Upstream contract verification

Most provider P0s come from guessed upstream contracts. Every param name and
response field needs evidence BEFORE it ships.

## Request parameters
1. Start from the official spec document (data.go.kr 활용가이드, vendor API
   docs). Copy exact names — casing and underscores matter
   (`WGS84_LAT` ≠ `WGS84LAT`; the wrong one is often silently ignored).
2. Confirm with ONE live call per endpoint. A param being ignored does not
   produce an error — it produces plausible-looking wrong results, so compare:
   - filtered vs unfiltered `totalCount` (identical → param ignored)
   - a dense-area query returning 0 rows (→ param name/format wrong)
3. Do NOT copy param names from a sibling endpoint or sibling API of the same
   vendor without re-verifying. Same vendor ≠ same contract; endpoints drift.
4. If a param only works together with another param (district requires
   province), encode that dependency in the input schema with a clear error.
   Test it: dependent-param-alone must be rejected, not silently national.

## Response fields
- Map exactly the field names present in your recorded live fixtures.
- No speculative fallback chains (`row.distance ?? row.dist ?? row.Distance`).
  If two shapes genuinely exist, you need a recorded fixture proving EACH
  branch plus a row-level test per branch; otherwise map one name only.
- Field presence varies by endpoint within the same vendor. Detail endpoints
  often return more/differently-named fields than list endpoints — record
  fixtures per endpoint, not per vendor.

## When results look wrong
- Same response body across different request payloads → the upstream is
  ignoring your variation; stop tuning fields and re-check param names/auth.
- Empty result for a query that must have data (city-center radius search,
  major-district listing) → treat as a request bug. Never record it as a
  fixture and never ship it.

## Deliverables per endpoint
- [ ] Spec reference (URL or doc name + section) noted in the PR/commit
- [ ] One recorded live fixture proving request params take effect
- [ ] Negative evidence checked: filtered count differs from unfiltered
- [ ] Param dependencies enforced in the input schema with tests
