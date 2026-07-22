---
name: pagination-and-counts
description: total_count semantics, client-side filtering, and paging honesty. Load before implementing any list/search operation.
---

# Pagination and counts

A caller uses `total_count`, `page`, and `limit` to plan iteration. If those
numbers don't describe what the caller can actually page through, the
operation is lying.

## The client-side filtering trap
If the upstream has no server-side filter for one of your inputs (e.g. no
radius param) and you filter rows after fetching:

- Upstream `totalCount` counts UNFILTERED rows. Returning it as your
  `total_count` while returning filtered rows means: caller sees
  `total_count: 541`, gets 1 row on page 1, and pages 2..28 return rows that
  are outside the filter or empty. This is a contract failure, not a nuance.

Acceptable resolutions, in preference order:
1. **Don't accept the input.** If the upstream can't filter by it and you
   can't enumerate all pages, drop the input from the schema and document the
   upstream's real semantics (e.g. "results are distance-sorted; no radius
   cutoff").
2. **Expose upstream semantics honestly.** Distance-sorted paging with a
   documented "no radius filter" contract and no fake `radius` input.
3. **Filter AND fix the metadata.** If you must filter client-side, do not
   return the upstream total. Return only what you can prove (`returned_count`
   plus a `has_more` you can actually compute) and document that totals are
   unavailable.

Never combine: accepted filter input + client-side filter + upstream total.

## Count integrity
- Parse failure of `totalCount` → `UPSTREAM_SCHEMA_ERROR`, not `0`.
  A fail-open zero disguises upstream drift as an empty dataset.
- If `total_count > 0` but the page's row array normalizes to empty on
  page 1, throw — that combination means broken extraction, not empty data.

## Page/limit echo
- Echo the EFFECTIVE values: if you clamp `limit` to the upstream max, return
  the clamped value, not the requested one.
- `page`/`limit` semantics must match the upstream's paging model
  (1-indexed vs 0-indexed) — verify with two live pages, checking the
  returned rows actually differ.

## Checklist
- [ ] No input is filtered client-side while `total_count` comes from upstream
- [ ] totalCount parse failure fails closed
- [ ] Effective (clamped) limit echoed
- [ ] Two-page live check proves paging advances
